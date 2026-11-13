import type { Archetype } from "./Archetype";
import type { ECS } from "./ECS";
import type { CustomAction } from "./Actions";
import { query as buildQuery, type Query, type QueryBuilder } from "./Query";
import type { WorldTypes } from "./types";

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

export type EntitySystem<W extends WorldTypes = WorldTypes> = BaseSystem & {
  readonly type: SystemType.Entity;
  execute(entities: Array<string>, world: ECS<W>, ...args: W["args"]): void;
};

export type ArchetypeSystem<W extends WorldTypes = WorldTypes> = BaseSystem & {
  readonly type: SystemType.Archetype;
  execute(archetypes: Set<Archetype>, world: ECS<W>, ...args: W["args"]): void;
};

export type EventSystem = BaseSystem & {
  readonly type: SystemType.Event;
  execute(entities: Array<string>): void;
};

export type LifecycleSystem = BaseSystem & {
  readonly type: SystemType.Lifecycle;
  execute(entity: string): void;
};

export type Behavior<W extends WorldTypes = WorldTypes> = BaseSystem & {
  readonly type: SystemType.Behavior;
  tag: number;
  handler: (
    world: ECS<W>,
    entity: W["entity"],
    event: CustomAction<W["actions"]>,
  ) => void | Promise<void>;
  priority: number | undefined; // Higher priority runs first
};

/**
 * The handler {@link createBehavior} accepts: `event.detail` is narrowed to the
 * `W["actions"]` member whose tag is `Tag`.
 */
export type BehaviorHandler<
  W extends WorldTypes = WorldTypes,
  Tag extends W["actions"]["tag"] = W["actions"]["tag"],
> = (
  world: ECS<W>,
  entity: W["entity"],
  event: CustomAction<Extract<W["actions"], { tag: Tag }>>,
) => void | Promise<void>;

export type System<W extends WorldTypes = WorldTypes> =
  | EntitySystem<W>
  | ArchetypeSystem<W>
  | EventSystem
  | LifecycleSystem
  | Behavior<W>;

/**
 * An entity system runs once per update with the ids of every entity matching
 * the query, snapshotted before it runs (an entity it moves into another
 * matching archetype is not visited twice). The array is reused between updates,
 * so do not keep a reference to it. Use `createArchetypeSystem` to work per
 * archetype instead.
 * @param execute
 * @param query
 * @returns
 */
export function createEntitySystem<W extends WorldTypes = WorldTypes>(
  execute: (entities: Array<string>, world: ECS<W>, ...args: W["args"]) => void,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): EntitySystem<W> {
  query = query instanceof Function ? buildQuery(query) : query;
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
export function createArchetypeSystem<W extends WorldTypes = WorldTypes>(
  execute: (archetypes: Set<Archetype>, world: ECS<W>, ...args: W["args"]) => void,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): ArchetypeSystem<W> {
  query = query instanceof Function ? buildQuery(query) : query;
  return Object.freeze({
    execute,
    query,
    type: SystemType.Archetype,
  });
}

/**
 * An event system runs reactively (via {@link ECS.subscribe}) whenever an entity
 * matching `query` changes, rather than every update cycle. The executor
 * receives the ids that changed, including an entity that was just deleted
 * (reading it then returns `undefined`). `subscribe(system, true)` also runs it
 * once over every current match.
 * @param execute
 * @param query
 * @returns
 */
export function createEventSystem(
  execute: (entities: Array<string>) => void,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
): EventSystem {
  query = query instanceof Function ? buildQuery(query) : query;
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
  query = query instanceof Function ? buildQuery(query) : query;
  return Object.freeze({
    execute,
    query,
    type: SystemType.Lifecycle,
  });
}

/**
 * Create an event-driven {@link Behavior} for {@link ECS.registerBehavior}, keyed
 * by an action `tag`. When {@link ECS.act} dispatches that tag to an entity
 * matching `query`, `handler(world, entity, event)` runs with `event.detail`
 * narrowed to the `W["actions"]` member for `tag`. An optional `priority` orders
 * behaviors sharing a tag.
 * @param tag action tag this behavior responds to
 * @param handler runs against the world + struck entity + action payload
 * @param query which entities this behavior applies to
 * @param priority higher runs first among behaviors for the same tag
 */
export function createBehavior<
  W extends WorldTypes = WorldTypes,
  Tag extends W["actions"]["tag"] = W["actions"]["tag"],
>(
  tag: Tag,
  handler: BehaviorHandler<W, Tag>,
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder),
  priority?: number,
): Behavior<W> {
  query = query instanceof Function ? buildQuery(query) : query;
  return Object.freeze({
    tag,
    // SAFETY: ECS.act looks behaviors up by the dispatched action's own tag
    // (ECS.ts behavior cache), so this handler only ever receives actions whose
    // tag is `Tag`, i.e. `Extract<W["actions"], { tag: Tag }>`.
    handler: handler as Behavior<W>["handler"],
    query,
    priority,
    type: SystemType.Behavior,
  });
}
