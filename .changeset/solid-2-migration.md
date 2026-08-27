---
"@vampgg/solid": major
---

Migrate to Solid 2 (`solid-js@^2.0.0-rc.3`). Breaking for every consumer.

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
