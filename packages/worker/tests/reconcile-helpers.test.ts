import { describe, expect, it } from "vitest";
import {
  applyKeyChange,
  componentKeysToReconcile,
  nextAlarmTime,
  occurrenceIndicesDescending,
  type PendingKeyDelta,
  RESERVED_RECONCILE_KEYS,
  shouldCompactThisTick,
  shouldPushId,
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

describe("reconcile-helpers: id-array dedup + delete-all (ghost-entity guard)", () => {
  it("shouldPushId is false when the id is already present (idempotent push)", () => {
    expect(shouldPushId(["a", "b"], "b")).toBe(false);
    expect(shouldPushId(["a", "b"], "c")).toBe(true);
    expect(shouldPushId([], "a")).toBe(true);
  });

  it("occurrenceIndicesDescending returns every occurrence, high index first", () => {
    // A double-written id must yield BOTH indices so a delete removes all of
    // them; first-occurrence-only delete is what leaves a ghost.
    expect(occurrenceIndicesDescending(["x", "dup", "y", "dup"], "dup")).toEqual([3, 1]);
    expect(occurrenceIndicesDescending(["x", "y"], "dup")).toEqual([]);
    expect(occurrenceIndicesDescending(["dup"], "dup")).toEqual([0]);
  });

  it("deleting by descending indices removes all occurrences without shift errors", () => {
    // Simulate a Y.Array splice using the descending indices.
    const arr = ["x", "dup", "y", "dup", "z"];
    for (const i of occurrenceIndicesDescending(arr, "dup")) {
      arr.splice(i, 1);
    }
    expect(arr).toEqual(["x", "y", "z"]);
    expect(arr.includes("dup")).toBe(false);
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
