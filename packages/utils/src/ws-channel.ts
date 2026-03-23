import {
  BaseChannel,
  type CallCredential,
  type CallOptions,
  type ClientContext,
  InsecureChannelCredential,
  type MethodInfo,
  type RetryPolicy,
  type TempoChannelOptions,
} from "@tempojs/client";
import {
  type BebopContentType,
  ConsoleLogger,
  type Credential,
  Deadline,
  ExecutionEnvironment,
  Metadata,
  type MethodType,
  parseCredential,
  TempoError,
  TempoStatusCode,
  TempoUtil,
  TempoVersion,
} from "@tempojs/common";
import type { BebopRecord } from "bebop";
import { EventEmitter } from "tseep";
import { Websocket, WebsocketEvent, type WebsocketOptions } from "websocket-ts";
import { Message } from "./bebop";
import { createDuplexIterator } from "./create-duplex-iterator";
import { createEventIterator } from "./create-event-iterator";

export type TempoWSChannelOptions = TempoChannelOptions & {
  binaryType?: BinaryType;
} & WebsocketOptions;

//@ts-expect-error
class ExistingWebSocket extends Websocket {
  constructor(ws: WebSocket, protocols?: string | string[], options?: WebsocketOptions) {
    //@ts-expect-error
    this._underlyingWebsocket = ws;
    super(ws.url, protocols, options);
  }
  //@ts-ignore called internally by base class
  private tryConnect() {
    //@ts-expect-error
    this._underlyingWebsocket.addEventListener(
      WebsocketEvent.open,
      //@ts-expect-error
      this.handleOpenEvent,
    );
    //@ts-expect-error
    this._underlyingWebsocket.addEventListener(
      WebsocketEvent.close,
      //@ts-expect-error
      this.handleCloseEvent,
    );
    //@ts-expect-error
    this._underlyingWebsocket.addEventListener(
      WebsocketEvent.error,
      //@ts-expect-error
      this.handleErrorEvent,
    );
    //@ts-expect-error
    this._underlyingWebsocket.addEventListener(
      WebsocketEvent.message,
      //@ts-expect-error
      this.handleMessageEvent,
    );

    //@ts-expect-error
    return this._underlyingWebsocket;
  }
}

/**
 * Represents a Tempo channel for communication with a remote server.
 */
export class TempoWSChannel extends BaseChannel {
  public static readonly defaultMaxRetryAttempts: number = 5;
  public static readonly defaultMaxReceiveMessageSize: number = 1024 * 1024 * 4; // 4 MB
  public static readonly defaultMaxSendMessageSize: number = 1024 * 1024 * 4; // 4 MB
  public static readonly defaultCredential: CallCredential = InsecureChannelCredential.create();
  public static readonly defaultContentType: BebopContentType = "bebop";

  public readonly ws: Websocket;
  public readonly events = new EventEmitter<Record<string, (message: Message) => void>>();

  private readonly isSecure: boolean;
  private readonly credential: CallCredential;
  private readonly userAgent: string;

  public get log() {
    return this.logger;
  }

  /**
   * Constructs a new TempoChannel instance.
   *
   * @param {URL} target - The target URL for the channel.
   * @param {TempoWSChannelOptions} options - The configuration options for the channel.
   * @protected
   */
  protected constructor(target: URL | WebSocket, options: TempoWSChannelOptions) {
    const url = target instanceof URL ? target : new URL(target.url);
    super(
      url,
      options.logger ?? new ConsoleLogger("TempoWSChannel"),
      options.contentType ?? TempoWSChannel.defaultContentType,
    );
    this.logger.trace("creating new TempoWSChannel");
    this.isSecure = target.protocol === "https:" || target.protocol === "wss:";
    this.credential = options.credential ?? TempoWSChannel.defaultCredential;
    if (
      !this.isSecure &&
      !(this.credential instanceof InsecureChannelCredential) &&
      options.unsafeUseInsecureChannelCallCredential !== true
    ) {
      throw new Error("Cannot use secure credential with insecure channel");
    }
    this.credential = options.credential ?? TempoWSChannel.defaultCredential;
    this.userAgent = TempoUtil.buildUserAgent("javascript", TempoVersion, undefined, {
      runtime: TempoUtil.getEnvironmentName(),
    });

    if (target instanceof URL) {
      this.ws = new Websocket(url.toString(), [], options);
    } else {
      //@ts-expect-error
      this.ws = new ExistingWebSocket(target, [], options);
    }
    this.ws.binaryType = options.binaryType || "arraybuffer";

    // Add event listeners
    this.ws.addEventListener(WebsocketEvent.open, () => {
      this.logger.trace(`opened TempoWSChannel for ${url.href} / ${this.userAgent}`);
    });
    this.ws.addEventListener(WebsocketEvent.close, () =>
      this.logger.trace(`closed TempoWSChannel for ${url.href} / ${this.userAgent}`),
    );
    this.ws.addEventListener(WebsocketEvent.message, (_ws, ev) => {
      let message: Message;
      if (typeof ev.data === "string") message = Message(JSON.parse(ev.data));
      else {
        // this is a hack to fix decoding
        message = Message(Message.decode(new Uint8Array(ev.data)));
      }
      const messageId = message.messageId;
      this.events.emit(messageId!, message);
      this.logger.trace(`received new message ${messageId}`);
    });

    this.logger.trace(`created new TempoWSChannel for ${url.href} / ${this.userAgent}`);
  }

  /**
   * Creates a new TempoChannel instance for the specified address.
   *
   * @param {string | URL} address - The target address as a string or URL object.
   * @param {TempoChannelOptions} [options] - Optional configuration options for the channel.
   * @returns {TempoChannel} - A new TempoChannel instance.
   */
  public static forWebSocket(target: WebSocket, options?: TempoWSChannelOptions): TempoWSChannel {
    options ??= {};
    return new TempoWSChannel(target, options);
  }

  /**
   * Creates a new TempoChannel instance for the specified address.
   *
   * @param {string | URL} address - The target address as a string or URL object.
   * @param {TempoChannelOptions} [options] - Optional configuration options for the channel.
   * @returns {TempoChannel} - A new TempoChannel instance.
   */
  public static forAddress(address: string | URL, options?: TempoWSChannelOptions): TempoWSChannel {
    if (!address) {
      throw new Error("no address");
    }
    if (typeof address === "string") {
      address = new URL(address);
    }
    options ??= {};
    return new TempoWSChannel(address, options);
  }

  public override async removeCredential(): Promise<void> {
    await this.credential.removeCredential();
  }
  public override async getCredential(): Promise<Credential | undefined> {
    return await this.credential.getCredential();
  }

  /**
   * Executes a function with retries according to the provided retry policy.
   * The function will be retried if it fails with a TempoError and its status code is included in the retryableStatusCodes of the retry policy.
   * If a deadline is provided, the deadline for each attempt will be managed by the provided deadline, but the deadline will not be reset upon each retry.
   *
   * @template T - The type of the result returned by the function.
   * @param {((retryAttempt: number) => Promise<T>)} func - A function that returns a Promise with a result. The function will receive a number indicating the current retry attempt.
   * @param {RetryPolicy} retryPolicy - An object defining the retry policy, including maxAttempts, initialBackoff, maxBackoff, backoffMultiplier, and retryableStatusCodes.
   * @param {Deadline} [deadline] - An optional deadline object that manages the timeout for each attempt.
   * @param {AbortController} [abortController] - An optional AbortController instance to cancel the function execution.
   * @returns {Promise<T>} - A Promise that resolves with the result of the function if it completes within the deadline and retry policy constraints.
   * @throws {Error} - If the function execution fails and the error does not match the retry policy, or if the maximum number of attempts is reached without a successful result.
   */
  async executeWithRetry<T>(
    func: (retryAttempt: number) => Promise<T>,
    retryPolicy: RetryPolicy,
    deadline?: Deadline,
    abortController?: AbortController,
  ): Promise<T> {
    let attempt = 0;
    let lastError: Error | undefined;

    const execute = deadline
      ? (retryAttempt: number) =>
          deadline.executeWithinDeadline(async () => await func(retryAttempt), abortController)
      : (retryAttempt: number) => func(retryAttempt);

    while (attempt < retryPolicy.maxAttempts) {
      try {
        // Attempt to execute the function within the deadline, if provided.
        const result = await execute(attempt);
        return result;
      } catch (error) {
        if (!(error instanceof Error)) {
          throw new TempoError(TempoStatusCode.UNKNOWN, `unexpected error`, {
            data: error,
          });
        }
        lastError = error;
        // If error is not an instance of TempoError or the status code is not in retryableStatusCodes, throw the error.
        if (
          !(error instanceof TempoError) ||
          !retryPolicy.retryableStatusCodes.includes(error.status)
        ) {
          throw error;
        }

        // Calculate the backoff time for this attempt.
        const backoffTime = Math.min(
          retryPolicy.initialBackoff.multiply(Math.pow(retryPolicy.backoffMultiplier, attempt))
            .totalMilliseconds,
          retryPolicy.maxBackoff.totalMilliseconds,
        );

        // Add some jitter to the backoff time.
        const backoffWithJitter = backoffTime * (Math.random() * 0.5 + 0.75);

        // Wait for the backoff duration.
        await new Promise<void>((resolve) => setTimeout(resolve, backoffWithJitter));

        // Increment the attempt counter.
        attempt++;
      }
    }

    if (
      abortController &&
      lastError !== undefined &&
      !(lastError instanceof Error && lastError.name === "AbortError") &&
      !(lastError instanceof TempoError && lastError.status === TempoStatusCode.ABORTED)
    ) {
      abortController.abort();
    }

    return Promise.reject(
      lastError ||
        new TempoError(
          TempoStatusCode.DEADLINE_EXCEEDED,
          "Failed to execute function with retry policy",
        ),
    );
  }

  private async fetchUnary(init: Message, options?: CallOptions): Promise<Message> {
    return await new Promise((resolve, reject) => {
      const messageId = init.messageId!;
      const listener = (message: Message) => {
        resolve(message);
        this.events.off(messageId, listener);
      };
      if (options?.controller) {
        options.controller.signal.addEventListener("abort", () => {
          this.events.off(messageId, listener);
          reject(new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {}));
        });
      }
      this.events.on(messageId, listener);
      this.send(init);
    });
  }

  // should loop over generator, send all, and resolve on one response
  private async fetchClientStream(
    init: Message,
    method: MethodInfo<BebopRecord, BebopRecord>,
    generator: () => AsyncGenerator<BebopRecord, void, undefined>,
    options?: CallOptions,
  ): Promise<Message> {
    const messageId = init.messageId;
    return await new Promise(async (resolve, reject) => {
      const listener = (message: Message) => {
        resolve(message);
        this.events.off(messageId!, listener);
      };
      if (options?.controller) {
        options.controller.signal.addEventListener("abort", () => {
          this.events.off(messageId!, listener);
          reject(new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {}));
        });
      }
      this.events.on(messageId!, listener);
      for await (const value of generator()) {
        init.data = new Uint8Array(method.serialize(value));
        this.send(init);
      }
      init.status = TempoStatusCode.CANCELLED;
      init.data = new Uint8Array();
      this.send(init);
    });
  }

  // should send message, then return a createEventIterator from incoming events, stopping on CANCEL
  // TODO should cancel on server side when done?
  private fetchServerStream(
    init: Message,
    context: ClientContext,
    method: MethodInfo<BebopRecord, BebopRecord>,
    options?: CallOptions,
  ): AsyncGenerator<BebopRecord, void, undefined> {
    const messageId = init.messageId;
    return createEventIterator<BebopRecord>(({ emit, cancel }) => {
      const eventHandler = async (message: Message) => {
        if (message.status === TempoStatusCode.CANCELLED) {
          cancel();
          return;
        }
        await this.processResponseHeaders(message, context, method.type);
        const requestData = message.data;
        const record = method.deserialize(requestData!);
        if (this.hooks !== undefined) {
          await this.hooks.executeDecodeHooks(context, record);
        }
        emit(record);
      };
      if (options?.controller) {
        options.controller.signal.addEventListener("abort", () => {
          cancel();
          throw new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {});
        });
      }
      this.events.on(messageId!, eventHandler);
      this.send(init);
      return () => {
        this.events.off(messageId!, eventHandler);
      };
    });
  }

  // should do both client and server stream logic
  private fetchDuplexStream(
    init: Message,
    context: ClientContext,
    method: MethodInfo<BebopRecord, BebopRecord>,
    generator: () => AsyncGenerator<BebopRecord, void, undefined>,
    options?: CallOptions,
  ): AsyncGenerator<BebopRecord, void, undefined> {
    const messageId = init.messageId!;
    const iterator = createDuplexIterator<BebopRecord>(
      generator(),
      (value) => {
        init.data = new Uint8Array(method.serialize(value));
        this.send(init);
      },
      ({ emit, cancel }) => {
        const eventHandler = async (message: Message) => {
          if (message.status === TempoStatusCode.CANCELLED) {
            cancel();
            return;
          }
          await this.processResponseHeaders(message, context, method.type);
          const requestData = message.data!;
          const record = method.deserialize(requestData);
          if (this.hooks !== undefined) {
            await this.hooks.executeDecodeHooks(context, record);
          }
          emit(record);
        };
        if (options?.controller) {
          options.controller.signal.addEventListener("abort", () => {
            cancel();
            throw new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {});
          });
        }
        this.events.on(messageId, eventHandler);
        return () => {
          this.events.off(messageId, eventHandler);
        };
      },
    );

    return iterator;
  }

  /**
   * Creates a `RequestInit` object for a given payload, context, method and optional call options.
   * This object can be used to make an HTTP request using the Fetch API.
   *
   * @private
   * @param {Uint8Array} payload - The payload to be sent in the request.
   * @param {ClientContext} context - The context of the client making the request.
   * @param {MethodInfo<BebopRecord, BebopRecord>} method - Information about the method being called.
   * @param {CallOptions | undefined} options - Optional configuration for the call.
   * @returns {Promise<RequestInit>} A Promise resolving to the created `RequestInit` object.
   * @throws {TempoError} Throws an error if there's a problem while getting the credential header.
   */
  private async createRequest(
    payload: Uint8Array,
    _context: ClientContext,
    method: MethodInfo<BebopRecord, BebopRecord>,
    options?: CallOptions  ,
  ): Promise<Message> {
    const messageId = crypto.randomUUID();
    const requestInit: Message = {
      messageId,
      methodId: method.id,
      data: payload,
      timestamp: new Date(),
    };
    if (options?.deadline) {
      requestInit.deadline = new Date(options.deadline.toUnixTimestamp());
    }
    const credentialHeader = await this.credential.getHeader();
    if (credentialHeader) {
      requestInit.authorization = credentialHeader.value;
    }
    return Message(requestInit);
  }

  /**
   * Processes the headers of the response from the server, validating their integrity and correctness.
   * Also sets the incoming metadata from the response headers to the provided context.
   *
   * @private
   * @param {Response} response - The response received from the server.
   * @param {ClientContext} context - The context of the client making the request.
   * @param {MethodType} methodType - The type of method being called.
   * @throws {TempoError} Throws an error if any validation checks fail or if there's a problem parsing or storing credentials.
   */
  private async processResponseHeaders(
    response: Message,
    context: ClientContext,
    _methodType: MethodType,
  ) {
    // Validate response headers
    const statusCode: TempoStatusCode | undefined = response.status;
    if (statusCode === undefined) {
      throw new TempoError(TempoStatusCode.UNKNOWN, "tempo-status missing from response.");
    }

    if (statusCode !== TempoStatusCode.OK && statusCode !== TempoStatusCode.CANCELLED) {
      let tempoMessage = response.msg;
      if (!tempoMessage) {
        tempoMessage = "unknown error";
      }
      throw new TempoError(statusCode, tempoMessage);
    }

    // Set incoming metadata from response headers
    const responseCredential = response.credential;
    if (responseCredential) {
      const credential = parseCredential(responseCredential);
      if (!credential) {
        throw new TempoError(
          TempoStatusCode.INVALID_ARGUMENT,
          "unable to parse credentials received on 'tempo-credential' header",
        );
      }
      await this.credential.storeCredential(credential);
    }
  }

  public async waitForOpen(): Promise<void> {
    if (this.ws.readyState === 1) return;
    await Deadline.after(5, "seconds").executeWithinDeadline(
      () =>
        new Promise((resolve, reject) => {
          this.ws.addEventListener(WebsocketEvent.open, resolve);
          this.ws.addEventListener(WebsocketEvent.error, reject);
        }),
    );
  }

  public send(message: Message) {
    this.ws.send(Message.encode(message));
  }

  /**
   * {@inheritDoc BaseChannel.startUnary}
   */
  public override async startUnary<TRequest extends BebopRecord, TResponse extends BebopRecord>(
    request: TRequest,
    context: ClientContext,
    method: MethodInfo<TRequest, TResponse>,
    options?: CallOptions  ,
  ): Promise<TResponse> {
    try {
      await this.waitForOpen();
      // Prepare request data based on content type
      const requestData: Uint8Array = method.serialize(request);
      if (this.hooks !== undefined) {
        await this.hooks.executeRequestHooks(context);
      }
      const requestInit = await this.createRequest(requestData, context, method, options);
      let response: Message;
      // If the retry policy is set, execute the request with retries
      if (options?.retryPolicy) {
        response = await this.executeWithRetry(
          async (retryAttempt: number) => {
            if (retryAttempt > 0) {
              requestInit.previousAttempts = retryAttempt;
            }
            return await this.fetchUnary(requestInit);
          },
          options.retryPolicy,
          options.deadline,
          options.controller,
        );
        // If the deadline is set, execute the request within the deadline
      } else if (options?.deadline) {
        response = await options.deadline.executeWithinDeadline(async () => {
          return await this.fetchUnary(requestInit, options);
        }, options.controller);
      } else {
        // Otherwise, just execute the request indefinitely
        response = await this.fetchUnary(requestInit, options);
      }
      // Validate response headers
      await this.processResponseHeaders(response, context, method.type);
      if (this.hooks !== undefined) {
        await this.hooks.executeResponseHooks(context);
      }
      // Deserialize the response based on the content type
      const record: TResponse = method.deserialize(response.data!);
      if (this.hooks !== undefined) {
        await this.hooks.executeDecodeHooks(context, record);
      }
      // Return the deserialized response object
      return record;
    } catch (e) {
      if (this.hooks !== undefined && e instanceof Error) {
        this.hooks.executeErrorHooks(context, e);
      }
      if (e instanceof TempoError) {
        throw e;
      }
      if (e instanceof Error) {
        if (e.name === "AbortError") {
          throw new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", e);
        } else {
          throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", e);
        }
      }
      throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", { data: e });
    }
  }

  /**
   * {@inheritDoc BaseChannel.startClientStream}
   */
  public override async startClientStream<
    TRequest extends BebopRecord,
    TResponse extends BebopRecord,
  >(
    generator: () => AsyncGenerator<TRequest, void, undefined>,
    context: ClientContext,
    method: MethodInfo<TRequest, TResponse>,
    options?: CallOptions  ,
  ): Promise<TResponse> {
    try {
      await this.waitForOpen();
      if (this.hooks !== undefined) {
        await this.hooks.executeRequestHooks(context);
      }
      const requestInit = await this.createRequest(new Uint8Array(), context, method, options);
      let response: Message;
      if (options?.deadline) {
        response = await options.deadline.executeWithinDeadline(async () => {
          return await this.fetchClientStream(requestInit, method, generator, options);
        }, options.controller);
      } else {
        // Otherwise, just execute the request indefinitely
        response = await this.fetchClientStream(requestInit, method, generator, options);
      }
      // Validate response headers
      await this.processResponseHeaders(response, context, method.type);
      // Deserialize the response based on the content type
      const record: TResponse = this.deserializeResponse(response.data!, method);
      if (this.hooks !== undefined) {
        await this.hooks.executeDecodeHooks(context, record);
      }
      // Return the deserialized response object
      return record;
    } catch (e) {
      if (this.hooks !== undefined && e instanceof Error) {
        this.hooks.executeErrorHooks(context, e);
      }
      if (e instanceof TempoError) {
        throw e;
      }
      if (e instanceof Error) {
        if (e.name === "AbortError") {
          throw new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", e);
        } else {
          throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", e);
        }
      }
      throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", { data: e });
    }
  }
  /**
   * {@inheritDoc BaseChannel.startServerStream}
   */
  public override async startServerStream<
    TRequest extends BebopRecord,
    TResponse extends BebopRecord,
  >(
    request: TRequest,
    context: ClientContext,
    method: MethodInfo<TRequest, TResponse>,
    options?: CallOptions  ,
  ): Promise<AsyncGenerator<TResponse, void, undefined>> {
    try {
      await this.waitForOpen();
      // Prepare request data based on content type
      const requestData: Uint8Array = method.serialize(request);
      if (this.hooks !== undefined) {
        await this.hooks.executeRequestHooks(context);
      }
      const requestInit = await this.createRequest(requestData, context, method, options);
      let response: AsyncGenerator<BebopRecord, void, undefined>;
      // If the retry policy is set, execute the request with retries
      if (options?.retryPolicy) {
        response = await this.executeWithRetry(
          async (retryAttempt: number) => {
            if (retryAttempt > 0) {
              requestInit.previousAttempts = retryAttempt;
            }
            // todo this.fetchStreams returns readablestream
            return await this.fetchServerStream(requestInit, context, method, options);
          },
          options.retryPolicy,
          options.deadline,
          options.controller,
        );
        // If the deadline is set, execute the request within the deadline
      } else if (options?.deadline) {
        response = await options.deadline.executeWithinDeadline(async () => {
          return await this.fetchServerStream(requestInit, context, method, options);
        }, options.controller);
      } else {
        // Otherwise, just execute the request indefinitely
        response = this.fetchServerStream(requestInit, context, method, options);
      }
      return response as AsyncGenerator<TResponse, void, undefined>;
    } catch (e) {
      if (this.hooks !== undefined && e instanceof Error) {
        this.hooks.executeErrorHooks(context, e);
      }
      if (e instanceof TempoError) {
        throw e;
      }
      if (e instanceof Error) {
        if (e.name === "AbortError") {
          throw new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", e);
        } else {
          throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", e);
        }
      }
      throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", { data: e });
    }
  }
  /**
   * {@inheritDoc BaseChannel.startDuplexStream}
   */
  public override async startDuplexStream<
    TRequest extends BebopRecord,
    TResponse extends BebopRecord,
  >(
    generator: () => AsyncGenerator<TRequest, void, undefined>,
    context: ClientContext,
    method: MethodInfo<TRequest, TResponse>,
    options?: CallOptions  ,
  ): Promise<AsyncGenerator<TResponse, void, undefined>> {
    try {
      await this.waitForOpen();
      if (this.hooks !== undefined) {
        await this.hooks.executeRequestHooks(context);
      }
      const requestInit = await this.createRequest(new Uint8Array(), context, method, options);
      let response: AsyncGenerator<BebopRecord, void, undefined>;
      if (options?.deadline) {
        response = await options.deadline.executeWithinDeadline(async () => {
          return await this.fetchDuplexStream(requestInit, context, method, generator, options);
        }, options.controller);
      } else {
        // Otherwise, just execute the request indefinitely
        response = this.fetchDuplexStream(requestInit, context, method, generator, options);
      }
      // Validate response headers
      return response as AsyncGenerator<TResponse, void, undefined>;
    } catch (e) {
      if (this.hooks !== undefined && e instanceof Error) {
        this.hooks.executeErrorHooks(context, e);
      }
      if (e instanceof TempoError) {
        throw e;
      }
      if (e instanceof Error) {
        if (e.name === "AbortError") {
          throw new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", e);
        } else {
          throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", e);
        }
      }
      throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", { data: e });
    }
  }
}
