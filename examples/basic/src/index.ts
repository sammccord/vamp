import { ConsoleLogger } from "@tempojs/common";
import { Hono } from "hono/quick";
import { nanoid } from "nanoid";
import { TempoServiceRegistry } from "./bebop";
import { createECSOptions } from "./game.core.generated";
import { defineGameECSRuntime } from "./game.worker.generated";
// Importing the service module runs its `@TempoServiceRegistry.register` decorator,
// registering the RPC service implementation in this (and the durable object's) isolate.
// The named imports additionally give us the interest-broadcast lifecycle hooks so
// they can be wired into the durable object's connection-close and wake paths.
import { type GameWorldContext, onConnectionClose, rehydrateConnection } from "./rpc.service";
import { registerGameSystems } from "./systems";

// `TempoServiceRegistry#init()` — invoked by every tempo router constructor —
// is a destructive, isolate-global handoff: it moves the singleton service
// instance registered by `@TempoServiceRegistry.register` out of a *static* map
// and into the registry instance, deleting the static entry. The worker builds
// one router per durable object, and Cloudflare can colocate multiple durable
// objects in a single isolate, so a second DO's router would re-run `init()`
// against the now-empty static map and throw
// `Unable to retrieve service 'RpcService' - it is not registered.`
//
// Guard `init()` so it runs exactly once per isolate; the populated method map
// is then safely shared by every per-DO router (the registry is only read, via
// `getMethod`, after init). A single shared instance is required for the guard
// to be effective, so it is constructed once at module scope rather than inside
// the provider closure below. The same single-instance requirement also avoids a
// `A logger with the name 'rpc' already exists` throw — the logger registry is
// likewise per-isolate.
class SharedServiceRegistry extends TempoServiceRegistry {
  #initialized = false;
  override init(): void {
    if (this.#initialized) return;
    this.#initialized = true;
    super.init();
  }
}

const serviceRegistry = new SharedServiceRegistry(new ConsoleLogger("rpc"));

// Register the runtime configuration provider. This runs at module scope, so it
// is available inside the GameECS durable object isolate. The non-serializable
// pieces (the tempo service registry + ECS options functions) are therefore
// constructed inside the DO rather than passed across the RPC boundary.
defineGameECSRuntime<{}, GameWorldContext>(() => ({
  serviceRegistry,
  // This lobby DO's own binding name, so a shard provider can RPC `onShardUpdate`
  // back on it — enabling live cross-lobby propagation (notify-push). Without it,
  // shards sync on connect only. Must match the GAME_ECS binding in wrangler.jsonc.
  lobbyBinding: "GAME_ECS",
  // nanoid(16) ≈ 96 bits — ample collision headroom past 100k entities — and
  // far shorter than a 36-char uuid, which the doc encodes ~3× per entity
  // (entities/refs/membership keys). Shrinks per-entity bytes ⇒ higher ceiling.
  ecs: createECSOptions(() => nanoid(16)),
  // Static default context, merged under any runtime-resolved context below.
  context: { faction: 0, seededAt: 0 },
  // Derive the world context at runtime from the per-request seed. The handler
  // forwards the request query params as the seed; an app with a DB binding would
  // instead `await env.DB.get(seed.id)` here. Re-run on every cold bootstrap,
  // INCLUDING after a hibernation wake (the seed is restored from storage), so
  // `seededAt` is re-stamped fresh each time. Only the seed is persisted, so the
  // resolved context is free to hold non-serializable values.
  resolveContext: (seed: Record<string, unknown>) => {
    const faction = Number(seed.faction);
    return { faction: Number.isFinite(faction) ? faction : 0, seededAt: Date.now() };
  },
  // Install the example's systems + behaviors on the world during bootstrap, so
  // `tick` (update) and `act` drive registered systems/behaviors end-to-end.
  registerSystems: registerGameSystems,
  // Tear down per-connection interest observers when a socket closes or errors,
  // so disconnects do not leave observers feeding dead sockets.
  onConnectionClose,
  // Rebuild each live socket's interest observer after a hibernation wake from
  // its persisted subscription, so the generator-free broadcast resumes without
  // the original `observe` generator (destroyed with the isolate).
  rehydrateConnection,
}));

const app = new Hono<{
  Bindings: Cloudflare.Env;
  Variables: {};
}>();

app.get("/v1/game", async (c) => {
  // Reject requests that don't require upgrade
  if (c.req.header("upgrade") !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }

  const gameWorker = c.env.GAME_ECS;
  // Everything except `ns` becomes the runtime context seed. The seed is
  // structured-clone serializable (query params are strings), persisted by the
  // DO, and turned into the world context by `resolveContext` above.
  const { ns, ...seed } = c.req.query();
  const gameId = gameWorker.idFromName(ns);
  if (!gameId) return c.text("No game id found", 500);

  const stub = gameWorker.get(gameId);
  if (!stub) return c.text("No game worker stub available, this should never happen", 500);

  // Bootstrap the durable object. `setup` is idempotent and resolves once the
  // ECS has been seeded + initialized, so RPC is ready by the time we upgrade.
  // The seed configures the world context on first bootstrap for this namespace.
  await stub.setup(ns, seed);

  const headers = new Headers(c.req.raw.headers);
  return stub.fetch(c.req.raw, { headers });
});

export default app;

export { GameECS, GameStorage } from "./game.worker.generated";
