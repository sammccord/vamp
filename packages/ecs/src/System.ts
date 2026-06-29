import type { Archetype } from "./Archetype";
import type { ECS } from "./ECS";
import type { CustomAction, GenericAction } from "./Actions";
import { query as buildQuery, type Query, type QueryBuilder } from "./Query";
import type { BaseEntity } from "./types";

/**
 * Discriminator for the {@link System} union. Numeric values are load-bearing
 * (the update loop and registration dispatch on them); they are NOT serialized,
 * so the names — not the numbers — are the API. Use these constants instead of
 * raw `0..4` literals everywhere a system's `type` is read.
 */
export enum SystemType {
  Entity = 0,
  Archetype = 1,
  Event = 2,
  Lifecycle = 3,
  Behavior = 4,
}

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
  readonly type: SystemType.Entity;
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
  readonly type: SystemType.Archetype;
  execute(
    archetypes: Set<Archetype>,
    world: ECS<State, UpdateArguments, Actions, Tags, E, D>,
    ...args: UpdateArguments
  ): void;
};

export type EventSystem = BaseSystem & {
  readonly type: SystemType.Event;
  execute(entities: Array<string>): void;
};

export type LifecycleSystem = BaseSystem & {
  readonly type: SystemType.Lifecycle;
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
  readonly type: SystemType.Behavior;
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
    type: SystemType.Entity,
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
    type: SystemType.Archetype,
  });
}

/**
 * An event system runs reactively (via {@link ECS.subscribe}) whenever an entity
 * matching `query` changes, rather than every update cycle. The executor receives
 * the matching entity ids.
 * @param execute
 * @param query
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
    type: SystemType.Event,
  });
}

/**
 * A lifecycle system runs once per entity when it is created ({@link ECS.onCreate})
 * or deleted ({@link ECS.onDelete}) and matches `query`. The executor receives the
 * single entity id.
 * @param execute
 * @param query
 * @returns
 */
export function createLifecycleSystem(
  execute: (entity: string) => void,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): LifecycleSystem {
  query = typeof query === "function" ? buildQuery(query) : query;
  return Object.freeze({
    execute,
    query,
    type: SystemType.Lifecycle,
  });
}

/**
 * Create an event-driven {@link Behavior} for {@link ECS.registerBehavior}, keyed
 * by an action `tag`. When {@link ECS.act} dispatches that tag to an entity
 * matching `query`, `handler(world, entity, event)` runs. An optional `priority`
 * orders behaviors sharing a tag.
 * @param tag action tag this behavior responds to
 * @param handler runs against the world + struck entity + action payload
 * @param query which entities this behavior applies to
 * @param priority higher runs first among behaviors for the same tag
 */
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
    type: SystemType.Behavior,
  });
}
