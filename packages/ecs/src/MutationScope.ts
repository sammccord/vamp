import { type InsertMutation, MutationRecord, MutationType } from "./types";

export type MergeDeltaFn<E, D> = (entity: E, delta: D) => void;
export type AccumulateDeltaFn<D> = (from: D, to: D) => D;

export class MutationScope<E, D> {
  readonly mutations = new Map<string, MutationRecord<E, D>>();
  readonly shadowEntities = new Map<string, E>();
  readonly deletedIds = new Set<string>();

  constructor(
    private readonly _mergeDelta: MergeDeltaFn<E, D>,
    private readonly _accumulateDelta: AccumulateDeltaFn<D>,
  ) {}

  /**
   * Initialize shadow state from a parent scope for nested scope support.
   */
  initializeFromParent(parentScope: MutationScope<E, D>): void {
    for (const [id, entity] of parentScope.shadowEntities) {
      this.shadowEntities.set(id, { ...entity });
    }
    for (const id of parentScope.deletedIds) {
      this.deletedIds.add(id);
    }
  }

  /**
   * Get entity from shadow, checking deletion state.
   * Returns null if explicitly deleted, undefined if not in scope.
   */
  getShadowEntity(entityId: string): E | undefined | null {
    if (this.deletedIds.has(entityId)) return null;
    return this.shadowEntities.get(entityId);
  }

  insert(entityId: string, entity: E): void {
    // Clone entity to prevent shared reference issues
    const clonedEntity = structuredClone(entity);

    const existing = this.mutations.get(entityId);

    if (existing?.tag === MutationType.Delete) {
      // Re-creation after delete = treat as insert
      const mutable = existing as unknown as InsertMutation<E>;
      mutable.tag = 1;
      mutable.value = { entity: clonedEntity };
    } else {
      this.mutations.set(entityId, MutationRecord.fromInsert<E, D>({ entity: clonedEntity }));
    }

    // Update shadow state
    this.shadowEntities.set(entityId, clonedEntity);
    this.deletedIds.delete(entityId);
  }

  update(entityId: string, delta: D): void {
    const existing = this.mutations.get(entityId);
    const shadow = this.shadowEntities.get(entityId);

    if (!existing) {
      this.mutations.set(entityId, MutationRecord.fromUpdate<E, D>({ delta }));
      // Update shadow entity if it exists (for entities that existed before scope)
      if (shadow) {
        this._mergeDelta(shadow, delta);
      }
    } else {
      switch (existing.tag) {
        case MutationType.Delete:
          // Update after delete - ignore
          return;
        case MutationType.Insert:
          // Merge the delta into the inserted entity
          // Shadow and mutation entity are the same reference, so only merge once
          this._mergeDelta(existing.value.entity, delta);
          break;
        case MutationType.Update:
          this._accumulateDelta(existing.value.delta, delta);
          // Update shadow entity if it exists
          if (shadow) {
            this._mergeDelta(shadow, delta);
          }
          break;
      }
    }
  }

  delete(entityId: string, entity: E): void {
    const existing = this.mutations.get(entityId);

    if (existing?.tag === MutationType.Insert) {
      // Insert then delete = net zero
      this.mutations.delete(entityId);
    } else {
      this.mutations.set(entityId, MutationRecord.fromDelete<E, D>({ entity }));
    }

    // Update shadow state
    this.shadowEntities.delete(entityId);
    this.deletedIds.add(entityId);
  }

  clear(): void {
    this.mutations.clear();
    this.shadowEntities.clear();
    this.deletedIds.clear();
  }
}
