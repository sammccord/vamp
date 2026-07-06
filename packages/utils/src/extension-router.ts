import {
  type BebopContentType,
  type HookRegistry,
  Metadata,
  TempoError,
  type TempoLogger,
  TempoStatusCode,
  TempoUtil,
  TempoVersion,
} from "@tempojs/common";
import {
  type AuthInterceptor,
  type BebopMethodAny,
  type ServerContext,
  type ServiceRegistry,
  TempoRouterConfiguration,
} from "@tempojs/server";
import type { BebopRecord } from "bebop";
import { type Runtime, runtime, tabs } from "webextension-polyfill";
import { Message } from "./bebop";
import { RouterCore } from "./router-core";

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
   * Optional flag to indicate whether the tempo version, runtime, and variant should be exposed in responses via X-Powered-By (and if the GET endpoint should be enabled). Defaults to false.
   */
  public exposeTempo?: boolean;

  /**
   * Constructs a new instance of TempoRouterConfiguration with default values.
   */
  constructor() {
    this.maxReceiveMessageSize = TempoRouterConfiguration.defaultMaxReceiveMessageSize;
    this.maxSendMessageSize = TempoRouterConfiguration.defaultMaxSendMessageSize;
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
  private readonly core: RouterCore;

  constructor(
    logger: TempoLogger,
    registry: ServiceRegistry,
    configuration: TempoRouterConfiguration = new TempoRouterConfiguration(),
    authInterceptor?: AuthInterceptor,
  ) {
    super(logger, registry, configuration, authInterceptor);
    this.core = new RouterCore({
      logger,
      maxRetryAttempts: this.maxRetryAttempts,
      transmitInternalErrors: this.transmitInternalErrors,
      authInterceptor,
      getMethod: (methodId) => this.registry.getMethod(methodId),
      getHooks: () => this.hooks,
      deserializeRequest: (data, method, contentType) =>
        this.deserializeRequest(data, method, contentType),
      serializeResponse: (record, method, contentType) =>
        this.serializeResponse(record, method, contentType),
    });
  }

  /**
   * Tear down all open streams for this connection. Emits a synthetic CANCELLED
   * to each in-flight client/duplex stream so its generator ends, then clears
   * all listeners.
   */
  public async closeConnection(): Promise<void> {
    this.core.cancelClientStreams();
    this.core.removeAllListeners();
  }

  public override async process(req: Message, response: Message, ctx: Ctx) {
    const request = Message(req);
    const send = (message: Message) => this.send(ctx.sender, message);

    await this.core.processRequest(request, response, ctx, {
      send,
      stampErrorResponse: true,
      decorateResponse: (message) => {
        message.msg = "";
      },
      writeStreamFrames: (generator, resp, method) =>
        this.core.writeStreamFrames({
          generator,
          response: resp,
          method,
          send,
        }),
    });
  }

  private async send(sender: Runtime.MessageSender, message: Message) {
    const payload = Array.from(Message.encode(message));
    try {
      if (sender.tab?.id !== undefined && sender.tab.discarded !== true) {
        await tabs.sendMessage(sender.tab.id, payload);
      } else {
        // Popup / options / other extension pages aren't reachable via tabs;
        // broadcast reaches them and each channel demultiplexes by messageId.
        await runtime.sendMessage(payload);
      }
    } catch (e) {
      // Receiver gone (popup closed, tab navigated); the client call times out.
      this.logger.debug(
        "extension reply not delivered; receiver likely gone",
        { tab: sender.tab },
        e as Error,
      );
    }
  }

  override async handle(_req: Message, _ctx: Ctx): Promise<Message> {
    return Message({});
  }
}

export type ExtensionSenderContext = { sender: Runtime.MessageSender };

/**
 * Inbound guard + dispatch for the background/service-worker `runtime.onMessage`
 * hook, which the router does not install itself. Only frames from this
 * extension that decode to a Message with a registered methodId are processed;
 * everything else (other extensions, reply frames, malformed traffic) is
 * ignored. Replies travel back through the router's send path, so this never
 * uses `sendResponse`.
 */
export function createExtensionListener(
  router: Pick<TempoExtensionRouter<ExtensionSenderContext>, "process">,
  registry: ServiceRegistry,
): (raw: unknown, sender: Runtime.MessageSender) => undefined {
  return (raw, sender) => {
    if (sender.id !== runtime.id) return undefined;
    if (!Array.isArray(raw)) return undefined;
    let message: Message;
    try {
      message = Message(Message.decode(new Uint8Array(raw as number[])));
    } catch {
      return undefined;
    }
    if (message.methodId === undefined || !registry.getMethod(message.methodId)) {
      return undefined;
    }
    void router.process(message, Message({}), { sender });
    return undefined;
  };
}
