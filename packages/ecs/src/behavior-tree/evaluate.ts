import {
  type BehaviorCondition,
  BehaviorNodeKind,
  type BehaviorRandom,
  type BehaviorStatus,
  type BehaviorTask,
  type BehaviorTree,
  type Brain,
} from "./types";

export interface BehaviorContext<W, E, A> {
  world: W;
  entity: E;
  conditions: Readonly<Record<number, BehaviorCondition<W, E>>>;
  tasks: Readonly<Record<number, BehaviorTask<W, E, A>>>;
  random: BehaviorRandom;
  /** Current tick, compared against `Brain.readyAt` by cooldown nodes. */
  now: number;
}

export interface BehaviorResult<A> {
  status: BehaviorStatus;
  /** Actions the winning branch's tasks asked for, in tree order. Not yet dispatched. */
  intents: A[];
  /** Brain fields that changed; empty when nothing did. */
  brain: Brain;
}

const fingerprints = new WeakMap<BehaviorTree, number>();
const float = new Float32Array(1);
const floatBits = new Uint32Array(float.buffer);

/**
 * A 32-bit FNV-1a fingerprint of the tree's nodes, cached per tree object.
 * Absent fields hash like their wire defaults, so a built tree and its decoded
 * copy share a fingerprint.
 */
export function treeFingerprint(tree: BehaviorTree): number {
  const cached = fingerprints.get(tree);
  if (cached !== undefined) return cached;
  let hash = 0x811c9dc5;
  const mix = (word: number) => {
    hash = Math.imul(hash ^ word, 0x01000193) >>> 0;
  };
  const nodes = tree.nodes ?? [];
  mix(nodes.length);
  for (const node of nodes) {
    mix(node.kind ?? 0);
    mix(node.weight ?? 0);
    mix(node.leaf ?? 0);
    const children = node.children ?? [];
    mix(children.length);
    for (const child of children) mix(child);
    const args = node.args ?? [];
    mix(args.length);
    for (const arg of args) {
      float[0] = arg;
      mix(floatBits[0]);
    }
  }
  fingerprints.set(tree, hash);
  return hash;
}

interface Slice<A> {
  intents: A[];
  cooldowns: number[];
  last: number | undefined;
}

/**
 * Evaluate `tree` from the root for one agent. Pure apart from the RNG: tasks
 * only return intents, and a subtree's intents and cooldowns take effect only
 * when that subtree succeeds, so a failed sequence or an unpicked weighted
 * branch leaves no trace. A brain whose `fingerprint` differs from the tree's was
 * built against another tree, so it is evaluated as fresh and fully rewritten.
 */
export function evaluate<W, E, A>(
  tree: BehaviorTree,
  brain: Brain,
  ctx: BehaviorContext<W, E, A>,
): BehaviorResult<A> {
  const nodes = tree.nodes ?? [];
  const fingerprint = treeFingerprint(tree);
  const stale = brain.fingerprint !== fingerprint;
  const readyAt = stale ? [] : (brain.readyAt ?? []);
  const intents: A[] = [];
  // Flattened [nodeIndex, readyAtTick] pairs from cooldowns that fired.
  const cooldowns: number[] = [];
  let last = stale ? undefined : brain.last;

  const cut = (intentMark: number, cooldownMark: number, lastMark: number | undefined) => {
    const slice: Slice<A> = {
      intents: intents.splice(intentMark),
      cooldowns: cooldowns.splice(cooldownMark),
      last,
    };
    last = lastMark;
    return slice;
  };

  // Trees are data that can be swapped at runtime; a cycle fails the looping
  // branch instead of overflowing the stack for the whole tick.
  const onPath = new Set<number>();

  const run = (index: number): boolean => {
    if (onPath.has(index)) return false;
    onPath.add(index);
    const intentMark = intents.length;
    const cooldownMark = cooldowns.length;
    const lastMark = last;
    const ok = visit(index);
    onPath.delete(index);
    if (!ok) cut(intentMark, cooldownMark, lastMark);
    return ok;
  };

  const visit = (index: number): boolean => {
    const node = nodes[index];
    if (!node) return false;
    const children = node.children ?? [];
    const args = node.args ?? [];
    switch (node.kind) {
      case BehaviorNodeKind.Selector:
        return children.some(run);
      case BehaviorNodeKind.Sequence:
        return children.every(run);
      case BehaviorNodeKind.Weighted: {
        const weights: Record<number, number> = {};
        const passed: Slice<A>[] = [];
        for (let k = 0; k < children.length; k++) {
          const weight = args[k] ?? 1;
          if (weight <= 0) continue;
          const intentMark = intents.length;
          const cooldownMark = cooldowns.length;
          const lastMark = last;
          if (!run(children[k])) continue;
          passed[k] = cut(intentMark, cooldownMark, lastMark);
          weights[k] = weight;
        }
        const picked = ctx.random.getWeightedValue(weights);
        const slice = picked === undefined ? undefined : passed[Number(picked)];
        if (!slice) return false;
        intents.push(...slice.intents);
        cooldowns.push(...slice.cooldowns);
        last = slice.last;
        return true;
      }
      case BehaviorNodeKind.Condition:
        return ctx.conditions[node.leaf ?? 0]?.(ctx.world, ctx.entity, args) ?? false;
      case BehaviorNodeKind.Task: {
        const out = ctx.tasks[node.leaf ?? 0]?.(ctx.world, ctx.entity, args);
        if (out === undefined) return false;
        if (Array.isArray(out)) intents.push(...out);
        else intents.push(out);
        last = index;
        return true;
      }
      case BehaviorNodeKind.Invert:
        return children.length > 0 && !run(children[0]);
      case BehaviorNodeKind.Chance:
        return (
          ctx.random.getUniform() * 100 < (node.weight ?? 0) &&
          (children.length === 0 || run(children[0]))
        );
      case BehaviorNodeKind.Cooldown:
        if (ctx.now < (readyAt[index] ?? 0)) return false;
        if (children.length > 0 && !run(children[0])) return false;
        cooldowns.push(index, ctx.now + (node.weight ?? 0));
        return true;
      default:
        return false;
    }
  };

  const status: BehaviorStatus = run(0) ? "success" : "failure";
  // Replace deltas skip undefined fields, so a stale brain's `last` is cleared
  // to 0, the value a brain that never fired a task materializes with.
  const delta: Brain = stale ? { fingerprint, readyAt: [], last: last ?? 0 } : {};
  if (cooldowns.length > 0) {
    const next = Array.from({ length: nodes.length }, (_, i) => readyAt[i] ?? 0);
    for (let i = 0; i < cooldowns.length; i += 2) next[cooldowns[i]] = cooldowns[i + 1];
    delta.readyAt = next;
  }
  if (!stale && last !== brain.last) delta.last = last;
  return { status, intents, brain: delta };
}
