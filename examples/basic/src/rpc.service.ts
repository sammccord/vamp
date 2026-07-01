import type { ServerContext } from "@tempojs/server";
import {
  type Actions,
  BaseRpcService,
  type Entity,
  type MutationScope,
  TempoServiceRegistry,
  type TickRequest,
  TickResult,
} from "./bebop";
import { observe, type WorldContext } from "./observe-routing";

// Re-export the interest-broadcast lifecycle hooks the worker entry wires into
// `defineGameECSRuntime` (connection-close teardown and hibernation re-register).
export { type GameWorldContext, onConnectionClose, rehydrateConnection } from "./observe-routing";

/**
 * The RPC service implementation for the basic example.
 *
 * - `spawn` inserts an entity into the ECS. The commit auto-routes the resulting
 *   mutation to every interested observer (see ECS `observeMutations`).
 * - `act` dispatches the action through the registered behaviors (see
 *   `registerGameSystems`); `act` propagates down the entity's children, so an
 *   `AreaAttack` on a parent cascades through its subtree.
 * - `tick` advances the server simulation N frames via `ecs.update()` (running
 *   every registered system), one mutation scope / Yjs transaction per frame.
 * - `observe` registers an interest-filtered, hibernation-safe broadcast for the
 *   connection: it yields an initial filtered snapshot, then receives only the
 *   committed mutations its viewer cares about — pushed generator-free so it
 *   survives DO hibernation.
 *
 * Routing is automatic: every committed scope fans its coalesced mutations out
 * to interested observers, so the mutation handlers below no longer broadcast
 * manually.
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

    // The commit auto-routes the insert to interested observers; no manual broadcast.
    const { result } = await ecs.withScope(() => ecs.insert(entity));
    return result;
  }

  public async act(record: Actions, context: ServerContext): Promise<Actions> {
    const [ecs] = context.getEnvironment<WorldContext>();

    const target = record.value.target;
    await ecs.withScope(async () => {
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

    // The commit auto-routes the resulting mutations to interested observers.
    return record;
  }

  public async tick(record: TickRequest, context: ServerContext): Promise<TickResult> {
    const [ecs] = context.getEnvironment<WorldContext>();

    const steps = Math.max(1, record.steps ?? 1);
    const start = performance.now();
    for (let i = 0; i < steps; i++) {
      // One scope (one Yjs transaction) per frame: systems' mutations are
      // coalesced, flushed to the doc, and auto-routed to interested observers
      // exactly like a server-authoritative tick.
      await ecs.withScope(() => {
        ecs.update();
      });
    }
    const micros = Math.max(0, Math.round((performance.now() - start) * 1000));

    return TickResult({ frames: steps, entities: ecs.entities.size, micros });
  }

  public async *observe(
    record: MutationScope,
    context: ServerContext,
  ): AsyncGenerator<MutationScope, void, undefined> {
    // All interest-broadcast plumbing — viewer resolution, subscription
    // persistence, the interest-filtered snapshot, generator-free framed
    // delivery, and hibernation-safe teardown — lives in `@vampgg/worker/interest`
    // (bound to this app's types by the generated `createGameInterestBroadcast`).
    // The RPC method is just the delegation point.
    yield* observe(record, context);
  }
}
