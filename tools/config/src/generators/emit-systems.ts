/**
 * Emits app-typed aliases for the generic system types and factories from
 * `@vamp/ecs` (`System.ts`). Each underlying type is generic over
 * `<State, UpdateArguments, Actions, Tags, E, D>`; this bakes the schema's
 * concrete `Actions`/`Tags`/`Entity`/`EntityDelta` into the last four slots and
 * leaves `State`/`UpdateArguments` open (mirroring `GameECS`/`GameContext`). The
 * point is developer ergonomics: game code calls `createGameEntitySystem(...)`
 * and gets a fully-typed `world` inside the executor without ever restating
 * `Tags`, `Entity`, or `EntityDelta`.
 *
 * The `createGame*` wrappers are *functions* (not just aliases) so the call site
 * keeps inference on `State`/`UpdateArguments` while the concrete types stay
 * pinned — a type alias alone cannot constrain the generic factory. Wrapper
 * parameter types are read back off the emitted aliases (e.g.
 * `GameEntitySystem<...>["execute"]`) so they cannot drift from `System.ts` and
 * we avoid importing `ECS`/`Archetype`/`CustomAction` just to restate them.
 */
export function emitSystems(): string {
  return `export type GameEntitySystem<
  State extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
> = EntitySystem<State, UpdateArguments, Actions, Tags, Entity, EntityDelta>;

export type GameArchetypeSystem<
  State extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
> = ArchetypeSystem<State, UpdateArguments, Actions, Tags, Entity, EntityDelta>;

export type GameBehavior<
  State extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
> = Behavior<State, UpdateArguments, Actions, Tags, Entity, EntityDelta>;

export type GameSystem<
  State extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
> = System<State, UpdateArguments, Actions, Tags, Entity, EntityDelta>;

export function createGameEntitySystem<
  State extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
>(
  execute: GameEntitySystem<State, UpdateArguments>["execute"],
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): GameEntitySystem<State, UpdateArguments> {
  return createEntitySystem(execute, query);
}

export function createGameArchetypeSystem<
  State extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
>(
  execute: GameArchetypeSystem<State, UpdateArguments>["execute"],
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): GameArchetypeSystem<State, UpdateArguments> {
  return createArchetypeSystem(execute, query);
}

export function createGameBehavior<
  State extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
>(
  tag: number,
  handler: GameBehavior<State, UpdateArguments>["handler"],
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
  priority?: number,
): GameBehavior<State, UpdateArguments> {
  return createBehavior(tag, handler, query, priority);
}`;
}
