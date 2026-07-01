# @vamp/ecs

Entity-Component-System runtime for @vamp game state. Archetype-graph storage,
component queries, event-driven behaviors, and transactional mutation scopes.

```bash
pnpm add @vamp/ecs
```

## Concepts

- **World (`ECS`)** — owns every entity and its components in an _archetype graph_
  (entities with the same component+tag set share an archetype, so queries iterate
  a contiguous set instead of scanning the world).
- **Components & tags** — components are numeric-keyed fields on an entity; tags are
  numeric markers. Both are generated from your `.bop` schema by `@vamp/cli`.
- **Systems** — run logic over a query each `update()` cycle. Build them with
  `createEntitySystem`, `createArchetypeSystem`, `createEventSystem`, and
  `createLifecycleSystem`.
- **Behaviors** — event-driven, per-entity reactions with bubbling (see
  `createBehavior` + `@vamp/ecs` `Actions`).
- **Mutation scopes** — `createScope()` / `withScope` batch and coalesce entity
  changes into a `MutationBatch` so they can be observed and synced atomically.
- **Mutation observers** — `observeMutations()` / `routeMutations()` /
  `applyMutations()` move batches between worlds (this is how `@vamp/worker` syncs
  the authoritative world to clients, and how `@vamp/solid` applies them locally).

## Usage

The world is generic over its context, update args, action union, tag space, and
entity/delta shapes. You normally get a fully-typed `ECSOptions` from generated
code (`createECSOptions(...)` emitted by `@vamp/cli`) rather than writing the
generics by hand:

```ts
import { createEntitySystem } from "@vamp/ecs";
import { components } from "./game.generated"; // emitted by @vamp/cli
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

Server-side, you typically don't construct `ECS` directly — `@vamp/worker` hosts
it inside a Durable Object. Client-side, `@vamp/solid` wraps it as a reactive
read-replica. See **`examples/basic/`** for the full end-to-end wiring (schema →
generated options → systems → worker → solid client).

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
