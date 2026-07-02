import { type MethodInfo, type TempoChannelOptions } from "@tempojs/client";
import { type BebopContentType, ConsoleLogger, type TempoError } from "@tempojs/common";
import type { BebopRecord } from "bebop";
import * as browser from "webextension-polyfill";
import { Message } from "./bebop";
import { CoreChannel } from "./channel-core";

/**
 * Represents a Tempo channel for communication with a remote server.
 */
export class TempoExtensionChannel extends CoreChannel {
  public static readonly defaultMaxRetryAttempts: number = 5;
  public static readonly defaultMaxReceiveMessageSize: number = 1024 * 1024 * 4; // 4 MB
  public static readonly defaultMaxSendMessageSize: number = 1024 * 1024 * 4; // 4 MB
  public static readonly defaultContentType: BebopContentType = "bebop";

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
   * @param {TempoChannelOptions} options - The configuration options for the channel.
   */
  constructor(options: TempoChannelOptions = {}) {
    super(
      new URL("runtime://"),
      options.logger ?? new ConsoleLogger("TempoExtensionChannel"),
      options.contentType ?? TempoExtensionChannel.defaultContentType,
    );
    this.logger.trace("creating new TempoExtensionChannel");

    browser.runtime.onMessage.addListener(this.onMessage);

    this.logger.debug(`created new TempoExtensionChannel`);
  }

  /** Remove the runtime message listener before in-flight calls are settled. */
  protected override onClosing(_reason: TempoError): void {
    try {
      browser.runtime.onMessage.removeListener(this.onMessage);
    } catch {
      /* listener already gone */
    }
  }

  /**
   * {@inheritDoc CoreChannel.serializeStreamItem}
   *
   * No copy: {@link sendMessage} encodes the frame synchronously, so the view
   * into bebop's shared write buffer is consumed before it can be clobbered
   * (each streamed send is awaited by the core for the same reason).
   */
  protected override serializeStreamItem(
    method: MethodInfo<BebopRecord, BebopRecord>,
    value: BebopRecord,
  ): Uint8Array {
    return method.serialize(value);
  }

  /**
   * {@inheritDoc CoreChannel.sendFrame}
   */
  protected override sendFrame(message: Message): Promise<unknown> {
    return this.sendMessage(message);
  }

  protected sendMessage(message: Message) {
    return browser.runtime.sendMessage(Array.from(Message.encode(message)));
  }
}
