import { describe, expect, it } from "vitest";
import type { Doc } from "yjs";

import { ShardManager, type ShardClient } from "../src/shard-manager.ts";

/** A mock client factory that records connect/disconnect per root. */
function mockFactory() {
  const connected: string[] = [];
  const disconnected: string[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const createClient = (root: string, _doc: Doc): ShardClient => {
    connected.push(root);
    return {
      disconnect() {
        disconnected.push(root);
      },
    };
  };
  return {
    connected,
    disconnected,
    opened,
    closed,
    createClient,
    onShardOpen: (root: string) => opened.push(root),
    onShardClose: (root: string) => closed.push(root),
  };
}

describe("ShardManager: open/reuse/route", () => {
  it("first acquire opens a shard (client + onShardOpen); reuses on re-acquire", () => {
    const f = mockFactory();
    const m = new ShardManager(f);

    const docA = m.acquire("character/p1");
    expect(f.connected).toEqual(["character/p1"]);
    expect(f.opened).toEqual(["character/p1"]);

    const docA2 = m.acquire("character/p1"); // second pin — reuse, no new client
    expect(docA2).toBe(docA);
    expect(f.connected).toEqual(["character/p1"]); // still one connect
    expect(m.has("character/p1")).toBe(true);
    expect(m.docFor("character/p1")).toBe(docA);
  });

  it("docFor returns undefined for an unsubscribed root", () => {
    const m = new ShardManager(mockFactory());
    expect(m.docFor("game/lobby")).toBeUndefined();
  });

  it("distinct roots get distinct docs + clients", () => {
    const f = mockFactory();
    const m = new ShardManager(f);
    const a = m.acquire("character/p1");
    const b = m.acquire("game/lobby");
    expect(a).not.toBe(b);
    expect(f.connected.sort()).toEqual(["character/p1", "game/lobby"]);
  });
});

describe("ShardManager: teardown + hysteresis", () => {
  it("release does not close until the grace period elapses; reap then closes", () => {
    const f = mockFactory();
    const m = new ShardManager({ ...f, gracePeriodMs: 1000 });
    m.acquire("r");
    m.release("r", 0); // scheduled to drop at 1000

    m.reap(500); // within grace
    expect(f.disconnected).toEqual([]);
    expect(m.has("r")).toBe(true);

    m.reap(1000); // grace elapsed
    expect(f.disconnected).toEqual(["r"]);
    expect(f.closed).toEqual(["r"]); // onShardClose fired
    expect(m.has("r")).toBe(false);
    expect(m.docFor("r")).toBeUndefined();
  });

  it("re-acquiring within grace cancels teardown", () => {
    const f = mockFactory();
    const m = new ShardManager({ ...f, gracePeriodMs: 1000 });
    const doc = m.acquire("r");
    m.release("r", 0);
    const doc2 = m.acquire("r"); // re-pin within grace — same doc, no reconnect
    expect(doc2).toBe(doc);
    m.reap(2000);
    expect(f.disconnected).toEqual([]); // never torn down
    expect(m.has("r")).toBe(true);
  });

  it("only the last pin's release schedules teardown", () => {
    const f = mockFactory();
    const m = new ShardManager({ ...f, gracePeriodMs: 0 });
    m.acquire("r");
    m.acquire("r"); // 2 pins
    m.release("r", 0); // → 1 pin, no teardown
    m.reap(0);
    expect(f.disconnected).toEqual([]);
    m.release("r", 0); // → 0 pins, scheduled
    m.reap(0);
    expect(f.disconnected).toEqual(["r"]);
  });

  it("pinned() distinguishes a pinned shard from one coasting through grace", () => {
    const f = mockFactory();
    const m = new ShardManager({ ...f, gracePeriodMs: 1000 });
    m.acquire("r");
    expect(m.pinned("r")).toBe(true);

    m.release("r", 0);
    // Open (grace period) but no longer pinned — the entity-emptiness release
    // driver uses exactly this state to decide whether a re-appearing entity
    // must re-pin.
    expect(m.has("r")).toBe(true);
    expect(m.pinned("r")).toBe(false);

    m.acquire("r"); // re-pin cancels the pending teardown
    expect(m.pinned("r")).toBe(true);
    m.reap(2000);
    expect(m.has("r")).toBe(true);
  });
});

describe("ShardManager: persistence / restore", () => {
  it("activeRoots reflects pinned shards; restore re-opens a persisted set", () => {
    const f = mockFactory();
    const m = new ShardManager(f);
    m.acquire("game/lobby");
    m.acquire("character/p1");
    m.acquire("character/p2");
    expect(m.activeRoots().sort()).toEqual(["character/p1", "character/p2", "game/lobby"]);

    // Simulate hibernation wake: a fresh manager restores the persisted set.
    const persisted = m.activeRoots();
    const f2 = mockFactory();
    const woken = new ShardManager(f2);
    woken.restore(persisted);
    expect(f2.connected.sort()).toEqual(["character/p1", "character/p2", "game/lobby"]);
    expect(woken.has("character/p2")).toBe(true); // p2's shard restored without p2 reconnecting
  });

  it("teardownAll disconnects every open shard", () => {
    const f = mockFactory();
    const m = new ShardManager(f);
    m.acquire("a");
    m.acquire("b");
    m.teardownAll();
    expect(f.disconnected.sort()).toEqual(["a", "b"]);
    expect(m.has("a")).toBe(false);
  });
});
