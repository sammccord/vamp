import type { ServerContext } from "@tempojs/server";
import { createEventIterator } from "@vamp/utils/create-event-iterator";
import {
  type Actions,
  BaseRpcService,
  type Entity,
  type MutationRecord,
  MutationScope,
  TempoServiceRegistry,
  type TickRequest,
  TickResult,
} from "./bebop";
import type { GameContext } from "./game.generated";

/**
 * The runtime-configurable world context for this example. It is derived per
 * Durable Object at bootstrap from the handler's request (see `resolveContext`
 * in `index.ts`) and survives hibernation via the persisted seed. `faction` is
 * applied as the default faction for entities spawned into this world, so the
 * world's runtime context is observable through the `spawn` RPC response.
 */
export type GameWorldContext = { faction: number; seededAt: number };

/** The example's ECS context tuple, typed with the world context above. */
type WorldContext = GameContext<{}, GameWorldContext>;

/**
 * Active observer sinks, keyed at module scope.
 *
 * The tempo service registry invokes service methods *unbound* (it stores
 * `service.spawn` etc. as the method `invoke`), so `this` is not available
 * inside the handlers. We therefore keep shared state at module scope rather
 * than on the instance. The service is a per-isolate singleton, so this is
 * equivalent to instance state for a single durable object.
 */
const observers = new Set<(scope: MutationScope) => void>();

/**
 * Per-connection teardown callbacks, keyed by the underlying WebSocket. The
 * `observe` generator registers a callback that removes its sink and ends its
 * stream here, so the durable object's connection-close path can drive it on
 * disconnect/error — not only when the generator happens to be returned. Keyed
 * weakly so a dropped socket does not leak the map entry.
 */
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

/** Forward a batch of ECS mutations to every active observer. */
function broadcast(mutations: Map<string, MutationRecord>): void {
  if (mutations.size === 0) return;
  const scope = MutationScope({ mutations });
  for (const emit of observers) emit(scope);
}

/**
 * The RPC service implementation for the basic example.
 *
 * - `spawn` inserts an entity into the ECS and streams the resulting mutation
 *   to all active observers.
 * - `act` dispatches the action through the registered behaviors (see
 *   `registerGameSystems`); `act` propagates down the entity's children, so an
 *   `AreaAttack` on a parent cascades through its subtree.
 * - `tick` advances the server simulation N frames via `ecs.update()` (running
 *   every registered system), one mutation scope / Yjs transaction per frame,
 *   and reports server-measured timing. Used by the FPS stress benchmark.
 * - `observe` yields a snapshot of the current world, then streams every
 *   subsequent mutation produced by `spawn`/`act`/`tick`.
 *
 * The ECS-produced mutation records are wire-compatible with the generated
 * bebop `MutationScope`, so they can be forwarded directly to observers.
 */
@TempoServiceRegistry.register(BaseRpcService.serviceName)
export class RpcService extends BaseRpcService {
  public async spawn(record: Entity, context: ServerContext): Promise<Entity> {
    const [ecs] = context.getEnvironment<WorldContext>();

    // Strip the bebop `encode` method so the record is a plain, cloneable data
    // object (the ECS structuredClones inserts, and functions cannot be cloned).
    const entity = { ...(record as Entity) } as Entity;
    delete (entity as Record<string, unknown>).encode;

    // Default the entity's faction to the world's runtime-configured faction
    // (derived per-DO from the handler request; see `resolveContext`). Only when
    // the client did not specify one, so explicit factions still win.
    if (entity.faction === undefined) entity.faction = ecs.context.faction;

    const { result, mutations } = await ecs.withScope(() => ecs.insert(entity));
    broadcast(mutations as unknown as Map<string, MutationRecord>);
    return result;
  }

  public async act(record: Actions, context: ServerContext): Promise<Actions> {
    const [ecs] = context.getEnvironment<GameContext>();

    const target = record.value.target;
    const { mutations } = await ecs.withScope(async () => {
      if (!target) return;
      if (!ecs.entity(target)) return;
      // Entities spawned since the last `update()` only have a *deferred* behavior
      // cache rebuild pending. This DO is purely reactive (no tick loop unless the
      // client calls `tick`), so force the rebuild here to guarantee `act`
      // dispatches to the registered behaviors. Cached at the archetype level, so
      // repeated dispatches to the same shape are cheap.
      if (!ecs.entityBehaviorCache.has(target)) ecs.rebuildBehaviorCache(target);
      // Dispatch through the registered behaviors. `act` runs the behaviors whose
      // query matches the target, then propagates the same action down to every
      // child (so AreaAttack on a parent cascades through its subtree).
      await ecs.act(target, record);
    });

    broadcast(mutations as unknown as Map<string, MutationRecord>);
    return record;
  }

  public async tick(record: TickRequest, context: ServerContext): Promise<TickResult> {
    const [ecs] = context.getEnvironment<GameContext>();

    const steps = Math.max(1, record.steps ?? 1);
    const start = performance.now();
    for (let i = 0; i < steps; i++) {
      // One scope (one Yjs transaction) per frame: systems' mutations are
      // coalesced, flushed to the doc, and broadcast to observers exactly like a
      // server-authoritative tick.
      const { mutations } = await ecs.withScope(() => {
        ecs.update();
      });
      broadcast(mutations as unknown as Map<string, MutationRecord>);
    }
    const micros = Math.max(0, Math.round((performance.now() - start) * 1000));

    return TickResult({ frames: steps, entities: ecs.entities.size, micros });
  }

  public async *observe(
    _record: MutationScope,
    context: ServerContext,
  ): AsyncGenerator<MutationScope, void, undefined> {
    const [ecs, ws] = context.getEnvironment<GameContext>();

    // 1. Initial snapshot: every existing entity as an insert.
    const snapshot = new Map<string, MutationRecord>();
    for (const [id, entity] of ecs.entities) {
      snapshot.set(id, { tag: 1, value: { entity } } as MutationRecord);
    }
    if (snapshot.size > 0) {
      yield MutationScope({ mutations: snapshot });
    }

    // 2. Stream subsequent mutations produced by spawn/act.
    yield* createEventIterator<MutationScope>(({ emit, cancel }) => {
      const sink = (scope: MutationScope) => emit(scope);
      observers.add(sink);
      // Register with the connection so the durable object's close/error path
      // can drive this stream to completion (which removes the sink). Without
      // this, a disconnect would leave the sink in `observers` until the next
      // broadcast happened to fail a send and return the generator.
      const unregister = registerConnectionTeardown(ws, () => {
        observers.delete(sink);
        cancel();
      });
      // The cleanup callback runs on natural generator return/throw too, so the
      // sink and the registration are removed exactly once regardless of path.
      return () => {
        observers.delete(sink);
        unregister();
      };
    });
  }
}
