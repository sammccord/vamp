import {
  type CallCredential,
  InsecureChannelCredential,
  type TempoChannelOptions,
} from "@tempojs/client";
import { type BebopContentType, ConsoleLogger, TempoError, TempoStatusCode } from "@tempojs/common";
import { Message } from "./bebop";
import { CoreChannel } from "./channel-core";

/**
 * Represents a Tempo channel for communication with a worker thread.
 */
export class TempoWorkerChannel extends CoreChannel {
  public static readonly defaultMaxRetryAttempts: number = 5;
  public static readonly defaultCredential: CallCredential = InsecureChannelCredential.create();
  public static readonly defaultContentType: BebopContentType = "bebop";

  private readonly _worker: Bun.Worker;
  private _open = false;
  private _ready: Promise<void>;
  private _resolveReady?: () => void;
  private _rejectReady?: (e: unknown) => void;

  public get worker() {
    return this._worker;
  }

  public get ready() {
    return this._ready;
  }

  /**
   * Constructs a new TempoChannel instance.
   *
   * @param {URL} target - The target URL for the channel.
   * @param {TempoChannelOptions} options - The configuration options for the channel.
   * @protected
   */
  constructor(url: string, options: TempoChannelOptions = {}) {
    super(
      new URL(url, "worker://"),
      options.logger ?? new ConsoleLogger("TempoWorkerChannel"),
      options.contentType ?? TempoWorkerChannel.defaultContentType,
    );
    this.logger.trace("creating new TempoWorkerChannel");

    // Create ready promise before worker starts
    this._ready = new Promise<void>((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    // Avoid an unhandled rejection if `ready` is never awaited but the worker dies.
    this._ready.catch(() => {});

    const worker = (this._worker = new Worker(url) as Bun.Worker);
    //@ts-expect-error
    worker.addEventListener("message", (ev: MessageEvent<Uint8Array>) => {
      const resolveReadyOnce = () => {
        if (!this._open) {
          this._open = true;
          this._resolveReady?.();
        }
      };
      if (!ev.data.length) {
        resolveReadyOnce(); // legacy empty-frame readiness ping
        return;
      }
      const message = Message.decode(ev.data);
      // Explicit readiness handshake: a dedicated sentinel frame means "the
      // worker runtime is fully constructed and can accept RPCs". Preferred over
      // inferring readiness from the first real response. The first frame still
      // resolves `ready` as a legacy fallback for un-upgraded worker hosts.
      if (message.messageId === "__ready__") {
        resolveReadyOnce();
        return;
      }
      resolveReadyOnce();
      if (!message.methodId) {
        // Reserved control-frame space; ignore (do not treat as a response)
        // instead of silently dropping with no trace.
        this.logger.trace("ignoring control frame without methodId");
        return;
      }
      const messageId = message.messageId!;
      this.logger.trace(`received new message ${messageId}`);
      this.events.emit(messageId, message);
    });
    worker.addEventListener("open", (e) => {
      this.logger.trace(`opened TempoWorkerChannel for ${url} / ${this.userAgent}`, { event: e });
    });
    worker.addEventListener("close", (e) => {
      this.logger.trace(`closed TempoWorkerChannel for ${url} / ${this.userAgent}`, { event: e });
      this.close(new TempoError(TempoStatusCode.UNAVAILABLE, "channel closed"));
    });
    worker.addEventListener("error", () => {
      this.close(new TempoError(TempoStatusCode.UNAVAILABLE, "channel transport error"));
    });
    this.logger.debug(`created new TempoWorkerChannel`);
  }

  /** Reject a pending `ready` before in-flight calls are settled. */
  protected override onClosing(reason: TempoError): void {
    this._rejectReady?.(reason);
  }

  /** Terminate the owned worker on {@link CoreChannel.close}. */
  protected override closeTransport(): void {
    try {
      this._worker.terminate();
    } catch {
      /* already terminated */
    }
  }

  protected override generateMessageId(): string {
    return Bun.randomUUIDv7();
  }

  /**
   * {@inheritDoc CoreChannel.sendFrame}
   *
   * `.slice()` owns a fresh ArrayBuffer; transferring it cannot detach bebop's
   * process-wide singleton write buffer.
   */
  protected override sendFrame(message: Message): void {
    const frame = Message.encode(message).slice();
    this._worker.postMessage(frame, [frame.buffer]);
  }
}
