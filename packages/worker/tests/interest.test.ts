import { TempoStatusCode } from "@tempojs/common";
import type { ServerContext } from "@tempojs/server";
import {
  type BaseEntity,
  ECS,
  type ECSOptions,
  type GenericAction,
  MutationRecord,
} from "@vampgg/ecs";
import { Message } from "@vampgg/utils/bebop";
import { STREAM_MESSAGE_ID_KEY, STREAM_METHOD_ID_KEY } from "@vampgg/utils/ws-router";
import { describe, expect, test } from "vitest";
import { createInterestBroadcast } from "../src/interest.ts";

/**
 * Unit coverage for the generic interest-managed broadcast factory. Uses a real
 * `@vampgg/ecs` world plus a fake hibernatable WebSocket and a self-contained text
 * codec (no bebop), so the suite is a plain node test — which also proves
 * `interest.ts` is free of `cloudflare:workers` (it would fail to import here
 * otherwise).
 */

type TestEntity = BaseEntity & { position?: { x: number; y: number } };
type TestDelta = Partial<TestEntity>;
type TestReq = { viewerId?: string };
type World = ECS<Record<string, unknown>, [], GenericAction, number, TestEntity, TestDelta>;

const AOI_RADIUS_SQ = 100 * 100;

/** AOI policy: a missing viewer / position-less entity is always visible. */
function canSee(
  world: World,
  viewerId: string | undefined,
  targetId: string,
  target: TestEntity,
): boolean {
  if (!viewerId || targetId === viewerId) return true;
  const viewer = world.entity(viewerId);
  if (!viewer?.position || !target.position) return true;
  const dx = (target.position.x ?? 0) - (viewer.position.x ?? 0);
  const dy = (target.position.y ?? 0) - (viewer.position.y ?? 0);
  return dx * dx + dy * dy <= AOI_RADIUS_SQ;
}

/** Encode a batch as its comma-joined entity ids — keeps the test bebop-free. */
function encodeBatch(batch: Map<string, MutationRecord<TestEntity, TestDelta>>): Uint8Array {
  return new TextEncoder().encode([...batch.keys()].join(","));
}

const options = {
  createId: () => crypto.randomUUID(),
  components: {},
  materializeDelta: (delta: TestDelta): TestEntity => delta as TestEntity,
  mergeDelta: (entity: TestEntity, delta: TestDelta): void => {
    Object.assign(entity as Record<string, unknown>, delta);
  },
  accumulateDelta: (from: TestDelta, to: TestDelta): TestDelta => ({ ...to, ...from }),
} as unknown as ECSOptions<TestEntity, TestDelta>;

/** A bare ECS world wired like the durable object's, minus Yjs/flush. */
function makeWorld(): World {
  const entities = new Map<string, TestEntity>();
  const mutate = (id: string, m: MutationRecord<TestEntity, TestDelta>): void => {
    switch (m.tag) {
      case 1:
        entities.set(id, m.value.entity);
        break;
      case 2: {
        const e = entities.get(id);
        if (e) options.mergeDelta(e, m.value.delta);
        break;
      }
      case 3:
        entities.delete(id);
        break;
    }
  };
  const ecs = new ECS<Record<string, unknown>, [], GenericAction, number, TestEntity, TestDelta>(
    entities,
    mutate,
    {},
    options,
  );
  ecs.initialize();
  return ecs;
}

/** A minimal hibernatable-WebSocket stand-in capturing attachment + sends. */
function makeFakeWs() {
  let attachment: unknown = null;
  const sent: ArrayBuffer[] = [];
  const ws = {
    readyState: 1,
    serializeAttachment(v: unknown) {
      attachment = structuredClone(v);
    },
    deserializeAttachment() {
      return attachment;
    },
    send(data: ArrayBuffer) {
      sent.push(data);
    },
  } as unknown as WebSocket;
  return { ws, sent };
}

/** A minimal ServerContext exposing the [world, ws] env + stream-id metadata. */
function makeCtx(world: World, ws: WebSocket, messageId: string, methodId: number): ServerContext {
  const meta = new Map<string, string[]>([
    [STREAM_MESSAGE_ID_KEY, [messageId]],
    [STREAM_METHOD_ID_KEY, [String(methodId)]],
  ]);
  return {
    clientMetadata: { get: (k: string) => meta.get(k) },
    getEnvironment: () => [world, ws],
  } as unknown as ServerContext;
}

function frameInfo(frame: ArrayBuffer): {
  messageId?: string;
  status?: number;
  keys: string[];
} {
  const m = Message.decode(new Uint8Array(frame));
  const text = new TextDecoder().decode((m.data ?? new Uint8Array()) as Uint8Array);
  return { messageId: m.messageId, status: m.status, keys: text ? text.split(",") : [] };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const ATTACHMENT_KEY = "__vamp:interest";

describe("createInterestBroadcast", () => {
  test("rehydrateConnection rebuilds observers and routes framed pushes to the right sockets", async () => {
    const broadcast = createInterestBroadcast<World, TestReq, never, TestEntity, TestDelta>({
      encodeBatch,
      canSee,
      resolveViewer: (r: TestReq) => r.viewerId,
    });
    const world = makeWorld();

    const viewerId = crypto.randomUUID();
    await world.withScope(() => world.insert({ id: viewerId, position: { x: 0, y: 0 } }));

    // Socket 1: global observer (no viewer → sees every mutation).
    const global = makeFakeWs();
    const globalMsgId = crypto.randomUUID();
    global.ws.serializeAttachment({
      [ATTACHMENT_KEY]: { messageId: globalMsgId, methodId: 11, viewerId: undefined },
    });
    broadcast.rehydrateConnection(world, global.ws);

    // Socket 2: AOI observer around `viewerId`.
    const aoi = makeFakeWs();
    const aoiMsgId = crypto.randomUUID();
    aoi.ws.serializeAttachment({
      [ATTACHMENT_KEY]: { messageId: aoiMsgId, methodId: 22, viewerId },
    });
    broadcast.rehydrateConnection(world, aoi.ws);

    expect(world.observerCount).toBe(2);

    const near = crypto.randomUUID();
    const far = crypto.randomUUID();
    await world.withScope(() => {
      world.insert({ id: near, position: { x: 5, y: 5 } });
      world.insert({ id: far, position: { x: 9999, y: 9999 } });
    });

    // Global socket: a single frame (its messageId) carrying BOTH inserts.
    expect(global.sent.length).toBe(1);
    const g = frameInfo(global.sent[0]);
    expect(g.messageId).toBe(globalMsgId);
    expect(g.status).toBe(TempoStatusCode.OK);
    expect(g.keys).toContain(near);
    expect(g.keys).toContain(far);

    // AOI socket: a single frame (its messageId) carrying ONLY the near insert.
    expect(aoi.sent.length).toBe(1);
    const a = frameInfo(aoi.sent[0]);
    expect(a.messageId).toBe(aoiMsgId);
    expect(a.keys).toContain(near);
    expect(a.keys).not.toContain(far);
  });

  test("rehydrateConnection is a no-op for a socket without a persisted subscription", () => {
    const broadcast = createInterestBroadcast<World, TestReq, never, TestEntity, TestDelta>({
      encodeBatch,
    });
    const world = makeWorld();
    const { ws } = makeFakeWs();
    broadcast.rehydrateConnection(world, ws);
    expect(world.observerCount).toBe(0);
  });

  test("observe persists the sub, sends an interest-filtered snapshot, then parks and pushes live frames", async () => {
    const broadcast = createInterestBroadcast<World, TestReq, never, TestEntity, TestDelta>({
      encodeBatch,
      canSee,
      resolveViewer: (r: TestReq) => r.viewerId,
    });
    const world = makeWorld();

    const viewerId = crypto.randomUUID();
    const near = crypto.randomUUID();
    const far = crypto.randomUUID();
    await world.withScope(() => {
      world.insert({ id: viewerId, position: { x: 0, y: 0 } });
      world.insert({ id: near, position: { x: 1, y: 1 } });
      world.insert({ id: far, position: { x: 9999, y: 9999 } });
    });

    const { ws, sent } = makeFakeWs();
    const msgId = crypto.randomUUID();
    const ctx = makeCtx(world, ws, msgId, 42);

    const gen = broadcast.observe({ viewerId }, ctx);
    // Start the generator; it registers + sends snapshot + parks. The promise
    // stays pending until the stream is cancelled (kept so we can await the
    // clean done after teardown — never `gen.return()` a parked generator, that
    // deadlocks behind the pending next()).
    const parked = gen.next();
    await tick();

    // The subscription is persisted under the namespaced attachment key.
    const attachment = ws.deserializeAttachment() as Record<string, unknown>;
    expect(attachment[ATTACHMENT_KEY]).toMatchObject({ messageId: msgId, methodId: 42, viewerId });
    expect(world.observerCount).toBe(1);

    // Initial snapshot frame: viewer + near, NOT far.
    expect(sent.length).toBe(1);
    const snap = frameInfo(sent[0]);
    expect(snap.messageId).toBe(msgId);
    expect(snap.keys).toEqual(expect.arrayContaining([viewerId, near]));
    expect(snap.keys).not.toContain(far);

    // A live commit pushes a second framed batch, still interest-filtered.
    const near2 = crypto.randomUUID();
    await world.withScope(() => {
      world.insert({ id: near2, position: { x: 2, y: 2 } });
      world.insert({ id: crypto.randomUUID(), position: { x: 8888, y: 8888 } });
    });
    expect(sent.length).toBe(2);
    expect(frameInfo(sent[1]).keys).toEqual([near2]);

    // Socket close drives the teardown (cancel → parked next() resolves done),
    // tearing the observer down and clearing the sub.
    broadcast.onConnectionClose(ws);
    await parked;
    expect(world.observerCount).toBe(0);
    expect((ws.deserializeAttachment() as Record<string, unknown>)[ATTACHMENT_KEY]).toBeUndefined();
  });

  test("default policy broadcasts globally (no canSee / resolveViewer)", async () => {
    const broadcast = createInterestBroadcast<World, TestReq, never, TestEntity, TestDelta>({
      encodeBatch,
    });
    const world = makeWorld();
    const { ws, sent } = makeFakeWs();
    const msgId = crypto.randomUUID();

    const gen = broadcast.observe({}, makeCtx(world, ws, msgId, 7));
    const parked = gen.next();
    await tick();

    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await world.withScope(() => {
      world.insert({ id: a, position: { x: 0, y: 0 } });
      world.insert({ id: b, position: { x: 9999, y: 9999 } });
    });

    // No empty snapshot (world was empty at observe time), then one live frame
    // carrying BOTH entities — the default canSee is always-visible.
    expect(sent.length).toBe(1);
    expect(frameInfo(sent[0]).keys).toEqual(expect.arrayContaining([a, b]));

    broadcast.onConnectionClose(ws);
    await parked;
    expect(world.observerCount).toBe(0);
  });

  test("onConnectionClose reaps a rehydrated (generator-free) observer", async () => {
    const broadcast = createInterestBroadcast<World, TestReq, never, TestEntity, TestDelta>({
      encodeBatch,
    });
    const world = makeWorld();
    const { ws, sent } = makeFakeWs();
    ws.serializeAttachment({ [ATTACHMENT_KEY]: { messageId: crypto.randomUUID(), methodId: 3 } });
    broadcast.rehydrateConnection(world, ws);
    expect(world.observerCount).toBe(1);

    broadcast.onConnectionClose(ws);
    expect(world.observerCount).toBe(0);
    expect((ws.deserializeAttachment() as Record<string, unknown>)[ATTACHMENT_KEY]).toBeUndefined();

    // A later commit reaches no one.
    await world.withScope(() => world.insert({ id: crypto.randomUUID() }));
    expect(sent.length).toBe(0);
  });

  test("observe cleanup and onConnectionClose do not double-unsubscribe", async () => {
    const broadcast = createInterestBroadcast<World, TestReq, never, TestEntity, TestDelta>({
      encodeBatch,
    });
    const world = makeWorld();
    const { ws } = makeFakeWs();
    const gen = broadcast.observe({}, makeCtx(world, ws, crypto.randomUUID(), 9));
    const parked = gen.next();
    await tick();
    expect(world.observerCount).toBe(1);

    // Both teardown paths fire: the DO close hook (cancels → parked next resolves)
    // and then a redundant generator return. The second is a harmless no-op.
    broadcast.onConnectionClose(ws);
    await parked;
    await gen.return(undefined);
    expect(world.observerCount).toBe(0);
  });
});
