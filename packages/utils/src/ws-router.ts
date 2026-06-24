import {
  type BebopContentType,
  Deadline,
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
  BaseRouter,
  type BebopMethodAny,
  type IncomingContext,
  ServerContext,
  type ServiceRegistry,
  TempoRouterConfiguration,
} from "@tempojs/server";
import type { BebopRecord } from "bebop";
import { EventEmitter } from "tseep";
import { Message } from "./bebop";
import { createEventIterator } from "./create-event-iterator";

interface GenericWs {
  send(message: string | Blob | BufferSource): void;
}

/**
 * Client-metadata keys under which {@link TempoWsRouter.process} exposes the
 * current call's message/method ids to a service handler (read via
 * `context.clientMetadata`). A streaming handler persists these so the
 * hibernation-safe broadcast path can re-frame server->client pushes.
 */
export const STREAM_MESSAGE_ID_KEY = "tempo-message-id";
export const STREAM_METHOD_ID_KEY = "tempo-method-id";

/**
 * Build an encoded server-stream frame identical to the one {@link TempoWsRouter}
 * emits from a streaming handler: status OK, the given `methodId`/`messageId`, and
 * the already-serialized record bytes `data`. Used by the hibernation-safe
 * broadcast path to push frames over a live socket WITHOUT a live generator — the
 * client's server-stream iterator matches them by `messageId` exactly like
 * generator-emitted frames. `messageId` MUST be the original observe call's id
 * (a GUID); `methodId` its method id.
 */
export function encodeServerStreamFrame(opts: {
  methodId: number;
  messageId: string;
  data: Uint8Array;
}): Uint8Array {
  return new Uint8Array(
    Message.encode(
      Message({
        methodId: opts.methodId,
        messageId: opts.messageId,
        status: TempoStatusCode.OK,
        data: opts.data,
      }),
    ),
  );
}

export class TempoWsRouter<
  Context,
  Ws extends GenericWs = WebSocket,
  Env extends [Context, Ws] = [Context, Ws],
> extends BaseRouter<ArrayBuffer, Env, Message> {
  private readonly events = new EventEmitter<Record<string, (message: Message) => void>>();
  private readonly clientStreams: Map<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    Promise<any>
  > = new Map();
  // Active server-stream generators keyed by messageId. Tracked so an inbound
  // CANCELLED frame ENDS the existing stream (running its cleanup — e.g.
  // unsubscribing interest observers) instead of re-invoking the handler and
  // starting a duplicate stream. Post-hibernation this map is empty (the parked
  // generator was destroyed with the isolate), so a CANCELLED simply no-ops and
  // the rehydrated observer is reaped on socket close.
  private readonly serverStreams = new Map<string, AsyncGenerator<BebopRecord, void, unknown>>();
  // Encode-once broadcast cache. When one record object is fanned out to many
  // server-stream consumers (e.g. an ECS mutation scope broadcast to every
  // observer of a room), its payload is serialized a single time and the bytes
  // are reused for every observer's frame — turning O(observers) bebop encodes
  // per broadcast into O(1). Keyed weakly by the record, so the entry is GC'd
  // once the broadcast value is no longer referenced (no unbounded growth).
  private readonly _streamEncodeCache = new WeakMap<BebopRecord, Uint8Array>();

  constructor(
    logger: TempoLogger,
    registry: ServiceRegistry,
    configuration: TempoRouterConfiguration = new TempoRouterConfiguration(),
    authInterceptor?: AuthInterceptor,
  ) {
    super(logger, registry, configuration, authInterceptor);
  }

  private async setAuthContext(request: Message, context: ServerContext): Promise<void> {
    const authHeader = request.authorization;
    if (authHeader !== undefined && this.authInterceptor !== undefined) {
      const authContext = await this.authInterceptor.intercept(context, authHeader);
      if (authContext !== undefined) context.authContext = authContext;
    }
  }

  private async invokeUnaryMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Promise<BebopRecord> {
    await this.setAuthContext(request, context);
    if (this.hooks !== undefined) {
      await this.hooks.executeRequestHooks(context);
    }
    // `request.data` is already an isolated Uint8Array from decode; pass it
    // straight to the synchronous deserializer instead of re-copying it.
    const requestData = request.data!;
    const record = this.deserializeRequest(requestData, method, contentType);
    if (this.hooks !== undefined) {
      await this.hooks.executeDecodeHooks(context, record);
    }
    return await method.invoke(record, context);
  }

  private async invokeClientStreamMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Promise<BebopRecord> {
    await this.setAuthContext(request, context);
    if (this.hooks !== undefined) {
      await this.hooks.executeRequestHooks(context);
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
          if (this.hooks !== undefined) {
            await this.hooks.executeRequestHooks(context);
          }
          if (message.status === TempoStatusCode.CANCELLED) {
            cancel();
            return;
          }
          const requestData = message.data!;
          const record = this.deserializeRequest(requestData, method, contentType);
          if (this.hooks !== undefined) {
            await this.hooks.executeDecodeHooks(context, record);
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

  private async invokeServerStreamMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>> {
    await this.setAuthContext(request, context);
    const messageId = request.messageId!;
    // A CANCELLED frame must NEVER start a fresh server stream. End the tracked
    // generator (its cleanup runs — e.g. unsubscribing interest observers) and
    // return an already-finished generator so process() emits the terminal frame
    // without re-invoking the handler. Without this, a client `.return()` on an
    // observe stream would re-invoke the handler and spawn a duplicate stream.
    if (request.status === TempoStatusCode.CANCELLED) {
      const existing = this.serverStreams.get(messageId);
      if (existing) {
        this.serverStreams.delete(messageId);
        try {
          await existing.return(undefined);
        } catch {
          /* best effort: generator cleanup may itself throw */
        }
      }
      return (async function* (): AsyncGenerator<BebopRecord, void, unknown> {})();
    }
    // if we are currently streaming to the topic, return it
    if (this.hooks !== undefined) {
      await this.hooks.executeRequestHooks(context);
    }
    const requestData = request.data!;
    const record = this.deserializeRequest(requestData, method, contentType);
    if (!TempoUtil.isAsyncGeneratorFunction(method.invoke.bind(method))) {
      throw new TempoError(
        TempoStatusCode.INTERNAL,
        "service method incorrect: method must be async generator",
      );
    }
    if (this.hooks !== undefined) {
      await this.hooks.executeDecodeHooks(context, record);
    }
    const invocation = method.invoke(record, context) as AsyncGenerator<BebopRecord, void, unknown>;
    // Track so a later CANCELLED for this messageId ends it instead of re-invoking.
    this.serverStreams.set(messageId, invocation);
    return invocation;
  }

  private async invokeDuplexStreamMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>> {
    await this.setAuthContext(request, context);
    if (this.hooks !== undefined) {
      await this.hooks.executeRequestHooks(context);
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
          if (this.hooks !== undefined) {
            await this.hooks.executeRequestHooks(context);
          }
          // Check the CURRENT frame's status, not the original captured request.
          if (message.status === TempoStatusCode.CANCELLED) {
            cancel();
            return;
          }
          const requestData = message.data!;
          const record = this.deserializeRequest(requestData, method, contentType);
          if (this.hooks !== undefined) {
            await this.hooks.executeDecodeHooks(context, record);
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
   * Tear down all open streams for this connection (driven by the DO socket
   * close/error lifecycle). Emits a synthetic CANCELLED to each in-flight
   * client/duplex stream so its generator ends, then clears all listeners.
   */
  public async closeConnection(): Promise<void> {
    for (const id of [...this.clientStreams.keys()]) {
      this.events.emit(
        id,
        Message({ messageId: id, status: TempoStatusCode.CANCELLED, data: new Uint8Array() }),
      );
      this.clientStreams.delete(id);
    }
    // End every parked server-stream generator so its cleanup runs (e.g.
    // unsubscribing interest observers registered by an `observe` handler).
    for (const [id, gen] of [...this.serverStreams]) {
      this.serverStreams.delete(id);
      try {
        await gen.return(undefined);
      } catch {
        /* best effort */
      }
    }
    this.events.removeAllListeners();
  }

  public override async process(req: ArrayBuffer, response: Message, env: Env) {
    // Bound the untrusted inbound frame BEFORE decoding it into a Message, so a
    // hostile/oversized client frame cannot force a large allocation. The client
    // call surfaces the failure via its deadline.
    if (req.byteLength > this.maxReceiveMessageSize) {
      this.logger.error(
        `inbound frame ${req.byteLength}B exceeds maxReceiveMessageSize ${this.maxReceiveMessageSize}B; dropping`,
      );
      return;
    }
    let request = Message.decode(new Uint8Array(req as ArrayBuffer));
    const [, ws] = env;

    try {
      const methodId = request.methodId!;
      const method = this.registry.getMethod(methodId);
      if (!method) {
        throw new TempoError(
          TempoStatusCode.NOT_FOUND,
          `no service is registered which contains a method of '${methodId}'`,
        );
      }

      const previousAttempts = request.previousAttempts;
      if (previousAttempts !== undefined) {
        if (previousAttempts > this.maxRetryAttempts) {
          throw new TempoError(TempoStatusCode.RESOURCE_EXHAUSTED, "max retry attempts exceeded");
        }
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
      // Expose the per-call message/method ids to handlers (read via
      // `context.clientMetadata`). The hibernation-safe broadcast path persists
      // these in the socket attachment so a generator-free push can frame
      // server->client messages the client's stream iterator matches by
      // `messageId` — see `encodeServerStreamFrame`.
      const incomingMetadata = new Metadata();
      if (request.messageId !== undefined) {
        incomingMetadata.set(STREAM_MESSAGE_ID_KEY, request.messageId);
      }
      if (request.methodId !== undefined) {
        incomingMetadata.set(STREAM_METHOD_ID_KEY, String(request.methodId));
      }
      const incomingContext: IncomingContext = {
        headers: new Headers(),
        metadata: incomingMetadata,
      };
      if (deadline !== undefined) {
        incomingContext.deadline = deadline;
      }
      const context = new ServerContext(
        incomingContext,
        {
          metadata: outgoingMetadata,
        },
        env,
      );

      const handleRequest = async () => {
        let recordGenerator: AsyncGenerator<BebopRecord, void, undefined> | undefined = undefined;
        let record: BebopRecord | undefined;
        switch (method.type) {
          case MethodType.Unary:
            record = await this.invokeUnaryMethod(request, context, method, "bebop");
            break;
          case MethodType.ClientStream:
            record = await this.invokeClientStreamMethod(request, context, method, "bebop");
            break;
          case MethodType.ServerStream:
            recordGenerator = await this.invokeServerStreamMethod(
              request,
              context,
              method,
              "bebop",
            );
            break;
          case MethodType.DuplexStream:
            recordGenerator = await this.invokeDuplexStreamMethod(
              request,
              context,
              method,
              "bebop",
            );
            break;
          default:
            throw new TempoError(
              TempoStatusCode.INTERNAL,
              "service method incorrect: unknown method type",
            );
        }
        const outgoingCredential = context.outgoingCredential;
        if (outgoingCredential) {
          response.credential = stringifyCredential(outgoingCredential);
        }
        response.methodId = request.methodId;
        response.messageId = request.messageId;
        response.status = TempoStatusCode.OK;
        response.timestamp = new Date();
        if (this.hooks !== undefined) {
          await this.hooks.executeResponseHooks(context);
        }
        outgoingMetadata.freeze();
        if (outgoingMetadata.size() > 0) {
          //@ts-expect-error
          response.customMetadata = outgoingMetadata.data;
        }
        if (recordGenerator !== undefined) {
          const writeFrames = async () => {
            for await (const value of recordGenerator) {
              // Encode the payload once per distinct record. A fan-out broadcast
              // yields the SAME object to every observer's stream, so all but the
              // first reuse these bytes instead of re-encoding the whole scope.
              let payload = this._streamEncodeCache.get(value);
              if (payload === undefined) {
                // `serializeResponse` returns a view into bebop's shared write
                // buffer; copy it into an owned array before caching so a later
                // encode cannot clobber it.
                payload = new Uint8Array(this.serializeResponse(value, method, "bebop"));
                this._streamEncodeCache.set(value, payload);
              }
              response.data = payload;
              // `Message.encode` returns a view into bebop's shared write buffer;
              // copy it so concurrent encodes (e.g. an overlapping unary response)
              // cannot clobber this frame before the socket flushes it.
              ws.send(new Uint8Array(Message.encode(response)) as BufferSource);
            }
            // Stream ended: drop its tracking entry (harmless no-op for the
            // duplex path, which is keyed in clientStreams).
            this.serverStreams.delete(request.messageId!);
            // cancel the stream
            response.data = new Uint8Array();
            response.status = TempoStatusCode.CANCELLED;
            ws.send(new Uint8Array(Message.encode(response)) as BufferSource);
          };

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
          const responseData = this.serializeResponse(record, method, "bebop");
          response.data = new Uint8Array(responseData);
          ws.send(new Uint8Array(Message.encode(response)) as BufferSource);
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
        if (e.status === TempoStatusCode.INTERNAL && this.transmitInternalErrors !== true) {
          message = "internal error";
        }
        // internal errors indicate transient problems or implementation bugs
        // so we log them as critical errors
        if (e.status === TempoStatusCode.INTERNAL) {
          this.logger.critical(e.message, undefined, e);
        } else {
          this.logger.error(message, undefined, e);
        }
      } else if (e instanceof Error) {
        message = e.message;
        this.logger.error(message, undefined, e);
      }
      if (e instanceof Error && this.hooks !== undefined) {
        await this.hooks.executeErrorHooks(undefined, e);
      }
      // cleanup any lingering event emitters
      this.clientStreams.delete(request.messageId!);
      response.status = status;
      response.msg = message;
      ws.send(new Uint8Array(Message.encode(response)) as BufferSource);
    }
  }

  override handle(_request: ArrayBuffer, _env: Env): Promise<Message> {
    throw new TempoError(TempoStatusCode.UNIMPLEMENTED, "Method not implemented.");
  }
}
