import type { Archetype } from "./Archetype";
import type { ECS } from "./ECS";
import type { CustomAction, GenericAction } from "./Actions";
import { query as buildQuery, type Query, type QueryBuilder } from "./Query";
import type { BaseEntity } from "./types";

export type BaseSystem = {
  readonly query: Query;
};

export type EntitySystem<
  State extends Record<string, unknown>,
  UpdateArguments extends unknown[],
  Actions extends GenericAction,
  Tags extends number = number,
  E extends BaseEntity<Tags> = BaseEntity<Tags>,
  D = unknown,
> = BaseSystem & {
  /**
   * 0 = entitySystem
   * 1 = archetypeSystem
   */
  readonly type: 0;
  execute(
    entities: Array<string>,
    world: ECS<State, UpdateArguments, Actions, Tags, E, D>,
    ...args: UpdateArguments
  ): void;
};

export type ArchetypeSystem<
  State extends Record<string, unknown>,
  UpdateArguments extends unknown[],
  Actions extends GenericAction,
  Tags extends number = number,
  E extends BaseEntity<Tags> = BaseEntity<Tags>,
  D = unknown,
> = BaseSystem & {
  /**
   * 0 = entitySystem
   * 1 = archetypeSystem
   */
  readonly type: 1;
  execute(
    archetypes: Set<Archetype>,
    world: ECS<State, UpdateArguments, Actions, Tags, E, D>,
    ...args: UpdateArguments
  ): void;
};

export type EventSystem = BaseSystem & {
  /**
   * 0 = entitySystem
   * 1 = archetypeSystem
   */
  readonly type: 2;
  execute(entities: Array<string>): void;
};

export type LifecycleSystem = BaseSystem & {
  /**
   * 0 = entitySystem
   * 1 = archetypeSystem
   */
  readonly type: 3;
  execute(entity: string): void;
};

export type Behavior<
  State extends Record<string, unknown>,
  UpdateArguments extends unknown[],
  Actions extends GenericAction,
  Tags extends number = number,
  E extends BaseEntity<Tags> = BaseEntity<Tags>,
  D = unknown,
> = BaseSystem & {
  readonly type: 4;
  tag: number;
  handler: (
    world: ECS<State, UpdateArguments, Actions, Tags, E, D>,
    entity: E,
    event: CustomAction<Actions>,
  ) => void | Promise<void>;
  priority: number | undefined; // Higher priority runs first
};

export type System<
  State extends Record<string, unknown>,
  UpdateArguments extends unknown[],
  Actions extends GenericAction,
  Tags extends number = number,
  E extends BaseEntity<Tags> = BaseEntity<Tags>,
  D = unknown,
> =
  | EntitySystem<State, UpdateArguments, Actions, Tags, E, D>
  | ArchetypeSystem<State, UpdateArguments, Actions, Tags, E, D>
  | EventSystem
  | LifecycleSystem
  | Behavior<State, UpdateArguments, Actions, Tags, E, D>;

/**
 * An entity system is a system that will be executed for each archetype matching the query.
 * In other words, it may be executed multiple times in each update.
 * If you need the system to only execute once in each update, use the `ArchetypeSystem` created by `createArchetypeSystem`
 * @param execute
 * @param query
 * @returns
 */
export function createEntitySystem<
  State extends Record<string, unknown>,
  UpdateArguments extends unknown[],
  Actions extends GenericAction,
  Tags extends number = number,
  E extends BaseEntity<Tags> = BaseEntity<Tags>,
  D = unknown,
>(
  execute: (
    entities: Array<string>,
    world: ECS<State, UpdateArguments, Actions, Tags, E, D>,
    ...args: UpdateArguments
  ) => void,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): EntitySystem<State, UpdateArguments, Actions, Tags, E, D> {
  query = typeof query === "function" ? buildQuery(query) : query;
  return Object.freeze({
    execute,
    query,
    type: 0,
  });
}

/**
 * An archetype system is a system that that will only execute once in each update with all the archetypes matching the query.
 * This is usefull when your query potentially matches 2 or more archetypes and you need to check for the presence of a componentId on entities.
 * The differing components can be checked for once for each archetype instead of for each entity.
 * @param execute
 * @param queryParams
 * @returns
 */
export function createArchetypeSystem<
  State extends Record<string, unknown>,
  UpdateArguments extends unknown[],
  ReturnArguments,
  Actions extends GenericAction,
  Tags extends number = number,
  E extends BaseEntity<Tags> = BaseEntity<Tags>,
  D = unknown,
>(
  execute: (
    archetypes: Set<Archetype>,
    world: ECS<State, UpdateArguments, Actions, Tags, E, D>,
    ...args: UpdateArguments
  ) => ReturnArguments,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): ArchetypeSystem<State, UpdateArguments, Actions, Tags, E, D> {
  query = typeof query === "function" ? buildQuery(query) : query;
  return Object.freeze({
    execute,
    query,
    type: 1,
  });
}

/**
 * An archetype system is a system that that will only execute once in each update with all the archetypes matching the query.
 * This is usefull when your query potentially matches 2 or more archetypes and you need to check for the presence of a componentId on entities.
 * The differing components can be checked for once for each archetype instead of for each entity.
 * @param execute
 * @param queryParams
 * @returns
 */
export function createEventSystem(
  execute: (entities: Array<string>) => void,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): EventSystem {
  query = typeof query === "function" ? buildQuery(query) : query;
  return Object.freeze({
    execute,
    query,
    type: 2,
  });
}

export function createLifecycleSystem(
  execute: (entity: string) => void,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): LifecycleSystem {
  query = typeof query === "function" ? buildQuery(query) : query;
  return Object.freeze({
    execute,
    query,
    type: 3,
  });
}

export function createBehavior<
  State extends Record<string, unknown>,
  UpdateArguments extends unknown[],
  Actions extends GenericAction,
  Tags extends number = number,
  E extends BaseEntity<Tags> = BaseEntity<Tags>,
  D = unknown,
>(
  tag: number,
  handler: (
    world: ECS<State, UpdateArguments, Actions, Tags, E, D>,
    entity: E,
    event: CustomAction<Actions>,
  ) => void | Promise<void>,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
  priority?: number,
): Behavior<State, UpdateArguments, Actions, Tags, E, D> {
  query = typeof query === "function" ? buildQuery(query) : query;
  return Object.freeze({
    tag,
    handler,
    query,
    priority,
    type: 4,
  });
}
