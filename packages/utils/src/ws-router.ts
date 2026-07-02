import { Metadata, TempoError, type TempoLogger, TempoStatusCode } from "@tempojs/common";
import {
  type AuthInterceptor,
  BaseRouter,
  type BebopMethodAny,
  ServerContext,
  type ServiceRegistry,
  TempoRouterConfiguration,
} from "@tempojs/server";
import type { BebopRecord } from "bebop";
import { Message } from "./bebop";
import { RouterCore } from "./router-core";

interface GenericWs {
  send(message: string | Blob | BufferSource): void;
}

/**
 * Client-metadata keys under which {@link TempoWsRouter.process} exposes the
 * current call's message/method ids to a service handler (read via
 * `context.clientMetadata`). A streaming handler persists these so the
 * hibernation-safe broadcast path can re-frame server->client pushes.
 */
export const STREAM_MESSAGE_ID_KEY = "tempo-message-id";
export const STREAM_METHOD_ID_KEY = "tempo-method-id";

/**
 * Build an encoded server-stream frame identical to the one {@link TempoWsRouter}
 * emits from a streaming handler: status OK, the given `methodId`/`messageId`, and
 * the already-serialized record bytes `data`. Used by the hibernation-safe
 * broadcast path to push frames over a live socket WITHOUT a live generator — the
 * client's server-stream iterator matches them by `messageId` exactly like
 * generator-emitted frames. `messageId` MUST be the original observe call's id
 * (a GUID); `methodId` its method id.
 */
export function encodeServerStreamFrame(opts: {
  methodId: number;
  messageId: string;
  data: Uint8Array;
}): Uint8Array {
  return new Uint8Array(
    Message.encode(
      Message({
        methodId: opts.methodId,
        messageId: opts.messageId,
        status: TempoStatusCode.OK,
        data: opts.data,
      }),
    ),
  );
}

export class TempoWsRouter<
  Context,
  Ws extends GenericWs = WebSocket,
  Env extends [Context, Ws] = [Context, Ws],
> extends BaseRouter<ArrayBuffer, Env, Message> {
  private readonly core: RouterCore;
  // Active server-stream generators keyed by messageId. Tracked so an inbound
  // CANCELLED frame ENDS the existing stream (running its cleanup — e.g.
  // unsubscribing interest observers) instead of re-invoking the handler and
  // starting a duplicate stream. Post-hibernation this map is empty (the parked
  // generator was destroyed with the isolate), so a CANCELLED simply no-ops and
  // the rehydrated observer is reaped on socket close.
  private readonly serverStreams = new Map<string, AsyncGenerator<BebopRecord, void, unknown>>();
  // Encode-once broadcast cache. When one record object is fanned out to many
  // server-stream consumers (e.g. an ECS mutation scope broadcast to every
  // observer of a room), its payload is serialized a single time and the bytes
  // are reused for every observer's frame — turning O(observers) bebop encodes
  // per broadcast into O(1). Keyed weakly by the record, so the entry is GC'd
  // once the broadcast value is no longer referenced (no unbounded growth).
  private readonly _streamEncodeCache = new WeakMap<BebopRecord, Uint8Array>();

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

  private async invokeServerStreamMethod(
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>> {
    const messageId = request.messageId!;
    // A CANCELLED frame must NEVER start a fresh server stream. End the tracked
    // generator (its cleanup runs — e.g. unsubscribing interest observers) and
    // return an already-finished generator so process() emits the terminal frame
    // without re-invoking the handler. Without this, a client `.return()` on an
    // observe stream would re-invoke the handler and spawn a duplicate stream.
    if (request.status === TempoStatusCode.CANCELLED) {
      const existing = this.serverStreams.get(messageId);
      if (existing) {
        this.serverStreams.delete(messageId);
        try {
          await existing.return(undefined);
        } catch {
          /* best effort: generator cleanup may itself throw */
        }
      }
      return (async function* (): AsyncGenerator<BebopRecord, void, unknown> {})();
    }
    const invocation = await this.core.invokeServerStreamMethod(request, context, method, "bebop");
    // Track so a later CANCELLED for this messageId ends it instead of re-invoking.
    this.serverStreams.set(messageId, invocation);
    return invocation;
  }

  /**
   * Tear down all open streams for this connection (driven by the DO socket
   * close/error lifecycle). Emits a synthetic CANCELLED to each in-flight
   * client/duplex stream so its generator ends, then clears all listeners.
   */
  public async closeConnection(): Promise<void> {
    this.core.cancelClientStreams();
    // End every parked server-stream generator so its cleanup runs (e.g.
    // unsubscribing interest observers registered by an `observe` handler).
    for (const [id, gen] of [...this.serverStreams]) {
      this.serverStreams.delete(id);
      try {
        await gen.return(undefined);
      } catch {
        /* best effort */
      }
    }
    this.core.removeAllListeners();
  }

  public override async process(req: ArrayBuffer, response: Message, env: Env) {
    // Bound the untrusted inbound frame BEFORE decoding it into a Message, so a
    // hostile/oversized client frame cannot force a large allocation. The client
    // call surfaces the failure via its deadline.
    if (req.byteLength > this.maxReceiveMessageSize) {
      this.logger.error(
        `inbound frame ${req.byteLength}B exceeds maxReceiveMessageSize ${this.maxReceiveMessageSize}B; dropping`,
      );
      return;
    }
    const request = Message.decode(new Uint8Array(req as ArrayBuffer));
    const [, ws] = env;

    // `Message.encode` returns a view into bebop's shared write buffer; copy it
    // so concurrent encodes (e.g. an overlapping unary response) cannot clobber
    // this frame before the socket flushes it.
    const send = (message: Message) => {
      ws.send(new Uint8Array(Message.encode(message)) as BufferSource);
    };

    await this.core.processRequest(request, response, env, {
      send,
      // Expose the per-call message/method ids to handlers (read via
      // `context.clientMetadata`). The hibernation-safe broadcast path persists
      // these in the socket attachment so a generator-free push can frame
      // server->client messages the client's stream iterator matches by
      // `messageId` — see `encodeServerStreamFrame`.
      buildIncomingMetadata: (message) => {
        const incomingMetadata = new Metadata();
        if (message.messageId !== undefined) {
          incomingMetadata.set(STREAM_MESSAGE_ID_KEY, message.messageId);
        }
        if (message.methodId !== undefined) {
          incomingMetadata.set(STREAM_METHOD_ID_KEY, String(message.methodId));
        }
        return incomingMetadata;
      },
      invokeServerStream: (message, context, method) =>
        this.invokeServerStreamMethod(message, context, method),
      writeStreamFrames: (generator, resp, method) =>
        this.core.writeStreamFrames({
          generator,
          response: resp,
          method,
          send,
          // Encode the payload once per distinct record. A fan-out broadcast
          // yields the SAME object to every observer's stream, so all but the
          // first reuse these bytes instead of re-encoding the whole scope.
          serializePayload: (value) => {
            let payload = this._streamEncodeCache.get(value);
            if (payload === undefined) {
              // `serializeResponse` returns a view into bebop's shared write
              // buffer; copy it into an owned array before caching so a later
              // encode cannot clobber it.
              payload = new Uint8Array(this.serializeResponse(value, method, "bebop"));
              this._streamEncodeCache.set(value, payload);
            }
            return payload;
          },
          // Stream ended: drop its tracking entry (harmless no-op for the
          // duplex path, which is keyed in clientStreams).
          onEnd: () => this.serverStreams.delete(request.messageId!),
        }),
    });
  }

  override handle(_request: ArrayBuffer, _env: Env): Promise<Message> {
    throw new TempoError(TempoStatusCode.UNIMPLEMENTED, "Method not implemented.");
  }
}
