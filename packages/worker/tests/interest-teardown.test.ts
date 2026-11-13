import { ConsoleLogger, MethodType, TempoLogLevel, TempoStatusCode } from "@tempojs/common";
import { type BebopMethodAny, ServiceRegistry } from "@tempojs/server";
import { createBaseMutator, ECS, type ECSOptions, type GenericAction } from "@vampgg/ecs";
import { Message } from "@vampgg/utils/bebop";
import { TempoWsRouter } from "@vampgg/utils/ws-router";
import { describe, expect, test } from "vitest";
import { createInterestBroadcast } from "../src/interest.ts";

type Entity = { id?: string; hp?: number };
type World = ECS<{}, [], GenericAction, number, Entity, Entity>;

const METHOD_ID = 7;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const entities = new Map<string, Entity>();
  const options: ECSOptions<Entity, Entity> = {
    createId: () => crypto.randomUUID(),
    components: { hp: 1 },
    materializeDelta: (delta, base) => ({ ...base, ...delta }),
    mergeDelta: (entity, delta) => void Object.assign(entity, delta),
    accumulateDelta: (from, to) => Object.assign(to, from),
  };
  const world: World = new ECS(entities, createBaseMutator(entities, options), {}, options);
  world.initialize();

  const broadcast = createInterestBroadcast<World, unknown>({
    encodeBatch: (batch) => new TextEncoder().encode([...batch.keys()].join(",")),
  });
  const method: BebopMethodAny = {
    name: "observe",
    service: "test",
    type: MethodType.ServerStream,
    async *invoke(record, context) {
      yield* broadcast.observe(record, context);
    },
    deserialize: () => ({}),
    serialize: () => new Uint8Array(),
    stringify: () => "",
    fromJSON: () => ({}),
  };
  class Registry extends ServiceRegistry {
    init(): void {}
    getMethod(id: number): BebopMethodAny | undefined {
      return id === METHOD_ID ? method : undefined;
    }
  }
  const logger = new ConsoleLogger(
    `interest-teardown-${crypto.randomUUID()}`,
    TempoLogLevel.Critical,
  );
  const router = new TempoWsRouter<World, WebSocket>(logger, new Registry(logger));

  const socket = () => {
    let attachment: WebSocketAttachment | null = null;
    const frames: Message[] = [];
    // SAFETY: interest.ts and the router touch only these members of a socket.
    const ws = {
      readyState: 1,
      serializeAttachment: (v: WebSocketAttachment) => void (attachment = structuredClone(v)),
      deserializeAttachment: () => attachment,
      send: (data: ArrayBuffer | Uint8Array) =>
        void frames.push(Message.decode(data instanceof Uint8Array ? data : new Uint8Array(data))),
    } as WebSocket;
    return { ws, frames };
  };
  const call = (ws: WebSocket, messageId: string, status?: number) =>
    router.process(
      new Uint8Array(
        Message.encode(Message({ messageId, methodId: METHOD_ID, data: new Uint8Array(), status })),
      ).buffer,
      Message({}),
      [world, ws],
    );
  return { world, router, broadcast, socket, call };
}

describe("interest observe teardown through TempoWsRouter", () => {
  test("a client CANCELLED unsubscribes the observer", async () => {
    const { world, socket, call } = setup();
    const { ws } = socket();
    void call(ws, "11111111-1111-1111-1111-111111111111");
    await sleep(10);
    expect(world.observerCount).toBe(1);
    await call(ws, "11111111-1111-1111-1111-111111111111", TempoStatusCode.CANCELLED);
    await sleep(10);
    expect(world.observerCount).toBe(0);
  });

  test("closing one socket leaves other sockets' observers streaming", async () => {
    const { world, router, broadcast, socket, call } = setup();
    const alice = socket();
    const bob = socket();
    void call(alice.ws, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    void call(bob.ws, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    await sleep(10);
    expect(world.observerCount).toBe(2);

    router.closeConnection(alice.ws);
    broadcast.onConnectionClose(alice.ws);
    await sleep(10);
    expect(world.observerCount).toBe(1);

    await world.withScope(() => world.insert({ id: "e", hp: 1 }));
    expect(bob.frames.filter((m) => m.status === TempoStatusCode.OK)).toHaveLength(1);
    expect(bob.frames.some((m) => m.status === TempoStatusCode.CANCELLED)).toBe(false);
  });
});
