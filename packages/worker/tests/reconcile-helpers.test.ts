import { describe, expect, it } from "vitest";
import {
  applyKeyChange,
  componentKeysToReconcile,
  ENTITY_REFS_KEY,
  GLOBAL_ENTITIES_KEY,
  membershipKey,
  nextAlarmTime,
  type PendingKeyDelta,
  RESERVED_RECONCILE_KEYS,
  shouldCompactThisTick,
  shouldScheduleAlarm,
} from "../src/reconcile-helpers.ts";

function emptyPending(): PendingKeyDelta {
  return { addedKeys: new Set(), removedKeys: new Set() };
}

describe("reconcile-helpers: applyKeyChange", () => {
  it("records an added key when a new (non-existing) key is added", () => {
    const p = emptyPending();
    applyKeyChange(p, "health", "add", /* existed */ false);
    expect([...p.addedKeys]).toEqual(["health"]);
    expect([...p.removedKeys]).toEqual([]);
  });

  it("does NOT record an add for a key that already existed locally", () => {
    const p = emptyPending();
    applyKeyChange(p, "health", "add", /* existed */ true);
    expect(p.addedKeys.size).toBe(0);
  });

  it("does NOT record an add for a plain update action", () => {
    const p = emptyPending();
    applyKeyChange(p, "health", "update", /* existed */ true);
    expect(p.addedKeys.size).toBe(0);
    expect(p.removedKeys.size).toBe(0);
  });

  it("records a removed key on delete and clears any pending add", () => {
    const p = emptyPending();
    p.addedKeys.add("health");
    applyKeyChange(p, "health", "delete", /* existed */ true);
    expect([...p.removedKeys]).toEqual(["health"]);
    expect(p.addedKeys.has("health")).toBe(false);
  });

  it("a re-add after a remove cancels the pending removal", () => {
    const p = emptyPending();
    // remote burst 1: delete
    applyKeyChange(p, "health", "delete", true);
    expect(p.removedKeys.has("health")).toBe(true);
    // remote burst 2: re-add the key (now it does not exist locally)
    applyKeyChange(p, "health", "add", false);
    expect(p.removedKeys.has("health")).toBe(false);
    expect(p.addedKeys.has("health")).toBe(true);
  });
});

describe("reconcile-helpers: componentKeysToReconcile", () => {
  it("filters out reserved id/tags keys", () => {
    expect(componentKeysToReconcile(["id", "tags", "health", "root"]).sort()).toEqual([
      "health",
      "root",
    ]);
  });

  it("RESERVED_RECONCILE_KEYS contains id and tags", () => {
    expect(RESERVED_RECONCILE_KEYS.has("id")).toBe(true);
    expect(RESERVED_RECONCILE_KEYS.has("tags")).toBe(true);
    expect(RESERVED_RECONCILE_KEYS.has("health")).toBe(false);
  });
});

describe("reconcile-helpers: shared entity-model keys", () => {
  it("membershipKey is namespace-scoped and distinct from the bare namespace", () => {
    // Must differ from the namespace itself: the legacy layout used the bare
    // namespace for a Y.Array, and a Y.Map under the same name would collide.
    expect(membershipKey("room1")).toBe("__vamp:members:room1");
    expect(membershipKey("room1")).not.toBe("room1");
    expect(membershipKey("a")).not.toBe(membershipKey("b"));
    expect(membershipKey("a")).toBe(membershipKey("a"));
  });

  it("global keys are stable, distinct, and prefixed to avoid id collisions", () => {
    expect(GLOBAL_ENTITIES_KEY).toBe("__vamp:entities");
    expect(ENTITY_REFS_KEY).toBe("__vamp:refs");
    expect(GLOBAL_ENTITIES_KEY).not.toBe(ENTITY_REFS_KEY);
    // No membership key can collide with the global stores.
    expect(membershipKey("entities")).not.toBe(GLOBAL_ENTITIES_KEY);
  });
});

describe("reconcile-helpers: alarm scheduling math", () => {
  it("nextAlarmTime returns now + interval when ticking is enabled", () => {
    expect(nextAlarmTime(1000, 250)).toBe(1250);
  });

  it("nextAlarmTime returns null when ticking is disabled", () => {
    expect(nextAlarmTime(1000, 0)).toBeNull();
    expect(nextAlarmTime(1000, -5)).toBeNull();
  });

  it("shouldScheduleAlarm only schedules when no alarm is pending", () => {
    expect(shouldScheduleAlarm(null)).toBe(true);
    expect(shouldScheduleAlarm(undefined)).toBe(true);
    // an already-pending alarm must not be clobbered
    expect(shouldScheduleAlarm(123456)).toBe(false);
    expect(shouldScheduleAlarm(0)).toBe(false);
  });

  it("shouldCompactThisTick fires every N ticks and never when disabled", () => {
    expect(shouldCompactThisTick(5, 0)).toBe(false);
    expect(shouldCompactThisTick(5, -1)).toBe(false);
    expect(shouldCompactThisTick(10, 5)).toBe(true);
    expect(shouldCompactThisTick(7, 5)).toBe(false);
    expect(shouldCompactThisTick(5, 5)).toBe(true);
  });
});
