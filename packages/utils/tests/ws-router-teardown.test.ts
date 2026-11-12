import { ConsoleLogger, MethodType, TempoLogLevel, TempoStatusCode } from "@tempojs/common";
import { type BebopMethodAny, type ServerContext, ServiceRegistry } from "@tempojs/server";
import { describe, expect, test } from "vitest";
import { Message } from "../src/bebop.ts";
import { createEventIterator } from "../src/create-event-iterator.ts";
import { streamAbortSignal, TempoWsRouter } from "../src/ws-router.ts";

const METHOD_ID = 42;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server-stream handler parked on an external source, ended only by its abort signal. */
function parkedStream(live: Set<string>): BebopMethodAny {
  return {
    name: "observe",
    service: "test",
    type: MethodType.ServerStream,
    async *invoke(_record, context: ServerContext) {
      const [name] = context.getEnvironment<[string, FakeSocket]>();
      const signal = streamAbortSignal(context);
      live.add(name);
      yield* createEventIterator<never>(({ cancel }) => {
        signal?.addEventListener("abort", cancel, { once: true });
        return () => {
          live.delete(name);
        };
      });
    },
    deserialize: () => ({}),
    serialize: () => new Uint8Array(),
    stringify: () => "",
    fromJSON: () => ({}),
  };
}

interface FakeSocket {
  frames: Message[];
  send(message: string | Blob | BufferSource): void;
}

function setup() {
  const live = new Set<string>();
  const method = parkedStream(live);
  class Registry extends ServiceRegistry {
    init(): void {}
    getMethod(id: number): BebopMethodAny | undefined {
      return id === METHOD_ID ? method : undefined;
    }
  }
  const logger = new ConsoleLogger(
    `ws-router-teardown-${crypto.randomUUID()}`,
    TempoLogLevel.Critical,
  );
  const router = new TempoWsRouter<string, FakeSocket>(logger, new Registry(logger));
  const socket = (): FakeSocket => {
    const frames: Message[] = [];
    return {
      frames,
      send: (message) => {
        // SAFETY: the router only ever sends encoded frames (Uint8Array).
        frames.push(Message.decode(message as Uint8Array));
      },
    };
  };
  const call = (name: string, ws: FakeSocket, messageId: string, status?: number) =>
    router.process(
      new Uint8Array(
        Message.encode(Message({ messageId, methodId: METHOD_ID, data: new Uint8Array(), status })),
      ).buffer,
      Message({}),
      [name, ws],
    );
  return { router, live, socket, call };
}

describe("TempoWsRouter stream teardown", () => {
  test("closeConnection ends only that socket's parked streams, without blocking", async () => {
    const { router, live, socket, call } = setup();
    const alice = socket();
    const bob = socket();
    void call("alice", alice, "alice-stream");
    void call("bob", bob, "bob-stream");
    await sleep(10);
    expect([...live].sort()).toEqual(["alice", "bob"]);

    router.closeConnection(alice);
    await sleep(10);
    expect([...live]).toEqual(["bob"]);
    expect(bob.frames.filter((m) => m.status === TempoStatusCode.CANCELLED)).toEqual([]);
  });

  test("a client CANCELLED frame ends the parked stream and sends the terminal frame", async () => {
    const { live, socket, call } = setup();
    const ws = socket();
    void call("carol", ws, "carol-stream");
    await sleep(10);
    const cancelled = await Promise.race([
      call("carol", ws, "carol-stream", TempoStatusCode.CANCELLED).then(() => "done"),
      sleep(200).then(() => "hung"),
    ]);
    expect(cancelled).toBe("done");
    await sleep(10);
    expect(live.size).toBe(0);
    expect(ws.frames.some((m) => m.status === TempoStatusCode.CANCELLED)).toBe(true);
  });

  test("a CANCELLED from another socket cannot end a stream it does not own", async () => {
    const { live, socket, call } = setup();
    const owner = socket();
    const other = socket();
    void call("owner", owner, "shared-id");
    await sleep(10);
    await call("other", other, "shared-id", TempoStatusCode.CANCELLED);
    await sleep(10);
    expect([...live]).toEqual(["owner"]);
  });
});
