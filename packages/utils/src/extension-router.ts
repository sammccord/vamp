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
  TempoVersion,
} from "@tempojs/common";
import {
  type AuthInterceptor,
  type BebopMethodAny,
  type IncomingContext,
  ServerContext,
  type ServiceRegistry,
  TempoRouterConfiguration,
} from "@tempojs/server";
import type { BebopRecord } from "bebop";
import { EventEmitter } from "tseep";
import { type Runtime, tabs } from "webextension-polyfill";
import { Message } from "./bebop";
import { createEventIterator } from "./create-event-iterator";

/**
 * Interface defining the configuration options for a TempoRouter instance.
 */
export class TempoExtensionRouterConfiguration {
  public static readonly defaultMaxRetryAttempts: number = 5;
  public static readonly defaultMaxReceiveMessageSize: number = 1024 * 1024 * 4; // 4 MB
  public static readonly defaultMaxSendMessageSize: number = 1024 * 1024 * 4; // 4 MB
  /**
   * Optional flag to enable CORS (Cross-Origin Resource Sharing) support.
   */
  public enableCors?: boolean;

  /**
   * Optional list of allowed origins for CORS. Ignored if enableCors is false.
   */
  public allowedOrigins?: string[];

  /**
   * Optional flag to indicate whether internal errors should be transmitted
   * in the API response. Defaults to false, meaning internal errors are
   * masked and not exposed to clients.
   */
  public transmitInternalErrors?: boolean;

  /**
   * The maximum size of the message that can be received. Defaults to the value in `TempoRouterConfiguration.defaultMaxReceiveMessageSize`.
   */
  public maxReceiveMessageSize?: number;

  /**
   * The maximum size of the message that can be sent.
   */
  public maxSendMessageSize?: number;

  /**
   * The maximum number of retry attempts for failed requests. Defaults to the value in `TempoRouterConfiguration.defaultMaxRetryAttempts`.
   */
  public maxRetryAttempts?: number;

  /**
   * Constructs a new instance of TempoRouterConfiguration with default values.
   */
  constructor() {
    this.maxReceiveMessageSize = TempoRouterConfiguration.defaultMaxReceiveMessageSize;
    this.maxRetryAttempts = TempoRouterConfiguration.defaultMaxRetryAttempts;
    this.maxRetryAttempts = TempoRouterConfiguration.defaultMaxRetryAttempts;
  }
}

/**
 * Represents an abstract base class for a router that handles incoming requests, performs validation, and routes
 * them to the appropriate services and methods in a Tempo application.
 *
 * @template TRequest - The type of the request object.
 * @template TEnvironment - The type of the environment/context object.
 * @template TResponse - The type of the response object.
 */
export abstract class ExtensionBaseRouter<TRequest, TEnvironment, TResponse> {
  protected readonly corsEnabled: boolean;
  protected readonly allowedCorsOrigins: string[] | undefined;
  protected readonly transmitInternalErrors: boolean;
  protected readonly maxReceiveMessageSize: number;
  protected readonly maxSendMessageSize?: number;
  protected readonly maxRetryAttempts: number;
  protected readonly exposeTempo: boolean;
  protected hooks?: HookRegistry<ServerContext, TEnvironment>;
  protected poweredByHeader = "x-powered-by";
  protected poweredByHeaderValue?: string;

  /**
   * Constructs a new BaseRouter instance.
   * @param logger - The logger to use for logging router-related information.
   * @param registry - The service registry instance that manages services and methods for this router.
   * @param authInterceptor - The interceptor (if any) that will be used for authenticating the peer of an incoming requests.
   */
  constructor(
    protected readonly logger: TempoLogger,
    protected readonly registry: ServiceRegistry,
    protected readonly configuration: TempoRouterConfiguration,
    protected readonly authInterceptor?: AuthInterceptor,
  ) {
    this.corsEnabled = configuration.enableCors ?? false;
    this.allowedCorsOrigins = configuration.allowedOrigins;
    this.transmitInternalErrors = configuration.transmitInternalErrors ?? false;
    this.maxReceiveMessageSize =
      configuration.maxReceiveMessageSize ?? TempoRouterConfiguration.defaultMaxReceiveMessageSize;
    if (configuration.maxSendMessageSize !== undefined) {
      this.maxSendMessageSize = configuration.maxSendMessageSize;
    }
    this.maxRetryAttempts =
      configuration.maxRetryAttempts ?? TempoRouterConfiguration.defaultMaxRetryAttempts;
    this.exposeTempo = configuration.exposeTempo ?? false;
    this.registry.init();
  }

  /**
   * Handles an incoming request by routing it to the appropriate service and method, applying any necessary
   * validation and processing and returns a response.
   *
   * @param request - The incoming request object.
   * @param env - The environment/context object associated with the request.
   * @returns A promise that resolves to the response object.
   */
  abstract handle(request: TRequest, env: TEnvironment): Promise<TResponse>;

  /**
   * Processes an incoming request by routing it to the appropriate service and method, applying any necessary
   * validation and processing, in place on the provided response object.
   *
   * @param request - The incoming request object.
   * @param response - The outgoing response object.
   * @param env - The environment/context object associated with the request.
   */
  abstract process(request: TRequest, response: TResponse, env: TEnvironment): Promise<void>;

  /**
   * Private function that retrieves custom metadata from the header.
   *
   * @private
   * @function
   * @param {string | null} value The custom metadata value from the request.
   * @returns {Metadata} The metadata object.
   */
  protected getCustomMetaData(value: string | null | undefined): Metadata {
    if (!value) {
      return new Metadata();
    }
    return Metadata.fromHttpHeader(value);
  }

  /**
   * Defines a hook registry for the router.
   * @param hooks - The hook registry to be used.
   */
  public useHooks(hooks: HookRegistry<ServerContext, TEnvironment>): void {
    this.hooks = hooks;
  }

  protected definePoweredByHeader(variant: string): void {
    this.poweredByHeaderValue = TempoUtil.buildUserAgent("javascript", TempoVersion, variant, {
      runtime: TempoUtil.getEnvironmentName(),
    });
  }

  /**
   * Deserializes an incoming request based on its content type.
   *
   * @param requestData - The incoming request data as a Uint8Array.
   * @param method - The Bebop method to use for deserialization.
   * @param contentType - The content type of the incoming request.
   * @returns The deserialized request record.
   * @throws {TempoError} When the content type is not valid.
   * @throws {BebopRuntimeError} When the request data cannot be deserialized.
   */
  protected deserializeRequest(
    requestData: Uint8Array,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): BebopRecord {
    switch (contentType) {
      case "bebop":
        return method.deserialize(requestData);
      default:
        throw new TempoError(
          TempoStatusCode.UNKNOWN_CONTENT_TYPE,
          `invalid request content type: ${contentType}`,
        );
    }
  }

  /**
   * Serializes a response record based on its content type.
   *
   * @param response - The response record to be serialized.
   * @param method - The Bebop method to use for serialization.
   * @param contentType - The content type of the response.
   * @returns The serialized response as a Uint8Array.
   * @throws {TempoError} When the content type is not valid.
   * @throws {BebopRuntimeError} When the response record cannot be serialized.
   */
  protected serializeResponse(
    response: BebopRecord,
    method: BebopMethodAny,
    contentType: BebopContentType,
  ): Uint8Array {
    switch (contentType) {
      case "bebop":
        return method.serialize(response);
      default:
        throw new TempoError(
          TempoStatusCode.UNKNOWN_CONTENT_TYPE,
          `invalid response content type: ${contentType}`,
        );
    }
  }
}

export class TempoExtensionRouter<
  Ctx extends { sender: Runtime.MessageSender },
> extends ExtensionBaseRouter<Message, Ctx, Message> {
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
  ): Promise<BebopRecord> {
    await this.setAuthContext(request, context);
    if (this.hooks !== undefined) {
      await this.hooks.executeRequestHooks(context);
    }
    const record = this.deserializeRequest(request.data!, method, "bebop");
    if (this.hooks !== undefined) {
      await this.hooks.executeDecodeHooks(context, record);
    }
    return await method.invoke(record, context);
  }

  private async invokeClientStreamMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
  ): Promise<BebopRecord> {
    await this.setAuthContext(request, context);
    if (this.hooks !== undefined) {
      await this.hooks.executeRequestHooks(context);
    }
    const messageId = request.messageId!;
    const isStreaming = this.clientStreams.has(messageId);
    if (isStreaming) {
      const invocation = this.clientStreams.get(messageId)!;
      this.events.emit(messageId, request);
      return await invocation;
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
          const record = this.deserializeRequest(requestData, method, "bebop");
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
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>> {
    await this.setAuthContext(request, context);
    // if we are currently streaming to the topic, return it
    if (this.hooks !== undefined) {
      await this.hooks.executeRequestHooks(context);
    }
    const requestData = request.data!;
    const record = this.deserializeRequest(requestData, method, "bebop");
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
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>> {
    await this.setAuthContext(request, context);
    if (this.hooks !== undefined) {
      await this.hooks.executeRequestHooks(context);
    }
    const messageId = request.messageId!;
    const isStreaming = this.clientStreams.has(messageId);
    if (isStreaming) {
      const invocation = this.clientStreams.get(messageId)!;
      this.events.emit(messageId, request);
      return invocation;
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
          const record = this.deserializeRequest(requestData, method, "bebop");
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

  public override async process(req: Message, response: Message, ctx: Ctx) {
    let request = Message(req);
    let context: ServerContext;
    try {
      const methodId = request.methodId!;
      const method = this.registry.getMethod(methodId);
      if (!method) {
        throw new TempoError(
          TempoStatusCode.NOT_FOUND,
          `no service is registered which contains a method of '${methodId}'`,
        );
      }
      //@ts-expect-error
      const metadataHeader = request.customMetadata;
      const metadata = metadataHeader ? Metadata.fromHttpHeader(metadataHeader) : new Metadata();

      const previousAttempts = metadata.get("tempo-previous-rpc-attempts");
      if (previousAttempts !== undefined) {
        const numberOfAttempts = previousAttempts.at(0);
        if (numberOfAttempts && Number(numberOfAttempts) > this.maxRetryAttempts) {
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
        metadata: metadata,
      };
      if (deadline !== undefined) {
        incomingContext.deadline = deadline;
      }
      context = new ServerContext(
        incomingContext,
        {
          metadata: outgoingMetadata,
        },
        ctx,
      );

      const handleRequest = async () => {
        let recordGenerator: AsyncGenerator<BebopRecord, void, undefined> | undefined = undefined;
        let record: BebopRecord | undefined;
        switch (method.type) {
          case MethodType.Unary:
            record = await this.invokeUnaryMethod(request, context, method);
            break;
          case MethodType.ClientStream:
            record = await this.invokeClientStreamMethod(request, context, method);
            break;
          case MethodType.ServerStream:
            recordGenerator = await this.invokeServerStreamMethod(request, context, method);
            break;
          case MethodType.DuplexStream:
            recordGenerator = await this.invokeDuplexStreamMethod(request, context, method);
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
        response.methodId = request.methodId!;
        response.messageId = request.messageId!;
        response.status = TempoStatusCode.OK;
        response.timestamp = new Date();
        response.msg = "";
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
              await this.send(ctx.sender, response);
              // if (response.topic) env.publish(response.topic, encoded, true);
            }
            // cancel the stream
            response.data = new Uint8Array();
            response.status = TempoStatusCode.CANCELLED;
            await this.send(ctx.sender, response);
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
          await this.send(ctx.sender, response);
          // if (response.topic) env.publish(response.topic, encoded, true);
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
        await this.hooks.executeErrorHooks(context!, e);
      }
      // cleanup any lingering event emitters
      this.clientStreams.delete(request.messageId!);
      response.status = status;
      response.msg = message;
      response.messageId = request.messageId!;
      response.timestamp = request.timestamp!;
      response.methodId = request.methodId!;
      await this.send(ctx.sender, response);
    }
  }

  private async send(sender: Runtime.MessageSender, message: Message) {
    if (!sender.tab?.id || sender.tab?.discarded === true) {
      this.logger.warn(`ignoring message to discarded tab`, { tab: sender.tab });
      return;
    }
    try {
      await tabs.sendMessage(
        sender.tab.id,
        Array.apply(null, Message.encode(message) as unknown as number[]),
      );
    } catch (e) {
      this.logger.error("failed to send message, tab is likely inactive", {}, e as Error);
    }
  }

  override async handle(_req: Message, _ctx: Ctx): Promise<Message> {
    return Message({});
  }
}
