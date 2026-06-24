import type { MutationBatch } from "@vamp/ecs";
import { encodeServerStreamFrame } from "@vamp/utils/ws-router";
import { type Entity, type MutationRecord, MutationScope } from "./bebop";
import type { EntityDelta, GameContext } from "./game.generated";

/**
 * Interest-managed broadcast wiring for the basic example.
 *
 * This module is intentionally free of the `@TempoServiceRegistry.register`
 * decorator (kept in `rpc.service.ts`) so it can be imported by plain unit tests
 * AND by the durable object's hibernation re-bootstrap without pulling in the
 * service-registration side effect. It owns the subjective interest policy
 * (`canSee`), the per-connection subscription lifecycle, and the generator-free
 * framed delivery that survives DO hibernation.
 */

/**
 * The runtime-configurable world context for this example. It is derived per
 * Durable Object at bootstrap from the handler's request (see `resolveContext`
 * in `index.ts`) and survives hibernation via the persisted seed. `faction` is
 * applied as the default faction for entities spawned into this world, so the
 * world's runtime context is observable through the `spawn` RPC response.
 */
export type GameWorldContext = { faction: number; seededAt: number };

/** The example's ECS context tuple, typed with the world context above. */
export type WorldContext = GameContext<{}, GameWorldContext>;
/** The example's ECS world type (the first element of the context tuple). */
export type GameWorld = WorldContext[0];
/** A coalesced batch of mutations as routed by the ECS interest broadcast. */
type GameBatch = MutationBatch<Entity, EntityDelta>;

/**
 * Area-of-interest radius for the example's subjective interest policy
 * (`canSee`). Entities within this distance of a viewer's position are relevant
 * to that observer; everything else is filtered out before it is ever sent.
 */
const AOI_RADIUS = 100;
const AOI_RADIUS_SQ = AOI_RADIUS * AOI_RADIUS;

/**
 * Per-connection teardown callbacks, keyed by the underlying WebSocket. The
 * interest observer registered by `observe` (and rebuilt on hibernation wake by
 * {@link rehydrateGameConnection}) registers a callback that unsubscribes it and
 * clears its persisted subscription here, so the durable object's
 * connection-close path can drive it on disconnect/error. Keyed weakly so a
 * dropped socket does not leak the map entry.
 */
const connectionTeardowns = new WeakMap<WebSocket, Set<() => void>>();

export function registerConnectionTeardown(ws: WebSocket, fn: () => void): () => void {
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

/**
 * Run and clear all teardown callbacks for a connection. Wired into the durable
 * object's connection-close path via `onConnectionClose` in `defineECSRuntime`.
 */
export function closeConnectionObservers(ws: WebSocket): void {
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

/// ── Interest policy + per-connection subscription (hibernation-safe) ─────────

/**
 * The serializable subscription persisted in the socket attachment. Holds only
 * the routing-critical ids (≤ a few bytes), never entity data, so it stays well
 * under the ~2 KB attachment budget and can be restored on a hibernation wake to
 * rebuild the interest observer. `messageId`/`methodId` frame server→client
 * pushes that the client's `observe` stream iterator matches by `messageId`.
 */
export type ObserveSub = { messageId: string; methodId: number; viewerId?: string };

export function persistSub(ws: WebSocket, sub: ObserveSub): void {
  const attachment = (ws.deserializeAttachment() ?? {}) as Record<string, unknown>;
  attachment.sub = sub;
  ws.serializeAttachment(attachment);
}

function readSub(ws: WebSocket): ObserveSub | undefined {
  const attachment = ws.deserializeAttachment() as Record<string, unknown> | null;
  return (attachment?.sub as ObserveSub | undefined) ?? undefined;
}

export function clearSub(ws: WebSocket): void {
  const attachment = ws.deserializeAttachment() as Record<string, unknown> | null;
  if (attachment && "sub" in attachment) {
    delete attachment.sub;
    ws.serializeAttachment(attachment);
  }
}

/**
 * The viewer entity id this observe connection is interested around. Convention
 * for the example: the client passes it as the first key of the request scope's
 * `mutations` map. An empty `observe(MutationScope({}))` therefore yields an
 * undefined viewer — a GLOBAL observer that sees every mutation (backward
 * compatible). A real app would resolve this from the authenticated session.
 */
export function resolveViewer(record: MutationScope): string | undefined {
  if (!record.mutations) return undefined;
  for (const key of record.mutations.keys()) return key;
  return undefined;
}

/**
 * The subjective area-of-interest policy. Is `target` relevant to the connection
 * viewing around `viewerId`? A missing viewer (global observer) or an entity
 * without a position (a system/global entity) is always visible; otherwise the
 * target must be within `AOI_RADIUS` of the viewer. Swap this body for room id /
 * faction / line-of-sight as a game requires — ECS owns the routing mechanism,
 * this function is the injected policy.
 */
function canSee(
  ecs: GameWorld,
  viewerId: string | undefined,
  targetId: string,
  target: Entity,
): boolean {
  if (!viewerId || targetId === viewerId) return true;
  const viewer = ecs.entity(viewerId);
  if (!viewer?.position || !target.position) return true;
  const dx = (target.position.x ?? 0) - (viewer.position.x ?? 0);
  const dy = (target.position.y ?? 0) - (viewer.position.y ?? 0);
  return dx * dx + dy * dy <= AOI_RADIUS_SQ;
}

/** Frame a routed batch as a server-stream response the client matches by messageId. */
export function frameBatch(methodId: number, messageId: string, batch: GameBatch): Uint8Array {
  const scope = MutationScope({ mutations: batch as unknown as Map<string, MutationRecord> });
  // Copy the serialized scope into an owned array before re-entering bebop's
  // shared write buffer via Message.encode (inside encodeServerStreamFrame).
  const data = new Uint8Array(MutationScope.encode(scope));
  return encodeServerStreamFrame({ methodId, messageId, data });
}

/**
 * The interest-filtered snapshot a connection's `observe` yields first: an insert
 * per entity its viewer can currently see.
 */
export function interestSnapshot(ecs: GameWorld, viewerId: string | undefined): GameBatch {
  return ecs.snapshotMutations((id, entity) => canSee(ecs, viewerId, id, entity));
}

/**
 * Register the interest-managed observer for one connection and return its
 * unsubscribe. The `deliver` path is GENERATOR-FREE — it frames the filtered
 * batch and writes it straight to the live socket — so it keeps working after a
 * hibernation wake (when the original `observe` generator is gone). Shared by
 * the initial `observe` call and the wake-time {@link rehydrateGameConnection}.
 */
export function registerInterestObserver(
  ecs: GameWorld,
  ws: WebSocket,
  sub: ObserveSub,
): () => void {
  const { messageId, methodId, viewerId } = sub;
  return ecs.observeMutations({
    interested: (id, mutation) => {
      // On delete the entity is gone from the world; read its last state from
      // the mutation payload, not world.entity(id).
      const target = mutation.tag === 3 ? mutation.value.entity : ecs.entity(id);
      return target ? canSee(ecs, viewerId, id, target) : false;
    },
    deliver: (batch) => {
      try {
        // readyState 1 === OPEN; skip a closing/closed socket.
        if (ws.readyState === 1) ws.send(frameBatch(methodId, messageId, batch));
      } catch {
        /* best-effort: socket may be gone */
      }
    },
  });
}

/**
 * Register an interest observer AND wire its per-connection teardown (unsubscribe
 * + clear the persisted subscription on socket close/error). Returns the
 * unsubscribe so a generator-backed caller can also cancel its stream.
 */
export function subscribeConnection(ecs: GameWorld, ws: WebSocket, sub: ObserveSub): () => void {
  const unobserve = registerInterestObserver(ecs, ws, sub);
  registerConnectionTeardown(ws, () => {
    unobserve();
    clearSub(ws);
  });
  return unobserve;
}

/**
 * Rebuild a connection's interest observer from its persisted subscription after
 * a hibernation wake. Registered as `rehydrateConnection` in `defineECSRuntime`
 * and invoked by the durable object for each live socket once the world has been
 * re-seeded. No-op for sockets without a persisted `observe` subscription.
 */
export function rehydrateGameConnection(ecs: GameWorld, ws: WebSocket): void {
  const sub = readSub(ws);
  if (!sub) return;
  subscribeConnection(ecs, ws, sub);
}
