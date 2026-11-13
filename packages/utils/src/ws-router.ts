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

/** Cancellation signals for live server streams, keyed by their ServerContext. */
const streamSignals = new WeakMap<ServerContext, AbortSignal>();

/**
 * The abort signal of the server stream `context` belongs to, if it was opened
 * by a {@link TempoWsRouter}. It fires when the client cancels the stream or its
 * connection closes. A handler parked on an external event source (one that
 * never yields on its own) must end its generator when this fires: the router
 * cannot interrupt a generator suspended in `await`.
 */
export function streamAbortSignal(context: ServerContext): AbortSignal | undefined {
  return streamSignals.get(context);
}

interface ServerStream {
  generator: AsyncGenerator<BebopRecord, void, unknown>;
  abort: AbortController;
}

/** Per-socket routing state. Keyed by socket so connections never share streams. */
interface Connection {
  core: RouterCore;
  serverStreams: Map<string, ServerStream>;
}

/** End a server stream without awaiting it: `return()` queues behind a parked `next()`. */
function endServerStream(stream: ServerStream): void {
  stream.abort.abort();
  stream.generator.return(undefined).catch(() => {});
}

export class TempoWsRouter<
  Context,
  Ws extends GenericWs = WebSocket,
  Env extends [Context, Ws] = [Context, Ws],
> extends BaseRouter<ArrayBuffer, Env, Message> {
  private readonly connections = new WeakMap<Ws, Connection>();
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
  }

  private connection(ws: Ws): Connection {
    let connection = this.connections.get(ws);
    if (!connection) {
      connection = {
        core: new RouterCore({
          logger: this.logger,
          maxRetryAttempts: this.maxRetryAttempts,
          transmitInternalErrors: this.transmitInternalErrors,
          authInterceptor: this.authInterceptor,
          getMethod: (methodId) => this.registry.getMethod(methodId),
          getHooks: () => this.hooks,
          deserializeRequest: (data, method, contentType) =>
            this.deserializeRequest(data, method, contentType),
          serializeResponse: (record, method, contentType) =>
            this.serializeResponse(record, method, contentType),
        }),
        serverStreams: new Map(),
      };
      this.connections.set(ws, connection);
    }
    return connection;
  }

  private async invokeServerStreamMethod(
    connection: Connection,
    request: Message,
    context: ServerContext,
    method: BebopMethodAny,
  ): Promise<AsyncGenerator<BebopRecord, void, unknown>> {
    const messageId = request.messageId!;
    // A CANCELLED frame must NEVER start a fresh server stream. End the tracked
    // stream and return an already-finished generator so process() emits the
    // terminal frame without re-invoking the handler.
    if (request.status === TempoStatusCode.CANCELLED) {
      const existing = connection.serverStreams.get(messageId);
      if (existing) {
        connection.serverStreams.delete(messageId);
        endServerStream(existing);
      }
      return (async function* (): AsyncGenerator<BebopRecord, void, unknown> {})();
    }
    const abort = new AbortController();
    streamSignals.set(context, abort.signal);
    const generator = await connection.core.invokeServerStreamMethod(
      request,
      context,
      method,
      "bebop",
    );
    connection.serverStreams.set(messageId, { generator, abort });
    return generator;
  }

  /**
   * Tear down every open stream on `ws` (driven by the socket close/error
   * lifecycle). Client/duplex streams get a synthetic CANCELLED; server streams
   * are aborted (see {@link streamAbortSignal}). Never waits on a generator, so
   * a handler parked on an external source cannot stall teardown. Other
   * connections are untouched.
   */
  public closeConnection(ws: Ws): void {
    const connection = this.connections.get(ws);
    if (!connection) return;
    this.connections.delete(ws);
    connection.core.cancelClientStreams();
    for (const stream of connection.serverStreams.values()) endServerStream(stream);
    connection.serverStreams.clear();
    connection.core.removeAllListeners();
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
    const request = Message.decode(new Uint8Array(req));
    const [, ws] = env;
    const connection = this.connection(ws);

    // `Message.encode` returns a view into bebop's shared write buffer; copy it
    // so concurrent encodes (e.g. an overlapping unary response) cannot clobber
    // this frame before the socket flushes it.
    const send = (message: Message) => {
      ws.send(new Uint8Array(Message.encode(message)));
    };

    await connection.core.processRequest(request, response, env, {
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
        this.invokeServerStreamMethod(connection, message, context, method),
      writeStreamFrames: (generator, resp, method) =>
        connection.core.writeStreamFrames({
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
          onEnd: () => {
            const stream = connection.serverStreams.get(request.messageId!);
            if (stream?.generator === generator)
              connection.serverStreams.delete(request.messageId!);
          },
        }),
    });
  }

  override handle(_request: ArrayBuffer, _env: Env): Promise<Message> {
    throw new TempoError(TempoStatusCode.UNIMPLEMENTED, "Method not implemented.");
  }
}
