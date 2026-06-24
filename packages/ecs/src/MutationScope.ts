import { MutationRecord, MutationType } from "./types";

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
    // Shallow-copy the entity to break the shared reference between the caller's
    // object and the scope's shadow/mutation record. This matches the
    // framework's "entities are flat data" contract (the same `{ ...entity }`
    // strategy `initializeFromParent` already uses). It is both cheaper than
    // `structuredClone` and, unlike it, never throws on non-cloneable fields
    // (functions, class instances, etc.). NOTE: nested mutable fields are shared
    // by reference, not deep-copied — entities are expected to hold flat,
    // value-like data.
    const clonedEntity = { ...entity };

    // The map holds the single NET record per id, so an insert always overwrites
    // whatever was there — including a Delete left by a prior delete-then-recreate
    // in the same scope. Setting a fresh Insert record (rather than mutating the
    // old one in place) keeps records immutable and drops an unsafe double cast.
    this.mutations.set(entityId, MutationRecord.fromInsert<E, D>({ entity: clonedEntity }));

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

  /**
   * Merge a coalesced mutation record from a nested (inner) scope into this
   * (parent) scope, routing it through this scope's own insert/update/delete
   * coalescing so the parent's shadow + mutation map stay consistent. Used when
   * a nested `withScope` exits: inner writes become visible to the parent's
   * shadow but only commit when the OUTERMOST scope flushes (transactional
   * atomicity).
   */
  applyMutation(id: string, record: MutationRecord<E, D>): void {
    switch (record.tag) {
      case MutationType.Insert:
        this.insert(id, record.value.entity);
        break;
      case MutationType.Update:
        this.update(id, record.value.delta);
        break;
      case MutationType.Delete:
        this.delete(id, record.value.entity);
        break;
    }
  }

  clear(): void {
    this.mutations.clear();
    this.shadowEntities.clear();
    this.deletedIds.clear();
  }
}
