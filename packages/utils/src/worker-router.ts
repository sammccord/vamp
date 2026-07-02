import { TempoError, type TempoLogger, TempoStatusCode } from "@tempojs/common";
import {
  type AuthInterceptor,
  BaseRouter,
  type ServiceRegistry,
  TempoRouterConfiguration,
} from "@tempojs/server";
import type { BebopRecord } from "bebop";
import { Message } from "./bebop";
import { RouterCore } from "./router-core";

export class TempoWorkerRouter<TEnv> extends BaseRouter<Buffer, TEnv, Message> {
  private readonly core: RouterCore;
  // Track server stream generators so they can be cancelled
  private readonly serverStreams: Map<
    string,
    {
      generator: AsyncGenerator<BebopRecord, void, unknown>;
      cancelled: boolean;
    }
  > = new Map();

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
   * Tear down all open streams for this connection (driven by the host
   * close/error lifecycle). Returns each server-stream generator and emits a
   * synthetic CANCELLED to each client/duplex stream, then clears listeners.
   */
  public async closeConnection(): Promise<void> {
    for (const [id, info] of [...this.serverStreams]) {
      info.cancelled = true;
      await info.generator.return(undefined).catch(() => {});
      this.serverStreams.delete(id);
    }
    this.core.cancelClientStreams();
    this.core.removeAllListeners();
  }

  public override async process(req: Uint8Array, response: Message, env: TEnv) {
    const request = Message.decode(req);

    // Handle cancellation messages for server streams
    if (request.status === TempoStatusCode.CANCELLED && request.messageId) {
      const streamInfo = this.serverStreams.get(request.messageId);
      if (streamInfo) {
        streamInfo.cancelled = true;
        // Call return() to trigger cleanup in the generator
        await streamInfo.generator.return(undefined);
        this.serverStreams.delete(request.messageId);
      }
      return;
    }

    // `Message.encode` returns a view into bebop's singleton write buffer;
    // `.slice()` owns a fresh ArrayBuffer so the transfer cannot detach it.
    const send = (message: Message) => {
      const encoded = Message.encode(message).slice();
      postMessage(encoded, [encoded.buffer]);
    };

    await this.core.processRequest(request, response, env, {
      send,
      stampErrorResponse: true,
      writeStreamFrames: async (generator, resp, method) => {
        const messageId = request.messageId!;
        // Track the generator so an inbound CANCELLED frame (handled above)
        // can stop the pump and run the generator's cleanup.
        const streamInfo = { generator, cancelled: false };
        this.serverStreams.set(messageId, streamInfo);
        await this.core.writeStreamFrames({
          generator,
          response: resp,
          method,
          send,
          shouldStop: () => streamInfo.cancelled,
          alwaysTerminate: true,
          onEnd: () => this.serverStreams.delete(messageId),
        });
      },
    });
  }

  override handle(_request: string | Buffer, _env: TEnv): Promise<Message> {
    throw new TempoError(TempoStatusCode.UNIMPLEMENTED, "Method not implemented.");
  }
}
