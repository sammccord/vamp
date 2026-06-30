/**
 * Pure operations on the shared, cross-namespace entity model stored in a Yjs
 * document. Extracted from {@link ECSDurableObject} (like {@link reconcile-helpers})
 * so the CRDT-level invariants — global entity sharing, per-namespace
 * membership, and refcounted garbage collection — can be unit-tested against a
 * plain `Y.Doc` without a workerd isolate.
 *
 * Layout (see {@link reconcile-helpers} for the key names):
 *  - {@link GLOBAL_ENTITIES_KEY}: `id → Y.Map` of components. **Global** — the
 *    same id resolves to the same nested map for every namespace, so a mutation
 *    in one lobby propagates to all others observing that entity.
 *  - {@link ENTITY_REFS_KEY}: `id → Y.Map<namespace, true>`. The set of
 *    namespaces referencing an entity; its size is the GC refcount.
 *  - {@link membershipKey}(ns): `id → true` — entities a given lobby tracks.
 *
 * The `write*` helpers assume they run inside a surrounding `doc.transact()`
 * (the DO batches a whole flush into one). `migrateLegacyNamespace` and
 * `reapOrphanedEntities` open their own transaction with the supplied origin.
 */

import { type Doc, Map as YMap } from "yjs";

import { ENTITY_REFS_KEY, GLOBAL_ENTITIES_KEY, membershipKey } from "./reconcile-helpers";

/** The global `id → components` store, shared by every namespace. */
export function entitiesMap(doc: Doc): YMap<YMap<unknown>> {
  return doc.getMap<YMap<unknown>>(GLOBAL_ENTITIES_KEY);
}

/** The refcount index `id → Y.Map<namespace, true>`. */
export function refsMap(doc: Doc): YMap<YMap<boolean>> {
  return doc.getMap<YMap<boolean>>(ENTITY_REFS_KEY);
}

/** A namespace's membership set `id → true`. */
export function membersMap(doc: Doc, namespace: string): YMap<boolean> {
  return doc.getMap<boolean>(membershipKey(namespace));
}

/**
 * Deep-clone object/array values before they enter the Yjs document. Yjs stores
 * by reference; a later in-place mutation of the same object would change the
 * Y.Map cell with no update and silently diverge peers. Scalars pass through.
 */
export function cloneComponentValue(value: unknown): unknown {
  return value !== null && typeof value === "object" ? structuredClone(value) : value;
}

/** Reference an entity from a namespace (idempotent). Assumes a surrounding transaction. */
export function addRef(doc: Doc, namespace: string, id: string): void {
  const refs = refsMap(doc);
  let set = refs.get(id);
  if (!set) {
    set = new YMap<boolean>();
    refs.set(id, set);
  }
  set.set(namespace, true);
}

/**
 * Release a namespace's reference and garbage-collect the global entity when no
 * namespace references it anymore. Assumes a surrounding transaction.
 */
export function releaseRef(doc: Doc, namespace: string, id: string): void {
  const refs = refsMap(doc);
  const set = refs.get(id);
  if (!set) return;
  set.delete(namespace);
  if (set.size === 0) {
    refs.delete(id);
    entitiesMap(doc).delete(id);
  }
}

/**
 * Write only the entity's component data into the global store: create-or-reuse
 * its nested map and populate component keys. Reuse (rather than replace) means
 * an entity already created by another lobby is shared, never duplicated.
 * Assumes a surrounding transaction.
 *
 * This is the **entity-data** half of an insert. In the interest-scoped (AOI)
 * model the subscriber authors only this (its doc holds entity data, not the
 * refcount/membership index); namespace membership is recorded separately and
 * authoritatively via {@link joinNamespace}.
 */
export function writeEntityInsert(doc: Doc, id: string, entity: Record<string, unknown>): void {
  const entities = entitiesMap(doc);
  let map = entities.get(id);
  if (!map) {
    map = new YMap<unknown>();
    entities.set(id, map);
  }
  for (const key in entity) {
    // `id` is the map key (and the refs/membership key) — storing it as a
    // component too is pure redundancy (~1 of 4 id copies). Readers backfill it
    // from the key (`_addEntityFromDoc`, `ECSStorage.entity`).
    if (key === "id") continue;
    if (Object.prototype.hasOwnProperty.call(entity, key)) {
      const val = entity[key];
      if (val !== undefined) map.set(key, cloneComponentValue(val));
    }
  }
}

/**
 * Record that `namespace` references entity `id`: bump the refcount and add it to
 * the namespace's membership set. The **membership** half of an insert, kept
 * authoritative on the provider in the AOI model. Idempotent. Assumes a
 * surrounding transaction.
 */
export function joinNamespace(doc: Doc, namespace: string, id: string): void {
  addRef(doc, namespace, id);
  membersMap(doc, namespace).set(id, true);
}

/**
 * Remove `id` from `namespace`: drop membership and release the refcount,
 * GC'ing the global entity when it was the last reference. Assumes a
 * surrounding transaction.
 */
export function leaveNamespace(doc: Doc, namespace: string, id: string): void {
  membersMap(doc, namespace).delete(id);
  releaseRef(doc, namespace, id);
}

/**
 * Combined insert (entity data + namespace membership) — the full-sync path.
 * Equivalent to {@link writeEntityInsert} + {@link joinNamespace}. Assumes a
 * surrounding transaction.
 */
export function writeInsert(
  doc: Doc,
  namespace: string,
  id: string,
  entity: Record<string, unknown>,
): void {
  writeEntityInsert(doc, id, entity);
  joinNamespace(doc, namespace, id);
}

/** Apply a component delta (set/delete keys) to a global entity. Assumes a surrounding transaction. */
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

/**
 * Combined delete — the full-sync path. Alias of {@link leaveNamespace}: drop
 * membership and release the refcount (GC'ing the global entity if it was the
 * last reference). Assumes a surrounding transaction.
 */
export function writeDelete(doc: Doc, namespace: string, id: string): void {
  leaveNamespace(doc, namespace, id);
}

/**
 * Garbage-collect global entities whose refcount set is empty — the backstop for
 * a concurrent last-reference release where neither lobby observed the other's
 * removal. Safe (no false positives): an insert writes the entity and its
 * refcount in one transaction, so an empty refcount always means a genuine
 * orphan, never sync lag. Opens its own transaction. Returns the reaped ids.
 */
export function reapOrphanedEntities(doc: Doc, origin?: unknown): string[] {
  const entities = entitiesMap(doc);
  const refs = refsMap(doc);
  const orphans: string[] = [];
  for (const id of entities.keys()) {
    const set = refs.get(id);
    if (!set || set.size === 0) orphans.push(id);
  }
  if (orphans.length > 0) {
    doc.transact(() => {
      for (const id of orphans) {
        entities.delete(id);
        refs.delete(id);
      }
    }, origin);
  }
  return orphans;
}

/**
 * One-time, per-namespace migration from the legacy layout (a `Y.Array<id>`
 * named by the bare namespace + one top-level `Y.Map` per entity) to the shared
 * layout. Creates the global entity only if another namespace did not migrate it
 * first, references it from this namespace, records membership, and clears the
 * legacy array so it never runs twice. Opens its own transaction with `origin`.
 * Returns the migrated ids.
 */
export function migrateLegacyNamespace(doc: Doc, namespace: string, origin?: unknown): string[] {
  const members = membersMap(doc, namespace);
  if (members.size > 0) return []; // already migrated for this namespace
  if (!doc.share.has(namespace)) return []; // no legacy array present
  const legacyIds = doc.getArray<string>(namespace);
  if (legacyIds.length === 0) return [];

  const entities = entitiesMap(doc);
  const migrated: string[] = [];
  doc.transact(() => {
    for (const id of legacyIds.toArray()) {
      if (!entities.has(id)) {
        const legacyMap = doc.getMap<unknown>(id);
        const emap = new YMap<unknown>();
        entities.set(id, emap);
        for (const [key, value] of legacyMap.entries()) {
          if (key === "id") continue; // redundant with the map key (see writeInsert)
          emap.set(key, cloneComponentValue(value));
        }
        for (const key of [...legacyMap.keys()]) legacyMap.delete(key);
      }
      addRef(doc, namespace, id);
      members.set(id, true);
      migrated.push(id);
    }
    legacyIds.delete(0, legacyIds.length);
  }, origin);
  return migrated;
}
