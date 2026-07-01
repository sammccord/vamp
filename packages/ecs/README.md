# @vampgg/ecs

Entity-Component-System runtime for @vampgg game state. Archetype-graph storage,
component queries, event-driven behaviors, and transactional mutation scopes.

```bash
pnpm add @vampgg/ecs
```

## Concepts

- **World (`ECS`)** — owns every entity and its components in an _archetype graph_
  (entities with the same component+tag set share an archetype, so queries iterate
  a contiguous set instead of scanning the world).
- **Components & tags** — components are numeric-keyed fields on an entity; tags are
  numeric markers. Both are generated from your `.bop` schema by `@vampgg/cli`.
- **Systems** — run logic over a query each `update()` cycle. Build them with
  `createEntitySystem`, `createArchetypeSystem`, `createEventSystem`, and
  `createLifecycleSystem`.
- **Behaviors** — event-driven, per-entity reactions with bubbling (see
  `createBehavior` + `@vampgg/ecs` `Actions`).
- **Mutation scopes** — `createScope()` / `withScope` batch and coalesce entity
  changes into a `MutationBatch` so they can be observed and synced atomically.
- **Mutation observers** — `observeMutations()` / `routeMutations()` /
  `applyMutations()` move batches between worlds (this is how `@vampgg/worker` syncs
  the authoritative world to clients, and how `@vampgg/solid` applies them locally).

## Usage

The world is generic over its context, update args, action union, tag space, and
entity/delta shapes. You normally get a fully-typed `ECSOptions` from generated
code (`createECSOptions(...)` emitted by `@vampgg/cli`) rather than writing the
generics by hand:

```ts
import { createEntitySystem } from "@vampgg/ecs";
import { components } from "./game.generated"; // emitted by @vampgg/cli
import { type Entity, type EntityDelta } from "./bebop";

// A system runs over every entity matching its query each update(). The executor
// is `(entities, world) => …`; the second arg builds the query. Read components
// with `world.entity(id)` and stage changes with `world.put(id, delta)` — writes
// are coalesced into the active mutation scope and emitted as one batch.
const regen = createEntitySystem<Context, [], Actions, Tags, Entity, EntityDelta>(
  (entities, world) => {
    for (const id of entities) {
      const h = world.entity(id)?.health;
      if (!h || !h.rate || (h.points ?? 0) >= (h.max ?? 0)) continue;
      world.put(id, { health: { points: 1 } });
    }
  },
  (q) => q.every(components.health),
);

world.registerSystem(regen);
world.update(); // advance one cycle

// Cross-archetype query + behavior dispatch:
const players = world.query((q) => q.someTag(Tags.PlayerControlled).every(components.position));
world.act(targetId, attackAction); // runs matching behaviors, cascading to children
```

Server-side, you typically don't construct `ECS` directly — `@vampgg/worker` hosts
it inside a Durable Object. Client-side, `@vampgg/solid` wraps it as a reactive
read-replica. See **`examples/basic/`** for the full end-to-end wiring (schema →
generated options → systems → worker → solid client).

### Building a world without codegen

`createECSOptions` (from `@vampgg/cli`) is just a convenience — you can wire an
`ECS` by hand. You supply the entity map, a `mutate` function (how a
`MutationRecord` lands in your store), a context, and `ECSOptions` (component-id
map + the three delta functions). Note that **numeric deltas are additive**:
`put(id, { hp: -30 })` on `hp: 100` yields `70`.

```ts
import { ECS, type ECSOptions, type EntityMutator, MutationType } from "@vampgg/ecs";

type Entity = { id?: string; tags?: number[]; hp?: number; faction?: number };
type EntityDelta = { hp?: number; faction?: number };

const components = { id: 1, hp: 2, faction: 3 } as const;

const materializeDelta = (d: EntityDelta, base?: Partial<Entity>): Entity => ({
  id: base?.id,
  hp: (base?.hp ?? 0) + (d.hp ?? 0), // additive
  faction: d.faction ?? base?.faction, // last-writer-wins
});
const mergeDelta = (e: Entity, d: EntityDelta) => {
  if (d.hp !== undefined) e.hp = (e.hp ?? 0) + d.hp; // additive
  if (d.faction !== undefined) e.faction = d.faction; // replace
};
const accumulateDelta = (from: EntityDelta, to: EntityDelta) => {
  if (from.hp !== undefined) to.hp = (to.hp ?? 0) + from.hp;
  if (from.faction !== undefined) to.faction = from.faction;
  return to;
};

const entities = new Map<string, Entity>();
const mutate: EntityMutator<Entity, EntityDelta> = (id, m) => {
  switch (m.tag) {
    case MutationType.Insert:
      entities.set(id, m.value.entity);
      return;
    case MutationType.Update: {
      const e = entities.get(id);
      if (!e) entities.set(id, materializeDelta(m.value.delta, { id }));
      else mergeDelta(e, m.value.delta);
      return;
    }
    case MutationType.Delete:
      entities.delete(id);
  }
};

const options: ECSOptions<Entity, EntityDelta> = {
  createId: () => crypto.randomUUID(),
  components: components as unknown as Record<keyof Entity, number>,
  materializeDelta,
  mergeDelta,
  accumulateDelta,
};

const world = new ECS(entities, mutate, {}, options);
world.initialize();
world.insert({ id: "goblin", hp: 100, tags: [] });
world.put("goblin", { hp: -30 }); // hp is now 70
```

### Behaviors

Behaviors are event-driven, per-entity reactions selected by an action tag. Build
them with `createBehavior(tag, handler, query, priority?)`, register with
`registerBehavior`, then dispatch with `act`. `act` runs the matching behaviors on
the target **and propagates the same action down to its children**; use
`actWithBubbling` to travel up through ancestors and `actBatch` for many targets.
Call `event.preventDefault()` to halt propagation.

```ts
import { createBehavior } from "@vampgg/ecs";

const onAttack = createBehavior<Context, [], Actions, Tags, Entity, EntityDelta>(
  1, // action tag
  (world, entity, event) => {
    const dmg = (event.detail.value as { damage?: number }).damage ?? 0;
    if (entity.id && dmg) world.put(entity.id, { hp: -dmg });
  },
  (q) => q.every(components.hp),
  10, // priority — higher runs first
);
world.registerBehavior(onAttack);

await world.act("goblin", { tag: 1, value: { damage: 5 } }); // + every child
```

### Mutation scopes & syncing worlds

`withScope(fn)` batches every change made inside `fn` into one coalesced
`MutationBatch` (insert+update ⇒ insert, insert+delete ⇒ nothing, etc.) and returns
`{ result, mutations }`. Observers registered with `observeMutations` receive each
committed batch — this is exactly how `@vampgg/worker` streams the authoritative
world to clients and how `@vampgg/solid` applies it into a read-replica.

```ts
// Authoritative world: observe committed batches and ship interested ones.
const unobserve = world.observeMutations({
  interested: (id, mutation) => canClientSee(id),
  deliver: (batch) => sendToClient(batch), // MutationBatch = Map<id, MutationRecord>
});

const { result, mutations } = await world.withScope(() => world.insert(entity));

// Replica world: ingest a snapshot of matching entities, then live batches.
const snapshot = world.snapshotMutations((id, e) => (e.hp ?? 0) > 0);
await replica.withScope(() => replica.applyMutations(snapshot));
```

## Performance

The ECS is exercised by a full-stack end-to-end benchmark (see
[`@vampgg/worker`](../worker#performance) for the numbers table and how to
reproduce it). Highlights on the reference machine: a server frame running **all**
registered systems over **1,024 entities** takes ~2.0 ms (≈492 FPS), and a
single-behavior `act` round-trips in ~100 µs across the whole stack (ws → ECS →
CRDT write → broadcast). A single Durable Object holds **~18k rich entities**.

## Key exports

`ECS`, `ECSOptions`, `MutationBatch`, `MutationObserver` · `createEntitySystem`,
`createArchetypeSystem`, `createEventSystem`, `createLifecycleSystem`,
`createBehavior`, `SystemType` · `query`, `QueryBuilder`, `Query` ·
`createQueryMembershipTracker` (membership diffing for reactive clients) ·
`MutationRecord`, `MutationType`, `InsertMutation`, `UpdateMutation`,
`DeleteMutation`, `BaseEntity` · `applyMutation`, `createBaseMutator` ·
`accumulateArrayDelta`, `applyArrayDelta`, `accumulatePoolDelta`, `applyPoolDelta`
· archetype helpers (`archetypeId`, `createArchetype`, `transformArchetype`, …).

## Development

```bash
vp install     # install dependencies
vp test        # run the unit tests
vp run build   # build the library (outputs to dist/)
```
