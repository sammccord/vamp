# @vampgg/solid

Solid.js bindings for [`@vampgg/ecs`](../ecs) + generated bebop RPC clients. Wrap your
app in `<GameProvider>` and read entities through reactive, fine-grained queries
that update as the server streams mutations.

## Model

**Server-authoritative.** The client ECS is a read-replica. You call semantic RPCs
(`spawn`, `act`, …) on the generated client; the server validates them and streams the
resulting mutations back over its `observe` stream, which this package decodes and
applies into the local world. Clients never broadcast arbitrary local mutations —
mutating fields like health/position are CRDT-additive, so optimistic double-apply
would double-count. (A prediction overlay is intentionally left out; see the plan.)

## Usage

Build a read-replica `world` from your generated `ECSOptions`, open a channel +
client, and mount `<GameProvider>`. Children read state through `createQuery` /
`createEntity` and call RPCs via the `client` (or `useClient`). The example below is
the real wiring from `examples/basic` (JSX shown for illustration — the package
itself ships JSX-free):

```tsx
import { createWorld, GameProvider, createQuery } from "@vampgg/solid";
import { TempoWSChannel } from "@vampgg/utils/ws-channel";
import { For } from "solid-js";
import { MutationScope, RpcClient } from "./bebop";
import { createECSOptions, components } from "./game.generated";

const world = createWorld(createECSOptions(() => crypto.randomUUID()));
const channel = TempoWSChannel.forAddress("ws://host/v1/game?ns=room1");
const client = channel.getClient(RpcClient);

// `open` decides which server stream feeds the replica — the consumer picks the
// method + request, so the provider stays codec-agnostic.
const openStream = (c: RpcClient) => c.observe(MutationScope({}));

function HealthBars() {
  // Fine-grained: the array changes identity only on membership change; each
  // entity is a reactive store node, so <For> rows update fields in place.
  const entities = createQuery<Entity>((q) => q.every(components.health));
  return <For each={entities()}>{(e) => <li>{`${e.id}: ${e.health?.points}`}</li>}</For>;
}

render(() => (
  <GameProvider world={world} client={client} open={openStream}>
    <HealthBars />
  </GameProvider>
));

// A server spawn streams back and re-renders <For> automatically:
await client.spawn(entity);
```

### Single entity, connection status, and RPCs

```tsx
import { createEntity, useConnection, useClient } from "@vampgg/solid";

function EnemyView(props: { id: string }) {
  const enemy = createEntity<Entity>(() => props.id); // Accessor<Entity | undefined>
  const client = useClient<RpcClient>();
  return (
    <button onClick={() => client.act(/* Attack(...) */)}>
      {enemy()?.health?.points ?? "gone"}
    </button>
  );
}

function ConnectionBadge() {
  const status = useConnection(); // "connecting" | "open" | "closed"
  return <span>{status()}</span>;
}
```

### App-side reactions

`createSubscription` / `createOnCreate` / `createOnDelete` register ECS systems that
fire as mutations stream in — use them for side effects (sounds, particles,
analytics) rather than rendering:

```ts
import { createOnCreate, createOnDelete } from "@vampgg/solid";

createOnCreate((id) => playSpawnSound(id));
createOnDelete((id) => playDeathAnimation(id));
```

## API

- `createWorld(options, context?)` — build the read-replica ECS from your generated `ECSOptions`.
- `<GameProvider world client open reconnectDelay?>` — owns init, the entity store, the
  membership registry, and the observe loop (`reconnectDelay` defaults to 1000 ms).
- `useWorld()`, `useClient()`, `useConnection()` — context accessors.
- `createQuery(input)` — reactive `Accessor<E[]>`; fine-grained over membership + per-entity fields.
- `createEntity(id)` — reactive `Accessor<E | undefined>` (id may be static or an `Accessor`).
- `createSubscription` / `createOnCreate` / `createOnDelete` — register ECS systems for app reactions.
- `createEntityStore`, `createQueryRegistry` — lower-level building blocks.
