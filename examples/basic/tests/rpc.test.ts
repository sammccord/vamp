import { type ChildProcess, spawn } from "node:child_process";
import { ConsoleLogger, TempoLogLevel } from "@tempojs/common";
import { TempoWSChannel } from "@vamp/utils/ws-channel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Actions, Attack, Entity, MutationScope, RpcClient } from "../src/bebop";

/** Boot a local `wrangler dev` server and resolve once it is ready. */
function startWranglerDev(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "./node_modules/.bin/wrangler",
      ["dev", "--ip", "127.0.0.1", "--port", "0", "--log-level", "log"],
      { cwd: process.cwd(), env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" } },
    );

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const inspect = (chunk: Buffer) => {
      const text = chunk.toString();
      if (/Build failed|\[ERROR\]/i.test(text))
        fail(new Error(`wrangler dev build error: ${text}`));
      const match = text.match(/Ready on https?:\/\/([\d.]+):(\d+)/i);
      if (match && !settled) {
        settled = true;
        resolve({ proc, port: Number(match[2]) });
      }
    };
    proc.stdout?.on("data", inspect);
    proc.stderr?.on("data", inspect);
    proc.on("exit", (code) => fail(new Error(`wrangler dev exited early (code ${code})`)));
    setTimeout(() => fail(new Error("wrangler dev did not become ready in time")), 45_000);
  });
}

function waitFor<T>(
  poll: () => T | undefined,
  { timeout = 10_000, label = "condition" }: { timeout?: number; label?: string } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = poll();
      if (value !== undefined) return resolve(value);
      if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function makeEntity(points: number) {
  const id = crypto.randomUUID();
  return {
    id,
    entity: Entity({
      id,
      tags: [],
      children: [],
      health: { points, min: 0, max: points, rate: 0, interval: 0 },
    }),
  };
}

describe("basic RPC service (integration)", () => {
  let proc: ChildProcess;
  let channel: TempoWSChannel;
  let client: RpcClient;
  let observeStream: AsyncGenerator<MutationScope, void, undefined>;
  const scopes: MutationScope[] = [];

  beforeAll(async () => {
    const dev = await startWranglerDev();
    proc = dev.proc;

    // Unique namespace per run: `wrangler dev` persists durable object state.
    const ns = `integration-test-${Date.now()}`;
    // Drive the generated RPC client over a real tempo websocket channel, the
    // same stack a browser/worker client uses. The channel frames each call in
    // the shared `Message` envelope and routes responses by `messageId`.
    channel = TempoWSChannel.forAddress(`ws://127.0.0.1:${dev.port}/v1/game?ns=${ns}`, {
      logger: new ConsoleLogger("rpc-test", TempoLogLevel.None),
    });
    client = channel.getClient(RpcClient);

    // Begin observing; collect every streamed mutation scope in the background.
    observeStream = await client.observe(MutationScope({}));
    void (async () => {
      try {
        for await (const scope of observeStream) scopes.push(scope);
      } catch {
        // stream torn down on teardown
      }
    })();
  });

  afterAll(async () => {
    // The observe generator is parked awaiting the next frame, so awaiting its
    // return() would block; fire-and-forget it and let closing the socket tear
    // the background consumer down.
    void observeStream?.return(undefined);
    try {
      channel?.ws.close();
    } catch {
      // ignore
    }
    proc?.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 500));
    proc?.kill("SIGKILL");
  });

  it("upgrades the websocket connection", async () => {
    await channel.waitForOpen();
    expect(channel.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("spawns an entity and echoes it back", async () => {
    const { id, entity } = makeEntity(100);
    const spawned = await client.spawn(entity);
    expect(spawned.id).toBe(id);
    expect(spawned.health?.points).toBe(100);
  });

  it("streams the spawned entity to observers as an insert", async () => {
    const { id, entity } = makeEntity(50);
    await client.spawn(entity);

    const record = await waitFor(
      () => scopes.flatMap((s) => [...(s.mutations ?? [])]).find(([key]) => key === id)?.[1],
      { label: "insert mutation" },
    );
    expect(record.tag).toBe(1); // Insert
    expect(record.tag === 1 && record.value.entity.id).toBe(id);
  });

  it("applies an action and streams the resulting health update", async () => {
    const { id, entity } = makeEntity(100);
    await client.spawn(entity);

    const attack = Actions.fromAttack(Attack({ source: id, target: id, damage: 30 }));
    const echoed = await client.act(attack);
    expect(echoed.tag).toBe(1);

    const update = await waitFor(
      () =>
        scopes
          .flatMap((s) => [...(s.mutations ?? [])])
          .find(([key, rec]) => key === id && rec.tag === 2)?.[1],
      { label: "health update mutation" },
    );
    expect(update.tag).toBe(2); // Update
    expect(update.tag === 2 && update.value.delta.health?.points).toBe(-30);
  });
});
