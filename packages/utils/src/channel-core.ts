import {
  BaseChannel,
  type CallOptions,
  type ClientContext,
  type MethodInfo,
  type RetryPolicy,
} from "@tempojs/client";
import {
  type BebopContentType,
  type Credential,
  type Deadline,
  type MethodType,
  TempoError,
  type TempoLogger,
  TempoStatusCode,
  TempoUtil,
  TempoVersion,
} from "@tempojs/common";
import type { BebopRecord } from "bebop";
import { EventEmitter } from "tseep";
import { Message } from "./bebop";
import { createDuplexIterator } from "./create-duplex-iterator";
import { createEventIterator } from "./create-event-iterator";

/**
 * Shared client-channel core for the worker, WebSocket, and browser-extension
 * transports.
 *
 * All three transports speak the same framed protocol: each request is a
 * {@link Message} envelope matched to its response(s) by `messageId`, streamed
 * frames reuse the envelope with fresh `data`, and a `CANCELLED` status frame
 * terminates a stream. This class owns the protocol machinery — request
 * construction, retry/deadline handling, response validation, the four RPC
 * shapes (unary / client-stream / server-stream / duplex) and teardown —
 * while subclasses supply only the genuinely transport-specific pieces via the
 * small protected surface ({@link sendFrame} et al).
 *
 * Internal to `@vampgg/utils`; the public transports are the concrete
 * subclasses (`TempoWorkerChannel`, `TempoWSChannel`, `TempoExtensionChannel`).
 */
export abstract class CoreChannel extends BaseChannel {
  /** Per-call response listeners keyed by messageId (response demultiplexing). */
  public readonly events = new EventEmitter<Record<string, (message: Message) => void>>();
  /**
   * Reject callbacks for in-flight unary / client-stream calls, keyed by
   * messageId. Lets close()/error() settle parked requests instead of hanging.
   */
  public readonly pending = new Map<string, (e: unknown) => void>();
  protected closed = false;
  /** The reason a closed channel settles calls that arrive after teardown. */
  protected closeReason?: TempoError;
  protected readonly userAgent: string;

  protected constructor(target: URL, logger: TempoLogger, contentType: BebopContentType) {
    super(target, logger, contentType);
    this.userAgent = TempoUtil.buildUserAgent("javascript", TempoVersion, undefined, {
      runtime: TempoUtil.getEnvironmentName(),
    });
  }

  // ---------------------------------------------------------------------
  // Transport surface — the only pieces a concrete transport implements.
  // ---------------------------------------------------------------------

  /**
   * Encodes and delivers one {@link Message} frame over the transport. May be
   * synchronous (worker / WebSocket) or asynchronous (extension runtime); the
   * call sites await or attach rejection handlers as each RPC shape requires.
   */
  protected abstract sendFrame(message: Message): void | Promise<unknown>;

  /** Generates the unique id for an outgoing request envelope. */
  protected generateMessageId(): string {
    return crypto.randomUUID();
  }

  /**
   * Serializes one streamed record into the bytes placed on `Message.data`.
   * The default copies out of bebop's shared static write buffer so a later
   * encode cannot clobber the payload; a transport whose {@link sendFrame}
   * consumes the bytes synchronously may override to skip the copy.
   */
  protected serializeStreamItem(
    method: MethodInfo<BebopRecord, BebopRecord>,
    value: BebopRecord,
  ): Uint8Array {
    return new Uint8Array(method.serialize(value));
  }

  /** Awaited before every RPC (e.g. the WebSocket transport's open gate). */
  protected async beforeCall(): Promise<void> {}

  /** Value for the request `authorization` field, if the transport has one. */
  protected async getAuthorizationValue(): Promise<string | undefined> {
    return undefined;
  }

  /**
   * Persists a `credential` value received on a response envelope. The default
   * ignores it (the worker/extension transports carry no credentials).
   */
  protected async storeResponseCredential(_credential: string): Promise<void> {}

  /**
   * Whether tearing down a duplex-stream consumer sends a terminal CANCELLED
   * frame to the server (the WebSocket transport does; the others do not).
   */
  protected readonly cancelDuplexOnCleanup: boolean = false;

  /** Runs inside {@link close} before in-flight calls are rejected. */
  protected onClosing(_reason: TempoError): void {}

  /** Runs at the end of {@link close} to tear down the underlying transport. */
  protected closeTransport(): void {}

  // ---------------------------------------------------------------------
  // Shared machinery.
  // ---------------------------------------------------------------------

  /**
   * Tear down the channel: reject every in-flight unary/client-stream call,
   * remove all event listeners, and dispose the underlying transport.
   * Idempotent and safe to invoke from transport close/error events or by an
   * explicit caller.
   */
  public close(reason?: TempoError): void {
    if (this.closed) return;
    this.closed = true;
    const err = reason ?? new TempoError(TempoStatusCode.CANCELLED, "channel disposed");
    this.closeReason = err;
    this.onClosing(err);
    for (const reject of this.pending.values()) reject(err);
    this.pending.clear();
    this.events.removeAllListeners();
    this.closeTransport();
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

  protected async fetchUnary(init: Message, options?: CallOptions): Promise<Message> {
    const messageId = init.messageId!;
    let listener!: (message: Message) => void;
    let onAbort: (() => void) | undefined;
    // Single idempotent cleanup runs on EVERY settlement (resolve, reject,
    // abort, timeout/deadline) via .finally, so listeners and pending entries
    // never leak.
    const cleanup = () => {
      this.events.off(messageId, listener);
      if (onAbort) options?.controller?.signal.removeEventListener("abort", onAbort);
      this.pending.delete(messageId);
    };
    const promise = new Promise<Message>((resolve, reject) => {
      // The channel may have been torn down between the caller starting the RPC
      // and this registration (request construction awaits); settle immediately
      // instead of parking a request no close() can ever reject again.
      if (this.closed) {
        reject(this.closeReason ?? new TempoError(TempoStatusCode.CANCELLED, "channel disposed"));
        return;
      }
      listener = (message: Message) => resolve(message);
      this.pending.set(messageId, reject); // close()/error() can reject a parked request
      if (options?.controller) {
        onAbort = () => reject(new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {}));
        options.controller.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.events.on(messageId, listener);
      // A synchronous send failure rejects via the executor throw; an async
      // send failure is routed to reject explicitly.
      const sent = this.sendFrame(init);
      if (sent instanceof Promise) sent.catch(reject);
    });
    return await promise.finally(cleanup);
  }

  // Loops over the generator, sends every frame, and resolves on one response.
  protected async fetchClientStream(
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
      // See fetchUnary: never park a call on a channel that already closed.
      if (this.closed) {
        reject(this.closeReason ?? new TempoError(TempoStatusCode.CANCELLED, "channel disposed"));
        return;
      }
      listener = (message: Message) => resolve(message);
      this.pending.set(messageId, reject);
      if (options?.controller) {
        onAbort = () => reject(new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {}));
        options.controller.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.events.on(messageId, listener);
      // A generator-side failure must settle (and therefore clean up) the call
      // rather than hang waiting for a server response that will never come.
      runGenerator.call(this).catch(reject);
      async function runGenerator(this: CoreChannel) {
        // Fresh Message per frame (never mutate the shared `init`) so concurrent
        // sends cannot alias and a terminal CANCELLED cannot leak into a later
        // frame. Each send is AWAITED so an async transport cannot serialize an
        // overwritten payload (shared write-buffer race).
        for await (const value of generator()) {
          await this.sendFrame(Message({ ...init, data: this.serializeStreamItem(method, value) }));
        }
        await this.sendFrame(
          Message({ ...init, status: TempoStatusCode.CANCELLED, data: new Uint8Array() }),
        );
      }
    });
    return await promise.finally(cleanup);
  }

  // Sends the request, then returns a createEventIterator over incoming
  // events, stopping on a CANCELLED status frame.
  protected fetchServerStream(
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
            terminated = true; // server ended the stream; do not echo CANCELLED back
            cancel();
            return;
          }
          await this.processResponseHeaders(message, context, method.type);
          const record = method.deserialize(message.data!);
          if (this.hooks !== undefined) {
            await this.hooks.executeDecodeHooks(context, record);
          }
          emit(record);
        } catch (e) {
          // Surface transport/decode failures at the consumer instead of letting
          // the EventEmitter swallow them.
          error(e);
        }
      };
      if (options?.controller) {
        // Route abort through the iterator error channel; never throw inside a listener.
        onAbort = () => error(new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", {}));
        options.controller.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.events.on(messageId, eventHandler);
      void this.sendFrame(init);
      return () => {
        this.events.off(messageId, eventHandler);
        if (onAbort) options?.controller?.signal.removeEventListener("abort", onAbort);
        if (terminated || this.closed) return;
        // Tell the server to stop streaming (fresh message — never mutate init).
        void this.sendFrame(
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

  // Combines the client- and server-stream halves over one messageId.
  protected fetchDuplexStream(
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
        // Fresh Message per frame; never mutate the shared `init`.
        void this.sendFrame(Message({ ...init, data: this.serializeStreamItem(method, value) }));
      },
      ({ emit, cancel, error }) => {
        let terminated = false;
        let onAbort: (() => void) | undefined;
        const eventHandler = async (message: Message) => {
          try {
            if (message.status === TempoStatusCode.CANCELLED) {
              terminated = true;
              cancel();
              return;
            }
            await this.processResponseHeaders(message, context, method.type);
            const record = method.deserialize(message.data!);
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
          if (this.cancelDuplexOnCleanup && !terminated && !this.closed) {
            void this.sendFrame(
              Message({
                messageId,
                methodId: init.methodId,
                status: TempoStatusCode.CANCELLED,
                data: new Uint8Array(),
                timestamp: new Date(),
              }),
            );
          }
        };
      },
    );

    return iterator;
  }

  /**
   * Creates the request {@link Message} envelope for a given payload, context,
   * method and optional call options.
   *
   * @param {Uint8Array} payload - The payload to be sent in the request.
   * @param {ClientContext} context - The context of the client making the request.
   * @param {MethodInfo<BebopRecord, BebopRecord>} method - Information about the method being called.
   * @param {CallOptions | undefined} options - Optional configuration for the call.
   * @returns {Promise<Message>} A Promise resolving to the created request envelope.
   * @throws {TempoError} Throws an error if there's a problem while getting the credential header.
   */
  protected async createRequest(
    payload: Uint8Array,
    _context: ClientContext,
    method: MethodInfo<BebopRecord, BebopRecord>,
    options?: CallOptions,
  ): Promise<Message> {
    const requestInit: Message = {
      messageId: this.generateMessageId(),
      methodId: method.id,
      // `method.serialize` returns a view into bebop's shared static write
      // buffer; the subsequent `Message.encode` (in `sendFrame`) reuses that
      // same buffer and would clobber these bytes before they reach the wire.
      // Copy the payload so the framed envelope is stable.
      data: new Uint8Array(payload),
      timestamp: new Date(),
    };
    if (options?.deadline) {
      requestInit.deadline = new Date(options.deadline.toUnixTimestamp());
    }
    const authorization = await this.getAuthorizationValue();
    if (authorization !== undefined) {
      requestInit.authorization = authorization;
    }
    return Message(requestInit);
  }

  /**
   * Processes the headers of the response from the server, validating their
   * integrity and correctness, and hands any received credential to the
   * transport via {@link storeResponseCredential}.
   *
   * @param {Message} response - The response received from the server.
   * @param {ClientContext} context - The context of the client making the request.
   * @param {MethodType} methodType - The type of method being called.
   * @throws {TempoError} Throws an error if any validation checks fail or if there's a problem parsing or storing credentials.
   */
  protected async processResponseHeaders(
    response: Message,
    _context: ClientContext,
    _methodType: MethodType,
  ): Promise<void> {
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

    // Hand a received credential to the transport (no-op by default).
    const responseCredential = response.credential;
    if (responseCredential) {
      await this.storeResponseCredential(responseCredential);
    }
  }

  /**
   * Runs the shared error-hook + error-mapping tail of every `start*` method.
   * Always throws.
   */
  private async raiseCallError(context: ClientContext, e: unknown): Promise<never> {
    if (this.hooks !== undefined && e instanceof Error) {
      await this.hooks.executeErrorHooks(context, e);
    }
    if (e instanceof TempoError) {
      throw e;
    }
    if (e instanceof Error) {
      if (e.name === "AbortError") {
        throw new TempoError(TempoStatusCode.ABORTED, "RPC fetch aborted", e);
      }
      throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", e);
    }
    throw new TempoError(TempoStatusCode.UNKNOWN, "an unknown error occurred", { data: e });
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
      await this.beforeCall();
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
      return await this.raiseCallError(context, e);
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
      await this.beforeCall();
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
      return await this.raiseCallError(context, e);
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
      await this.beforeCall();
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
      return await this.raiseCallError(context, e);
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
      await this.beforeCall();
      if (this.hooks !== undefined) {
        await this.hooks.executeRequestHooks(context);
      }
      const requestInit = await this.createRequest(new Uint8Array(), context, method, options);
      let response: AsyncGenerator<BebopRecord, void, undefined>;
      if (options?.deadline) {
        response = await options.deadline.executeWithinDeadline(async () => {
          return this.fetchDuplexStream(requestInit, context, method, generator, options);
        }, options.controller);
      } else {
        // Otherwise, just execute the request indefinitely
        response = this.fetchDuplexStream(requestInit, context, method, generator, options);
      }
      return response as AsyncGenerator<TResponse, void, undefined>;
    } catch (e) {
      return await this.raiseCallError(context, e);
    }
  }
}
