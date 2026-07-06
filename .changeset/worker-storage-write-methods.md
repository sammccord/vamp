---
"@vampgg/worker": minor
---

Add entity **write** methods to `ECSStorage`, so apps mutate a shard from inside the provider DO instead of hand-rolling a client-side read-modify-write against `getYDoc`/`update`.

Until now `ECSStorage` exposed only reads (`entity(id)`, `entities()`); the sole write path was the raw `YStreamProvider.update(syncFramedBytes)` RPC. A front worker that wanted to author an entity therefore had to pull the entire shard doc over RPC, mutate a throwaway `Y.Doc`, wrap the diff in the `MESSAGE_SYNC (0)` sync-protocol envelope, and push it back — re-implementing vamp's CRDT layout (`__vamp:entities`, `id → Y.Map` of components) and transferring the whole world on every write.

These methods run the mutation against the authoritative `doc` (O(change), not O(world)); the surrounding `doc.transact()` fires the base provider's `update` observer, which persists and broadcasts to every subscriber automatically — the same path `update()`/`compact()` already rely on. They reuse the existing internal `entity-doc` helpers (`writeEntityInsert`/`removeEntity`/`writeUpdate`) and mirror the `entity`/`entities` read side.

- `putEntity(entity): E` — insert-or-update one entity. Requires a non-empty string `entity.id` (the map key; never stored as a component). Returns the input record.
- `removeEntity(id): boolean` — delete one entity, returning whether it existed. Collapses the previous two-round-trip "check then delete" (`entity(id)` + a mutation) into one RPC; a no-op delete skips the transact entirely, so subscribers never see an empty update.
- `updateEntity(id, delta): boolean` — apply a partial component delta (defined values set keys, `undefined` deletes them), returning whether the entity existed. No-op on a missing entity.
- `putEntities(entities[]): E[]` — insert-or-update many in a single transaction (one `update` event → one persist + one broadcast) for bulk seeding. Validated up front so a bad record aborts before any partial write.
- `removeEntities(ids[]): number` — delete many in one transaction, returning the count actually removed; absent ids are skipped and the transact runs only if at least one was present.
