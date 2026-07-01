import { type ChildProcess, spawn } from "node:child_process";
import { ConsoleLogger, TempoLogLevel } from "@tempojs/common";
import { TempoWSChannel } from "@vampgg/utils/ws-channel";
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

/** A positioned entity, for exercising the example's distance-based AOI policy. */
function makeEntityAt(x: number, y: number): Entity {
  return Entity({
    id: crypto.randomUUID(),
    tags: [],
    children: [],
    position: { x, y },
    health: { points: 100, min: 0, max: 100, rate: 0, interval: 0 },
  });
}

/**
 * An entity homed in a specific shard via its `sk` (the D1b shard key). With
 * no `sk` it defaults server-side to the lobby's own `game/${ns}` shard.
 */
function makeShardEntity(sk?: string): { id: string; entity: Entity } {
  const id = crypto.randomUUID();
  return {
    id,
    entity: Entity({
      id,
      sk,
      tags: [],
      children: [],
      health: { points: 100, min: 0, max: 100, rate: 0, interval: 0 },
    }),
  };
}

/**
 * Observe as a specific viewer. The example resolves the viewer entity id from
 * the first key of the request scope's `mutations` map, so we send a one-entry
 * scope keyed by `viewerId` (the value is ignored server-side).
 */
function observeAs(client: RpcClient, viewerId: string) {
  return client.observe(
    MutationScope({
      mutations: new Map([[viewerId, { tag: 1, value: { entity: Entity({ id: viewerId }) } }]]),
    }),
  );
}

describe("basic RPC service (integration)", () => {
  let proc: ChildProcess;
  let port: number;

  function createRpcClient(
    ns: string,
    extraQuery = "",
  ): { channel: TempoWSChannel; client: RpcClient } {
    const channel = TempoWSChannel.forAddress(
      `ws://127.0.0.1:${port}/v1/game?ns=${ns}${extraQuery}`,
      {
        logger: new ConsoleLogger(crypto.randomUUID().slice(0, 8), TempoLogLevel.None),
      },
    );
    return { channel, client: channel.getClient(RpcClient) };
  }

  beforeAll(async () => {
    const dev = await startWranglerDev();
    proc = dev.proc;
    port = dev.port;
  });

  afterAll(async () => {
    proc?.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 500));
    proc?.kill("SIGKILL");
  });

  it("upgrades the websocket connection", async () => {
    const { channel } = createRpcClient(`test-ws-${crypto.randomUUID().slice(0, 8)}`);

    await channel.waitForOpen();
    expect(channel.ws.readyState).toBe(WebSocket.OPEN);

    channel.close();
  });

  it("spawns an entity and echoes it back", async () => {
    const { channel, client } = createRpcClient(`test-spawn-${crypto.randomUUID().slice(0, 8)}`);

    const { id, entity } = makeEntity(100);
    const spawned = await client.spawn(entity);
    expect(spawned.id).toBe(id);
    expect(spawned.health?.points).toBe(100);

    channel.close();
  });

  it("derives per-namespace world context from the request query seed", async () => {
    // Each namespace is a distinct Durable Object, so its world context is
    // resolved independently from the query-param seed forwarded by the handler.
    // The example applies `context.faction` as the default faction for spawned
    // entities, so the spawn response reflects the per-DO runtime context.
    const suffix = crypto.randomUUID().slice(0, 8);
    const { channel: chA, client: clientA } = createRpcClient(`test-ctx-a-${suffix}`, "&faction=7");
    const { channel: chB, client: clientB } = createRpcClient(`test-ctx-b-${suffix}`, "&faction=9");

    // makeEntity does not set a faction, so the world default is applied.
    const spawnedA = await clientA.spawn(makeEntity(10).entity);
    const spawnedB = await clientB.spawn(makeEntity(10).entity);

    expect(spawnedA.faction).toBe(7);
    expect(spawnedB.faction).toBe(9);

    chA.close();
    chB.close();
  });

  it("streams the spawned entity to observers as an insert", async () => {
    const { channel, client } = createRpcClient(`test-insert-${crypto.randomUUID().slice(0, 8)}`);

    const observeStream = await client.observe(MutationScope({}));
    const scopes: MutationScope[] = [];
    const bgPromise = (async () => {
      for await (const scope of observeStream) scopes.push(scope);
    })();

    const { id, entity } = makeEntity(50);
    await client.spawn(entity);

    const record = await waitFor(
      () => scopes.flatMap((s) => [...(s.mutations ?? [])]).find(([key]) => key === id)?.[1],
      { label: "insert mutation" },
    );
    expect(record.tag).toBe(1); // Insert
    expect(record.tag === 1 && record.value.entity.id).toBe(id);

    await observeStream.return(undefined);
    await bgPromise.catch(() => {});
    channel.close();
  });

  it("applies an action and streams the resulting health update", async () => {
    const { channel, client } = createRpcClient(`test-attack-${crypto.randomUUID().slice(0, 8)}`);

    const observeStream = await client.observe(MutationScope({}));
    const scopes: MutationScope[] = [];
    const bgPromise = (async () => {
      for await (const scope of observeStream) scopes.push(scope);
    })();

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

    await observeStream.return(undefined);
    await bgPromise.catch(() => {});
    channel.close();
  });

  it("delivers observe events to multiple clients sharing the same namespace", async () => {
    const ns = `test-multi-${crypto.randomUUID().slice(0, 8)}`;

    const { channel: chA, client: clientA } = createRpcClient(ns);
    const { channel: chB, client: clientB } = createRpcClient(ns);

    const streamA = await clientA.observe(MutationScope({}));
    const streamB = await clientB.observe(MutationScope({}));

    const scopesA: MutationScope[] = [];
    const scopesB: MutationScope[] = [];
    const bgA = (async () => {
      for await (const scope of streamA) scopesA.push(scope);
    })();
    const bgB = (async () => {
      for await (const scope of streamB) scopesB.push(scope);
    })();

    const { id, entity } = makeEntity(80);
    await clientA.spawn(entity);

    const findInsert = (scopes: MutationScope[], key: string) =>
      scopes.flatMap((s) => [...(s.mutations ?? [])]).find(([k]) => k === key)?.[1];

    const insertA = await waitFor(() => findInsert(scopesA, id), { label: "insert in A" });
    const insertB = await waitFor(() => findInsert(scopesB, id), { label: "insert in B" });

    expect(insertA.tag).toBe(1);
    expect(insertA.tag === 1 && insertA.value.entity.id).toBe(id);
    expect(insertB.tag).toBe(1);
    expect(insertB.tag === 1 && insertB.value.entity.id).toBe(id);

    const attack = Actions.fromAttack(Attack({ source: id, target: id, damage: 25 }));
    await clientB.act(attack);

    const findUpdate = (scopes: MutationScope[], key: string) =>
      scopes
        .flatMap((s) => [...(s.mutations ?? [])])
        .find(([k, r]) => k === key && r.tag === 2)?.[1];

    const updateA = await waitFor(() => findUpdate(scopesA, id), { label: "update in A" });
    const updateB = await waitFor(() => findUpdate(scopesB, id), { label: "update in B" });

    expect(updateA.tag).toBe(2);
    expect(updateA.tag === 2 && updateA.value.delta.health?.points).toBe(-25);
    expect(updateB.tag).toBe(2);
    expect(updateB.tag === 2 && updateB.value.delta.health?.points).toBe(-25);

    await streamA.return(undefined);
    await streamB.return(undefined);
    await bgA.catch(() => {});
    await bgB.catch(() => {});
    chA.close();
    chB.close();
  });

  it("routes only interest-relevant mutations to each viewer (AOI, no cross-zone leakage)", async () => {
    const ns = `test-aoi-${crypto.randomUUID().slice(0, 8)}`;
    const { client: actor } = createRpcClient(ns);

    // Two viewer entities far enough apart that neither is in the other's AOI.
    const viewerA = makeEntityAt(0, 0);
    const viewerB = makeEntityAt(1000, 1000);
    await actor.spawn(viewerA);
    await actor.spawn(viewerB);

    const { channel: chA, client: clientA } = createRpcClient(ns);
    const { channel: chB, client: clientB } = createRpcClient(ns);
    const streamA = await observeAs(clientA, viewerA.id as string);
    const streamB = await observeAs(clientB, viewerB.id as string);

    const seenA = new Set<string>();
    const seenB = new Set<string>();
    const collect = (stream: typeof streamA, into: Set<string>) =>
      (async () => {
        for await (const scope of stream) {
          for (const key of scope.mutations?.keys() ?? []) into.add(key);
        }
      })();
    const bgA = collect(streamA, seenA);
    const bgB = collect(streamB, seenB);

    // Let the interest-filtered initial snapshots land before mutating.
    await new Promise((r) => setTimeout(r, 200));

    // One entity inside each viewer's AOI; spawned after observers attach so they
    // arrive as live routed mutations, not via the snapshot.
    const nearA = makeEntityAt(10, 10);
    const nearB = makeEntityAt(1010, 1010);
    await actor.spawn(nearA);
    await actor.spawn(nearB);

    await waitFor(() => (seenA.has(nearA.id as string) ? true : undefined), {
      label: "nearA delivered to A",
    });
    await waitFor(() => (seenB.has(nearB.id as string) ? true : undefined), {
      label: "nearB delivered to B",
    });
    // Settle to surface any erroneous cross-zone delivery before asserting absence.
    await new Promise((r) => setTimeout(r, 300));

    expect(seenA.has(nearA.id as string)).toBe(true);
    expect(seenA.has(nearB.id as string)).toBe(false); // B's entity must not leak to A
    expect(seenB.has(nearB.id as string)).toBe(true);
    expect(seenB.has(nearA.id as string)).toBe(false); // A's entity must not leak to B

    await streamA.return(undefined);
    await streamB.return(undefined);
    await bgA.catch(() => {});
    await bgB.catch(() => {});
    chA.close();
    chB.close();
  });

  it("propagates a co-subscriber's LIVE edits across lobbies sharing a character/* shard, and keeps each lobby's own game shard private (E live cross-lobby)", async () => {
    // Two DISTINCT namespaces = two distinct GameECS Durable Objects (lobbies),
    // both subscribed to one `character/*` shard. The headline: after both are
    // connected, an edit by ONE lobby reaches the OTHER's observer with no action
    // by the other — the notify-push path (provider RPCs `onShardUpdate` back).
    // And a lobby's PRIVATE `game/${ns}` shard never leaks to the other lobby.
    const suffix = crypto.randomUUID().slice(0, 8);
    const shared = `character/shared-${suffix}`;

    const { channel: chA, client: clientA } = createRpcClient(`xshard-a-${suffix}`);
    const { channel: chB, client: clientB } = createRpcClient(`xshard-b-${suffix}`);

    // Each lobby observes its whole world (empty scope = see-all). Holding an
    // observer (a connected player) gates the lobby ON for live notify-push.
    const streamA = await clientA.observe(MutationScope({}));
    const streamB = await clientB.observe(MutationScope({}));
    const seenA = new Set<string>();
    const seenB = new Set<string>();
    const collect = (stream: typeof streamA, into: Set<string>) =>
      (async () => {
        for await (const scope of stream) {
          for (const key of scope.mutations?.keys() ?? []) into.add(key);
        }
      })();
    const bgA = collect(streamA, seenA);
    const bgB = collect(streamB, seenB);

    // Both lobbies author an entity into the SAME shared shard — each opens that
    // provider and registers for notify-push. Settle so both registrations land.
    await clientA.spawn(makeShardEntity(shared).entity);
    await clientB.spawn(makeShardEntity(shared).entity);
    await new Promise((r) => setTimeout(r, 800));

    // A private entity in A's OWN game shard — B never subscribes to that provider.
    const privateA = makeShardEntity();
    await clientA.spawn(privateA.entity);

    // LIVE A→B: A authors a NEW shared entity AFTER B is connected; B must see it
    // with NO action of its own (the provider pushes it to B via onShardUpdate).
    const liveFromA = makeShardEntity(shared);
    await clientA.spawn(liveFromA.entity);
    await waitFor(() => (seenB.has(liveFromA.id) ? true : undefined), {
      label: "A's live edit reaches B",
      timeout: 8000,
    });

    // LIVE B→A (symmetric).
    const liveFromB = makeShardEntity(shared);
    await clientB.spawn(liveFromB.entity);
    await waitFor(() => (seenA.has(liveFromB.id) ? true : undefined), {
      label: "B's live edit reaches A",
      timeout: 8000,
    });

    // Settle so any (erroneous) private-shard leakage would have surfaced.
    await new Promise((r) => setTimeout(r, 400));

    expect(seenB.has(liveFromA.id)).toBe(true); // A's live edit propagated to B
    expect(seenA.has(liveFromB.id)).toBe(true); // B's live edit propagated to A
    expect(seenB.has(privateA.id)).toBe(false); // isolation: A's private game shard never leaks

    await streamA.return(undefined);
    await streamB.return(undefined);
    await bgA.catch(() => {});
    await bgB.catch(() => {});
    chA.close();
    chB.close();
  });
});
