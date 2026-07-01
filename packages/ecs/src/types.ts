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
