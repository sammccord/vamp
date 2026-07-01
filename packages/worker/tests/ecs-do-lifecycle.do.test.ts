import { ConsoleLogger } from "@tempojs/common";
import { ServiceRegistry } from "@tempojs/server";
import { type BaseEntity, createEntitySystem, type ECSOptions } from "@vampgg/ecs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { entitiesMap, writeInsert } from "../src/entity-doc.ts";

/**
 * Durable Object lifecycle tests, run in plain Node (see vite.config.ts, which
 * aliases the workerd-only `cloudflare:workers` module to a stub base class).
 *
 * The DO is driven against a fake `DurableObjectState`/`env`. Only the external
 * Yjs sync transport (`y-durablestream`'s `YStreamClient`) is mocked — vamp's own
 * logic (storage persistence, doc write/seed, session restore on hibernation
 * wake, connection teardown, the alarm tick loop) runs for real. The mock client
 * applies an optional `stub.__seed` doc update on connect and reports "synced",
 * standing in for the storage DO streaming the persisted world.
 *
 * NOTE: pool-workers (real workerd) is the ideal harness but is currently
 * incompatible with the vite-plus test runner (its harness performs disallowed
 * I/O in workerd's global scope), so we run the DO in Node behind these fakes.
 */

vi.mock("y-durablestream", async () => {
  const Yjs = await import("yjs");
  class YStreamClient {
    private _synced = false;
    private _cb: ((s: string) => void) | undefined;
    constructor(
      public doc: Y.Doc,
      public opts: { stub?: { __seed?: Uint8Array } },
    ) {}
    get synced(): boolean {
      return this._synced;
    }
    onStatusChange(cb: (s: string) => void): () => void {
      this._cb = cb;
      return () => {
        this._cb = undefined;
      };
    }
    /** One-shot initial sync: apply the provider's seed (stands in for the pull). */
    async syncOnce(): Promise<void> {
      const seed = this.opts?.stub?.__seed;
      if (seed) Yjs.applyUpdate(this.doc, seed);
      this._synced = true;
    }
    /** Forward a local write upstream — no-op in this fake (no real provider). */
    async pushLocalUpdate(_update: Uint8Array, _key?: string): Promise<void> {}
    async connect(): Promise<void> {
      await this.syncOnce();
      this._cb?.("synced");
    }
    disconnect(): void {}
  }
  return { YStreamClient };
});

// Imported AFTER vi.mock so the DO picks up the mocked client.
const { ECSDurableObject, defineECSRuntime } = await import("../src/ecs.ts");

// `WebSocketRequestResponsePair` is a workerd global used in the DO constructor.
class FakeWSRRP {
  constructor(
    public request: string,
    public response: string,
  ) {}
}

const logger = new ConsoleLogger("worker-do-test");

// ── Minimal ECS world config (entity = { id, x?, y?, n? }) ──────────────────
type Entity = BaseEntity & { x?: number; y?: number; n?: number };
type Delta = Partial<Entity>;

const ecsOptions = {
  createId: () => crypto.randomUUID(),
  components: { x: 0, y: 1, n: 2 },
  materializeDelta: (delta: Delta): Entity => ({ ...delta }) as Entity,
  mergeDelta: (entity: Entity, delta: Delta): void => {
    Object.assign(entity as Record<string, unknown>, delta);
  },
  accumulateDelta: (from: Delta, to: Delta): Delta => ({ ...to, ...from }),
} as unknown as ECSOptions<Entity, Delta>;

// Registers a system that increments `n` on every entity carrying the `n`
// component each tick — the observable proof that a tick actually ran.
function registerNSystem(ecs: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: minimal world typing in test
  const world = ecs as any;
  world.registerSystem(
    createEntitySystem(
      // biome-ignore lint/suspicious/noExplicitAny: see above
      (entities: string[], w: any) => {
        for (const id of entities) {
          const n = w.entity(id)?.n ?? 0;
          w.put(id, { n: n + 1 });
        }
      },
      // biome-ignore lint/suspicious/noExplicitAny: query builder
      (q: any) => q.every(ecsOptions.components.n),
    ),
  );
}

class TestRegistry extends ServiceRegistry {
  init(): void {}
  // biome-ignore lint/suspicious/noExplicitAny: no RPC methods exercised here
  getMethod(): any {
    return undefined;
  }
}

// ── Fakes for the Durable Object runtime ────────────────────────────────────
function makeStorage(initial: Record<string, unknown> = {}) {
  const _map = new Map<string, unknown>(Object.entries(initial));
  let _alarm: number | null = null;
  return {
    _map,
    get _alarm() {
      return _alarm;
    },
    async get(key: string) {
      return _map.get(key);
    },
    async put(entries: Record<string, unknown> | string, value?: unknown) {
      if (typeof entries === "string") _map.set(entries, value);
      else for (const [k, v] of Object.entries(entries)) _map.set(k, v);
    },
    async getAlarm() {
      return _alarm;
    },
    async setAlarm(t: number) {
      _alarm = t;
    },
    async deleteAlarm() {
      _alarm = null;
    },
  };
}
type FakeStorage = ReturnType<typeof makeStorage>;

// biome-ignore lint/suspicious/noExplicitAny: fake socket list
function makeCtx(storage: FakeStorage, sockets: any[] = []) {
  const ctx = {
    id: { toString: () => "do-test", name: "do-test" },
    storage,
    _sockets: sockets,
    _blocking: undefined as Promise<unknown> | undefined,
    getWebSockets() {
      return this._sockets;
    },
    setWebSocketAutoResponse() {},
    acceptWebSocket() {},
    waitUntil() {},
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const p = fn();
      this._blocking = p;
      return p;
    },
    abort() {},
  };
  return ctx;
}
type FakeCtx = ReturnType<typeof makeCtx>;

function makeWs(attachment: unknown = null) {
  let a = attachment;
  const sent: ArrayBuffer[] = [];
  let closed: { code?: number; reason?: string } | undefined;
  return {
    readyState: 1,
    serializeAttachment(v: unknown) {
      a = structuredClone(v);
    },
    deserializeAttachment() {
      return a;
    },
    send(d: ArrayBuffer) {
      sent.push(d);
    },
    close(code?: number, reason?: string) {
      closed = { code, reason };
    },
    get _closed() {
      return closed;
    },
    _sent: sent,
  };
}

function makeStub(seed?: Uint8Array) {
  return {
    __seed: seed,
    async subscribe() {
      return new ReadableStream();
    },
    async update() {},
    async getYDoc() {
      return new Uint8Array();
    },
    async compact() {},
    async register() {},
    async deregister() {},
  };
}

// biome-ignore lint/suspicious/noExplicitAny: fake env binding
function makeEnv(stub: any) {
  return {
    GAME_STORAGE: {
      idFromName: (name: string) => ({ name }),
      get: () => stub,
    },
  };
}

/** A Yjs doc holding `entities` in the CURRENT shared layout, encoded as one update. */
function seedDoc(namespace: string, entities: Array<Entity & { id: string }>): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const e of entities) writeInsert(doc, namespace, e.id, e as Record<string, unknown>);
  });
  return Y.encodeStateAsUpdate(doc);
}

interface RuntimeOverrides {
  registerSystems?: (ecs: unknown) => void;
  tickIntervalMs?: number;
  tickArgs?: () => unknown[];
  onConnectionClose?: (ws: unknown) => void;
  rehydrateConnection?: (ecs: unknown, ws: unknown) => void;
}

function configureRuntime(overrides: RuntimeOverrides = {}) {
  defineECSRuntime(
    () =>
      ({
        serviceRegistry: new TestRegistry(logger),
        ecs: ecsOptions,
        ...overrides,
        // biome-ignore lint/suspicious/noExplicitAny: erased provider shape
      }) as any,
  );
}

// biome-ignore lint/suspicious/noExplicitAny: the DO has many generic params the tests don't need
function newDO(ctx: FakeCtx, env: unknown): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return new (ECSDurableObject as any)(ctx, env);
}

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: install workerd global
  (globalThis as any).WebSocketRequestResponsePair = FakeWSRRP;
});

describe("ECSDurableObject — bootstrap & persistence", () => {
  test("setup() persists the namespace, context seed, and subscribed shard set", async () => {
    configureRuntime();
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage), makeEnv(makeStub()));

    await instance.setup("room1", { faction: 3 });

    expect(instance.initialized()).toBe(true);
    expect(storage._map.get("__vamp:namespace")).toBe("room1");
    expect(storage._map.get("__vamp:context")).toEqual({ faction: 3 });
    // The lobby opens its own shard (`game/${ns}`) at bootstrap, and persists the
    // active root set so a hibernation-recreated constructor can re-subscribe.
    expect(storage._map.get("__vamp:shards")).toEqual(["game/room1"]);
  });

  test("seeds the local ECS world from the persisted Yjs document on connect", async () => {
    configureRuntime();
    const seeded = [
      { id: "e1", x: 5, y: 7 },
      { id: "e2", x: 1, y: 2 },
    ];
    const instance = newDO(makeCtx(makeStorage()), makeEnv(makeStub(seedDoc("room1", seeded))));

    await instance.setup("room1");

    expect(instance.ecs.hasEntity("e1")).toBe(true);
    expect(instance.ecs.entity("e1")).toMatchObject({ x: 5, y: 7 });
    expect(instance.ecs.entity("e2")).toMatchObject({ x: 1, y: 2 });
  });

  test("a local insert is written through to its shard's Yjs document", async () => {
    configureRuntime();
    const instance = newDO(makeCtx(makeStorage()), makeEnv(makeStub()));
    await instance.setup("room1");

    await instance.ecs.withScope(() => instance.ecs.insert({ id: "p1", x: 10, y: 20 }));

    // A locally-spawned entity defaults to the lobby's own shard (`game/${ns}`)
    // and is written there as entity data only — the shard's entity-set is its
    // membership, so there is no separate refcount/membership index.
    const shardDoc = instance.shards.docFor("game/room1");
    expect(entitiesMap(shardDoc).get("p1")?.toJSON()).toMatchObject({
      x: 10,
      y: 20,
      // The resolved home shard is stamped onto the entity so subscribers see it.
      sk: "game/room1",
    });
  });

  test("an entity authored with an explicit root opens + writes to that shard", async () => {
    configureRuntime();
    const instance = newDO(makeCtx(makeStorage()), makeEnv(makeStub()));
    await instance.setup("room1");

    await instance.ecs.withScope(() =>
      instance.ecs.insert({ id: "c1", x: 1, y: 2, sk: "character/alice" }),
    );

    // The explicit root opens a second shard; the entity lands in THAT shard's
    // doc, not the lobby's own. Both shards are now subscribed + persisted.
    expect(instance.shards.docFor("game/room1")?.getMap("__vamp:entities").has("c1")).toBe(false);
    expect(
      entitiesMap(instance.shards.docFor("character/alice")).get("c1")?.toJSON(),
    ).toMatchObject({ x: 1, y: 2 });
    expect(instance.shards.activeRoots().sort()).toEqual(["character/alice", "game/room1"]);
  });
});

describe("ECSDurableObject — hibernation wake", () => {
  test("restores sessions and re-bootstraps the runtime from persisted state", async () => {
    const rehydrated: unknown[] = [];
    configureRuntime({ rehydrateConnection: (_ecs, ws) => rehydrated.push(ws) });

    // A DO that was previously initialized: namespace persisted + live sockets
    // carrying their session attachments (what survives an eviction).
    const storage = makeStorage({ "__vamp:namespace": "room1" });
    const ws1 = makeWs({ userId: "u1" });
    const ws2 = makeWs({ userId: "u2" });
    const ctx = makeCtx(storage, [ws1, ws2]);

    const instance = newDO(ctx, makeEnv(makeStub()));

    // Sessions are restored synchronously in the constructor from the sockets'
    // attachments.
    expect(instance.sessions.size).toBe(2);
    expect(instance.sessions.get(ws1)).toEqual({ userId: "u1" });

    // The constructor re-bootstraps under blockConcurrencyWhile; await it.
    await ctx._blocking;

    expect(instance.initialized()).toBe(true);
    // Each live socket's per-connection observer is rebuilt via the app hook.
    expect(rehydrated).toEqual([ws1, ws2]);
  });

  test("a cold DO with no hibernating sockets does not re-bootstrap", () => {
    configureRuntime();
    const ctx = makeCtx(makeStorage({ "__vamp:namespace": "room1" }), []);
    const instance = newDO(ctx, makeEnv(makeStub()));

    expect(instance.sessions.size).toBe(0);
    expect(ctx._blocking).toBeUndefined();
    expect(instance.initialized()).toBeFalsy();
  });
});

describe("ECSDurableObject — connection teardown", () => {
  test("webSocketClose drops the session and runs the app close hook", async () => {
    const closedHooks: unknown[] = [];
    configureRuntime({ onConnectionClose: (ws) => closedHooks.push(ws) });
    const instance = newDO(makeCtx(makeStorage()), makeEnv(makeStub()));
    await instance.setup("room1");

    const ws = makeWs({ userId: "u1" });
    instance.sessions.set(ws, { userId: "u1" });

    await instance.webSocketClose(ws, 1000, "bye", true);

    expect(instance.sessions.has(ws)).toBe(false);
    expect(closedHooks).toEqual([ws]);
    expect(ws._closed).toBeDefined();
  });

  test("webSocketError tears the connection down the same way", async () => {
    const closedHooks: unknown[] = [];
    configureRuntime({ onConnectionClose: (ws) => closedHooks.push(ws) });
    const instance = newDO(makeCtx(makeStorage()), makeEnv(makeStub()));
    await instance.setup("room1");

    const ws = makeWs({ userId: "u2" });
    instance.sessions.set(ws, { userId: "u2" });

    await instance.webSocketError(ws, new Error("boom"));

    expect(instance.sessions.has(ws)).toBe(false);
    expect(closedHooks).toEqual([ws]);
  });
});

describe("ECSDurableObject — alarm tick loop", () => {
  test("alarm() runs ecs.update through a scope and reschedules", async () => {
    configureRuntime({ tickIntervalMs: 50, registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage), makeEnv(makeStub()));
    await instance.setup("room1");

    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));
    expect(instance.ecs.entity("ticker").n).toBe(0);

    await instance.alarm();

    // The tick system ran (n incremented) and the next alarm was scheduled.
    expect(instance.ecs.entity("ticker").n).toBe(1);
    expect(storage._alarm).not.toBeNull();
  });
});

describe("ECSDurableObject — runtime tick controls", () => {
  test("setTickInterval enables + arms a loop booted with ticking disabled", async () => {
    // No tickIntervalMs in the provider config: the loop starts disabled.
    configureRuntime({ registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage), makeEnv(makeStub()));
    await instance.setup("room1");
    expect(storage._alarm).toBeNull();

    await instance.setTickInterval(50);

    // The alarm is armed at once and the override is persisted.
    expect(storage._alarm).not.toBeNull();
    expect(storage._map.get("__vamp:tick")).toEqual({ intervalMs: 50, paused: false });

    // The tick hooks were captured even though the world booted disabled, so the
    // loop runs when driven.
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));
    await instance.alarm();
    expect(instance.ecs.entity("ticker").n).toBe(1);
  });

  test("setTickInterval(0) stops the loop and clears the alarm", async () => {
    configureRuntime({ tickIntervalMs: 50, registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage), makeEnv(makeStub()));
    await instance.setup("room1");

    await instance.setTickInterval(100); // deterministically arm
    expect(storage._alarm).not.toBeNull();

    await instance.setTickInterval(0);

    expect(storage._alarm).toBeNull();
    expect(storage._map.get("__vamp:tick")).toEqual({ intervalMs: 0, paused: false });
  });

  test("pauseTick clears the alarm; resumeTick re-arms at the preserved interval", async () => {
    configureRuntime({ tickIntervalMs: 50, registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage), makeEnv(makeStub()));
    await instance.setup("room1");
    await instance.setTickInterval(50); // deterministically arm

    await instance.pauseTick();
    expect(storage._alarm).toBeNull();
    expect(storage._map.get("__vamp:tick")).toEqual({ intervalMs: 50, paused: true });

    // A stale alarm firing while paused is a no-op: no tick, no reschedule.
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));
    await instance.alarm();
    expect(instance.ecs.entity("ticker").n).toBe(0);
    expect(storage._alarm).toBeNull();

    await instance.resumeTick();
    // Re-armed at the preserved interval (never re-passed to resumeTick).
    expect(storage._alarm).not.toBeNull();
    expect(storage._map.get("__vamp:tick")).toEqual({ intervalMs: 50, paused: false });

    await instance.alarm();
    expect(instance.ecs.entity("ticker").n).toBe(1);
  });

  test("stepTick advances one tick regardless of the loop, without scheduling", async () => {
    // Loop disabled: stepTick still drives the world by hand.
    configureRuntime({ registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage), makeEnv(makeStub()));
    await instance.setup("room1");

    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));
    expect(storage._alarm).toBeNull();

    await instance.stepTick();
    expect(instance.ecs.entity("ticker").n).toBe(1);
    // The alarm schedule is untouched by a manual step.
    expect(storage._alarm).toBeNull();

    await instance.stepTick();
    expect(instance.ecs.entity("ticker").n).toBe(2);
  });

  test("a runtime tick override survives hibernation wake", async () => {
    // Provider config leaves the loop disabled; the runtime override enables it.
    configureRuntime({ registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance1 = newDO(makeCtx(storage), makeEnv(makeStub()));
    await instance1.setup("room1");
    await instance1.setTickInterval(50);
    expect(storage._map.get("__vamp:tick")).toEqual({ intervalMs: 50, paused: false });

    // Hibernation wake: a fresh DO over the SAME storage with a live socket. The
    // constructor re-bootstraps under blockConcurrencyWhile and re-applies the
    // persisted override.
    const ws = makeWs({ userId: "u1" });
    const ctx2 = makeCtx(storage, [ws]);
    const instance2 = newDO(ctx2, makeEnv(makeStub()));
    await ctx2._blocking;
    expect(instance2.initialized()).toBe(true);

    // The restored world adopted the runtime interval (50), NOT the provider's
    // disabled default: alarm() runs the tick and reschedules. Had the override
    // been lost, the interval-0 guard would bail and leave `n` at 0.
    await instance2.ecs.withScope(() => instance2.ecs.insert({ id: "ticker", n: 0 }));
    await instance2.alarm();
    expect(instance2.ecs.entity("ticker").n).toBe(1);
    expect(storage._alarm).not.toBeNull();
  });
});
