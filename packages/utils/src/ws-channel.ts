import {
  type CallCredential,
  InsecureChannelCredential,
  type TempoChannelOptions,
} from "@tempojs/client";
import {
  type BebopContentType,
  ConsoleLogger,
  type Credential,
  Deadline,
  parseCredential,
  TempoError,
  TempoStatusCode,
} from "@tempojs/common";
import { Websocket, WebsocketEvent, type WebsocketOptions } from "websocket-ts";
import { Message } from "./bebop";
import { CoreChannel } from "./channel-core";

export type TempoWSChannelOptions = TempoChannelOptions & {
  binaryType?: BinaryType;
} & WebsocketOptions;

//@ts-expect-error
class ExistingWebSocket extends Websocket {
  constructor(ws: WebSocket, protocols?: string | string[], options?: WebsocketOptions) {
    super(ws.url, protocols, options);
    //@ts-expect-error
    this._underlyingWebsocket = ws;
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
export class TempoWSChannel extends CoreChannel {
  public static readonly defaultMaxRetryAttempts: number = 5;
  public static readonly defaultMaxReceiveMessageSize: number = 1024 * 1024 * 4; // 4 MB
  public static readonly defaultMaxSendMessageSize: number = 1024 * 1024 * 4; // 4 MB
  public static readonly defaultCredential: CallCredential = InsecureChannelCredential.create();
  public static readonly defaultContentType: BebopContentType = "bebop";

  public ws!: Websocket;

  /** Teardown of a duplex consumer must tell the server to stop streaming. */
  protected override readonly cancelDuplexOnCleanup: boolean = true;

  private readonly isSecure: boolean;
  private readonly credential: CallCredential;
  private readonly maxReceiveMessageSize: number;
  private readonly maxSendMessageSize: number;

  private readonly _url: URL;
  private readonly _wsOptions: TempoWSChannelOptions;

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
    this._url = url;
    this._wsOptions = options;
    this.isSecure = target.protocol === "https:" || target.protocol === "wss:";
    this.credential = options.credential ?? TempoWSChannel.defaultCredential;
    if (
      !this.isSecure &&
      !(this.credential instanceof InsecureChannelCredential) &&
      options.unsafeUseInsecureChannelCallCredential !== true
    ) {
      throw new Error("Cannot use secure credential with insecure channel");
    }
    this.maxReceiveMessageSize =
      options.maxReceiveMessageSize ?? TempoWSChannel.defaultMaxReceiveMessageSize;
    this.maxSendMessageSize =
      options.maxSendMessageSize ?? TempoWSChannel.defaultMaxSendMessageSize;

    this._setupWebSocket(target);

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

  private _setupWebSocket(target: URL | WebSocket): void {
    if (target instanceof URL) {
      this.ws = new Websocket(target.toString(), [], this._wsOptions);
    } else {
      //@ts-expect-error
      this.ws = new ExistingWebSocket(target, [], this._wsOptions);
    }
    this.ws.binaryType = this._wsOptions.binaryType || "arraybuffer";

    this.ws.addEventListener(WebsocketEvent.open, () => {
      this.logger.trace(`opened TempoWSChannel for ${this._url.href} / ${this.userAgent}`);
    });
    this.ws.addEventListener(WebsocketEvent.close, (ws) => {
      if (this.closed) return;
      // If the socket was never opened (connection failure before first open),
      // waitForOpen's own listeners handle it — do not tear down the channel.
      if (ws.lastConnection === undefined) return;
      this.logger.trace(`closed TempoWSChannel for ${this._url.href} / ${this.userAgent}`);
      this.close(new TempoError(TempoStatusCode.UNAVAILABLE, "channel closed"));
    });
    this.ws.addEventListener(WebsocketEvent.error, (ws) => {
      if (this.closed) return;
      // Only tear down if we were previously connected — waitForOpen handles
      // pre-open errors with its own retry logic.
      if (ws.lastConnection === undefined) return;
      this.close(new TempoError(TempoStatusCode.UNAVAILABLE, "channel transport error"));
    });
    this.ws.addEventListener(WebsocketEvent.message, (_ws, ev) => {
      // Bound the inbound frame BEFORE decoding so an oversized/hostile frame is
      // never allocated into a Message. The corresponding call surfaces the
      // failure via its deadline or the channel close() reject-all path.
      const byteLength =
        typeof ev.data === "string" ? ev.data.length : (ev.data as ArrayBuffer).byteLength;
      if (byteLength > this.maxReceiveMessageSize) {
        this.logger.error(
          `inbound frame ${byteLength}B exceeds maxReceiveMessageSize ${this.maxReceiveMessageSize}B; dropping`,
        );
        return;
      }
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
  }

  private _reconnect(): void {
    this.ws.close();
    this._setupWebSocket(new URL(this._url.href));
  }

  public override async removeCredential(): Promise<void> {
    await this.credential.removeCredential();
  }
  public override async getCredential(): Promise<Credential | undefined> {
    return await this.credential.getCredential();
  }

  /** Every RPC waits for the socket to open before sending. */
  protected override async beforeCall(): Promise<void> {
    await this.waitForOpen();
  }

  /** {@inheritDoc CoreChannel.getAuthorizationValue} */
  protected override async getAuthorizationValue(): Promise<string | undefined> {
    const credentialHeader = await this.credential.getHeader();
    return credentialHeader ? credentialHeader.value : undefined;
  }

  /**
   * {@inheritDoc CoreChannel.storeResponseCredential}
   *
   * @throws {TempoError} If the credential received on the response cannot be parsed.
   */
  protected override async storeResponseCredential(responseCredential: string): Promise<void> {
    const credential = parseCredential(responseCredential);
    if (!credential) {
      throw new TempoError(
        TempoStatusCode.INVALID_ARGUMENT,
        "unable to parse credentials received on 'tempo-credential' header",
      );
    }
    await this.credential.storeCredential(credential);
  }

  public async waitForOpen(): Promise<void> {
    const maxAttempts = 2;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 100));
        this._reconnect();
      }

      const state = this.ws.readyState;
      if (state === 1 /* OPEN */) return;
      if (state === 2 /* CLOSING */ || state === 3 /* CLOSED */) {
        throw new TempoError(TempoStatusCode.UNAVAILABLE, "socket is closing or closed");
      }

      try {
        await Deadline.after(5, "seconds").executeWithinDeadline(
          () =>
            new Promise<void>((resolve, reject) => {
              const teardown = () => {
                this.ws.removeEventListener(WebsocketEvent.open, onOpen);
                this.ws.removeEventListener(WebsocketEvent.error, onError);
                this.ws.removeEventListener(WebsocketEvent.close, onClose);
              };
              const onOpen = () => {
                teardown();
                resolve();
              };
              const onError = (ws: Websocket, event: Event) => {
                teardown();
                // `ErrorEvent` is a DOM global and is NOT defined in Node (the
                // test/server runtime), so `event instanceof ErrorEvent` throws
                // a ReferenceError that escapes as an uncaught exception. Duck-type
                // the `message` field instead, falling back to the event `type`.
                const message = (event as Event & { message?: unknown }).message;
                const detail = typeof message === "string" ? message : event.type;
                reject(
                  new TempoError(
                    TempoStatusCode.UNAVAILABLE,
                    `socket error before open: ${detail}`,
                  ),
                );
              };
              const onClose = () => {
                teardown();
                reject(new TempoError(TempoStatusCode.UNAVAILABLE, "socket closed before open"));
              };
              this.ws.addEventListener(WebsocketEvent.open, onOpen);
              this.ws.addEventListener(WebsocketEvent.error, onError);
              this.ws.addEventListener(WebsocketEvent.close, onClose);
            }),
        );
        return;
      } catch (err) {
        lastError = err as Error;
        if (
          attempt < maxAttempts - 1 &&
          err instanceof TempoError &&
          err.message.startsWith("socket error before open")
        ) {
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new TempoError(TempoStatusCode.UNAVAILABLE, "socket error before open");
  }

  public send(message: Message) {
    const frame = Message.encode(message);
    if (frame.length > this.maxSendMessageSize) {
      throw new TempoError(
        TempoStatusCode.INVALID_ARGUMENT,
        `outbound frame ${frame.length}B exceeds maxSendMessageSize ${this.maxSendMessageSize}B`,
      );
    }
    this.ws.send(frame);
  }

  /** {@inheritDoc CoreChannel.sendFrame} */
  protected override sendFrame(message: Message): void {
    this.send(message);
  }

  /** Close the socket on {@link CoreChannel.close}. */
  protected override closeTransport(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
