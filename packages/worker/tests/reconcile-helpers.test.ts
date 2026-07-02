import { describe, expect, it } from "vitest";
import {
  applyKeyChange,
  componentKeysToReconcile,
  GLOBAL_ENTITIES_KEY,
  type PendingKeyDelta,
  RESERVED_RECONCILE_KEYS,
  shouldCompactThisTick,
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
    expect(componentKeysToReconcile(["id", "tags", "health", "sk"]).sort()).toEqual([
      "health",
      "sk",
    ]);
  });

  it("RESERVED_RECONCILE_KEYS contains id and tags", () => {
    expect(RESERVED_RECONCILE_KEYS.has("id")).toBe(true);
    expect(RESERVED_RECONCILE_KEYS.has("tags")).toBe(true);
    expect(RESERVED_RECONCILE_KEYS.has("health")).toBe(false);
  });
});

describe("reconcile-helpers: entity-set key", () => {
  it("the entity-set key is stable and prefixed to avoid id collisions", () => {
    expect(GLOBAL_ENTITIES_KEY).toBe("__vamp:entities");
    expect(GLOBAL_ENTITIES_KEY.startsWith("__vamp:")).toBe(true);
  });
});

describe("reconcile-helpers: compaction cadence", () => {
  it("shouldCompactThisTick fires every N ticks and never when disabled", () => {
    expect(shouldCompactThisTick(5, 0)).toBe(false);
    expect(shouldCompactThisTick(5, -1)).toBe(false);
    expect(shouldCompactThisTick(10, 5)).toBe(true);
    expect(shouldCompactThisTick(7, 5)).toBe(false);
    expect(shouldCompactThisTick(5, 5)).toBe(true);
  });
});
