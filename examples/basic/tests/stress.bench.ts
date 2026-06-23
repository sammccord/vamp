import { type ChildProcess, spawn } from "node:child_process";
import { ConsoleLogger, TempoLogLevel } from "@tempojs/common";
import { TempoWSChannel } from "@vamp/utils/ws-channel";
import { bench, boxplot, run, summary } from "mitata";
import { afterAll, beforeAll, test } from "vitest";
import {
  Actions,
  AreaAttack,
  Attack,
  Entity,
  MutationScope,
  RpcClient,
  Tags,
  TickRequest,
} from "../src/bebop";

/**
 * Full-stack end-to-end FPS stress benchmark.
 *
 * Boots a real `wrangler dev` server (Worker + GameECS/GameStorage durable
 * objects + Yjs sync) and drives it over WebSocket RPC with mitata. Every
 * measured operation crosses the full stack: ws frame -> tempo router -> ECS ->
 * systems/behaviors -> mutation scope -> mergeDelta -> Yjs doc.transact (real
 * CRDT write) -> broadcast.
 *
 * The headline question is "how many frames per second can the server sustain":
 *   - `tick` advances `ecs.update()` (all registered systems) one frame per call
 *     and reports server-measured wall-clock, so we get FPS *excluding* the ws
 *     round-trip as well as the client-observed round-trip rate.
 *   - `act` dispatches registered behaviors (simple single-target vs. a cascade
 *     down an entity subtree) to bound mutation cost from trivial to heavy.
 *   - `spawn` measures world-growth throughput.
 *   - the observer fan-out variant attaches N draining observers to one room and
 *     measures how action latency AND broadcast delivery throughput scale with N
 *     — the number that actually predicts MUD room capacity (dozens of users in
 *     one room each seeing every mutation).
 *
 * Run it with: `pnpm bench` (see package.json). It is excluded from `vp test`.
 */

const SIZES = [64, 256, 1024];
const CASCADE_CHILDREN = [8, 64];
// Observer fan-out: how many clients are subscribed to (observing) one room.
const FANOUT_OBSERVERS = [0, 8, 32, 64];
// Fixed populated world for the fan-out rooms, so a `tick` produces a realistic
// whole-world delta to broadcast while `act` produces a single mutation.
const FANOUT_WORLD = 128;

// ── wrangler dev lifecycle ───────────────────────────────────────────────────

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
    setTimeout(() => fail(new Error("wrangler dev did not become ready in time")), 60_000);
  });
}

// ── client + entity factories ────────────────────────────────────────────────

let port = 0;
const channels: TempoWSChannel[] = [];

function createClient(ns: string): RpcClient {
  const channel = TempoWSChannel.forAddress(`ws://127.0.0.1:${port}/v1/game?ns=${ns}`, {
    logger: new ConsoleLogger(crypto.randomUUID().slice(0, 8), TempoLogLevel.None),
  });
  channels.push(channel);
  return channel.getClient(RpcClient);
}

/** A richly-componented entity so systems and the archetype graph have real work. */
function makeStressEntity(i: number): Entity {
  const id = crypto.randomUUID();
  const tags: Tags[] = [];
  if (i % 7 === 0) tags.push(Tags.PlayerControlled, Tags.Human);
  if (i % 3 === 0) tags.push(Tags.Hostile);
  if (i % 5 === 0) tags.push(Tags.Flying);
  if (i % 11 === 0) tags.push(Tags.Undead);
  if (i % 17 === 0) tags.push(Tags.Boss);
  return Entity({
    id,
    tags,
    children: [],
    health: { points: 50 + (i % 50), min: 0, max: 100, rate: 1, interval: 0 },
    position: { x: (i * 13) % 512, y: (i * 7) % 512 },
    velocity: { x: (i % 3) - 1, y: (i % 5) - 2 },
    mana: { points: 20, min: 0, max: 50, rate: 1, interval: 0 },
    stamina: { points: 30, min: 0, max: 30, rate: 0, interval: 0 },
    level: 1 + (i % 10),
    xp: i % 100,
    faction: i % 4,
  });
}

/** A minimal combat-capable entity (health + stamina) used as a cascade leaf. */
function makeLeaf(): Entity {
  return Entity({
    id: crypto.randomUUID(),
    tags: [],
    children: [],
    health: { points: 1_000_000, min: 0, max: 1_000_000, rate: 0, interval: 0 },
    stamina: { points: 1_000_000, min: 0, max: 1_000_000, rate: 0, interval: 0 },
  });
}

/** Spawn `n` varied entities through the RPC stack, pipelined in batches. */
async function populate(client: RpcClient, n: number): Promise<void> {
  const BATCH = 32;
  for (let i = 0; i < n; i += BATCH) {
    const batch: Promise<unknown>[] = [];
    for (let j = i; j < Math.min(i + BATCH, n); j++) batch.push(client.spawn(makeStressEntity(j)));
    await Promise.all(batch);
  }
}

/** Build a parent with `k` children and return the parent id (for cascade acts). */
async function buildCascade(client: RpcClient, k: number): Promise<string> {
  const childIds: string[] = [];
  const batch: Promise<unknown>[] = [];
  for (let j = 0; j < k; j++) {
    const child = makeLeaf();
    childIds.push(child.id as string);
    batch.push(client.spawn(child));
  }
  await Promise.all(batch);
  const parent = Entity({
    id: crypto.randomUUID(),
    tags: [],
    children: childIds,
    health: { points: 1_000_000, min: 0, max: 1_000_000, rate: 0, interval: 0 },
    stamina: { points: 1_000_000, min: 0, max: 1_000_000, rate: 0, interval: 0 },
  });
  await client.spawn(parent);
  return parent.id as string;
}

// ── observer fan-out helpers ─────────────────────────────────────────────────

/** A background observer's running count of delivered entity mutations. */
type ObserverState = { n: number };
type ObserveStream = AsyncGenerator<MutationScope, void, undefined>;

// Live observe streams, returned on teardown so their background drains exit.
const fanoutStreams: ObserveStream[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtRate(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}

/**
 * Subscribe `count` observer clients to room `ns`, each draining the stream in
 * the background and counting delivered entity mutations (`scope.mutations.size`
 * — one per broadcast for an act, ~changed-entities for a tick).
 */
async function attachObservers(
  ns: string,
  count: number,
): Promise<{ states: ObserverState[]; streams: ObserveStream[] }> {
  const states: ObserverState[] = [];
  const streams: ObserveStream[] = [];
  for (let i = 0; i < count; i++) {
    const client = createClient(ns);
    const stream = await client.observe(MutationScope({}));
    fanoutStreams.push(stream);
    streams.push(stream);
    const state: ObserverState = { n: 0 };
    states.push(state);
    void (async () => {
      try {
        for await (const scope of stream) state.n += scope.mutations?.size ?? 0;
      } catch {
        /* stream closed on teardown */
      }
    })();
  }
  return { states, streams };
}

/** Return (end) a row's observe streams so their server-side sinks are removed. */
async function detachObservers(streams: ObserveStream[]): Promise<void> {
  for (const stream of streams) {
    try {
      await stream.return(undefined);
    } catch {
      /* best effort */
    }
  }
}

/** Block until the observers' total delivered count is quiet for `quietMs`. */
async function waitStable(obs: ObserverState[], quietMs: number, timeoutMs: number): Promise<void> {
  const start = performance.now();
  let last = obs.reduce((s, o) => s + o.n, 0);
  let lastChange = performance.now();
  for (;;) {
    await sleep(50);
    const cur = obs.reduce((s, o) => s + o.n, 0);
    if (cur !== last) {
      last = cur;
      lastChange = performance.now();
    } else if (performance.now() - lastChange >= quietMs) {
      return;
    }
    if (performance.now() - start > timeoutMs) return;
  }
}

/**
 * Fire `k` operations back-to-back, then wait for the broadcast to reach every
 * observer. Returns the action rate (act loop only) and the delivery rate
 * (mutations actually pushed to all observers, over the full settle window).
 */
async function measureDelivery(
  obs: ObserverState[],
  op: () => Promise<unknown>,
  k: number,
): Promise<{ opsPerSec: number; msgsPerSec: number; delivered: number }> {
  const baseline = obs.map((o) => o.n);
  const tStart = performance.now();
  for (let i = 0; i < k; i++) await op();
  const tActs = performance.now();
  await waitStable(obs, 300, 60_000);
  const tEnd = performance.now();
  const delivered = obs.reduce((s, o, i) => s + (o.n - baseline[i]), 0);
  return {
    opsPerSec: k / Math.max(1e-6, (tActs - tStart) / 1000),
    msgsPerSec: delivered / Math.max(1e-6, (tEnd - tStart) / 1000),
    delivered,
  };
}

// ── pre-populated worlds (built once, before measuring) ──────────────────────

const tickWorlds = new Map<number, RpcClient>();
let leafClient: RpcClient;
let leafTargetId: string;
let cascadeClient: RpcClient;
const cascadeParents = new Map<number, string>();

beforeAll(async () => {
  const dev = await startWranglerDev();
  proc = dev.proc;
  port = dev.port;

  // One isolated DO world per size for the tick benchmark.
  for (const size of SIZES) {
    const client = createClient(`bench-tick-${size}-${crypto.randomUUID().slice(0, 8)}`);
    await populate(client, size);
    // One settling frame flushes every deferred behavior-cache rebuild and lets
    // the world reach steady archetype state before measuring.
    await client.tick(TickRequest({ steps: 1, dtMs: 16 }));
    tickWorlds.set(size, client);
  }

  // A world for single-target behavior dispatch (act -> Attack).
  leafClient = createClient(`bench-act-leaf-${crypto.randomUUID().slice(0, 8)}`);
  const leaf = makeLeaf();
  leafTargetId = leaf.id as string;
  await leafClient.spawn(leaf);
  await leafClient.tick(TickRequest({ steps: 1, dtMs: 16 }));

  // A world for cascade behavior dispatch (act -> AreaAttack down a subtree).
  cascadeClient = createClient(`bench-act-cascade-${crypto.randomUUID().slice(0, 8)}`);
  for (const k of CASCADE_CHILDREN) {
    cascadeParents.set(k, await buildCascade(cascadeClient, k));
  }
  // Settle behavior caches for every spawned child so act() cascades dispatch.
  await cascadeClient.tick(TickRequest({ steps: 1, dtMs: 16 }));
}, 240_000);

let proc: ChildProcess | undefined;

afterAll(async () => {
  // End background observer drains before tearing down their sockets.
  for (const stream of fanoutStreams) {
    try {
      await stream.return(undefined);
    } catch {
      /* best effort */
    }
  }
  for (const channel of channels) {
    try {
      channel.close();
    } catch {
      /* best effort */
    }
  }
  proc?.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 500));
  proc?.kill("SIGKILL");
});

test("full-stack FPS stress benchmark", async () => {
  const spawnClient = createClient(`bench-spawn-${crypto.randomUUID().slice(0, 8)}`);

  boxplot(() => {
    summary(() => {
      // FPS: one server frame (all systems) per round-trip, across world sizes.
      bench("tick 1 frame · $size entities", function* (state: { get(k: string): number }) {
        const size = state.get("size");
        const client = tickWorlds.get(size)!;
        yield async () => {
          await client.tick(TickRequest({ steps: 1, dtMs: 16 }));
        };
      }).args("size", SIZES);
    });
  });

  summary(() => {
    // Simple mutation: one behavior, one target, one pool delta.
    bench("act Attack (single target)", function* () {
      yield async () => {
        await leafClient.act(
          Actions.fromAttack(Attack({ source: leafTargetId, target: leafTargetId, damage: 1 })),
        );
      };
    });

    // Complex mutation: AreaAttack cascades through the whole subtree, so a
    // single round-trip coalesces (children + 1) puts into one Yjs transaction.
    bench("act AreaAttack (cascade · $children children)", function* (state: {
      get(k: string): number;
    }) {
      const k = state.get("children");
      const parentId = cascadeParents.get(k)!;
      yield async () => {
        await cascadeClient.act(
          Actions.fromAreaAttack(
            AreaAttack({ source: parentId, target: parentId, damage: 1, radius: 1 }),
          ),
        );
      };
    }).args("children", CASCADE_CHILDREN);

    // World-growth throughput.
    bench("spawn entity", function* () {
      let n = 0;
      yield async () => {
        await spawnClient.spawn(makeStressEntity(n++));
      };
    });
  });

  const results = await run();

  // ── Derived FPS report ────────────────────────────────────────────────────
  // Client-observed round-trip rate (includes ws + serialization).
  console.log("\n=== Client-observed tick rate (full round-trip) ===");
  for (const trial of results.benchmarks) {
    if (!trial.alias.startsWith("tick")) continue;
    for (const r of trial.runs) {
      if (!r.stats) continue;
      const fps = 1e9 / r.stats.avg;
      const ms = r.stats.avg / 1e6;
      console.log(
        `  ${String(r.args.size).padStart(5)} entities: ${fps.toFixed(0).padStart(6)} FPS  (${ms.toFixed(2)} ms/round-trip)`,
      );
    }
  }

  // Server-measured compute rate (excludes ws round-trip): the durable object
  // runs 30 frames per call and reports its own wall-clock. Take the median of
  // several calls so a single GC/sync pause does not dominate the number.
  console.log("\n=== Server-measured tick rate (compute only, excl. network) ===");
  for (const size of SIZES) {
    const client = tickWorlds.get(size)!;
    const samples: number[] = [];
    let liveEntities = size;
    for (let s = 0; s < 7; s++) {
      const res = await client.tick(TickRequest({ steps: 30, dtMs: 16 }));
      const frames = Math.max(1, res.frames ?? 0);
      liveEntities = res.entities ?? liveEntities;
      samples.push(Math.max(1, res.micros ?? 0) / frames); // µs per frame
    }
    samples.sort((a, b) => a - b);
    const usPerFrame = samples[Math.floor(samples.length / 2)];
    const fps = 1e6 / usPerFrame;
    console.log(
      `  ${String(size).padStart(5)} entities: ${fps.toFixed(0).padStart(6)} FPS  (${usPerFrame.toFixed(1)} µs/frame median, ${liveEntities} entities live)`,
    );
  }

  // Observer fan-out: the real MUD room-capacity signal. Each row is a FRESH,
  // isolated room (the server's observer registry is module-global, so rows must
  // not overlap) with M observers draining in the background. Fire a burst and
  // measure how fast the DO delivers each broadcast to EVERY observer. `act`
  // broadcasts 1 mutation; `tick` broadcasts the whole-world delta. delivered/s =
  // (mutations × observers) the room sustains; loss = mutations not delivered
  // within the settle window (back-pressure / dropped).
  console.log("\n=== Observer fan-out: broadcast delivery throughput ===");
  console.log(
    `  (fresh ${FANOUT_WORLD}-entity room per row; act = 1 mutation/broadcast, tick = whole-world delta)`,
  );
  for (const m of FANOUT_OBSERVERS) {
    const ns = `bench-fanout-${m}-${crypto.randomUUID().slice(0, 8)}`;
    const actor = createClient(ns);
    await populate(actor, FANOUT_WORLD);
    const target = makeLeaf();
    const targetId = target.id as string;
    await actor.spawn(target);
    await actor.tick(TickRequest({ steps: 1, dtMs: 16 }));

    const { states, streams } = await attachObservers(ns, m);
    await sleep(200); // let initial snapshots land before baselines

    const ACT_K = 300;
    const act = await measureDelivery(
      states,
      () =>
        actor.act(Actions.fromAttack(Attack({ source: targetId, target: targetId, damage: 1 }))),
      ACT_K,
    );
    const actLossPct = m === 0 ? 0 : (1 - act.delivered / (ACT_K * m)) * 100;

    await waitStable(states, 200, 10_000);
    const tick = await measureDelivery(
      states,
      () => actor.tick(TickRequest({ steps: 1, dtMs: 16 })),
      60,
    );

    console.log(
      `  ${String(m).padStart(3)} obs | act ${act.opsPerSec.toFixed(0).padStart(5)}/s → ${fmtRate(act.msgsPerSec).padStart(7)} msg/s (${actLossPct.toFixed(0)}% loss)` +
        ` | tick ${tick.opsPerSec.toFixed(0).padStart(4)}/s → ${fmtRate(tick.msgsPerSec).padStart(7)} msg/s`,
    );

    // Isolate the next row: end this room's observe streams (removes sinks).
    await detachObservers(streams);
    await sleep(100);
  }
}, 600_000);
