import { describe, expect, it } from "vitest";
import { GLOBAL_ENTITIES_KEY, shouldCompactThisTick } from "../src/reconcile-helpers.ts";

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
