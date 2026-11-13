import type { GenericAction } from "./Actions";

/**
 * The minimum shape an entity must have for the ECS to manage hierarchy.
 * Consumer entity types should extend this interface.
 * Fields are optional to remain compatible with message/schema-generated types
 * where all fields are optional by convention.
 */
export type BaseEntity<Tags extends number = number> = {
  id?: string;
  sk?: string;
  parent?: string;
  children?: Array<string>;
  tags?: Tags[];
};

export enum MutationType {
  Insert = 1,
  Update = 2,
  Delete = 3,
}

export type InsertMutation<E> = { tag: 1; value: { entity: E } };
export type UpdateMutation<D> = { tag: 2; value: { delta: D } };
export type DeleteMutation<E> = { tag: 3; value: { entity: E } };

export type MutationRecord<E, D> = InsertMutation<E> | UpdateMutation<D> | DeleteMutation<E>;

export const MutationRecord = Object.freeze({
  fromInsert<E, D>(value: { entity: E }): MutationRecord<E, D> {
    return { tag: 1, value };
  },
  fromUpdate<E, D>(value: { delta: D }): MutationRecord<E, D> {
    return { tag: 2, value };
  },
  fromDelete<E, D>(value: { entity: E }): MutationRecord<E, D> {
    return { tag: 3, value };
  },
});

export type EntityMutator<E, D> = (id: string, mutation: MutationRecord<E, D>) => void;

/**
 * Every type an ECS world is parameterized by, named rather than positional:
 * the entity shape, its delta, the per-world context (`state`), the extra
 * arguments every `update()` passes to systems (`args`), the action union, and
 * the tag id space. Build one with {@link DefineWorld}, which fills defaults.
 */
export interface WorldTypes {
  entity: BaseEntity;
  delta: unknown;
  state: object;
  args: unknown[];
  actions: GenericAction;
  tags: number;
}

/**
 * A {@link WorldTypes} from the keys you care about. Only `entity` is required;
 * the rest default to `delta: unknown`, `state: {}`, `args: []`,
 * `actions: GenericAction`, and `tags: number`.
 *
 * @example
 * type GameWorld = DefineWorld<{ entity: Entity; delta: EntityDelta; actions: Actions }>;
 * const world = new ECS<GameWorld>(entities, mutate, {}, options);
 */
export type DefineWorld<T extends { entity: BaseEntity } & Partial<WorldTypes>> = {
  entity: T["entity"];
  delta: T extends { delta: infer D } ? D : unknown;
  state: T extends { state: infer S extends object } ? S : {};
  args: T extends { args: infer A extends unknown[] } ? A : [];
  actions: T extends { actions: infer A extends GenericAction } ? A : GenericAction;
  tags: T extends { tags: infer G extends number } ? G : number;
};
