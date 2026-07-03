---
"@vampgg/worker": minor
---

Add an explicit shard-subscription API and a bulk entity read to the durable-object surface, so apps can build "get character" / "load character" flows.

- `ECSStorage.entities(): E[]` — bulk-read every entity in a shard's authoritative doc. A provider DO is per-root, so this is exactly the set sharing a shard key (e.g. all entities of one `character/<id>`), backing a lobby-free "get character" read. Synchronous, mirroring `entity(id)`; the doc is already hydrated by the provider's `blockConcurrencyWhile(onStart)` before any stub call runs.
- `ECSDurableObject.loadShard(root)` / `unloadShard(root)` — explicitly subscribe a running lobby to a shard (e.g. a player's `character/*`), importing its entities into the ECS world for systems/behaviors **without re-persisting them**. It rides the existing `syncOnce` → `_onShardSynced` hydrate path (applied under `REMOTE_ORIGIN`, which the write-forwarder never forwards back), so the provider stays the sole storage authority. This is the previously-unbuilt explicit subscribe driver — authoring an entity into a root was the only prior trigger. Subscriptions use single-pin OR-semantics: a shard stays pinned while it has entities **or** an explicit subscription, so a loaded shard survives entity-emptiness until `unloadShard` (mirroring the default root's lifetime pin). Persisted under `__vamp:subscribed` and restored on hibernation wake.

Fixes: hibernation wake restored only the lobby's own default shard — additional roots (`character/*` etc.) were silently dropped, because `initialize()` re-persisted `__vamp:shards` down to the default root *before* the wake path read it. The wake path now reads the persisted shard/subscription sets before `setup()` and re-persists the full restored set, so a re-created lobby correctly re-aggregates its multi-provider world.
