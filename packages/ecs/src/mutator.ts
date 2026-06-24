import { type BaseEntity, type EntityMutator, type MutationRecord, MutationType } from "./types";

/**
 * The slice of `ECSOptions` a base mutator needs to apply a coalesced mutation
 * to a plain entity store. `ECSOptions` satisfies this structurally, so callers
 * pass their full options object directly.
 */
export interface BaseMutatorOptions<E extends BaseEntity, D> {
  mergeDelta: (entity: E, delta: D) => void;
  materializeDelta: (delta: D, base?: Partial<E>) => E;
}

export interface BaseMutatorConfig {
  /**
   * When an Update arrives for an id not present in the store, materialize the
   * delta into a fresh entity and insert it instead of no-op'ing. Client replicas
   * want this (a delta may be the first frame they see for an entity); the server,
   * which authored the Insert, does not.
   */
  materializeOnMissingUpdate?: boolean;
}

/**
 * Apply a single coalesced mutation to a flat entity store. The one canonical
 * Insert/Update/Delete switch, shared by every base mutator (server working
 * store, server flush handler, client read-replica) so they can never drift.
 */
export function applyMutation<E extends BaseEntity, D>(
  entities: Map<string, E>,
  id: string,
  mutation: MutationRecord<E, D>,
  options: BaseMutatorOptions<E, D>,
  config?: BaseMutatorConfig,
): void {
  switch (mutation.tag) {
    case MutationType.Insert:
      entities.set(id, mutation.value.entity);
      return;
    case MutationType.Update: {
      const entity = entities.get(id);
      if (entity) {
        options.mergeDelta(entity, mutation.value.delta);
      } else if (config?.materializeOnMissingUpdate) {
        entities.set(id, options.materializeDelta(mutation.value.delta, { id } as Partial<E>));
      }
      return;
    }
    case MutationType.Delete:
      entities.delete(id);
      return;
  }
}

/**
 * Build the standard base mutator (`Insert` → set, `Update` → `mergeDelta`,
 * `Delete` → remove) over an entity store, wrapping {@link applyMutation}.
 */
export function createBaseMutator<E extends BaseEntity, D>(
  entities: Map<string, E>,
  options: BaseMutatorOptions<E, D>,
  config?: BaseMutatorConfig,
): EntityMutator<E, D> {
  return (id, mutation) => applyMutation(entities, id, mutation, options, config);
}
