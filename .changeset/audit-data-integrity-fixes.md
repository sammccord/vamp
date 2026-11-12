---
"@vampgg/ecs": minor
"@vampgg/worker": minor
"@vampgg/utils": minor
"@vampgg/cli": minor
---

Fix silent data loss in mutation scopes, Yjs persistence, and stream teardown.

**`@vampgg/ecs`**

- Two updates to one entity in a scope now both commit. `MutationScope` passed `accumulateDelta` its arguments in reverse and dropped the return value, so every update after the first was lost. The contract is now documented on `AccumulateDeltaFn`: fold the newer `from` into the accumulated `to` and return the result. The scope owns its accumulated delta, so the caller's delta object is never mutated.
- Overlapping `withScope` calls (for example two RPCs awaiting I/O) no longer corrupt the world. A scope opened while another is active joins it as a child. The parent waits for its children before committing, so writes are never lost and the active-scope slot never dangles. A child that throws discards its own writes, including any the parent made while the child held the slot.
- A mutation made outside any scope while a flush handler is installed now commits immediately as a one-entry batch. Previously it went into a scope nothing ever committed.
- Breaking: the flush handler receives the committing scope as a second argument (`FlushHandler<E, D>`), and gets `undefined` for an out-of-scope commit.
- `put` on an unknown id inserts under that id, and an empty-string id on `insert` generates a fresh one. Previously both landed on the id `""` and overwrote each other.
- New `replace(id, entity)`. `applyMutations` uses it for an Insert of an existing entity: archetype membership follows the snapshot, and no delete/create lifecycle systems fire.

**`@vampgg/worker`**

- Local updates now write the merged component values to the shard doc. Previously the raw relative delta was written, persisting `{ points: -3 }` in place of a health pool.
- A remote change is broadcast to clients as a snapshot Insert rather than as an additive Update of the whole entity, which double-applied every pool on replicas.
- A remote delete removes the entity from the working store, and shard eviction no longer risks writing a delete upstream.
- `observe` streams end on a client cancel or a socket close through the router's abort signal.

**`@vampgg/utils`**

- Breaking: `TempoWsRouter.closeConnection(ws)` takes the closing socket and is synchronous. Stream state is now per connection, so one socket closing (or sending CANCELLED for another socket's message id) no longer touches other sockets' streams. Teardown aborts streams instead of awaiting `generator.return()`, which deadlocked behind a parked `next()`.
- New `streamAbortSignal(context)`. A server-stream handler parked on an external source listens on it to end when the client cancels or disconnects.
- `AsyncQueue` now runs its dispose callback when the producer closes or fails the queue while the consumer is parked. Previously the subscriber's cleanup never ran on that path.

**`@vampgg/cli`**

- Generated `materializeDelta` leaves fields absent from both the delta and the base `undefined`. Previously every field was defaulted, so a materialized entity carried every component and matched every query. Re-run `vamp generate`.
