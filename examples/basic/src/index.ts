import { Hono } from "hono/quick";
import { createECSOptions } from "./game.generated";

const app = new Hono<{
  Bindings: Cloudflare.Env;
  Variables: {};
}>();

app.get("/v1/game", (c) => {
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

  if (!stub.initialized()) {
    // TODO load in ecs
    stub.initialize(ns, {
      // serviceRegistry:
      ecs: createECSOptions(() => crypto.randomUUID()),
    });
  }

  const headers = new Headers(c.req.raw.headers);
  return stub.fetch(c.req.raw, { headers });
});

export default app;

export { GameECS, GameStorage } from "./game.generated";
