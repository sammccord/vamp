import { ConsoleLogger } from "@tempojs/common";
import { ServiceRegistry } from "@tempojs/server";
import { type BaseEntity, createEntitySystem, type ECSOptions } from "@vampgg/ecs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { entitiesMap, readAllEntities, writeEntityInsert } from "../src/entity-doc.ts";

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
    /**
     * Forward a local write upstream. No real provider in this fake, but (a) record
     * the call on the stub so tests can assert that synced-in (REMOTE) entities are
     * NOT forwarded back (the no-duplication guarantee of a pure load), and (b) if
     * the stub models a stateful provider (`__providerDoc`), apply the forwarded
     * update into it so a later `syncOnce` (a fresh DO) pulls the accumulated state
     * back — modeling durable persistence across eviction.
     */
    async pushLocalUpdate(update: Uint8Array, _key?: string): Promise<void> {
      const stub = this.opts?.stub as
        | { __pushed?: Uint8Array[]; __providerDoc?: Y.Doc }
        | undefined;
      if (!stub) return;
      (stub.__pushed ??= []).push(update);
      if (stub.__providerDoc) Yjs.applyUpdate(stub.__providerDoc, update);
    }
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
  return {
    _map,
    async get(key: string) {
      return _map.get(key);
    },
    async put(entries: Record<string, unknown> | string, value?: unknown) {
      if (typeof entries === "string") _map.set(entries, value);
      else for (const [k, v] of Object.entries(entries)) _map.set(k, v);
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

/**
 * A GAME_STORAGE stub that IS the durable provider: it holds a `Y.Doc`, the
 * mocked client's `pushLocalUpdate` accumulates forwarded LOCAL writes into it
 * (see the `vi.mock` above), and `__seed`/`getYDoc` return its CURRENT encoded
 * state — so a `syncOnce` from a later, fresh DO pulls back everything a previous
 * session persisted. Models world-state durability across DO eviction.
 */
function makeProviderStub() {
  const providerDoc = new Y.Doc();
  return {
    __providerDoc: providerDoc,
    get __seed(): Uint8Array {
      return Y.encodeStateAsUpdate(providerDoc);
    },
    async subscribe() {
      return new ReadableStream();
    },
    async update() {},
    async getYDoc() {
      return Y.encodeStateAsUpdate(providerDoc);
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
    for (const e of entities) writeEntityInsert(doc, e.id, e as Record<string, unknown>);
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

describe("ECSDurableObject — request-scoped catch-up tick", () => {
  test("_maybeTick advances catch-up frames while a player is connected", async () => {
    configureRuntime({ tickIntervalMs: 50, registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage, [makeWs()]), makeEnv(makeStub()));
    await instance.setup("room1");
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));

    // First call anchors the clock (no back-fill of history), so no tick yet.
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(0);

    // 220 ms elapsed at a 50 ms cadence → floor(220/50) = 4 catch-up frames.
    instance._lastTickAt = Date.now() - 220;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(4);
  });

  test("catch-up is capped at MAX_CATCHUP_TICKS after a long gap", async () => {
    configureRuntime({ tickIntervalMs: 50, registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage, [makeWs()]), makeEnv(makeStub()));
    await instance.setup("room1");
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));
    await instance._maybeTick(); // anchor

    // 5000 ms → 100 frames due, capped to the 8-frame burst limit.
    instance._lastTickAt = Date.now() - 5000;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(8);
  });

  test("no tick when no player is connected", async () => {
    configureRuntime({ tickIntervalMs: 50, registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage, []), makeEnv(makeStub())); // no sockets
    await instance.setup("room1");
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));

    instance._lastTickAt = Date.now() - 220;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(0);
  });

  test("no tick when ticking is disabled (interval 0) or paused", async () => {
    configureRuntime({ registerSystems: registerNSystem }); // interval 0 (disabled)
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage, [makeWs()]), makeEnv(makeStub()));
    await instance.setup("room1");
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));

    instance._lastTickAt = Date.now() - 220;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(0); // disabled → no tick

    await instance.setTickInterval(50);
    await instance.pauseTick();
    instance._lastTickAt = Date.now() - 220;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(0); // paused → no tick
  });

  test("webSocketMessage drives a catch-up tick before processing the message", async () => {
    configureRuntime({ tickIntervalMs: 50, registerSystems: registerNSystem });
    const storage = makeStorage();
    const ws = makeWs();
    const instance = newDO(makeCtx(storage, [ws]), makeEnv(makeStub()));
    await instance.setup("room1");
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));

    instance._lastTickAt = Date.now() - 120; // 2 frames due at 50 ms
    // An undecodable frame is fine: the tick runs BEFORE router.process, and the
    // decode error is caught + framed back to the client. We assert the tick ran.
    await instance.webSocketMessage(ws, new Uint8Array([0, 0, 0]).buffer);
    expect(instance.ecs.entity("ticker").n).toBe(2);
  });
});

describe("ECSDurableObject — runtime tick controls (no alarm)", () => {
  test("setTickInterval enables ticking booted disabled; persists the override", async () => {
    // No tickIntervalMs in the provider config: ticking starts disabled.
    configureRuntime({ registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage, [makeWs()]), makeEnv(makeStub()));
    await instance.setup("room1");
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));

    // Disabled: no catch-up even with elapsed time.
    instance._lastTickAt = Date.now() - 120;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(0);

    await instance.setTickInterval(50);
    // Persisted; no alarm involved (storage has no alarm API anymore).
    expect(storage._map.get("__vamp:tick")).toEqual({ intervalMs: 50, paused: false });

    // Now ticking is enabled and the captured hooks drive catch-up.
    instance._lastTickAt = Date.now() - 120;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(2);
  });

  test("setTickInterval(0) disables ticking; persists the override", async () => {
    configureRuntime({ tickIntervalMs: 50, registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage, [makeWs()]), makeEnv(makeStub()));
    await instance.setup("room1");
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));

    await instance.setTickInterval(0);
    expect(storage._map.get("__vamp:tick")).toEqual({ intervalMs: 0, paused: false });

    instance._lastTickAt = Date.now() - 220;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(0);
  });

  test("pauseTick then resumeTick preserves the interval; persists paused flag", async () => {
    configureRuntime({ tickIntervalMs: 50, registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage, [makeWs()]), makeEnv(makeStub()));
    await instance.setup("room1");
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));

    await instance.pauseTick();
    expect(storage._map.get("__vamp:tick")).toEqual({ intervalMs: 50, paused: true });
    instance._lastTickAt = Date.now() - 220;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(0); // paused → no tick

    await instance.resumeTick();
    // Resumed at the preserved interval (never re-passed to resumeTick).
    expect(storage._map.get("__vamp:tick")).toEqual({ intervalMs: 50, paused: false });
    instance._lastTickAt = Date.now() - 220;
    await instance._maybeTick();
    expect(instance.ecs.entity("ticker").n).toBe(4);
  });

  test("stepTick advances exactly one tick, independent of interval/socket", async () => {
    // Ticking disabled AND no socket: stepTick still drives the world by hand.
    configureRuntime({ registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance = newDO(makeCtx(storage, []), makeEnv(makeStub()));
    await instance.setup("room1");
    await instance.ecs.withScope(() => instance.ecs.insert({ id: "ticker", n: 0 }));

    await instance.stepTick();
    expect(instance.ecs.entity("ticker").n).toBe(1);
    await instance.stepTick();
    expect(instance.ecs.entity("ticker").n).toBe(2);
  });

  test("a runtime tick override survives hibernation wake", async () => {
    // Provider config leaves ticking disabled; the runtime override enables it.
    configureRuntime({ registerSystems: registerNSystem });
    const storage = makeStorage();
    const instance1 = newDO(makeCtx(storage, [makeWs()]), makeEnv(makeStub()));
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
    // disabled default: catch-up ticks run. Had the override been lost, the
    // interval-0 guard would bail and leave `n` at 0.
    await instance2.ecs.withScope(() => instance2.ecs.insert({ id: "ticker", n: 0 }));
    instance2._lastTickAt = Date.now() - 120;
    await instance2._maybeTick();
    expect(instance2.ecs.entity("ticker").n).toBe(2);
  });
});

// ── Explicit shard subscription (loadShard / unloadShard) ────────────────────

// Env whose GAME_STORAGE resolves a DISTINCT stub per root, so a character shard
// can be seeded independently of the lobby's own (default) shard.
// biome-ignore lint/suspicious/noExplicitAny: fake env binding
function makeEnvByRoot(byRoot: Record<string, any>): any {
  return {
    GAME_STORAGE: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => byRoot[id.name],
    },
  };
}

// Let fire-and-forget work scheduled past `waitUntil` (the fake ctx ignores the
// promise, but the async chain still runs) settle before asserting.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("ECSDurableObject — explicit shard subscription", () => {
  test("loadShard pulls a character shard's entities into the world and persists the subscription", async () => {
    configureRuntime();
    const storage = makeStorage();
    const gameStub = makeStub(); // lobby's own shard: empty
    const charStub = makeStub(
      seedDoc("character/alice", [
        { id: "c1", x: 1, y: 2 },
        { id: "c2", x: 3, y: 4 },
      ]),
    );
    const instance = newDO(
      makeCtx(storage),
      makeEnvByRoot({ "game/room1": gameStub, "character/alice": charStub }),
    );
    await instance.setup("room1");

    // The default shard is empty; the character's entities are not loaded yet.
    expect(instance.ecs.hasEntity("c1")).toBe(false);

    await instance.loadShard("character/alice");
    await settle();

    // The character's entities are now imported into the running ECS world.
    expect(instance.ecs.hasEntity("c1")).toBe(true);
    expect(instance.ecs.hasEntity("c2")).toBe(true);
    expect(instance.ecs.entity("c1")).toMatchObject({ x: 1, y: 2 });

    // The subscription is tracked, persisted, and pins the shard.
    expect(instance._subscribedRoots.has("character/alice")).toBe(true);
    expect(storage._map.get("__vamp:subscribed")).toEqual(["character/alice"]);
    expect(instance.shards.activeRoots().sort()).toEqual(["character/alice", "game/room1"]);

    // No duplication: the synced-in (REMOTE) entities are never forwarded back to
    // the provider — a pure load re-persists nothing. (`__pushed` is attached
    // dynamically by the mock client's `pushLocalUpdate`, so it is not on the
    // stub's literal type.)
    expect((charStub as { __pushed?: Uint8Array[] }).__pushed).toBeUndefined();
  });

  test("loadShard is idempotent and the subscription survives entity-emptiness until unloadShard", async () => {
    configureRuntime();
    const storage = makeStorage();
    const instance = newDO(
      makeCtx(storage),
      makeEnvByRoot({ "game/room1": makeStub(), "character/solo": makeStub() }), // both empty
    );
    await instance.setup("room1");

    // Subscribe to an entity-EMPTY character shard, twice (idempotent — no 2nd pin).
    await instance.loadShard("character/solo");
    await instance.loadShard("character/solo");
    await settle();
    expect(instance.shards.pinned("character/solo")).toBe(true);
    expect(instance._subscribedRoots.has("character/solo")).toBe(true);

    // OR-semantics: the release driver (called when a root becomes entity-empty)
    // is a no-op for a subscribed root — the subscription is NOT torn down.
    instance._maybeReleaseShard("character/solo");
    expect(instance.shards.pinned("character/solo")).toBe(true);
    expect(instance.shards.activeRoots()).toContain("character/solo");

    // unloadShard drops the (idempotent, single) pin: one release fully unpins it,
    // proving no pin leak from the double load.
    await instance.unloadShard("character/solo");
    expect(instance._subscribedRoots.has("character/solo")).toBe(false);
    expect(storage._map.get("__vamp:subscribed")).toEqual([]);
    expect(instance.shards.activeRoots()).not.toContain("character/solo");
  });

  test("unloadShard keeps the shard pinned while entities still live in it", async () => {
    configureRuntime();
    const storage = makeStorage();
    const charStub = makeStub(seedDoc("character/bob", [{ id: "c1", x: 9 }]));
    const instance = newDO(
      makeCtx(storage),
      makeEnvByRoot({ "game/room1": makeStub(), "character/bob": charStub }),
    );
    await instance.setup("room1");
    await instance.loadShard("character/bob");
    await settle();
    expect(instance.ecs.hasEntity("c1")).toBe(true);

    // Dropping the subscription while the shard still has members leaves the pin in
    // place (it reverts to the entity-pin, released later when membership hits 0).
    await instance.unloadShard("character/bob");
    expect(instance._subscribedRoots.has("character/bob")).toBe(false);
    expect(instance.shards.pinned("character/bob")).toBe(true);
    expect(instance.shards.activeRoots()).toContain("character/bob");
  });

  test("hibernation wake restores the subscribed set without leaking a second pin", async () => {
    configureRuntime();
    // A DO previously subscribed to character/alice: namespace + both shards
    // persisted as pinned, and the explicit-subscription set persisted.
    const storage = makeStorage({
      "__vamp:namespace": "room1",
      "__vamp:shards": ["game/room1", "character/alice"],
      "__vamp:subscribed": ["character/alice"],
    });
    const ws = makeWs({ userId: "u1" });
    const ctx = makeCtx(storage, [ws]);
    const instance = newDO(ctx, makeEnv(makeStub())); // empty shards on wake
    await ctx._blocking;
    await settle();

    expect(instance.initialized()).toBe(true);
    // The subscription set is restored so the release exemption holds post-wake.
    expect(instance._subscribedRoots.has("character/alice")).toBe(true);
    expect(instance.shards.activeRoots()).toContain("character/alice");

    // Single pin: the restore re-acquired it once (via __vamp:shards); the wake did
    // NOT re-acquire from the subscribed set. So one unload fully unpins it — a
    // leaked second pin would leave it active.
    await instance.unloadShard("character/alice");
    expect(instance.shards.activeRoots()).not.toContain("character/alice");
  });
});

describe("ECSDurableObject — game-shard state persists across eviction", () => {
  // Let the write-forwarder's debounce (`_forwardDebounceMs` = 16 ms) fire so
  // LOCAL writes reach the provider before we assert on it.
  const forwarded = () => new Promise((r) => setTimeout(r, 30));

  test("a game-owned (default-shard) entity is re-seeded with its mutated state when the next player joins", async () => {
    configureRuntime();
    // One durable provider DO backing the lobby's own `game/room1` shard, shared
    // across both sessions (same namespace → same provider by `idFromName`).
    const provider = makeProviderStub();

    // ── Session 1: game logic spawns and damages an enemy, then everyone leaves.
    const instance1 = newDO(makeCtx(makeStorage()), makeEnvByRoot({ "game/room1": provider }));
    await instance1.setup("room1");

    // An enemy OWNED BY THE GAME carries no `sk`, so it homes to the lobby's own
    // `game/room1` shard (not a player's `character/*`). `n` stands in for HP.
    await instance1.ecs.withScope(() => instance1.ecs.insert({ id: "enemy", n: 100 }));
    // It takes damage but survives (n: 100 → 70). The test's ECS mutator is
    // last-writer (Object.assign), so this is an absolute set.
    await instance1.ecs.withScope(() => instance1.ecs.put("enemy", { n: 70 }));
    await forwarded();

    // The mutated state was forwarded to and persisted in the durable provider doc.
    const persisted = readAllEntities<Entity>(provider.__providerDoc).find((e) => e.id === "enemy");
    expect(persisted?.n).toBe(70);

    // ── Session 2: a FRESH cold DO (a new isolate; the old one was evicted). Its
    // ECS starts empty — the enemy can only reappear by being pulled from the
    // provider on setup.
    const instance2 = newDO(makeCtx(makeStorage()), makeEnvByRoot({ "game/room1": provider }));
    expect(instance2.ecs).toBeUndefined(); // cold: nothing bootstrapped yet
    await instance2.setup("room1");

    // The same enemy is re-seeded into the new world, at its mutated HP — proving
    // game-owned world state survives eviction and is restored for the next player.
    expect(instance2.ecs.hasEntity("enemy")).toBe(true);
    expect(instance2.ecs.entity("enemy").n).toBe(70);
  });
});
