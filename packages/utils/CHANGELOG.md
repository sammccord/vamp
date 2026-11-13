# @vampgg/utils

## 1.0.0-beta.7

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

## 1.0.0-beta.6

### Minor Changes

- 1d169c2: Add behavior trees. `@vampgg/utils/schema/behavior.bop` defines `BehaviorTree` and `Brain` entity components. `@vampgg/ecs` adds a pure `evaluate`, a tree builder, and `createBehaviorTreeSystem`, which runs each agent's tree per update and dispatches the chosen actions through `act`. `ECS.waitUntil` keeps a `withScope` open until those dispatches settle, so their mutations commit in the tick's batch. Codegen now chooses a component's delta merge from a per-type table: `BehaviorTree` and `Brain` replace fields instead of summing them, via the new `applyReplaceDelta`/`accumulateReplaceDelta`. When `Entity` has both fields, codegen emits `createGameBehaviorTreeSystem`, which requires a leaf for every `Condition` and `Task` enum member. `vamp init` imports `behavior.bop` in the entity template.
- c76ae42: Add vector built-ins. `@vampgg/utils/schema/vec.bop` defines `Vec2` and `Vec3` entity components with `Vec2Delta` and `Vec3Delta`. The deltas are `float32` counters, so fractional offsets survive the wire. A `Vec2Delta` that `vamp generate` synthesized from an app's own `Vec2` used `int32` fields and truncated them. `vamp init` imports `vec.bop` in the entity template.

## 1.0.0-beta.5

### Minor Changes

- bf63dd7: Add `CompositeServiceRegistry` as the `@vampgg/utils/service-registry` subpath: one `ServiceRegistry` that fronts several generated registries behind a single router. `getMethod` resolves first-hit-wins — method ids are service+method hashes and collision-free across services — and `init()` forwards to every child exactly once even when re-entered, because generated `init()` is destructive (it drains tempo's decorator-registration static map).

## 1.0.0-beta.4

### Minor Changes

- 637791d: `TempoExtensionRouter` now replies to tabless senders, and a reusable inbound listener is exported.

  - **Fix:** the router's reply path only used `tabs.sendMessage` and bailed when the sender had no `tab`, so a **popup / options / extension-page** caller never received its response and the call timed out. Replies to tabless senders now go over `runtime.sendMessage` (broadcast; each channel demultiplexes by `messageId`, so only the awaiting caller resolves). The tab check also uses `sender.tab?.id !== undefined` instead of a truthiness test, which previously dropped tab id `0`, and an undeliverable reply (popup closed, tab navigated) is now logged at `debug` rather than `error`.
  - **Add:** `createExtensionListener(router, registry)` — the inbound `runtime.onMessage` guard the router never shipped. Only frames from this extension (`sender.id === runtime.id`) that decode to a `Message` with a registered `methodId` are dispatched; other extensions, reply frames, and malformed traffic are ignored. Replies travel back through the router's send path, so it never uses `sendResponse`. Exported alongside the `ExtensionSenderContext` type.

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
