import { describe, expect, test } from "vite-plus/test";
import { accumulateReplaceDelta, applyReplaceDelta } from "../src/index.ts";

type Brain = { tree?: string; readyAt?: number[]; last?: number };

describe("replace delta", () => {
  test("defined fields overwrite, arrays included, without mutating base", () => {
    const base: Brain = { tree: "a", readyAt: [1, 2], last: 3 };
    expect(applyReplaceDelta(base, { readyAt: [9], last: undefined })).toEqual({
      tree: "a",
      readyAt: [9],
      last: 3,
    });
    expect(base).toEqual({ tree: "a", readyAt: [1, 2], last: 3 });
  });

  test("accumulating keeps the later value per field", () => {
    const to: Brain = { tree: "a", last: 1 };
    expect(accumulateReplaceDelta(to, { last: 2, readyAt: [5] })).toEqual({
      tree: "a",
      last: 2,
      readyAt: [5],
    });
    expect(accumulateReplaceDelta<Brain>(undefined, { tree: "b" })).toEqual({ tree: "b" });
  });
});
