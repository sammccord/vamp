import { ClientContext, type MethodInfo } from "@tempojs/client";
import { ConsoleLogger, MethodType, TempoError, TempoStatusCode } from "@tempojs/common";
import { ServiceRegistry } from "@tempojs/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Message } from "../src/bebop.ts";

/**
 * In-process loopback for the browser-extension transport
 * (`TempoExtensionChannel` + `TempoExtensionRouter`). `webextension-polyfill`
 * throws outside an extension, but it hands back `globalThis.browser` unchanged
 * when that global already exposes `runtime.id` (the native Firefox path). So
 * the test installs a fake `browser` global before importing the transport: the
 * channel's `runtime.sendMessage` feeds a background handler that decodes and
 * calls `router.process(...)`, and the router's `tabs.sendMessage` is routed back
 * into the channel's `runtime.onMessage` listeners. Wire format is `number[]`
 * both ways (matching `Array.apply(null, Message.encode(...))`).
 */

// The loopback's wire frame is `number[]` both ways (see header): the fake
// tabs.sendMessage replays verbatim the payload runtime.sendMessage received.
type RuntimeListener = (msg: number[]) => void;

interface ExtFakeState {
  runtimeListeners: Set<RuntimeListener>;
  background: (payload: number[]) => void;
  removeListenerSpy: ((fn: RuntimeListener) => void) | undefined;
  runtimeSent: number[][];
}

const ext: ExtFakeState = {
  runtimeListeners: new Set<RuntimeListener>(),
  // Set per-test: handles a frame the channel sends toward the "background".
  background: (_payload: number[]) => {},
  removeListenerSpy: undefined,
  // Every payload passed to runtime.sendMessage (client->background frames and
  // the router's broadcast replies to tabless senders).
  runtimeSent: [],
};

const fakeBrowser = {
  runtime: {
    id: "test-ext",
    onMessage: {
      addListener: (fn: RuntimeListener) => ext.runtimeListeners.add(fn),
      removeListener: (fn: RuntimeListener) => {
        ext.removeListenerSpy?.(fn);
        ext.runtimeListeners.delete(fn);
      },
    },
    // client -> background, and background -> tabless senders (broadcast)
    sendMessage: (payload: number[]) => {
      ext.runtimeSent.push(payload);
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
};

Object.assign(globalThis, { chrome: { runtime: { id: "test-ext" } }, browser: fakeBrowser });
const { TempoExtensionChannel } = await import("../src/extension-channel.ts");
const { createExtensionListener, TempoExtensionRouter } =
  await import("../src/extension-router.ts");

const ECHO_METHOD_ID = 1234;

// Arrow wrappers so the static codec fns are not passed as unbound methods.
const encode = (m: Message): Uint8Array => Message.encode(m);
const decode = (b: Uint8Array): Message => Message.decode(b);

class EchoRegistry extends ServiceRegistry {
  init(): void {
    // SAFETY: `methods` is the base ServiceRegistry's own `protected readonly
    // methods: Map<number, BebopMethodAny>`; widening only the value type lets
    // the test register a literal that omits `stringify`/`fromJSON`, which the
    // router never calls (RouterCore uses only deserialize/invoke/serialize/type).
    (this.methods as Map<number, unknown>).set(ECHO_METHOD_ID, {
      name: "echo",
      service: "Test",
      invoke: async (record: Message) => record,
      serialize: encode,
      deserialize: decode,
      type: MethodType.Unary,
    });
  }
  // biome-ignore lint/suspicious/noExplicitAny: base getMethod returns BebopMethodAny
  getMethod(id: number): any {
    return this.methods.get(id);
  }
}

// One shared logger — TempoLogger's registry is process-global and rejects
// duplicate names.
const logger = new ConsoleLogger("extension-transport-test");

// SAFETY: BaseChannel.startUnary reads only method.id/serialize/deserialize/type
// (channel-core.ts); this literal supplies all four. The omitted
// stringify/fromJSON serve the JSON wire path, which this binary transport test
// never exercises.
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
// SAFETY: TempoExtensionRouter.send reads only sender.tab?.id and
// sender.tab.discarded (extension-router.ts), and RouterCore passes the ctx to
// ServerContext without inspecting it; this stand-in supplies both tab fields
// and no other MessageSender field is dereferenced.
// biome-ignore lint/suspicious/noExplicitAny: partial Runtime.MessageSender stand-in
const senderCtx = { sender: { tab: { id: 1, discarded: false } } } as any;

beforeEach(() => {
  ext.runtimeListeners.clear();
  ext.background = () => {};
  ext.removeListenerSpy = undefined;
  ext.runtimeSent = [];
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

    const removed: RuntimeListener[] = [];
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

  test("reply to a tabless (popup) sender is broadcast, not dropped", async () => {
    const router = new TempoExtensionRouter(logger, new EchoRegistry(logger));
    const messageId = "12345678-1234-1234-1234-123456789abc";
    const req = Message({
      methodId: ECHO_METHOD_ID,
      messageId,
      data: Message.encode(Message({ msg: "popup" })),
    });

    // A popup/options sender has no `tab`; the old router dropped the reply.
    // SAFETY: TempoExtensionRouter.send reads only sender.tab?.id/discarded and
    // takes the runtime.sendMessage broadcast branch when `tab` is absent
    // (extension-router.ts); no other MessageSender field is dereferenced.
    await router.process(req, Message({}), { sender: {} } as any);

    expect(ext.runtimeSent.length).toBe(1);
    const reply = Message.decode(new Uint8Array(ext.runtimeSent[0]!));
    expect(reply.messageId).toBe(messageId);
    expect(reply.methodId).toBe(ECHO_METHOD_ID);
  });
});

describe("createExtensionListener", () => {
  function setup() {
    const registry = new EchoRegistry(logger);
    const router = new TempoExtensionRouter(logger, registry);
    const processSpy = vi.spyOn(router, "process").mockResolvedValue(undefined);
    const listener = createExtensionListener(router, registry);
    return { listener, processSpy };
  }

  const validFrame = Array.from(
    Message.encode(Message({ methodId: ECHO_METHOD_ID, messageId: "x", data: new Uint8Array() })),
  );
  // SAFETY: createExtensionListener reads only sender.id, comparing it against
  // runtime.id ("test-ext" in the mock), before dispatching anything
  // (extension-router.ts); no other MessageSender field is dereferenced.
  const self = { id: "test-ext" } as any;

  test("dispatches a valid frame from this extension", () => {
    const { listener, processSpy } = setup();
    listener(validFrame, self);
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  test("rejects frames from another extension", () => {
    const { listener, processSpy } = setup();
    // SAFETY: the listener reads only sender.id; "other-ext" fails the runtime.id
    // equality check and the frame is dropped before any other field is touched
    // (extension-router.ts createExtensionListener).
    listener(validFrame, { id: "other-ext" } as any);
    expect(processSpy).not.toHaveBeenCalled();
  });

  test("drops non-array payloads", () => {
    const { listener, processSpy } = setup();
    listener("not-a-frame", self);
    expect(processSpy).not.toHaveBeenCalled();
  });

  test("drops undecodable payloads", () => {
    const { listener, processSpy } = setup();
    listener([1, 2, 3], self);
    expect(processSpy).not.toHaveBeenCalled();
  });

  test("drops frames whose methodId is not registered (replies / junk)", () => {
    const { listener, processSpy } = setup();
    const unknown = Array.from(Message.encode(Message({ methodId: 9999, messageId: "y" })));
    listener(unknown, self);
    expect(processSpy).not.toHaveBeenCalled();
  });
});
