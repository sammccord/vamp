import type { ServerContext } from "@tempojs/server";
import {
  type BaseEntity,
  type ECS,
  type MutationBatch,
  MutationRecord,
  MutationType,
} from "@vampgg/ecs";
import { createEventIterator } from "@vampgg/utils/create-event-iterator";
import {
  encodeServerStreamFrame,
  STREAM_MESSAGE_ID_KEY,
  STREAM_METHOD_ID_KEY,
  streamAbortSignal,
} from "@vampgg/utils/ws-router";

/**
 * Interest-managed, hibernation-safe broadcast for an ECS world over a Tempo
 * WebSocket router. This is the generic plumbing behind a streaming `observe`
 * RPC: it parks the server stream, registers a per-connection ECS mutation
 * observer, and pushes interest-filtered frames GENERATOR-FREE (straight
 * `ws.send`) so delivery survives a durable-object hibernation wake.
 *
 * A developer wires this with three pieces: the REQUIRED `encodeBatch` codec
 * (the per-app bebop `MutationScope` serializer the package cannot import), and
 * the OPTIONAL `canSee` / `resolveViewer` policy (default: global broadcast).
 *
 * The module is intentionally free of `cloudflare:workers` (it never imports
 * `./ecs`) so it loads in the plain node test runner; it depends only on
 * `@vampgg/ecs` types, the `@tempojs/server` context, and the `@vampgg/utils`
 * router/iterator helpers.
 */

/** The namespaced socket-attachment key the persisted subscription lives under. */
const ATTACHMENT_KEY = "__vamp:interest";

/**
 * The serializable subscription persisted in the socket attachment. Holds only
 * the routing-critical ids (≤ a few bytes), never entity data, so it stays well
 * under the ~2 KB attachment budget and can be restored on a hibernation wake to
 * rebuild the interest observer. `messageId`/`methodId` frame server→client
 * pushes that the client's `observe` stream iterator matches by `messageId`.
 */
export interface InterestSub {
  messageId: string;
  methodId: number;
  viewerId?: string;
}

/** The slice of a socket attachment this module owns; other keys are the app's session. */
interface InterestAttachment {
  [ATTACHMENT_KEY]?: InterestSub;
}

/** Extract the entity type `E` from an ECS world type. */
type EntityOf<W> = W extends ECS<any, any, any, any, infer E, any> ? E : never;
/** Extract the delta type `D` from an ECS world type. */
type DeltaOf<W> = W extends ECS<any, any, any, any, any, infer D> ? D : never;

/**
 * The injected policy + codec for {@link createInterestBroadcast}. `W` is the ECS
 * world type; `Req` the observe request record; `E`/`D` are inferred from `W`.
 */
export interface InterestBroadcastConfig<
  W extends ECS<any, any, any, any, any, any>,
  Req,
  E extends BaseEntity<any> = EntityOf<W>,
  D = DeltaOf<W>,
> {
  /**
   * REQUIRED. Encode a coalesced batch into the per-app wire bytes. The package
   * cannot import the app-generated `MutationScope`, so the app passes e.g.
   * `(batch) => new Uint8Array(MutationScope.encode(MutationScope({ mutations: batch })))`.
   * The returned bytes are wrapped in a server-stream frame before sending.
   */
  encodeBatch: (batch: MutationBatch<E, D>) => Uint8Array;
  /**
   * The subjective area-of-interest policy: is `target` relevant to the viewer?
   * Called once per (observer × mutation) at commit, and per entity for the
   * initial snapshot. Default: always visible (every observer sees everything).
   */
  canSee?: (world: W, viewerId: string | undefined, targetId: string, target: E) => boolean;
  /**
   * Resolve the viewer entity id from the observe request record. Default:
   * `() => undefined` — a GLOBAL observer that sees every mutation. A codegen
   * wrapper or app overrides this (e.g. first key of the request scope, or the
   * authenticated session's entity).
   */
  resolveViewer?: (record: Req) => string | undefined;
}

/** The wired broadcast surface returned by {@link createInterestBroadcast}. */
export interface InterestBroadcast<W extends ECS<any, any, any, any, any, any>, Req, Yield> {
  /**
   * Delegate target for the RPC `observe` method:
   * `public async *observe(r, ctx) { yield* broadcast.observe(r, ctx); }`.
   * Registers the interest observer, sends an interest-filtered snapshot, and
   * parks the stream (live frames are pushed generator-free, not yielded).
   */
  observe: (record: Req, context: ServerContext) => AsyncGenerator<Yield, void, undefined>;
  /** Pass straight into `defineECSRuntime({ onConnectionClose })`. */
  onConnectionClose: (ws: WebSocket) => void;
  /** Pass straight into `defineECSRuntime({ rehydrateConnection })`. */
  rehydrateConnection: (world: W, ws: WebSocket) => void;
}

/**
 * Build the interest-managed broadcast plumbing for one runtime. Returns the
 * `observe` generator (delegate from the RPC method) plus the `onConnectionClose`
 * and `rehydrateConnection` hooks (pass into `defineECSRuntime`).
 *
 * Generics: `W` is primary; `E`/`D` are inferred from it so the call site stays
 * `createInterestBroadcast<World, Request, Yield>({...})` rather than respelling
 * all six ECS type parameters.
 */
export function createInterestBroadcast<
  W extends ECS<any, any, any, any, any, any>,
  Req,
  Yield = never,
  E extends BaseEntity<any> = EntityOf<W>,
  D = DeltaOf<W>,
>(config: InterestBroadcastConfig<W, Req, E, D>): InterestBroadcast<W, Req, Yield> {
  const canSee = config.canSee ?? (() => true);
  const resolveViewer = config.resolveViewer ?? (() => undefined);

  // Per-connection teardown callbacks, keyed by the underlying WebSocket. The
  // interest observer registered by `observe` (and rebuilt on hibernation wake by
  // `rehydrateConnection`) registers a callback that unsubscribes it and clears
  // its persisted subscription, so `onConnectionClose` can drive it on
  // disconnect/error. Keyed weakly so a dropped socket does not leak the entry.
  const connectionTeardowns = new WeakMap<WebSocket, Set<() => void>>();

  function registerConnectionTeardown(ws: WebSocket, fn: () => void): () => void {
    let set = connectionTeardowns.get(ws);
    if (!set) {
      set = new Set();
      connectionTeardowns.set(ws, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  function readAttachment(ws: WebSocket): InterestAttachment | null {
    // SAFETY: only `persistSub` writes `ATTACHMENT_KEY`, always with an
    // `InterestSub`; the rest of the attachment is the app's session object.
    return ws.deserializeAttachment() as InterestAttachment | null;
  }

  function persistSub(ws: WebSocket, sub: InterestSub): void {
    const attachment = readAttachment(ws) ?? {};
    attachment[ATTACHMENT_KEY] = sub;
    ws.serializeAttachment(attachment);
  }

  function readSub(ws: WebSocket): InterestSub | undefined {
    return readAttachment(ws)?.[ATTACHMENT_KEY];
  }

  function clearSub(ws: WebSocket): void {
    const attachment = readAttachment(ws);
    if (attachment && ATTACHMENT_KEY in attachment) {
      delete attachment[ATTACHMENT_KEY];
      ws.serializeAttachment(attachment);
    }
  }

  /**
   * Frame a routed batch as a server-stream response the client matches by
   * messageId. `encodeServerStreamFrame` returns a freshly-allocated, exact-size
   * `Uint8Array`, so its backing buffer is precisely the frame — returned as an
   * `ArrayBuffer` because the (Cloudflare) WebSocket accepts `ArrayBuffer | string`,
   * not an `ArrayBufferView`.
   */
  // A batch delivered to many observers is the same object (see
  // ECS.routeMutations), so its payload is encoded once and reused.
  const encodedBatches = new WeakMap<MutationBatch<E, D>, Uint8Array>();
  function encode(batch: MutationBatch<E, D>): Uint8Array {
    let data = encodedBatches.get(batch);
    if (data === undefined) {
      data = config.encodeBatch(batch);
      encodedBatches.set(batch, data);
    }
    return data;
  }

  function frame(methodId: number, messageId: string, batch: MutationBatch<E, D>): ArrayBuffer {
    const bytes = encodeServerStreamFrame({ methodId, messageId, data: encode(batch) });
    // SAFETY: `encodeServerStreamFrame` returns `new Uint8Array(Message.encode(...))`,
    // a freshly-allocated, exact-size `Uint8Array`, so `bytes.buffer` is a plain
    // (non-shared) `ArrayBuffer`.
    return bytes.buffer as ArrayBuffer;
  }

  /**
   * Register the generator-free interest observer for one connection. The
   * `deliver` path frames the batch and writes it straight to the live socket,
   * so it keeps working after a hibernation wake (when the original `observe`
   * generator is gone).
   *
   * With a `canSee` policy the observer tracks which entities its client holds
   * (`visible`, seeded by the caller) and rewrites each batch so the client
   * stays in sync as things move: an entity entering view arrives as a full
   * Insert, one leaving view as a Delete. When the viewer entity itself changes,
   * every entity is re-tested, so keep `canSee` cheap.
   */
  function registerInterestObserver(
    world: W,
    ws: WebSocket,
    sub: InterestSub,
    visible: Set<string>,
  ): () => void {
    const { messageId, methodId, viewerId } = sub;
    const send = (batch: MutationBatch<E, D>): void => {
      if (batch.size === 0) return;
      try {
        // readyState 1 === OPEN; skip a closing/closed socket.
        if (ws.readyState === 1) ws.send(frame(methodId, messageId, batch));
      } catch {
        /* best-effort: socket may be gone */
      }
    };
    if (config.canSee === undefined) {
      return world.observeMutations({ interested: () => true, deliver: send });
    }

    const sees = (id: string, entity: E | undefined): boolean =>
      entity !== undefined && canSee(world, viewerId, id, entity);
    return world.observeMutations({
      interested: (id: string, mutation: MutationRecord<E, D>): boolean => {
        if (mutation.tag === MutationType.Delete) return visible.has(id);
        if (id === viewerId) return true;
        return visible.has(id) || sees(id, world.entity(id));
      },
      deliver: (batch: MutationBatch<E, D>): void => {
        const out: MutationBatch<E, D> = new Map();
        // Whether `out` differs from `batch`; an unchanged batch is sent as-is so
        // its encoding is shared with other observers.
        let rewritten = false;
        const put = (id: string, mutation: MutationRecord<E, D>): void => {
          out.set(id, mutation);
          if (batch.get(id) !== mutation) rewritten = true;
        };
        for (const [id, mutation] of batch) {
          if (mutation.tag === MutationType.Delete) {
            if (visible.delete(id)) put(id, mutation);
            else rewritten = true;
            continue;
          }
          const entity = world.entity(id);
          if (entity !== undefined && sees(id, entity)) {
            const entering = !visible.has(id);
            visible.add(id);
            put(id, entering ? MutationRecord.fromInsert<E, D>({ entity }) : mutation);
          } else if (visible.delete(id)) {
            put(id, MutationRecord.fromDelete<E, D>({ entity: entity ?? { id } }));
          } else {
            rewritten = true;
          }
        }
        if (viewerId !== undefined && batch.has(viewerId)) {
          // The viewer moved: entities outside this batch may have entered or
          // left its view.
          for (const [id, entity] of world.entities) {
            if (batch.has(id)) continue;
            const inView = sees(id, entity);
            if (inView && !visible.has(id)) {
              visible.add(id);
              put(id, MutationRecord.fromInsert<E, D>({ entity }));
            } else if (!inView && visible.delete(id)) {
              put(id, MutationRecord.fromDelete<E, D>({ entity }));
            }
          }
        }
        send(rewritten ? out : batch);
      },
    });
  }

  /**
   * Register an interest observer AND wire its per-connection teardown
   * (unsubscribe + clear the persisted subscription on socket close/error).
   * Used by the wake-time rehydrate path, which has no parked generator of its
   * own to drive cleanup.
   */
  function subscribeConnection(world: W, ws: WebSocket, sub: InterestSub): () => void {
    // The client already holds what it could see before the wake; assume that
    // is what it can see now.
    const visible = new Set(interestSnapshot(world, sub.viewerId).keys());
    const unobserve = registerInterestObserver(world, ws, sub, visible);
    registerConnectionTeardown(ws, () => {
      unobserve();
      clearSub(ws);
    });
    return unobserve;
  }

  /** The interest-filtered initial snapshot: an insert per entity the viewer can see. */
  function interestSnapshot(world: W, viewerId: string | undefined): MutationBatch<E, D> {
    return world.snapshotMutations((id: string, entity: E) => canSee(world, viewerId, id, entity));
  }

  async function* observe(
    record: Req,
    context: ServerContext,
  ): AsyncGenerator<Yield, void, undefined> {
    const [world, ws] = context.getEnvironment<[W, WebSocket]>();

    // The router exposes the per-call message/method ids via client metadata so
    // the generator-free broadcast path can frame server->client pushes the
    // client matches by messageId. Without them we cannot push hibernation-safe
    // frames; bail (the client's call surfaces the empty stream).
    // SAFETY: clientMetadata maps stream keys to their first header value (a
    // string from the client's metadata map), so [0] is that string, not an
    // arbitrary value.
    const messageId = context.clientMetadata?.get(STREAM_MESSAGE_ID_KEY)?.[0] as string | undefined;
    // SAFETY: same metadata contract as the message id above: the first value
    // under the stream method key is a numeric string.
    const methodIdRaw = context.clientMetadata?.get(STREAM_METHOD_ID_KEY)?.[0] as
      | string
      | undefined;
    const methodId = methodIdRaw !== undefined ? Number(methodIdRaw) : Number.NaN;
    if (messageId === undefined || Number.isNaN(methodId)) return;

    const viewerId = resolveViewer(record);

    // Persist the subscription so a hibernation re-bootstrap can rebuild this
    // observer from the socket attachment (see rehydrateConnection).
    persistSub(ws, { messageId, methodId, viewerId });

    // Register the generator-free observer BEFORE the snapshot so no committed
    // mutation is missed between snapshot and registration.
    const visible = new Set<string>();
    const unobserve = registerInterestObserver(
      world,
      ws,
      { messageId, methodId, viewerId },
      visible,
    );

    // Interest-filtered initial snapshot, sent through the same framed path the
    // live observer uses (NOT via a generator yield), so the resume path and the
    // snapshot path are identical bytes on the wire.
    // Always sent, even when empty: a replica treats the first frame of a
    // stream as the authoritative world and drops anything absent from it.
    const snapshot = interestSnapshot(world, viewerId);
    for (const id of snapshot.keys()) visible.add(id);
    if (ws.readyState === 1) ws.send(frame(methodId, messageId, snapshot));

    // Park: hold the server stream open WITHOUT yielding (live frames are pushed
    // generator-free above). The router ends this generator — running the
    // cleanup below — on a CANCELLED frame or socket close. Because it never
    // yields, no terminal frame is sent until then, so a hibernation that
    // destroys this generator leaves the client stream open to resume.
    const signal = streamAbortSignal(context);
    yield* createEventIterator<Yield>(({ cancel }) => {
      const unregister = registerConnectionTeardown(ws, () => {
        unobserve();
        clearSub(ws);
        cancel();
      });
      // The router aborts on a client CANCELLED or socket close; a parked
      // generator cannot be ended any other way.
      if (signal?.aborted) cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      return () => {
        signal?.removeEventListener("abort", cancel);
        unobserve();
        clearSub(ws);
        unregister();
      };
    });
  }

  function onConnectionClose(ws: WebSocket): void {
    const set = connectionTeardowns.get(ws);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
    set.clear();
    connectionTeardowns.delete(ws);
  }

  function rehydrateConnection(world: W, ws: WebSocket): void {
    const sub = readSub(ws);
    if (!sub) return;
    subscribeConnection(world, ws, sub);
  }

  return { observe, onConnectionClose, rehydrateConnection };
}
