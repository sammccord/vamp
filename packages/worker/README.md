# @vampgg/worker

Cloudflare Workers Durable Object integration for @vampgg. Hosts the `@vampgg/ecs`
runtime inside a Durable Object, persists/syncs state via yjs (`y-durablestream`),
and serves tempo RPC over **hibernatable** WebSockets.

```bash
pnpm add @vampgg/worker
```

> Peer/runtime deps: `yjs` + `y-durablestream`, and a Cloudflare Workers project
> (`wrangler`) with Durable Object bindings. See `examples/basic/wrangler.jsonc`.

## How it fits together

1. **`defineECSRuntime(provider)`** — call once at **module scope** in your worker
   entry. The provider returns the non-serializable runtime pieces (tempo service
   registry, generated `ecs` options, default `context`, `resolveContext(seed)`,
   `registerSystems`, and the interest hooks `onConnectionClose` /
   `rehydrateConnection`). It runs inside the DO isolate, so these never cross the
   RPC boundary.
2. **`ECSDurableObject`** — the Durable Object base class. Your build emits a
   concrete subclass (e.g. generated `GameECS`) that you bind in `wrangler.jsonc`.
   It bootstraps the ECS in `setup(namespace, seed)`, re-bootstraps after a
   hibernation wake, runs `webSocketMessage` through the tempo router, and tears
   down per-connection streams/observers on `webSocketClose` / `webSocketError`.
3. **`ECSStorage`** — the `y-durablestream` storage Durable Object that backs doc
   persistence/compaction (bind it alongside the ECS DO).

Typical worker entry (abridged from `examples/basic/src/index.ts`):

```ts
import { Hono } from "hono/quick";
import { createECSOptions, defineGameECSRuntime } from "./game.generated";
import { onConnectionClose, rehydrateConnection } from "./rpc.service";
import { registerGameSystems } from "./systems";

defineGameECSRuntime(() => ({
  serviceRegistry,
  ecs: createECSOptions(() => crypto.randomUUID()),
  context: { faction: 0 },
  resolveContext: (seed) => ({ faction: Number(seed.faction) || 0 }),
  registerSystems: registerGameSystems,
  onConnectionClose, // tear down interest observers on disconnect
  rehydrateConnection, // rebuild them after a hibernation wake
}));

const app = new Hono<{ Bindings: Cloudflare.Env }>();
app.get("/v1/game", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("Expected websocket", 426);
  const { ns, ...seed } = c.req.query();
  const stub = c.env.GAME_ECS.get(c.env.GAME_ECS.idFromName(ns));
  await stub.setup(ns, seed); // idempotent; resolves once the ECS is seeded
  return stub.fetch(c.req.raw);
});

export default app;
export { GameECS, GameStorage } from "./game.generated"; // the bound DO classes
```

> **Raw vs generated.** `defineGameECSRuntime` / `createECSOptions` / `GameECS` /
> `GameStorage` above are thin wrappers `@vampgg/cli` emits with your schema's types
> baked in. Under the hood they call the raw exports of this package:
> `defineECSRuntime(provider)`, and the base classes `ECSDurableObject` /
> `ECSStorage` (the generated `GameECS extends ECSDurableObject<…>` /
> `GameStorage extends ECSStorage<Entity>`). You can subclass them directly if you
> don't use codegen.

## Configuring the runtime

The provider you pass to `defineECSRuntime` returns an `ECSRuntimeConfiguration`.
Only `serviceRegistry` and `ecs` are required:

| Field                 | Purpose                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| `serviceRegistry`     | Tempo service registry (your RPC service impls). **Required.**             |
| `ecs`                 | `ECSOptions` — component map + delta functions. **Required.**              |
| `context`             | Static default world context.                                              |
| `resolveContext`      | `(seed) => context` — derive per-DO context from the request seed.         |
| `registerSystems`     | `(ecs) => void` — install systems + behaviors during bootstrap.            |
| `lobbyBinding`        | This DO's own binding name, so shard providers can `onShardUpdate` back.   |
| `onConnectionClose`   | Tear down per-connection interest observers on socket close/error.         |
| `rehydrateConnection` | Rebuild a live socket's observer after a hibernation wake.                 |
| `tickIntervalMs`      | Request-scoped tick cadence in ms (omit/`0` for reactive-only worlds).     |
| `broadcastTick`       | `(mutations) => void` — hook fired with each tick's coalesced mutations.   |
| `compactEveryNTicks`  | Compact the persisted Yjs doc every N ticks.                               |
| `maxFrameSize`        | Sync frame cap (vamp defaults to 8 MB; chunking removes the 1 MB ceiling). |

### Ticking

Ticking is **request-scoped, not alarm-driven**. When `tickIntervalMs` is set, the
world catches up on each **inbound player message**: it advances
`floor(elapsed / tickIntervalMs)` frames (capped at a small burst limit) to reach
real time, then applies the player's action. There is **no alarm**, so an idle lobby
still hibernates — no continuous duration charges, no per-tick `setAlarm` writes (see
[`BILLING.md`](./BILLING.md)).

> **Tradeoff:** a connected-but-idle lobby (no messages arriving) does not advance —
> time-based systems run on activity, not wall-clock. Omit `tickIntervalMs` for a
> purely reactive world; use it when the acting player is the one who needs the
> simulation stepped. For continuous simulation regardless of input, drive `stepTick`
> from your own external scheduler.

`ECSDurableObject` bootstraps via the RPC-safe `setup(ns, seed)` (idempotent;
resolves once the ECS is seeded + initialized) — `ready()` awaits that separately.
Adjust ticking at runtime (all persisted across hibernation, no alarm involved):

```ts
await stub.setTickInterval(50); // ~20 Hz catch-up cadence
await stub.pauseTick(); // stop advancing on messages
await stub.resumeTick();
await stub.stepTick(); // advance exactly one frame now (e.g. turn-based / external loop)
```

`ECSStorage` backs persistence; call `compact()` (or configure `maxBytes` /
`maxUpdates`) to bound the on-disk Yjs update log.

## `@vampgg/worker/interest` — area-of-interest broadcast

`createInterestBroadcast(config)` builds generator-free, per-connection interest
broadcasting (each client only receives mutations for entities it can see). It
returns the `observe` delegate for your RPC method plus the `onConnectionClose`
and `rehydrateConnection` hooks you pass into `defineECSRuntime`:

```ts
import { createInterestBroadcast } from "@vampgg/worker/interest";

const { observe, onConnectionClose, rehydrateConnection } = createInterestBroadcast<
  GameWorld,
  ObserveRequest,
  Mutation
>({
  encodeBatch, // MutationBatch -> wire frames
  canSee, // (viewer, entity) => boolean   (default: everyone sees everything)
  resolveViewer, // (request, ws) => viewer  (default: undefined)
});
```

The broadcast survives hibernation: subscriptions are persisted to the socket
attachment and `rehydrateConnection` rebuilds each live socket's observer on wake
without the original `observe` generator (which dies with the isolate).

## Key exports

`defineECSRuntime`, `ECSDurableObject` (from `@vampgg/worker`) · `ECSStorage` (from
`@vampgg/worker`) · `createInterestBroadcast`, `InterestBroadcast`,
`InterestBroadcastConfig`, `InterestSub` (from `@vampgg/worker/interest`).

## Performance

The whole stack is measured by a **full-stack end-to-end benchmark**
(`examples/basic/tests/stress.bench.ts`) that boots a real `wrangler dev` and drives
it over WebSocket RPC. Every measured op crosses the entire path:
`ws frame → tempo router → ECS → systems/behaviors → mutation scope → Yjs
doc.transact (real CRDT write) → interest broadcast`. Reproduce with:

```bash
cd examples/basic && pnpm bench
```

> Sample run — Apple Silicon Mac (macOS, Darwin 24.6.0, ~4.30 GHz), 2026-07-01.
> Absolute numbers vary by hardware; run the bench for your own.

**Server tick** — one frame running _every_ registered system, per world size:

| Entities | Compute only         | Full round-trip (incl. ws + serialization) |
| -------- | -------------------- | ------------------------------------------ |
| 64       | ~10,000 FPS (100 µs) | ~1,975 FPS (0.51 ms)                       |
| 256      | ~2,727 FPS (367 µs)  | ~687 FPS (1.46 ms)                         |
| 1,024    | ~492 FPS (2.03 ms)   | ~136 FPS (7.35 ms)                         |

**Per-op latency** (full stack, average per iteration):

| Operation                      | Latency  |
| ------------------------------ | -------- |
| `act` — single-target behavior | ~103 µs  |
| `act` — cascade (8 children)   | ~199 µs  |
| `act` — cascade (64 children)  | ~1.14 ms |
| `spawn` entity                 | ~253 µs  |

**Broadcast fan-out** — one room, N clients each draining the observe stream. The
DO delivers each committed mutation to every interested observer with **0% loss**:

| Observers | `act` rate | Delivered    | Interest-routed (AOI)      |
| --------- | ---------- | ------------ | -------------------------- |
| 8         | ~3,242/s   | ~6.0k msg/s  | ~1.5k msg/s, 0 cross-zone  |
| 32        | ~1,458/s   | ~18.6k msg/s | ~5.2k msg/s, 0 cross-zone  |
| 64        | ~813/s     | ~28.2k msg/s | ~11.1k msg/s, 0 cross-zone |

A whole-world `tick` broadcast to 64 observers sustains **~593k mutations/s**
delivered. Area-of-interest routing (`canSee`) filters each mutation to only the
observers that should see it — the benchmark asserts **zero cross-zone leakage**, so
effective room capacity scales with the number of interest zones.

**Scale:** a single Durable Object holds **~18k rich entities** (memory-bound,
~5.7 KB/entity; chunked sync removed the 1 MB frame ceiling). Shard across DOs for a
larger global store — a lobby's working set is the union of the shards it subscribes
to.

## Cost

See [`BILLING.md`](./BILLING.md) for a code-grounded Cloudflare cost model — compute
(requests + duration), SQLite storage (rows + bytes), and the front Worker — with
per-operation cost tables, parameterized formulas, and worked scenarios. Headline:
because ticking is request-scoped (no alarm), a lobby hibernates whenever idle — a
small game runs on the free tier, and enabling a server tick adds only the cost of the
extra flushes it produces while players are active (no continuous duration).

## Development

```bash
vp install     # install dependencies
vp test        # run the unit tests
vp run build   # build the library (outputs to dist/)
```
