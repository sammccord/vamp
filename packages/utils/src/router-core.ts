import {
  type BebopContentType,
  Deadline,
  type HookRegistry,
  Metadata,
  MethodType,
  stringifyCredential,
  TempoError,
  type TempoLogger,
  TempoStatusCode,
  TempoUtil,
} from "@tempojs/common";
import {
  type AuthInterceptor,
  type BebopMethodAny,
  type IncomingContext,
  ServerContext,
} from "@tempojs/server";
import type { BebopRecord } from "bebop";
import { EventEmitter } from "tseep";
import { Message } from "./bebop";
import { createEventIterator } from "./create-event-iterator";

/**
 * The slice of a concrete router (`BaseRouter` / `ExtensionBaseRouter`
 * subclass) that {@link RouterCore} needs. Supplied as delegate closures from
 * the router's constructor because the underlying members are `protected`.
 */
export interface RouterCoreHost {
  readonly logger: TempoLogger;
  readonly maxRetryAttempts: number;
  readonly transmitInternalErrors: boolean;
  readonly authInterceptor?: AuthInterceptor;
  /** Resolve a method from the router's service registry. */
  getMethod(methodId: number): BebopMethodAny | undefined;
  /** Read the router's current hook registry (set later via `useHooks`). */
  // biome-ignore lint/suspicious/noExplicitAny: hook registries are erased over the router's environment type
  getHooks(): HookRegistry<ServerContext, any> | undefined;
  deserializeRequest(
    requestData: Uint8Array,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): BebopRecord;
  serializeResponse(
    response: BebopRecord,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Uint8Array;
}

/**
 * The transport-specific pieces of one `process()` invocation, built fresh per
 * request so the callbacks can close over the transport handle (socket, worker
 * port, extension sender) and the request envelope.
 */
export interface ProcessTransport {
  /** Deliver a fully-populated response envelope to the client. */
  send(response: Message): void | Promise<void>;
  /**
   * Pump a server-stream / duplex generator into response frames (usually via
   * {@link RouterCore.writeStreamFrames}). Runs inside the request deadline.
   */
  writeStreamFrames(
    generator: AsyncGenerator<BebopRecord, void, unknown>,
    response: Message,
    method: BebopMethodAny,
  ): Promise<void>;
  /**
   * Build the incoming request {@link Metadata} for the ServerContext.
   * Defaults to parsing the request's custom-metadata header.
   */
  buildIncomingMetadata?(request: Message): Metadata;
  /**
   * Override the server-stream invocation (the WebSocket router layers
   * CANCELLED handling and generator tracking on top of the shared one).
   */
  invokeServerStream?(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>>;
  /** Mutate the response envelope after the OK headers are populated. */
  decorateResponse?(response: Message): void;
  /** Stamp messageId/timestamp/methodId from the request onto error frames. */
  stampErrorResponse?: boolean;
}

/** Options for {@link RouterCore.writeStreamFrames}. */
export interface StreamWriteOptions {
  generator: AsyncGenerator<BebopRecord, void, unknown>;
  response: Message;
  method: BebopMethodAny;
  contentType?: BebopContentType;
  /** Deliver one populated frame to the client. */
  send: (response: Message) => void | Promise<void>;
  /**
   * Serialize one record into owned payload bytes. The default copies out of
   * bebop's shared write buffer; the WebSocket router substitutes its
   * encode-once broadcast cache.
   */
  serializePayload?: (value: BebopRecord) => Uint8Array;
  /** Checked before each frame; `true` stops the pump (worker cancellation). */
  shouldStop?: () => boolean;
  /** Send the terminal frame even when the generator throws (worker semantics). */
  alwaysTerminate?: boolean;
  /** Runs after the pump ends, before the terminal frame (tracking-map reaping). */
  onEnd?: () => void;
}

/**
 * Parse the request's custom-metadata header into a {@link Metadata} (the
 * default incoming metadata for the worker/extension routers).
 */
function customMetadataOf(request: Message): Metadata {
  //@ts-expect-error custom metadata is not modeled on the Message envelope
  const metadataHeader = request.customMetadata;
  return metadataHeader ? Metadata.fromHttpHeader(metadataHeader) : new Metadata();
}

/**
 * Shared server-side routing core for the worker, WebSocket, and
 * browser-extension routers.
 *
 * Owns the per-connection stream state (response demultiplexing events and
 * in-flight client/duplex streams) plus every transport-agnostic step of
 * dispatching one framed request: auth interception, hook execution, the four
 * RPC invocation shapes, response population, deadline enforcement, and error
 * mapping. Each concrete router composes an instance and passes the genuinely
 * transport-specific bits per request via {@link ProcessTransport}.
 *
 * Internal to `@vampgg/utils`; the public routers are `TempoWorkerRouter`,
 * `TempoWsRouter`, and `TempoExtensionRouter`.
 */
export class RouterCore {
  /** Per-stream frame listeners keyed by messageId. */
  public readonly events = new EventEmitter<Record<string, (message: Message) => void>>();
  /** In-flight client/duplex stream invocations keyed by messageId. */
  public readonly clientStreams: Map<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: invocation results are method-specific
    Promise<any>
  > = new Map();

  constructor(private readonly host: RouterCoreHost) {}

  private async setAuthContext(request: Message, context: ServerContext): Promise<void> {
    const authHeader = request.authorization;
    if (authHeader !== undefined && this.host.authInterceptor !== undefined) {
      const authContext = await this.host.authInterceptor.intercept(context, authHeader);
      if (authContext !== undefined) context.authContext = authContext;
    }
  }

  public async invokeUnaryMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Promise<BebopRecord> {
    await this.setAuthContext(request, context);
    const hooks = this.host.getHooks();
    if (hooks !== undefined) {
      await hooks.executeRequestHooks(context);
    }
    // `request.data` is already an isolated Uint8Array from decode; pass it
    // straight to the synchronous deserializer instead of re-copying it.
    const requestData = request.data!;
    const record = this.host.deserializeRequest(requestData, method, contentType);
    if (hooks !== undefined) {
      await hooks.executeDecodeHooks(context, record);
    }
    return await method.invoke(record, context);
  }

  public async invokeClientStreamMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Promise<BebopRecord> {
    await this.setAuthContext(request, context);
    if (this.host.getHooks() !== undefined) {
      await this.host.getHooks()!.executeRequestHooks(context);
    }
    const messageId = request.messageId!;
    const stream = this.clientStreams.get(messageId);
    if (stream) {
      this.events.emit(messageId, request);
      return await stream;
    }
    const generator = () => {
      return createEventIterator<BebopRecord>(({ emit, cancel }) => {
        const eventHandler = async (message: Message) => {
          const hooks = this.host.getHooks();
          if (hooks !== undefined) {
            await hooks.executeRequestHooks(context);
          }
          if (message.status === TempoStatusCode.CANCELLED) {
            cancel();
            return;
          }
          const requestData = message.data!;
          const record = this.host.deserializeRequest(requestData, method, contentType);
          if (hooks !== undefined) {
            await hooks.executeDecodeHooks(context, record);
          }
          emit(record);
        };

        this.events.on(messageId, eventHandler);

        return () => {
          this.events.off(messageId, eventHandler);
          this.clientStreams.delete(messageId);
        };
      });
    };
    const invocation = method.invoke(generator, context);
    this.clientStreams.set(messageId, invocation);
    this.events.emit(messageId, request);
    // Reap the map entry on every completion path (incl. early resolution where
    // the iterator cleanup closure never runs).
    return await (invocation as Promise<BebopRecord>).finally(() => {
      this.clientStreams.delete(messageId);
    });
  }

  public async invokeServerStreamMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>> {
    await this.setAuthContext(request, context);
    const hooks = this.host.getHooks();
    if (hooks !== undefined) {
      await hooks.executeRequestHooks(context);
    }
    const requestData = request.data!;
    const record = this.host.deserializeRequest(requestData, method, contentType);
    if (!TempoUtil.isAsyncGeneratorFunction(method.invoke.bind(method))) {
      throw new TempoError(
        TempoStatusCode.INTERNAL,
        "service method incorrect: method must be async generator",
      );
    }
    if (hooks !== undefined) {
      await hooks.executeDecodeHooks(context, record);
    }
    return method.invoke(record, context) as AsyncGenerator<BebopRecord, void, unknown>;
  }

  public async invokeDuplexStreamMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>> {
    await this.setAuthContext(request, context);
    if (this.host.getHooks() !== undefined) {
      await this.host.getHooks()!.executeRequestHooks(context);
    }
    const messageId = request.messageId!;
    const stream = this.clientStreams.get(messageId);
    if (stream) {
      this.events.emit(messageId, request);
      return stream;
    }

    if (!TempoUtil.isAsyncGeneratorFunction(method.invoke.bind(method))) {
      throw new TempoError(
        TempoStatusCode.INTERNAL,
        "service method incorrect: method must be async generator",
      );
    }

    const generator = () => {
      return createEventIterator<BebopRecord>(({ emit, cancel }) => {
        const eventHandler = async (message: Message) => {
          const hooks = this.host.getHooks();
          if (hooks !== undefined) {
            await hooks.executeRequestHooks(context);
          }
          // Check the CURRENT frame's status, not the original captured request.
          if (message.status === TempoStatusCode.CANCELLED) {
            cancel();
            return;
          }
          const requestData = message.data!;
          const record = this.host.deserializeRequest(requestData, method, contentType);
          if (hooks !== undefined) {
            await hooks.executeDecodeHooks(context, record);
          }
          emit(record);
        };
        this.events.on(messageId, eventHandler);
        this.events.emit(messageId, request);
        return () => {
          this.events.off(messageId, eventHandler);
          this.clientStreams.delete(messageId);
        };
      });
    };
    const invocation = method.invoke(generator, context);
    this.clientStreams.set(messageId, invocation);
    // Duplex invocation is an AsyncGenerator (not a Promise); its map entry is
    // reaped by the iterator cleanup closure above and by closeConnection().
    return invocation;
  }

  /**
   * Emit a synthetic CANCELLED to every in-flight client/duplex stream so its
   * generator ends, and drop the tracking entries (connection teardown).
   */
  public cancelClientStreams(): void {
    for (const id of [...this.clientStreams.keys()]) {
      this.events.emit(
        id,
        Message({ messageId: id, status: TempoStatusCode.CANCELLED, data: new Uint8Array() }),
      );
      this.clientStreams.delete(id);
    }
  }

  /** Drop every per-stream frame listener (connection teardown). */
  public removeAllListeners(): void {
    this.events.removeAllListeners();
  }

  /**
   * Pump a server-stream / duplex generator into response frames and emit the
   * terminal CANCELLED frame that tells the client the stream is complete.
   */
  public async writeStreamFrames(opts: StreamWriteOptions): Promise<void> {
    const contentType = opts.contentType ?? "bebop";
    const serializePayload =
      opts.serializePayload ??
      // `serializeResponse` returns a view into bebop's shared write buffer;
      // copy it into an owned array so a later encode cannot clobber it.
      ((value: BebopRecord) =>
        new Uint8Array(this.host.serializeResponse(value, opts.method, contentType)));
    const terminate = async () => {
      opts.onEnd?.();
      // cancel the stream
      opts.response.data = new Uint8Array();
      opts.response.status = TempoStatusCode.CANCELLED;
      await opts.send(opts.response);
    };
    const pump = async () => {
      for await (const value of opts.generator) {
        if (opts.shouldStop?.()) break;
        opts.response.data = serializePayload(value);
        await opts.send(opts.response);
      }
    };
    if (opts.alwaysTerminate) {
      try {
        await pump();
      } finally {
        await terminate();
      }
    } else {
      await pump();
      await terminate();
    }
  }

  /**
   * Dispatch one decoded request envelope: resolve the method, enforce retry
   * and deadline limits, build the {@link ServerContext}, invoke the method by
   * type, populate and deliver the response, and map any failure onto an error
   * frame. Transport-specific behavior is injected via `transport`.
   */
  public async processRequest(
    request: Message,
    response: Message,
    env: unknown,
    transport: ProcessTransport,
    contentType: BebopContentType = "bebop",
  ): Promise<void> {
    let context: ServerContext | undefined;
    try {
      const methodId = request.methodId!;
      const method = this.host.getMethod(methodId);
      if (!method) {
        throw new TempoError(
          TempoStatusCode.NOT_FOUND,
          `no service is registered which contains a method of '${methodId}'`,
        );
      }

      // Read the retry counter from the top-level Message field that the
      // channels actually write (`requestInit.previousAttempts`), not from
      // metadata — otherwise the guard never fires.
      const previousAttempts = request.previousAttempts;
      if (previousAttempts !== undefined && previousAttempts > this.host.maxRetryAttempts) {
        throw new TempoError(TempoStatusCode.RESOURCE_EXHAUSTED, "max retry attempts exceeded");
      }

      let deadline: Deadline | undefined;
      const deadlineHeader = request.deadline;
      if (deadlineHeader !== undefined) {
        deadline = Deadline.fromUnixTimestamp(deadlineHeader.valueOf());
      }
      if (deadline !== undefined && deadline.isExpired()) {
        throw new TempoError(
          TempoStatusCode.DEADLINE_EXCEEDED,
          "incoming request has already exceeded its deadline",
        );
      }
      const outgoingMetadata = new Metadata();
      const incomingContext: IncomingContext = {
        headers: new Headers(),
        metadata: transport.buildIncomingMetadata
          ? transport.buildIncomingMetadata(request)
          : customMetadataOf(request),
      };
      if (deadline !== undefined) {
        incomingContext.deadline = deadline;
      }
      const serverContext = new ServerContext(
        incomingContext,
        {
          metadata: outgoingMetadata,
        },
        env,
      );
      context = serverContext;

      const handleRequest = async () => {
        let recordGenerator: AsyncGenerator<BebopRecord, void, unknown> | undefined = undefined;
        let record: BebopRecord | undefined;
        switch (method.type) {
          case MethodType.Unary:
            record = await this.invokeUnaryMethod(request, serverContext, method, contentType);
            break;
          case MethodType.ClientStream:
            record = await this.invokeClientStreamMethod(
              request,
              serverContext,
              method,
              contentType,
            );
            break;
          case MethodType.ServerStream:
            recordGenerator = transport.invokeServerStream
              ? await transport.invokeServerStream(request, serverContext, method)
              : await this.invokeServerStreamMethod(request, serverContext, method, contentType);
            break;
          case MethodType.DuplexStream:
            recordGenerator = await this.invokeDuplexStreamMethod(
              request,
              serverContext,
              method,
              contentType,
            );
            break;
          default:
            throw new TempoError(
              TempoStatusCode.INTERNAL,
              "service method incorrect: unknown method type",
            );
        }
        const outgoingCredential = serverContext.outgoingCredential;
        if (outgoingCredential) {
          response.credential = stringifyCredential(outgoingCredential);
        }
        response.methodId = request.methodId;
        response.messageId = request.messageId;
        response.status = TempoStatusCode.OK;
        response.timestamp = new Date();
        transport.decorateResponse?.(response);
        const hooks = this.host.getHooks();
        if (hooks !== undefined) {
          await hooks.executeResponseHooks(serverContext);
        }
        outgoingMetadata.freeze();
        if (outgoingMetadata.size() > 0) {
          //@ts-expect-error custom metadata is not modeled on the Message envelope
          response.customMetadata = outgoingMetadata.data;
        }
        if (recordGenerator !== undefined) {
          const generator = recordGenerator;
          const writeFrames = () => transport.writeStreamFrames(generator, response, method);

          if (deadline) {
            await deadline.executeWithinDeadline(writeFrames);
          } else {
            await writeFrames();
          }
        } else {
          if (record === undefined) {
            throw new TempoError(
              TempoStatusCode.INTERNAL,
              "service method did not return a record",
            );
          }
          const responseData = this.host.serializeResponse(record, method, contentType);
          response.data = new Uint8Array(responseData);
          await transport.send(response);
        }
      };
      if (deadline !== undefined) {
        await deadline.executeWithinDeadline(handleRequest);
      } else {
        await handleRequest();
      }
    } catch (e) {
      let status = TempoStatusCode.UNKNOWN;
      let message = "unknown error";
      if (e instanceof TempoError) {
        status = e.status;
        message = e.message;
        // dont expose internal error messages to the client
        if (e.status === TempoStatusCode.INTERNAL && this.host.transmitInternalErrors !== true) {
          message = "internal error";
        }
        // internal errors indicate transient problems or implementation bugs
        // so we log them as critical errors
        if (e.status === TempoStatusCode.INTERNAL) {
          this.host.logger.critical(e.message, undefined, e);
        } else {
          this.host.logger.error(message, undefined, e);
        }
      } else if (e instanceof Error) {
        message = e.message;
        this.host.logger.error(message, undefined, e);
      }
      const hooks = this.host.getHooks();
      if (e instanceof Error && hooks !== undefined) {
        await hooks.executeErrorHooks(context, e);
      }
      // cleanup any lingering event emitters
      this.clientStreams.delete(request.messageId!);
      response.status = status;
      response.msg = message;
      if (transport.stampErrorResponse) {
        response.messageId = request.messageId;
        response.timestamp = request.timestamp;
        response.methodId = request.methodId;
      }
      await transport.send(response);
    }
  }
}
