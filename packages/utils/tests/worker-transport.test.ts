import { webcrypto } from "node:crypto";
import { ClientContext, type MethodInfo } from "@tempojs/client";
import { ConsoleLogger, MethodType, TempoError, TempoStatusCode } from "@tempojs/common";
import { ServiceRegistry } from "@tempojs/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Message } from "../src/bebop.ts";

/**
 * In-process loopback for the worker transport (`TempoWorkerChannel` +
 * `TempoWorkerRouter`). The channel hard-constructs a (Bun/web) `Worker` and the
 * router writes responses via the bare global `postMessage`; neither owns an
 * injectable port. So we stub `globalThis.Worker` with a fake whose
 * `postMessage` feeds `router.process(...)`, and stub `globalThis.postMessage`
 * to dispatch the router's output back into the fake worker's message listeners.
 * No real worker thread, no separate fixture file — the whole round-trip is
 * microtask-driven.
 */

// --- A hand-rolled echo service registry (no bebop codegen). The transport only
//     touches method.invoke/serialize/deserialize/type, so reusing `Message` as
//     the request/response record is enough.
const ECHO_METHOD_ID = 1234;

// Arrow wrappers so the static codec fns are not passed as unbound methods.
const encode = (m: Message): Uint8Array => Message.encode(m);
const decode = (b: Uint8Array): Message => Message.decode(b);

class EchoRegistry extends ServiceRegistry {
  init(): void {
    (this as unknown as { methods: Map<number, unknown> }).methods.set(ECHO_METHOD_ID, {
      name: "echo",
      service: "Test",
      invoke: async (record: unknown) => record, // unary echo
      serialize: encode,
      deserialize: decode,
      type: MethodType.Unary,
    });
  }
  // biome-ignore lint/suspicious/noExplicitAny: base getMethod returns BebopMethodAny
  getMethod(id: number): any {
    return (this as unknown as { methods: Map<number, unknown> }).methods.get(id);
  }
}

// TempoLogger keeps a process-global registry keyed by name, so a second
// `new ConsoleLogger("test")` throws "already exists". One shared instance.
const logger = new ConsoleLogger("worker-transport-test");

// Typed as `any` records: `Message` (the transport envelope) doubles as the test
// request/response record, but its declared type isn't a `BebopRecord`.
// biome-ignore lint/suspicious/noExplicitAny: test record stands in for a BebopRecord
const echoMethodInfo: MethodInfo<any, any> = {
  name: "echo",
  service: "Test",
  id: ECHO_METHOD_ID,
  serialize: encode,
  deserialize: decode,
  type: MethodType.Unary,
} as any;

// --- Fake Worker: the channel constructs `new Worker(url)`; we capture it and
//     bridge its `postMessage` (client -> server) into `router.process`.
type Listener = (ev: unknown) => void;

let activeWorker: FakeWorker | undefined;
// Set per-test: where a frame the channel sends should be delivered.
let onClientSend: (frame: Uint8Array) => void = () => {};

class FakeWorker {
  listeners: Record<string, Listener[]> = {};
  constructor(_url: string | URL) {
    // oxlint-disable-next-line typescript/no-this-alias -- a test-double Worker must register the constructed instance for the loopback
    activeWorker = this;
  }
  addEventListener(type: string, cb: Listener) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: Listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
  }
  postMessage(frame: Uint8Array) {
    // The channel transfers the frame's buffer; copy so a detached buffer never
    // reaches the server side.
    onClientSend(new Uint8Array(frame));
  }
  terminate() {}
  dispatch(type: string, ev: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

beforeEach(() => {
  activeWorker = undefined;
  onClientSend = () => {};
  // Bun.randomUUIDv7 (messageId) + web Worker + global postMessage (router output).
  vi.stubGlobal("Bun", { randomUUIDv7: () => webcrypto.randomUUID() });
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("postMessage", (frame: Uint8Array) => {
    // Router -> client: deliver the response into the fake worker's listeners.
    activeWorker?.dispatch("message", { data: new Uint8Array(frame) });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Imported after the globals are in place — but construction (which reads
// globalThis.Worker) happens inside each test, so import order is not load-bearing.
async function loadTransport() {
  const { TempoWorkerChannel } = await import("../src/worker-channel.ts");
  const { TempoWorkerRouter } = await import("../src/worker-router.ts");
  return { TempoWorkerChannel, TempoWorkerRouter };
}

describe("worker transport (TempoWorkerChannel + TempoWorkerRouter)", () => {
  test("unary RPC round-trips client -> router -> client", async () => {
    const { TempoWorkerChannel, TempoWorkerRouter } = await loadTransport();
    const router = new TempoWorkerRouter(logger, new EchoRegistry(logger));

    // Wire client sends into the router.
    onClientSend = (frame) => {
      void router.process(frame, Message({}), {});
    };

    const channel = new TempoWorkerChannel("test", { logger });
    activeWorker?.dispatch("open", {}); // resolve any readiness gate

    const reply = await channel.startUnary<any, any>(
      Message({ msg: "hello" }),
      ClientContext.createContext(),
      echoMethodInfo,
    );

    expect(reply.msg).toBe("hello");
  });

  test("close() rejects in-flight requests instead of hanging", async () => {
    const { TempoWorkerChannel, TempoWorkerRouter } = await loadTransport();
    // Router that never replies, so the unary call stays pending.
    new TempoWorkerRouter(logger, new EchoRegistry(logger));
    onClientSend = () => {}; // swallow — no response is ever produced

    const channel = new TempoWorkerChannel("test", { logger });
    activeWorker?.dispatch("open", {});

    const pending = channel.startUnary<any, any>(
      Message({ msg: "drop me" }),
      ClientContext.createContext(),
      echoMethodInfo,
    );

    channel.close(new TempoError(TempoStatusCode.UNAVAILABLE, "test teardown"));

    await expect(pending).rejects.toMatchObject({ status: TempoStatusCode.UNAVAILABLE });
  });

  test("a worker 'close' event tears the channel down and rejects pending calls", async () => {
    const { TempoWorkerChannel, TempoWorkerRouter } = await loadTransport();
    new TempoWorkerRouter(logger, new EchoRegistry(logger));
    onClientSend = () => {};

    const channel = new TempoWorkerChannel("test", { logger });
    activeWorker?.dispatch("open", {});

    const pending = channel.startUnary<any, any>(
      Message({ msg: "orphan" }),
      ClientContext.createContext(),
      echoMethodInfo,
    );

    // Simulate the underlying worker dying.
    activeWorker?.dispatch("close", {});

    await expect(pending).rejects.toBeInstanceOf(TempoError);
  });
});
