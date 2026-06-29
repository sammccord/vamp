import { ClientContext, type MethodInfo } from "@tempojs/client";
import { ConsoleLogger, MethodType, TempoError, TempoStatusCode } from "@tempojs/common";
import { ServiceRegistry } from "@tempojs/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Message } from "../src/bebop.ts";
import { TempoExtensionChannel } from "../src/extension-channel.ts";
import { TempoExtensionRouter } from "../src/extension-router.ts";

/**
 * In-process loopback for the browser-extension transport
 * (`TempoExtensionChannel` + `TempoExtensionRouter`). `webextension-polyfill`
 * throws if imported outside an extension, and the router has no inbound
 * listener of its own, so we mock the polyfill: the channel's
 * `runtime.sendMessage` feeds a background handler that decodes and calls
 * `router.process(...)`, and the router's `tabs.sendMessage` is routed back into
 * the channel's `runtime.onMessage` listeners. Wire format is `number[]` both
 * ways (matching `Array.apply(null, Message.encode(...))`).
 */

// Shared mock state, hoisted so the vi.mock factory can close over it.
const ext = vi.hoisted(() => ({
  runtimeListeners: new Set<(msg: unknown) => void>(),
  // Set per-test: handles a frame the channel sends toward the "background".
  background: (_payload: number[]) => {},
  removeListenerSpy: undefined as undefined | ((fn: (msg: unknown) => void) => void),
}));

vi.mock("webextension-polyfill", () => ({
  runtime: {
    onMessage: {
      addListener: (fn: (msg: unknown) => void) => ext.runtimeListeners.add(fn),
      removeListener: (fn: (msg: unknown) => void) => {
        ext.removeListenerSpy?.(fn);
        ext.runtimeListeners.delete(fn);
      },
    },
    // client -> background
    sendMessage: (payload: number[]) => {
      ext.background(payload);
      return Promise.resolve();
    },
  },
  tabs: {
    // background -> client (a specific tab)
    sendMessage: (_tabId: number, payload: number[]) => {
      for (const l of ext.runtimeListeners) l(payload);
      return Promise.resolve();
    },
  },
}));

const ECHO_METHOD_ID = 1234;

// Arrow wrappers so the static codec fns are not passed as unbound methods.
const encode = (m: Message): Uint8Array => Message.encode(m);
const decode = (b: Uint8Array): Message => Message.decode(b);

class EchoRegistry extends ServiceRegistry {
  init(): void {
    (this as unknown as { methods: Map<number, unknown> }).methods.set(ECHO_METHOD_ID, {
      name: "echo",
      service: "Test",
      invoke: async (record: unknown) => record,
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

// One shared logger — TempoLogger's registry is process-global and rejects
// duplicate names.
const logger = new ConsoleLogger("extension-transport-test");

// biome-ignore lint/suspicious/noExplicitAny: test record stands in for a BebopRecord
const echoMethodInfo: MethodInfo<any, any> = {
  name: "echo",
  service: "Test",
  id: ECHO_METHOD_ID,
  serialize: encode,
  deserialize: decode,
  type: MethodType.Unary,
} as any;

// A sender with a real tab id, or the router's `send` drops the response.
// biome-ignore lint/suspicious/noExplicitAny: partial Runtime.MessageSender stand-in
const senderCtx = { sender: { tab: { id: 1, discarded: false } } } as any;

beforeEach(() => {
  ext.runtimeListeners.clear();
  ext.background = () => {};
  ext.removeListenerSpy = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extension transport (TempoExtensionChannel + TempoExtensionRouter)", () => {
  test("unary RPC round-trips client -> router -> client", async () => {
    const router = new TempoExtensionRouter(logger, new EchoRegistry(logger));
    ext.background = (payload) => {
      // Router expects an already-decoded Message and a sender-bearing context.
      const req = Message.decode(new Uint8Array(payload));
      void router.process(req, Message({}), senderCtx);
    };

    const channel = new TempoExtensionChannel({ logger });
    const reply = await channel.startUnary<any, any>(
      Message({ msg: "hello" }),
      ClientContext.createContext(),
      echoMethodInfo,
    );

    expect(reply.msg).toBe("hello");
  });

  test("close() rejects in-flight requests and removes the runtime listener", async () => {
    new TempoExtensionRouter(logger, new EchoRegistry(logger));
    ext.background = () => {}; // never reply

    const removed: Array<(msg: unknown) => void> = [];
    ext.removeListenerSpy = (fn) => removed.push(fn);

    const channel = new TempoExtensionChannel({ logger });
    const pending = channel.startUnary<any, any>(
      Message({ msg: "drop me" }),
      ClientContext.createContext(),
      echoMethodInfo,
    );

    channel.close(new TempoError(TempoStatusCode.UNAVAILABLE, "test teardown"));

    await expect(pending).rejects.toMatchObject({ status: TempoStatusCode.UNAVAILABLE });
    // The global onMessage listener added in the constructor must be removed.
    expect(removed.length).toBe(1);
    expect(ext.runtimeListeners.size).toBe(0);
  });
});
