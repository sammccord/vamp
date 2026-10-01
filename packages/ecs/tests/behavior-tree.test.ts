import { RNGClass } from "@vampgg/rot";
import { describe, expect, test } from "vite-plus/test";
import {
  type BehaviorContext,
  type BehaviorRandom,
  type Brain,
  chance,
  cond,
  cooldown,
  evaluate,
  invert,
  selector,
  seq,
  task,
  tree,
  weighted,
} from "../src/index.ts";
import { treeFingerprint } from "../src/behavior-tree/evaluate.ts";

type Intent = { tag: number };
type Agent = { near: boolean; calls: number[] };

const Near = 1;
const Never = 2;
const Emit = 1;
const Nothing = 2;

function context(
  random: BehaviorRandom,
  agent: Agent = { near: true, calls: [] },
  now = 0,
): BehaviorContext<null, Agent, Intent> {
  return {
    world: null,
    entity: agent,
    random,
    now,
    conditions: {
      [Near]: (_w: null, e: Agent) => e.near,
      [Never]: () => false,
    },
    tasks: {
      [Emit]: (_w: null, e: Agent, args: readonly number[]) => {
        e.calls.push(args[0]);
        return { tag: args[0] };
      },
      [Nothing]: () => undefined,
    },
  };
}

const seeded = (seed: number) => new RNGClass().setSeed(seed);
const fixed = (key: string | number | undefined, uniform = 0): BehaviorRandom => ({
  getUniform: () => uniform,
  getWeightedValue: () => key,
});

describe("evaluate", () => {
  test("selector takes the first child that succeeds", () => {
    const t = tree(selector(seq(cond(Never), task(Emit, 1)), task(Emit, 2), task(Emit, 3)));
    const r = evaluate(t, {}, context(seeded(1)));
    expect(r.status).toBe("success");
    expect(r.intents).toEqual([{ tag: 2 }]);
  });

  test("a failed sequence drops the intents its earlier tasks emitted", () => {
    const t = tree(seq(task(Emit, 1), cond(Never)));
    const r = evaluate(t, { fingerprint: treeFingerprint(t) }, context(seeded(1)));
    expect(r).toEqual({ status: "failure", intents: [], brain: {} });
  });

  test("a task returning undefined fails", () => {
    expect(evaluate(tree(task(Nothing)), {}, context(seeded(1))).status).toBe("failure");
  });

  test("invert flips the child's status", () => {
    expect(evaluate(tree(invert(cond(Never))), {}, context(seeded(1))).status).toBe("success");
    expect(evaluate(tree(invert(task(Emit, 1))), {}, context(seeded(1))).intents).toEqual([]);
  });

  test("weighted filters out failing branches before picking", () => {
    const t = tree(weighted([1000, seq(cond(Never), task(Emit, 1))], [1, task(Emit, 2)]));
    for (let seed = 1; seed < 20; seed++) {
      expect(evaluate(t, {}, context(seeded(seed))).intents).toEqual([{ tag: 2 }]);
    }
  });

  test("weighted passes child positions and weights, and reads back a string key", () => {
    const seen: Record<number, number>[] = [];
    const random: BehaviorRandom = {
      getUniform: () => 0,
      getWeightedValue: (data: Record<number, number>) => {
        seen.push(data);
        return "1";
      },
    };
    const t = tree(weighted([3, task(Emit, 1)], [5, task(Emit, 2)]));
    expect(evaluate(t, {}, context(random)).intents).toEqual([{ tag: 2 }]);
    expect(seen).toEqual([{ 0: 3, 1: 5 }]);
  });

  test("weighted fails when no branch passes", () => {
    const t = tree(weighted([1, cond(Never)]));
    expect(evaluate(t, {}, context(fixed(undefined))).status).toBe("failure");
  });

  test("weighted keeps only the chosen branch's intents and cooldowns", () => {
    const t = tree(weighted([1, cooldown(5, task(Emit, 1))], [1, cooldown(7, task(Emit, 2))]));
    const agent: Agent = { near: true, calls: [] };
    const r = evaluate(t, { fingerprint: treeFingerprint(t) }, context(fixed(1), agent, 10));
    expect(agent.calls).toEqual([1, 2]);
    expect(r.intents).toEqual([{ tag: 2 }]);
    expect(r.brain).toEqual({ readyAt: [0, 0, 0, 17, 0], last: 4 });
  });

  test("the same seed picks the same branches", () => {
    const t = tree(weighted([1, task(Emit, 1)], [1, task(Emit, 2)], [1, task(Emit, 3)]));
    const run = (seed: number) => {
      const random = seeded(seed);
      return Array.from({ length: 50 }, () => evaluate(t, {}, context(random)).intents[0].tag);
    };
    expect(run(42)).toEqual(run(42));
    expect(new Set(run(42)).size).toBe(3);
  });

  test("chance passes below its percentage", () => {
    expect(evaluate(tree(chance(30, task(Emit, 1))), {}, context(fixed(0, 0.29))).status).toBe(
      "success",
    );
    expect(evaluate(tree(chance(30, task(Emit, 1))), {}, context(fixed(0, 0.3))).status).toBe(
      "failure",
    );
  });

  test("cooldown fails until its ticks have passed since the last success", () => {
    const t = tree(seq(cooldown(10), task(Emit, 1)));
    let brain: Brain = {};
    const fired: number[] = [];
    for (let now = 0; now < 25; now++) {
      const r = evaluate(t, brain, context(seeded(1), undefined, now));
      if (r.status === "success") fired.push(now);
      brain = { ...brain, ...r.brain };
    }
    expect(fired).toEqual([0, 10, 20]);
    expect(brain.last).toBe(2);
  });

  test("a brain built against another tree starts fresh", () => {
    const before = tree(seq(task(Emit, 1), cooldown(100, task(Emit, 2))));
    const brain = evaluate(before, {}, context(seeded(1))).brain;
    expect(brain).toEqual({
      fingerprint: treeFingerprint(before),
      readyAt: [0, 0, 100, 0],
      last: 3,
    });

    const after = tree(seq(task(Emit, 1), cooldown(5, task(Emit, 2))));
    const r = evaluate(after, brain, context(seeded(1), undefined, 50));
    expect(r.status).toBe("success");
    expect(r.brain).toEqual({
      fingerprint: treeFingerprint(after),
      readyAt: [0, 0, 55, 0],
      last: 3,
    });
  });

  test("a stale brain is cleared even when nothing fires", () => {
    const t = tree(cond(Never));
    const r = evaluate(
      t,
      { fingerprint: treeFingerprint(t) + 1, readyAt: [9], last: 3 },
      context(seeded(1)),
    );
    expect(r.brain).toEqual({ fingerprint: treeFingerprint(t), readyAt: [], last: 0 });
  });

  test("a cycle fails the looping branch instead of overflowing the stack", () => {
    const cyclic = {
      nodes: [
        { kind: 1, children: [1, 2] },
        { kind: 2, children: [0] },
        { kind: 5, children: [], leaf: Emit, args: [7] },
      ],
    };
    const r = evaluate(cyclic, {}, context(seeded(1)));
    expect(r.status).toBe("success");
    expect(r.intents).toEqual([{ tag: 7 }]);
  });

  test("does not mutate the tree or brain it was given", () => {
    const t = tree(seq(cooldown(3), task(Emit, 1)));
    const brain: Brain = { readyAt: [0, 0, 0] };
    const before = structuredClone({ t, brain });
    evaluate(t, brain, context(seeded(1), undefined, 5));
    expect({ t, brain }).toEqual(before);
  });
});

describe("tree", () => {
  test("flattens depth-first with the root at index 0", () => {
    expect(tree(weighted([2, seq(cond(Near, 6), task(Emit, 1))], [1, task(Emit, 2)]))).toEqual({
      nodes: [
        { kind: 3, children: [1, 4], args: [2, 1] },
        { kind: 2, children: [2, 3] },
        { kind: 4, children: [], leaf: Near, args: [6] },
        { kind: 5, children: [], leaf: Emit, args: [1] },
        { kind: 5, children: [], leaf: Emit, args: [2] },
      ],
    });
  });
});

describe("treeFingerprint", () => {
  test("a built tree and its decoded copy share a fingerprint", () => {
    const built = tree(seq(cond(Near), cooldown(10, task(Emit, 1))));
    const decoded = {
      nodes: [
        { kind: 2, children: [1, 2], weight: 0, leaf: 0, args: [] },
        { kind: 4, children: [], weight: 0, leaf: Near, args: [] },
        { kind: 8, children: [3], weight: 10, leaf: 0, args: [] },
        { kind: 5, children: [], weight: 0, leaf: Emit, args: [1] },
      ],
    };
    expect(treeFingerprint(decoded)).toBe(treeFingerprint(built));
  });

  test("changing any node changes the fingerprint", () => {
    const fingerprint = treeFingerprint(tree(seq(cond(Near), cooldown(10, task(Emit, 1)))));
    expect(treeFingerprint(tree(seq(cond(Near), cooldown(11, task(Emit, 1)))))).not.toBe(
      fingerprint,
    );
    expect(treeFingerprint(tree(seq(cond(Near), cooldown(10, task(Emit, 1.5)))))).not.toBe(
      fingerprint,
    );
    expect(treeFingerprint(tree(seq(cooldown(10, task(Emit, 1)), cond(Near))))).not.toBe(
      fingerprint,
    );
  });
});
