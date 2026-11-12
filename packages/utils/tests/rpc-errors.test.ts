import { ClientContext, type MethodInfo } from "@tempojs/client";
import {
  ConsoleLogger,
  MethodType,
  TempoError,
  TempoLogLevel,
  TempoStatusCode,
} from "@tempojs/common";
import { type BebopMethodAny, ServiceRegistry } from "@tempojs/server";
import { describe, expect, test } from "vitest";
import { Message } from "../src/bebop.ts";
import { CoreChannel } from "../src/channel-core.ts";
import { TempoWsRouter } from "../src/ws-router.ts";

const FAILING = 1;
const COUNTING = 2;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeMethod(type: MethodType, invoke: BebopMethodAny["invoke"]): BebopMethodAny {
  return {
    name: "m",
    service: "test",
    type,
    invoke,
    deserialize: () => ({}),
    serialize: () => new Uint8Array([1]),
    stringify: () => "",
    fromJSON: () => ({}),
  };
}

interface FakeSocket {
  frames: Message[];
  send(message: string | Blob | BufferSource): void;
}

function setup() {
  const methods = new Map<number, BebopMethodAny>([
    [
      FAILING,
      fakeMethod(MethodType.Unary, () => {
        throw new Error("db password is hunter2");
      }),
    ],
    [
      COUNTING,
      fakeMethod(MethodType.ClientStream, async (frames) => {
        if (!(frames instanceof Function)) return {};
        for await (const _ of frames());
        return {};
      }),
    ],
  ]);
  class Registry extends ServiceRegistry {
    init(): void {}
    getMethod(id: number): BebopMethodAny | undefined {
      return methods.get(id);
    }
  }
  const logger = new ConsoleLogger(`rpc-errors-${crypto.randomUUID()}`, TempoLogLevel.Critical);
  const router = new TempoWsRouter<null, FakeSocket>(logger, new Registry(logger));
  const frames: Message[] = [];
  const ws: FakeSocket = {
    frames,
    send: (message) => {
      // SAFETY: the router only ever sends encoded frames (Uint8Array).
      frames.push(Message.decode(message as Uint8Array));
    },
  };
  const send = (fields: Parameters<typeof Message>[0]) =>
    router.process(
      new Uint8Array(Message.encode(Message({ data: new Uint8Array(), ...fields }))).buffer,
      Message({}),
      [null, ws],
    );
  return { frames, send };
}

describe("TempoWsRouter error frames", () => {
  test("carry the request's messageId so the client can match them", async () => {
    const { frames, send } = setup();
    const unknown = crypto.randomUUID();
    const throws = crypto.randomUUID();
    await send({ messageId: unknown, methodId: 999 });
    await send({ messageId: throws, methodId: FAILING });
    expect(frames.map((m) => [m.messageId, m.status])).toEqual([
      [unknown, TempoStatusCode.NOT_FOUND],
      [throws, TempoStatusCode.UNKNOWN],
    ]);
  });

  test("do not leak a non-Tempo error's message", async () => {
    const { frames, send } = setup();
    await send({ messageId: crypto.randomUUID(), methodId: FAILING });
    expect(frames[0]?.msg).toBe("internal error");
  });

  test("an oversized frame is rejected before decoding", async () => {
    const { send } = setup();
    const huge = new Uint8Array(5 * 1024 * 1024);
    await expect(
      send({ messageId: crypto.randomUUID(), methodId: FAILING, data: huge }),
    ).rejects.toMatchObject({
      status: TempoStatusCode.RESOURCE_EXHAUSTED,
    });
  });
});

describe("client streams", () => {
  test("send one response for the whole stream, not one per frame", async () => {
    const { frames, send } = setup();
    const id = crypto.randomUUID();
    const done = send({ messageId: id, methodId: COUNTING });
    await send({ messageId: id, methodId: COUNTING });
    await send({ messageId: id, methodId: COUNTING });
    await send({ messageId: id, methodId: COUNTING, status: TempoStatusCode.CANCELLED });
    await done;
    await sleep(10);
    expect(frames.filter((m) => m.messageId === id)).toHaveLength(1);
  });
});

class LoopbackChannel extends CoreChannel {
  constructor() {
    super(
      new URL("test://loopback"),
      new ConsoleLogger(`loopback-${crypto.randomUUID()}`, TempoLogLevel.Critical),
      "bebop",
    );
  }
  protected override sendFrame(): void {}
  drop(): void {
    this.failInFlight(new TempoError(TempoStatusCode.UNAVAILABLE, "connection closed"));
  }
}

describe("CoreChannel on a dropped connection", () => {
  test("fails open server streams instead of leaving them parked", async () => {
    const channel = new LoopbackChannel();
    const request = Message({});
    // SAFETY: a server stream reads only id/type/serialize/deserialize from its
    // MethodInfo; the JSON members serve a wire path this test never takes.
    // biome-ignore lint/suspicious/noExplicitAny: Message stands in for a BebopRecord
    const method: MethodInfo<any, any> = {
      id: 7,
      name: "watch",
      service: "test",
      type: MethodType.ServerStream,
      serialize: () => new Uint8Array(),
      deserialize: () => request,
    } as any;
    const stream = await channel.startServerStream(request, ClientContext.createContext(), method);
    const next = stream.next();
    await sleep(0);
    channel.drop();
    await expect(next).rejects.toMatchObject({ status: TempoStatusCode.UNAVAILABLE });
  });
});
