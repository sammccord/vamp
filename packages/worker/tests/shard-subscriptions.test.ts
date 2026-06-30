import { describe, expect, it } from "vitest";

import { ShardSubscriptions } from "../src/shard-subscriptions.ts";

describe("ShardSubscriptions: pin refcount", () => {
  it("first acquire signals subscribe; further acquires do not", () => {
    const s = new ShardSubscriptions();
    expect(s.acquire("character/p1")).toBe(true); // 0→1 ⇒ subscribe
    expect(s.acquire("character/p1")).toBe(false); // 1→2
    expect(s.count("character/p1")).toBe(2);
    expect(s.has("character/p1")).toBe(true);
  });

  it("release only hits 0 when the last pin goes", () => {
    const s = new ShardSubscriptions();
    s.acquire("r");
    s.acquire("r"); // count 2
    expect(s.release("r", 0)).toBe(false); // 2→1, still pinned
    expect(s.has("r")).toBe(true);
    expect(s.release("r", 0)).toBe(true); // 1→0, teardown scheduled
    expect(s.has("r")).toBe(false);
  });

  it("releasing an unpinned root is a no-op", () => {
    const s = new ShardSubscriptions();
    expect(s.release("nope", 0)).toBe(false);
  });
});

describe("ShardSubscriptions: hysteresis", () => {
  it("a 0-pin root is retained until the grace period elapses", () => {
    const s = new ShardSubscriptions(1000); // 1s grace
    s.acquire("r");
    s.release("r", 0); // scheduled to drop at t=1000

    expect(s.expired(500)).toEqual([]); // within grace → keep
    expect(s.expired(1000)).toEqual(["r"]); // at deadline → eligible
    expect(s.expired(2000)).toEqual(["r"]);
  });

  it("re-acquiring within the grace window cancels teardown", () => {
    const s = new ShardSubscriptions(1000);
    s.acquire("r");
    s.release("r", 0); // pending drop at 1000
    expect(s.acquire("r")).toBe(true); // re-subscribe signal (0→1) cancels drop
    expect(s.expired(2000)).toEqual([]); // no longer pending
    expect(s.has("r")).toBe(true);
  });

  it("finalizeTeardown clears the pending-drop bookkeeping", () => {
    const s = new ShardSubscriptions(0);
    s.acquire("r");
    s.release("r", 0);
    expect(s.expired(0)).toEqual(["r"]);
    s.finalizeTeardown("r");
    expect(s.expired(0)).toEqual([]);
  });

  it("expired never returns a root that has been re-pinned", () => {
    const s = new ShardSubscriptions(0);
    s.acquire("r");
    s.release("r", 0); // scheduled
    s.acquire("r"); // re-pinned (cancels), then
    expect(s.expired(100)).toEqual([]);
  });
});

describe("ShardSubscriptions: persisted active set", () => {
  it("active() lists only pinned roots (the set to persist + re-subscribe on wake)", () => {
    const s = new ShardSubscriptions(1000);
    s.acquire("game/lobby");
    s.acquire("character/p1");
    s.acquire("character/p2");
    s.release("character/p2", 0); // p2 left → pending teardown, not active

    expect(s.active().sort()).toEqual(["character/p1", "game/lobby"]);
  });

  it("models the re-activation scenario: lobby persists all participants' roots", () => {
    // Lobby pins its game shard + two players' character shards.
    const s = new ShardSubscriptions();
    s.acquire("game/lobby"); // the lobby owns this
    s.acquire("character/p1"); // p1 joined
    s.acquire("character/p2"); // p2 joined

    // Persist the set; on hibernation wake, re-subscribe to ALL of it — even
    // though only p1 is the one re-activating, p2's root is remembered.
    const persisted = s.active().sort();
    expect(persisted).toEqual(["character/p1", "character/p2", "game/lobby"]);

    const woken = new ShardSubscriptions();
    for (const root of persisted) woken.acquire(root); // restore pins → re-subscribe
    expect(woken.has("character/p2")).toBe(true); // p2's shard restored without p2 reconnecting
  });
});
