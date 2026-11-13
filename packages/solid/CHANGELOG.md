# @vampgg/solid

## 1.0.0-beta.8

### Minor Changes

- 0f6f633: Second round of fixes from the source audit: scope atomicity, query semantics, RPC error handling, reconnects, interest transitions, and hot-path cost.

  **`@vampgg/ecs`**

  - An aborted scope restores archetype membership for every entity it touched.
  - Reads inside a scope see staged updates to pre-existing entities, including a parent scope's.
  - `act()` runs behaviors for an entity inserted earlier in the same scope.
  - `insert()` with an existing id replaces the entity. `put(id, { x: undefined })` without `mutating` no longer adds component `x`.
  - Unsubscribe functions are idempotent. Registering a query that is already registered with another world throws.
  - `or()` ORs the whole sub-query. `none()`/`noneTag()` exclude only archetypes holding every listed id, as documented.
  - An entity system runs once per update over a snapshot of its matches. A throwing deferred action runs once.
  - Breaking: an `EventSystem` receives only the ids that changed, not every match. `subscribe(system, true)` still emits every match once.
  - `registerBehavior` returns an unsubscribe function. The error classes are exported.

  **`@vampgg/utils`**

  - Error frames always carry the request's `messageId`. Over WebSocket, failed calls previously hung.
  - Non-Tempo error messages are masked unless `transmitInternalErrors` is set.
  - Client- and duplex-stream continuation frames no longer each send a reply or start a second pump.
  - `TempoWSChannel` survives a dropped connection: in-flight calls and streams fail, and the next call reconnects. Oversized frames fail in-flight work instead of being dropped silently.

  **`@vampgg/worker`**

  - `saveSession` keeps framework-owned `__vamp:` attachment keys.
  - Reserved close codes are never echoed. An oversized frame closes the socket with 1009. Framed errors echo the request's `messageId`.
  - Interest observers with a `canSee` policy send an Insert when an entity enters view and a Delete when it leaves, including when the viewer moves. The `observe` stream always opens with a snapshot frame.
  - A commit broadcast to many sockets is encoded once.
  - The `logger` option is honored. `document` is deprecated.

  **`@vampgg/solid`**

  - `GameProvider` treats the first frame of each stream as an authoritative snapshot (`snapshotOnConnect`, default `true`), removing entities deleted while disconnected.
  - Components sharing a hoisted query builder share one tracked query.

  **`@vampgg/cli`**

  - An unlisted custom component is an additive counter only when every field is numeric; otherwise it replaces.

### Patch Changes

- Updated dependencies [0f6f633]
  - @vampgg/ecs@1.0.0-beta.7

## 1.0.0-beta.7

### Patch Changes

- Updated dependencies [2b7ad76]
  - @vampgg/ecs@1.0.0-beta.6

## 1.0.0-beta.6

### Patch Changes

- Updated dependencies [1d169c2]
- Updated dependencies [307db8a]
  - @vampgg/ecs@1.0.0-beta.5

## 1.0.0-beta.5

### Major Changes

- b3c3d52: Migrate to Solid 2 (`solid-js@^2.0.0-rc.3`). Breaking for every consumer.

  Apps must install `@solidjs/web`, build with `@solidjs/vite-plugin`, and set
  `jsxImportSource` to `@solidjs/web`. `@vampgg/solid` itself stays headless and
  imports no DOM types, so it takes no dependency on the renderer.

  - `createQueryRegistry(world, owner)` becomes `createQueryRegistry(world)`. Solid 2
    signals outlive the owner that created them, so the parameter bought nothing.
  - `createEntityStore()` takes an optional initial record. `GameProvider` seeds the
    entity mirror at construction, because Solid 2 rejects store writes from a
    component body and `onSettled` would drop the seed under SSR.
  - `GameProvider`'s `children` and return type are now Solid's renderer-neutral
    `Element` instead of `JSX.Element`.
  - `EntityStore.upsert` and `QueryRegistry.update` must be called from an unowned
    scope. Solid 2 throws on reactive writes from a component body or a computation.
  - Writes now commit on the next microtask. Tests asserting against streamed state
    need `flush()` from `solid-js` unless they poll.

## 1.0.0-beta.4

### Patch Changes

- Updated dependencies [646c805]
  - @vampgg/ecs@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

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

- Updated dependencies [dd15f12]
  - @vampgg/ecs@1.0.0-beta.3

## 1.0.0-beta.2

### Patch Changes

- bacbe16: Publish 1.0.0-beta.2 with npm provenance re-enabled now that the source repository is public. No runtime source changes.
- Updated dependencies [bacbe16]
  - @vampgg/ecs@1.0.0-beta.2

## 1.0.0-beta.1

### Patch Changes

- 046a351: Publish 1.0.0-beta.1: exercise the fixed CI/release pipeline (build-before-check, workspace bin linking, changeset-file fmt ignores, unit-only test gate, platform-stable codegen determinism, no-op-safe release commit). No runtime source changes.
- Updated dependencies [046a351]
  - @vampgg/ecs@1.0.0-beta.1

## 1.0.0-beta.0

### Major Changes

- 3961d4d: initial release

### Patch Changes

- Updated dependencies [3961d4d]
  - @vampgg/ecs@1.0.0-beta.0
