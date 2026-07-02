# @vampgg/ecs

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
