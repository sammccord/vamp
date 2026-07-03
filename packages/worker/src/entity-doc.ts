/**
 * Pure operations on a shard's entity model stored in a Yjs document.
 * Extracted from {@link ECSDurableObject} (like {@link reconcile-helpers}) so
 * the CRDT-level invariants can be unit-tested against a plain `Y.Doc` without
 * a workerd isolate.
 *
 * Layout: one map, {@link GLOBAL_ENTITIES_KEY} — `id → Y.Map` of components.
 * In the root-keyed sharding model a shard doc's entity set IS its membership:
 * an entity exists in a shard iff its id is present here, so there is no
 * separate refcount or membership index. (The pre-sharding cross-namespace
 * model — refcounts, per-namespace membership sets, orphan reaping — was
 * removed with it.)
 *
 * The `write*` helpers assume they run inside a surrounding `doc.transact()`
 * (the DO batches a whole flush into one).
 */

import { clonePlainValue } from "@vampgg/ecs";
import { type Doc, Map as YMap } from "yjs";

import { GLOBAL_ENTITIES_KEY } from "./reconcile-helpers";

/** The shard's `id → components` store — its entity set and membership. */
export function entitiesMap(doc: Doc): YMap<YMap<unknown>> {
  return doc.getMap<YMap<unknown>>(GLOBAL_ENTITIES_KEY);
}

/**
 * Read every entity in a shard doc as plain objects, backfilling each `id` from
 * its map key (the key is the id; it is not stored as a component). The whole set
 * sharing a shard key — e.g. all entities of one `character/<id>`. Pure read used
 * by the provider's bulk `entities()` accessor and node-testable without workerd.
 */
export function readAllEntities<E>(doc: Doc): E[] {
  const entities = entitiesMap(doc);
  const out: E[] = [];
  for (const [id, emap] of entities) {
    const raw = emap.toJSON() as Record<string, unknown>;
    if (raw.id === undefined) raw.id = id;
    out.push(raw as E);
  }
  return out;
}

/**
 * Deep-clone object/array values before they enter the Yjs document. Yjs stores
 * by reference; a later in-place mutation of the same object would change the
 * Y.Map cell with no update and silently diverge peers. Scalars pass through.
 */
export function cloneComponentValue(value: unknown): unknown {
  return value !== null && typeof value === "object" ? clonePlainValue(value) : value;
}

/**
 * Write an entity's component data into the shard's entity set: create-or-reuse
 * its nested map and populate component keys. Reuse (rather than replace) means
 * an entity already created by a co-subscriber is shared, never duplicated.
 * Assumes a surrounding transaction.
 */
export function writeEntityInsert(doc: Doc, id: string, entity: Record<string, unknown>): void {
  const entities = entitiesMap(doc);
  let map = entities.get(id);
  if (!map) {
    map = new YMap<unknown>();
    entities.set(id, map);
  }
  for (const key in entity) {
    // `id` is the map key — storing it as a component too is pure redundancy.
    // Readers backfill it from the key (`_addEntityFromDoc`, `ECSStorage.entity`).
    if (key === "id") continue;
    if (Object.prototype.hasOwnProperty.call(entity, key)) {
      const val = entity[key];
      if (val !== undefined) map.set(key, cloneComponentValue(val));
    }
  }
}

/**
 * Remove an entity from its shard doc. A shard's entity set *is* its
 * membership, so a delete is simply dropping the entity's map from
 * {@link GLOBAL_ENTITIES_KEY}. Syncs to every subscriber of the shard.
 * Assumes a surrounding transaction.
 */
export function removeEntity(doc: Doc, id: string): void {
  entitiesMap(doc).delete(id);
}

/** Apply a component delta (set/delete keys) to an entity. Assumes a surrounding transaction. */
export function writeUpdate(doc: Doc, id: string, delta: Record<string, unknown>): void {
  const map = entitiesMap(doc).get(id);
  if (!map) return;
  for (const key in delta) {
    if (Object.prototype.hasOwnProperty.call(delta, key)) {
      const val = delta[key];
      if (val === undefined) map.delete(key);
      else map.set(key, cloneComponentValue(val));
    }
  }
}
