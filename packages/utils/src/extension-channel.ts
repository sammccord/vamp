import {
  BaseChannel,
  type CallOptions,
  type ClientContext,
  type MethodInfo,
  type RetryPolicy,
  type TempoChannelOptions,
} from "@tempojs/client";
import {
  type BebopContentType,
  ConsoleLogger,
  type Credential,
  type Deadline,
  ExecutionEnvironment,
  Metadata,
  type MethodType,
  TempoError,
  TempoStatusCode,
  TempoUtil,
  TempoVersion,
} from "@tempojs/common";
import { Message } from "./bebop";
import type { BebopRecord } from "bebop";
import { EventEmitter } from "tseep";
import * as browser from "webextension-polyfill";
import { createDuplexIterator } from "./create-duplex-iterator";
import { createEventIterator } from "./create-event-iterator";

/**
 * Represents a Tempo channel for communication with a remote server.
 */
export class TempoExtensionChannel extends BaseChannel {
  public static readonly defaultMaxRetryAttempts: number = 5;
  public static readonly defaultMaxReceiveMessageSize: number = 1024 * 1024 * 4; // 4 MB
  public static readonly defaultMaxSendMessageSize: number = 1024 * 1024 * 4; // 4 MB
  public static readonly defaultContentType: BebopContentType = "bebop";

  private readonly events = new EventEmitter<Record<string, (message: Message) => void>>();
  private readonly userAgent: string;
  // Reject callbacks for in-flight unary / client-stream calls, keyed by messageId.
  public readonly pending = new Map<string, (e: unknown) => void>();
  private closed = false;

  // Stored so close() can remove it; guards decode so foreign/malformed runtime
  // traffic is dropped instead of throwing synchronously inside the listener.
  private readonly onMessage = (msg: unknown): Promise<void> => {
    let message: Message;
    try {
      message = Message(Message.decode(new Uint8Array(msg as number[])));
    } catch (e) {
      this.logger.warn("dropping undecodable runtime message", {}, e as Error);
      return Promise.resolve();
    }
    if (message.messageId) {
      this.events.emit(message.messageId, message);
      this.logger.debug(`received new message ${message.messageId}`);
    }
    return Promise.resolve();
  };

  /**
   * Constructs a new TempoChannel instance.
   *
   * @param {URL} target - The target URL for the channel.
   * @param {TempoWSChannelOptions} options - The configuration options for the channel.
   * @protected
   */
  constructor(options: TempoChannelOptions = {}) {
    super(
      new URL("runtime://"),
      options.logger ?? new ConsoleLogger("TempoExtensionChannel"),
      options.contentType ?? TempoExtensionChannel.defaultContentType,
    );
    this.logger.trace("creating new TempoExtensionChannel");
    this.userAgent = TempoUtil.buildUserAgent("javascript", TempoVersion, undefined, {
      runtime: TempoUtil.getEnvironmentName(),
    });

    browser.runtime.onMessage.addListener(this.onMessage);

    this.logger.debug(`created new TempoExtensionChannel`);
  }

  /**
   * Tear down the channel: remove the runtime message listener, reject every
   * in-flight call, and clear all event listeners. Idempotent.
   */
  public close(reason?: TempoError): void {
    if (this.closed) return;
    this.closed = true;
    try {
      browser.runtime.onMessage.removeListener(this.onMessage);
    } catch {
      /* listener already gone */
    }
    const err = reason ?? new TempoError(TempoStatusCode.CANCELLED, "channel disposed");
    for (const reject of this.pending.values()) reject(err);
    this.pending.clear();
    this.events.removeAllListeners();
  }

  public override async removeCredential(): Promise<void> {
    void 0;
  }
  public override async getCredential(): Promise<Credential | undefined> {
    return undefined;
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
    const messageId = init.messageId!;
    let listener!: (message: Message) => void;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      this.events.off(messageId, listener);
      if (onAbort) options?.controller?.signal.removeEventListener("abort", onAbort);
      this.pending.delete(messageId);
    };
    const promise = new Promise<Message>((resolve, reject) => {
      listener = (message: Message) => resolve(message);
      this.pending.set(messageId, reject);
      if (options?.controller) {
        onAbort = () => reject(new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {}));
        options.controller.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.events.on(messageId, listener);
      this.sendMessage(init).catch(reject);
    });
    return await promise.finally(cleanup);
  }

  // should loop over generator, send all, and resolve on one response
  private async fetchClientStream(
    init: Message,
    method: MethodInfo<BebopRecord, BebopRecord>,
    generator: () => AsyncGenerator<BebopRecord, void, undefined>,
    options?: CallOptions,
  ): Promise<Message> {
    const messageId = init.messageId!;
    let listener!: (message: Message) => void;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      this.events.off(messageId, listener);
      if (onAbort) options?.controller?.signal.removeEventListener("abort", onAbort);
      this.pending.delete(messageId);
    };
    const promise = new Promise<Message>((resolve, reject) => {
      listener = (message: Message) => resolve(message);
      this.pending.set(messageId, reject);
      if (options?.controller) {
        onAbort = () => reject(new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {}));
        options.controller.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.events.on(messageId, listener);
      runGenerator.call(this).catch(reject);
      async function runGenerator(this: TempoExtensionChannel) {
        // Fresh Message per frame, and AWAIT each send so concurrent un-awaited
        // sends cannot serialize an overwritten payload (shared-`init` race).
        for await (const value of generator()) {
          await this.sendMessage(Message({ ...init, data: method.serialize(value) }));
        }
        await this.sendMessage(
          Message({ ...init, status: TempoStatusCode.CANCELLED, data: new Uint8Array() }),
        );
      }
    });
    return await promise.finally(cleanup);
  }

  // should send message, then return a createEventIterator from incoming events, stopping on CANCEL
  // TODO should cancel on server side when done?
  private fetchServerStream(
    init: Message,
    context: ClientContext,
    method: MethodInfo<BebopRecord, BebopRecord>,
    options?: CallOptions,
  ): AsyncGenerator<BebopRecord, void, undefined> {
    const messageId = init.messageId!;
    return createEventIterator<BebopRecord>(({ emit, cancel, error }) => {
      let terminated = false;
      let onAbort: (() => void) | undefined;
      const eventHandler = async (message: Message) => {
        try {
          if (message.status === TempoStatusCode.CANCELLED) {
            terminated = true;
            cancel();
            return;
          }
          this.processResponseHeaders(message, context, method.type);
          const responseData = message.data!;
          const record = method.deserialize(responseData);
          if (this.hooks !== undefined) {
            await this.hooks.executeDecodeHooks(context, record);
          }
          emit(record);
        } catch (e) {
          error(e);
        }
      };
      if (options?.controller) {
        onAbort = () => error(new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {}));
        options.controller.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.events.on(messageId, eventHandler);
      void this.sendMessage(init);
      return () => {
        this.events.off(messageId, eventHandler);
        if (onAbort) options?.controller?.signal.removeEventListener("abort", onAbort);
        // Tell the server to stop streaming (fresh message — never mutate init).
        if (terminated || this.closed) return;
        void this.sendMessage(
          Message({
            messageId,
            methodId: init.methodId,
            status: TempoStatusCode.CANCELLED,
            data: new Uint8Array(),
            timestamp: new Date(),
          }),
        );
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
        void this.sendMessage(Message({ ...init, data: method.serialize(value) }));
      },
      ({ emit, cancel, error }) => {
        let onAbort: (() => void) | undefined;
        const eventHandler = async (message: Message) => {
          try {
            if (message.status === TempoStatusCode.CANCELLED) {
              cancel();
              return;
            }
            this.processResponseHeaders(message, context, method.type);
            const requestData = message.data!;
            const record = method.deserialize(requestData);
            if (this.hooks !== undefined) {
              await this.hooks.executeDecodeHooks(context, record);
            }
            emit(record);
          } catch (e) {
            error(e);
          }
        };
        if (options?.controller) {
          onAbort = () => error(new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {}));
          options.controller.signal.addEventListener("abort", onAbort, { once: true });
        }
        this.events.on(messageId, eventHandler);
        return () => {
          this.events.off(messageId, eventHandler);
          if (onAbort) options?.controller?.signal.removeEventListener("abort", onAbort);
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
  private createRequest(
    payload: Uint8Array,
    _context: ClientContext,
    method: MethodInfo<BebopRecord, BebopRecord>,
    options?: CallOptions,
  ): Message {
    const customMetadata = new Metadata();
    customMetadata.set("path", `/${method.service}/${method.name}`);
    customMetadata.set("service-name", method.service);
    // we can't modify the useragent in browsers, so use x-user-agent instead
    if (ExecutionEnvironment.isBrowser || ExecutionEnvironment.isWebWorker) {
      customMetadata.set("x-user-agent", this.userAgent);
    } else {
      customMetadata.set("user-agent", this.userAgent);
    }
    const requestInit: Message = {
      messageId: crypto.randomUUID(),
      methodId: method.id,
      data: new Uint8Array(payload),
      timestamp: new Date(),
    };
    if (options?.deadline) {
      requestInit.deadline = new Date(options.deadline.toUnixTimestamp());
    }
    return requestInit;
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
  private processResponseHeaders(
    response: Message,
    _context: ClientContext,
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
  }

  /**
   * {@inheritDoc BaseChannel.startUnary}
   */
  public override async startUnary<TRequest extends BebopRecord, TResponse extends BebopRecord>(
    request: TRequest,
    context: ClientContext,
    method: MethodInfo<TRequest, TResponse>,
    options?: CallOptions,
  ): Promise<TResponse> {
    try {
      // Prepare request data based on content type
      const requestData: Uint8Array = method.serialize(request);
      if (this.hooks !== undefined) {
        await this.hooks.executeRequestHooks(context);
      }
      const requestInit = this.createRequest(requestData, context, method, options);
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
      this.processResponseHeaders(response, context, method.type);
      if (this.hooks !== undefined) {
        await this.hooks.executeResponseHooks(context);
      }
      // Deserialize the response based on the content type
      const responseData = response.data!;
      const record: TResponse = method.deserialize(responseData);
      if (this.hooks !== undefined) {
        await this.hooks.executeDecodeHooks(context, record);
      }
      // Return the deserialized response object
      return record;
    } catch (e) {
      if (this.hooks !== undefined && e instanceof Error) {
        void this.hooks.executeErrorHooks(context, e);
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
    options?: CallOptions,
  ): Promise<TResponse> {
    try {
      if (this.hooks !== undefined) {
        await this.hooks.executeRequestHooks(context);
      }
      const requestInit = this.createRequest(new Uint8Array(), context, method, options);
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
      this.processResponseHeaders(response, context, method.type);
      // Deserialize the response based on the content type
      const responseData = response.data!;
      const record: TResponse = this.deserializeResponse(responseData, method);
      if (this.hooks !== undefined) {
        void this.hooks.executeDecodeHooks(context, record);
      }
      // Return the deserialized response object
      return record;
    } catch (e) {
      if (this.hooks !== undefined && e instanceof Error) {
        void this.hooks.executeErrorHooks(context, e);
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
    options?: CallOptions,
  ): Promise<AsyncGenerator<TResponse, void, undefined>> {
    try {
      // Prepare request data based on content type
      const requestData: Uint8Array = method.serialize(request);
      if (this.hooks !== undefined) {
        await this.hooks.executeRequestHooks(context);
      }
      const requestInit = this.createRequest(requestData, context, method, options);
      let response: AsyncGenerator<BebopRecord, void, undefined>;
      // If the retry policy is set, execute the request with retries
      if (options?.retryPolicy) {
        response = await this.executeWithRetry(
          async (retryAttempt: number) => {
            if (retryAttempt > 0) {
              requestInit.previousAttempts = retryAttempt;
            }
            // todo this.fetchStreams returns readablestream
            return this.fetchServerStream(requestInit, context, method, options);
          },
          options.retryPolicy,
          options.deadline,
          options.controller,
        );
        // If the deadline is set, execute the request within the deadline
      } else if (options?.deadline) {
        response = await options.deadline.executeWithinDeadline(async () => {
          return this.fetchServerStream(requestInit, context, method, options);
        }, options.controller);
      } else {
        // Otherwise, just execute the request indefinitely
        response = this.fetchServerStream(requestInit, context, method, options);
      }
      return response as AsyncGenerator<TResponse, void, undefined>;
    } catch (e) {
      if (this.hooks !== undefined && e instanceof Error) {
        void this.hooks.executeErrorHooks(context, e);
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
    options?: CallOptions,
  ): Promise<AsyncGenerator<TResponse, void, undefined>> {
    try {
      if (this.hooks !== undefined) {
        await this.hooks.executeRequestHooks(context);
      }
      const requestInit = this.createRequest(new Uint8Array(), context, method, options);
      let response: AsyncGenerator<BebopRecord, void, undefined>;
      if (options?.deadline) {
        response = await options.deadline.executeWithinDeadline(async () => {
          return this.fetchDuplexStream(requestInit, context, method, generator, options);
        }, options.controller);
      } else {
        // Otherwise, just execute the request indefinitely
        response = this.fetchDuplexStream(requestInit, context, method, generator, options);
      }
      // Validate response headers
      return response as AsyncGenerator<TResponse, void, undefined>;
    } catch (e) {
      if (this.hooks !== undefined && e instanceof Error) {
        void this.hooks.executeErrorHooks(context, e);
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

  protected sendMessage(message: Message) {
    return browser.runtime.sendMessage(
      Array.apply(null, Message.encode(message) as unknown as number[]),
    );
  }
}
