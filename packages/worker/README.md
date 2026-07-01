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

## Development

```bash
vp install     # install dependencies
vp test        # run the unit tests
vp run build   # build the library (outputs to dist/)
```
