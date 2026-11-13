# @vampgg/ecs

## 1.0.0-beta.6

### Major Changes

- 2b7ad76: Fix silent data loss in mutation scopes, Yjs persistence, and stream teardown.

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

## 1.0.0-beta.5

### Minor Changes

- 1d169c2: Add behavior trees. `@vampgg/utils/schema/behavior.bop` defines `BehaviorTree` and `Brain` entity components. `@vampgg/ecs` adds a pure `evaluate`, a tree builder, and `createBehaviorTreeSystem`, which runs each agent's tree per update and dispatches the chosen actions through `act`. `ECS.waitUntil` keeps a `withScope` open until those dispatches settle, so their mutations commit in the tick's batch. Codegen now chooses a component's delta merge from a per-type table: `BehaviorTree` and `Brain` replace fields instead of summing them, via the new `applyReplaceDelta`/`accumulateReplaceDelta`. When `Entity` has both fields, codegen emits `createGameBehaviorTreeSystem`, which requires a leaf for every `Condition` and `Task` enum member. `vamp init` imports `behavior.bop` in the entity template.
- 307db8a: Behavior handlers are now typed for the action tag they handle. `createBehavior` takes `tag` as a literal `Tag` type parameter (constrained to `Actions["tag"]` instead of `number`) and types the handler's `event.detail` as `Extract<Actions, { tag: Tag }>`, so handlers no longer cast the payload. The new `BehaviorHandler` type is exported from `@vampgg/ecs`. Codegen emits an `ActionTag` const map from each `Actions` branch name to its discriminator, and `createGameBehavior(ActionTag.Heal, handler, ...)` infers `Tag` and narrows the handler the same way.

## 1.0.0-beta.4

### Patch Changes

- 646c805: `act`/`actWithBubbling` now self-heal an entity's behavior cache on read. Entity mutators (`insert`, `addComponent`, `removeComponent`, `addTag`, `removeTag`, `transformEntity`) only enqueue a deferred cache rebuild that is otherwise flushed by `update()`. Dispatching outside an update tick previously read a stale or absent cache and silently ran zero behaviors. Both dispatch paths now rebuild a pending entity before reading it, so reactive callers no longer need a manual `rebuildBehaviorCache(target)` before `act`, and an entity whose archetype changed after its cache was built no longer runs the stale behavior set. The pending flag is cleared on the on-read rebuild, so the next `update()` does not redo the work.

## 1.0.0-beta.3

### Minor Changes

- dd15f12: Full-audit performance, leak, and API-surface pass.

  **worker**

  - Shard `release()` is now wired: per-root entity counts release a shard's pin when it becomes entity-empty (`_maybeReleaseShard`), the reap cycle tears it down after the grace period, and an entity re-appearing during grace re-pins it. Previously every root a lobby ever touched stayed subscribed (Y.Doc + sync client + observers) for the isolate's lifetime.
  - Legacy refcount/membership model removed from `entity-doc.ts` (`addRef`/`releaseRef`/`joinNamespace`/`leaveNamespace`/`writeInsert`/`writeDelete`/`reapOrphanedEntities`/`migrateLegacyNamespace` and the `__vamp:refs`/`__vamp:members:*` keys) — superseded by the sharded entity-set model. **Breaking** for anyone importing those helpers.
  - Scope-drain reconcile and component writes use `clonePlainValue` instead of `structuredClone` (~8× faster on entity-shaped data).
  - BILLING.md updated for the request-scoped tick model and y-durablestream 0.9 storage costs.

  **ecs**

  - New `clonePlainValue` export: fast deep clone for plain JSON-shaped entity data (+ `Uint8Array`).
  - `applyArrayDelta` switches to Set-based de-dup/removal past 32 elements (was O(n·m)); `accumulateArrayDelta` now de-dupes add/remove lists while coalescing.
  - `query()` documents its re-traversal cost and points to incremental alternatives.

  **rot**

  - `EventQueue` stores absolute times — advancing the clock no longer rekeys the whole heap (`MinHeap.shift` removed, **breaking** if you called it directly). O(log n) per tick instead of O(n).
  - `Dijkstra` uses a head-cursor queue and numeric cell keys (was `Array.shift()` + string keys per cell).
  - FOV ring walks are allocation-free (`_walkCircle`); `lighting` keys cells numerically end to end.
  - Curated exports: new root barrel (`@vampgg/rot`), internal subpaths removed (`MinHeap`, `util`, abstract bases, `map/features`) — **breaking** for deep imports of those; their public types re-export from the barrel. `DEFAULT_WIDTH`/`DEFAULT_HEIGHT` are `const` now; `Color.lerp`/`lerpHSL` aliases removed (use `interpolate`/`interpolateHSL`); the `RNG` class is exported for isolated instances.

  **utils**

  - Transport scaffolding deduplicated into shared internal cores (channels + routers) — public classes unchanged.
  - `Array.apply(null, bytes)` → `Array.from(bytes)` in the extension transport (RangeError on large frames).
  - `TempoExtensionRouterConfiguration` declares the `exposeTempo` field it reads (default stays `false`).
  - Dead exports removed: `DebugLogger`, `SystemError`/`ErrorTags`, `MemoryStorageStrategy`, `SyncStorageStrategy` (**breaking** if imported); `lodash-es` dependency dropped.

  **solid**

  - Entity store mirror uses `clonePlainValue` instead of `structuredClone` per changed entity per frame.

## 1.0.0-beta.2

### Patch Changes

- bacbe16: Publish 1.0.0-beta.2 with npm provenance re-enabled now that the source repository is public. No runtime source changes.

## 1.0.0-beta.1

### Patch Changes

- 046a351: Publish 1.0.0-beta.1: exercise the fixed CI/release pipeline (build-before-check, workspace bin linking, changeset-file fmt ignores, unit-only test gate, platform-stable codegen determinism, no-op-safe release commit). No runtime source changes.

## 1.0.0-beta.0

### Major Changes

- 3961d4d: initial release
