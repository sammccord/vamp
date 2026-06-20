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
    const requestData = new Uint8Array(request.data!);
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
    return await invocation;
  }

  private async invokeServerStreamMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>> {
    await this.setAuthContext(request, context);
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
    const invocation = method.invoke(record, context);
    // persist the stream
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
          if (request.status === TempoStatusCode.CANCELLED) {
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
    return invocation;
  }

  public override async process(req: ArrayBuffer, response: Message, env: Env) {
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
      const incomingContext: IncomingContext = {
        headers: new Headers(),
        metadata: new Metadata(),
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
              const responseData = this.serializeResponse(value, method, "bebop");
              response.data = new Uint8Array(responseData);
              // `Message.encode` returns a view into bebop's shared write buffer;
              // copy it so concurrent encodes (e.g. an overlapping unary response)
              // cannot clobber this frame before the socket flushes it.
              ws.send(new Uint8Array(Message.encode(response)) as BufferSource);
            }
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
