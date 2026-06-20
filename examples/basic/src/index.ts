import { ConsoleLogger } from "@tempojs/common";
import { defineECSRuntime } from "@vamp/worker";
import { Hono } from "hono/quick";
import { TempoServiceRegistry } from "./bebop";
import { createECSOptions } from "./game.generated";
// Importing the service module runs its `@TempoServiceRegistry.register` decorator,
// registering the RPC service implementation in this (and the durable object's) isolate.
import "./rpc.service";

// Register the runtime configuration provider. This runs at module scope, so it
// is available inside the GameECS durable object isolate. The non-serializable
// pieces (the tempo service registry + ECS options functions) are therefore
// constructed inside the DO rather than passed across the RPC boundary.
defineECSRuntime(() => ({
  serviceRegistry: new TempoServiceRegistry(new ConsoleLogger("rpc")),
  ecs: createECSOptions(() => crypto.randomUUID()),
  context: {},
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
  const { ns } = c.req.query();
  const gameId = gameWorker.idFromName(ns);
  if (!gameId) return c.text("No game id found", 500);

  const stub = gameWorker.get(gameId);
  if (!stub) return c.text("No game worker stub available, this should never happen", 500);

  // Bootstrap the durable object. `setup` is idempotent and resolves once the
  // ECS has been seeded + initialized, so RPC is ready by the time we upgrade.
  await stub.setup(ns);

  const headers = new Headers(c.req.raw.headers);
  return stub.fetch(c.req.raw, { headers });
});

export default app;

export { GameECS, GameStorage } from "./game.generated";
