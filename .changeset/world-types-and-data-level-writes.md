---
"@vampgg/ecs": major
"@vampgg/worker": major
"@vampgg/solid": minor
"@vampgg/cli": major
---

Name a world's types instead of listing them, and make every write data-level.

**Named world types (breaking).** `ECS`, every system and behavior type, and the worker types take one world type instead of six positional parameters:

```ts
type World = DefineWorld<{ entity: Entity; delta: EntityDelta; actions: Actions; state: Ctx }>;
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
