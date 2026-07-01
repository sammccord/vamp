import type { BaseEntity, ECS, MutationBatch } from "@vampgg/ecs";

/**
 * The ECS surface the client drives, with the non-essential type parameters
 * erased. A game's concrete `ECS<State, UpdateArguments, Actions, Tags, E, D>` is
 * assignable to this regardless of its `State`/`UpdateArguments`/`Actions`/`Tags`
 * — only the entity (`E`) and delta (`D`) types are load-bearing on the client,
 * where the world is a read-replica and is never `update()`-ticked.
 *
 * The four erased params are intentionally `any` (not `unknown`): the ECS class
 * uses them in both input and output positions, so `any` keeps any concrete world
 * assignable here regardless of its State/Actions/Tags.
 */
export type AnyECS<E extends BaseEntity = BaseEntity, D = unknown> = ECS<any, any, any, any, E, D>;

/**
 * A stream frame carrying a coalesced `MutationBatch` keyed by entity id — the
 * envelope a generated bebop `observe`-style stream yields (`MutationScope`). This
 * is the transport shape; the batch itself is the ECS's own {@link MutationBatch},
 * applied via `world.applyMutations`. Kept here (not in `@vampgg/ecs`) because the
 * `{ mutations }` envelope is schema/transport-specific, not universal ECS currency.
 */
export interface WireBatch<E extends BaseEntity, D> {
  mutations?: MutationBatch<E, D>;
}

export type ConnectionStatus = "connecting" | "open" | "closed";

/** The `EventSystem` accepted by `ECS.subscribe`, derived to avoid re-exporting internals. */
export type EventSystemArg = Parameters<AnyECS["subscribe"]>[0];

/** The `LifecycleSystem` accepted by `ECS.onCreate`/`onDelete`. */
export type LifecycleSystemArg = Parameters<AnyECS["onCreate"]>[0];
