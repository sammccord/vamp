import type { ServerContext } from "@tempojs/server";
import { createEventIterator } from "@vamp/utils/create-event-iterator";
import {
  type Actions,
  BaseRpcService,
  type Entity,
  type MutationRecord,
  MutationScope,
  TempoServiceRegistry,
} from "./bebop";
import type { EntityDelta, GameContext } from "./game.generated";

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

/** Forward a batch of ECS mutations to every active observer. */
function broadcast(mutations: Map<string, MutationRecord>): void {
  if (mutations.size === 0) return;
  const scope = MutationScope({ mutations });
  for (const emit of observers) emit(scope);
}

/**
 * A naive RPC service implementation for the basic example.
 *
 * - `spawn` inserts an entity into the ECS and streams the resulting mutation
 *   to all active observers.
 * - `act` applies a trivial bit of game logic (damage to the target's health
 *   pool) and streams the resulting mutation.
 * - `observe` yields a snapshot of the current world, then streams every
 *   subsequent mutation produced by `spawn`/`act`.
 *
 * The ECS-produced mutation records are wire-compatible with the generated
 * bebop `MutationScope`, so they can be forwarded directly to observers.
 */
@TempoServiceRegistry.register(BaseRpcService.serviceName)
export class RpcService extends BaseRpcService {
  public async spawn(record: Entity, context: ServerContext): Promise<Entity> {
    const [ecs] = context.getEnvironment<GameContext>();

    // Strip the bebop `encode` method so the record is a plain, cloneable data
    // object (the ECS structuredClones inserts, and functions cannot be cloned).
    const entity = { ...(record as Entity) } as Entity;
    delete (entity as Record<string, unknown>).encode;

    const { result, mutations } = await ecs.withScope(() => ecs.insert(entity));
    broadcast(mutations as unknown as Map<string, MutationRecord>);
    return result;
  }

  public async act(record: Actions, context: ServerContext): Promise<Actions> {
    const [ecs] = context.getEnvironment<GameContext>();

    const { mutations } = await ecs.withScope(() => {
      const target = record.value.target;
      const damage = record.value.damage ?? 0;
      if (!target || damage === 0) return;
      const entity = ecs.entity(target);
      if (!entity) return;
      // Health is an additive pool delta; subtract the incoming damage.
      ecs.put(target, { health: { points: -damage } } as EntityDelta);
    });

    broadcast(mutations as unknown as Map<string, MutationRecord>);
    return record;
  }

  public async *observe(
    _record: MutationScope,
    context: ServerContext,
  ): AsyncGenerator<MutationScope, void, undefined> {
    const [ecs] = context.getEnvironment<GameContext>();

    // 1. Initial snapshot: every existing entity as an insert.
    const snapshot = new Map<string, MutationRecord>();
    for (const [id, entity] of ecs.entities) {
      snapshot.set(id, { tag: 1, value: { entity } } as MutationRecord);
    }
    if (snapshot.size > 0) {
      yield MutationScope({ mutations: snapshot });
    }

    // 2. Stream subsequent mutations produced by spawn/act.
    yield* createEventIterator<MutationScope>(({ emit }) => {
      const sink = (scope: MutationScope) => emit(scope);
      observers.add(sink);
      return () => {
        observers.delete(sink);
      };
    });
  }
}
