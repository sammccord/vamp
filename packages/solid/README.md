# @vamp/solid

Solid.js bindings for [`@vamp/ecs`](../ecs) + generated bebop RPC clients. Wrap your
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

```ts
import { TempoWSChannel } from "@vamp/utils/ws-channel";
import { GameProvider, createQuery, createWorld, useClient } from "@vamp/solid";
import { MutationScope, RpcClient } from "./bebop";
import { createECSOptions, components } from "./game.generated";

const world = createWorld(createECSOptions(() => crypto.randomUUID()));
const channel = TempoWSChannel.forAddress("ws://host/v1/game?ns=room1");
const client = channel.getClient(RpcClient);

// App root (JSX shown for illustration; the library itself ships JSX-free)
<GameProvider world={world} client={client} open={(c) => c.observe(MutationScope({}))}>
  <Scene />
</GameProvider>;

function Scene() {
  const enemies = createQuery((q) => q.every(components.health).someTag(/* Hostile */ 3));
  const client = useClient<RpcClient>();
  // <For each={enemies()}>{(e) => <Sprite entity={e} />}</For>
  // client.spawn(Entity({ ... }))
}
```

## API

- `createWorld(options, context?)` — build the read-replica ECS from your generated `ECSOptions`.
- `<GameProvider world client open apply? reconnectDelay?>` — owns init, the entity store, the
  membership registry, and the observe loop.
- `useWorld()`, `useClient()`, `useConnection()` — context accessors.
- `createQuery(input)` — reactive `Accessor<E[]>`; fine-grained over membership + per-entity fields.
- `createEntity(id)` — reactive `Accessor<E | undefined>`.
- `createSubscription` / `createOnCreate` / `createOnDelete` — register ECS systems for app reactions.
- `createEntityStore`, `createQueryRegistry` — lower-level building blocks.
