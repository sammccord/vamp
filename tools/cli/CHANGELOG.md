# @vampgg/cli

## 1.0.0-beta.7

### Major Changes

- 361df8c: Name a world's types instead of listing them, and make every write data-level.

  **Named world types (breaking).** `ECS`, every system and behavior type, and the worker types take one world type instead of six positional parameters:

  ```ts
  type World = DefineWorld<{
    entity: Entity;
    delta: EntityDelta;
    actions: Actions;
    state: Ctx;
  }>;
  const world = new ECS<World>(entities, mutate, ctx, options);
  createEntitySystem<World>(execute, query);
  createBehavior<World, typeof ActionTag.Heal>(ActionTag.Heal, handler, query);
  ```

  `DefineWorld` fills defaults for omitted keys. `ECSDurableObject<G, Env>`, `RPCContext<G>`, `ECSRuntimeConfiguration<G>`, and `defineECSRuntime<G>` take a `GameTypes` (a world plus `session`; see `DefineGame`). Generated code exports `GameWorld<State, Args>` and `GameServerTypes<Session, State, Args>`; `GameECS`, `GameContext`, and the `createGame*` helpers keep their parameters. A bare `new ECS(...)` no longer infers entity and delta types from its arguments, so name the world. `createArchetypeSystem` drops its unused `ReturnArguments` parameter, and world state is constrained to `object`.

  **Data-level writes (breaking).** `createEntity`, `addComponent`, `removeComponent`, `transformEntity`, `deleteEntity`, `executeEventSystems`, and `rebuildBehaviorCache` are gone. They changed archetype membership without the entity's data, so queries, the store, snapshots, and replicas disagreed. Use `insert`, `put`, `replace`, `removeComponents`, `delete(id)`, `addTag`, and `removeTag`. `systems`, `behaviors`, and `entityArchetype` are read-only views, and `behaviorsFor(id, tag)` reports what `act` would run.

  - `put(id, delta)` returns the entity after the change. `undefined` keys are ignored and the `mutating` flag is removed; use `removeComponents(id, ...names)`. A removal is recorded as a snapshot Insert, since an encoded delta cannot carry it.
  - `delete` takes an id.
  - `addTag`/`removeTag` change the entity's `tags` data, not just its archetype.
  - `parent(id, child)` sets the child's `parent` too, detaching it from any previous parent; `unparent` clears it. `actWithBubbling` now reaches parents linked this way.

  **Worker.**

  - `writeEntityInsert` treats an entity as a full snapshot and deletes fields it no longer has.
  - Remote changes replay through `ECS.replace`.
  - An alarm that calls `stepTick` on a DO evicted with no players connected now restores the world first instead of hanging.

## 1.0.0-beta.6

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

## 1.0.0-beta.5

### Minor Changes

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

## 1.0.0-beta.4

### Minor Changes

- 1d169c2: Add behavior trees. `@vampgg/utils/schema/behavior.bop` defines `BehaviorTree` and `Brain` entity components. `@vampgg/ecs` adds a pure `evaluate`, a tree builder, and `createBehaviorTreeSystem`, which runs each agent's tree per update and dispatches the chosen actions through `act`. `ECS.waitUntil` keeps a `withScope` open until those dispatches settle, so their mutations commit in the tick's batch. Codegen now chooses a component's delta merge from a per-type table: `BehaviorTree` and `Brain` replace fields instead of summing them, via the new `applyReplaceDelta`/`accumulateReplaceDelta`. When `Entity` has both fields, codegen emits `createGameBehaviorTreeSystem`, which requires a leaf for every `Condition` and `Task` enum member. `vamp init` imports `behavior.bop` in the entity template.
- 307db8a: Behavior handlers are now typed for the action tag they handle. `createBehavior` takes `tag` as a literal `Tag` type parameter (constrained to `Actions["tag"]` instead of `number`) and types the handler's `event.detail` as `Extract<Actions, { tag: Tag }>`, so handlers no longer cast the payload. The new `BehaviorHandler` type is exported from `@vampgg/ecs`. Codegen emits an `ActionTag` const map from each `Actions` branch name to its discriminator, and `createGameBehavior(ActionTag.Heal, handler, ...)` infers `Tag` and narrows the handler the same way.
- c76ae42: Add vector built-ins. `@vampgg/utils/schema/vec.bop` defines `Vec2` and `Vec3` entity components with `Vec2Delta` and `Vec3Delta`. The deltas are `float32` counters, so fractional offsets survive the wire. A `Vec2Delta` that `vamp generate` synthesized from an app's own `Vec2` used `int32` fields and truncated them. `vamp init` imports `vec.bop` in the entity template.

## 1.0.0-beta.3

### Minor Changes

- 87153a6: `vamp generate`: the generated `GameECS` durable object now exposes an overridable `Env` generic (previously the `ECSDurableObject` `Env` slot was hardcoded to `Cloudflare.Env`). The default is configurable via a new optional `env` field in `vamp.json` (defaults to `"Cloudflare.Env"`, preserving current behavior). Non-Worker packages that lack wrangler types can set `"env": "unknown"` (or a local bindings type) so the generated durable object type-checks without a `Cloudflare.Env` shim.
- 87153a6: `vamp generate`: split the generated output into a pure ECS file and a Worker-runtime file, plus a backward-compatible barrel.

  - `game.core.generated.ts` — component map, `EntityDelta`, delta algebra, `createECSOptions`, and the `createGame*` system factories. Depends only on `@vampgg/ecs`, so it can be imported from non-Worker code (node, web, tests) without pulling `@vampgg/worker` and its `cloudflare:workers` import into the dependency graph.
  - `game.worker.generated.ts` — the `GameECS` durable object, runtime, and interest broadcast. Depends on `@vampgg/worker`.
  - `game.generated.ts` — a barrel re-exporting both, so existing `./game.generated` imports keep working.

  Override the two part-file paths with `coreOutFile` / `workerOutFile` in `vamp.json`. The docs cover the recommended tsconfig (`moduleResolution: nodenext` or `bundler`, and why `verbatimModuleSyntax` must stay off with bebopc output) and formatter-ignore guidance.

  Note (beta): the exported `generate()` now returns `{ barrel, core, worker }` paths instead of a single path string — a breaking change for programmatic API consumers.

### Patch Changes

- 87153a6: `vamp generate`: emit explicit `.js` extensions on the generated relative imports (e.g. `./bebop.js`). The extensionless specifier only resolved under `moduleResolution: bundler`; the `.js` form resolves under `nodenext` too (it maps back to the `.ts` source), so the generated output now type-checks in both module-resolution modes.
- 87153a6: `vamp init`: scaffold the `@vampgg/utils/schema/pool.bop` import as the stable, symlinked `node_modules/@vampgg/utils/…` path instead of the realpath. `require.resolve` previously resolved through pnpm's symlinks and baked a version-pinned `.pnpm/@vampgg+utils@<version>/…` path into `schema/entity.bop`, which broke on any dependency version bump.

## 1.0.0-beta.2

### Patch Changes

- bacbe16: Publish 1.0.0-beta.2 with npm provenance re-enabled now that the source repository is public. No runtime source changes.

## 1.0.0-beta.1

### Patch Changes

- 046a351: Publish 1.0.0-beta.1: exercise the fixed CI/release pipeline (build-before-check, workspace bin linking, changeset-file fmt ignores, unit-only test gate, platform-stable codegen determinism, no-op-safe release commit). No runtime source changes.

## 1.0.0-beta.0

### Major Changes

- 3961d4d: initial release
