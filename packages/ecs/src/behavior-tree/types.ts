/**
 * Structural mirrors of the `@vampgg/utils/schema/behavior.bop` messages, so the
 * evaluator runs against any app's generated bebop types without importing them.
 */
export const BehaviorNodeKind = {
  Selector: 1,
  Sequence: 2,
  Weighted: 3,
  Condition: 4,
  Task: 5,
  Invert: 6,
  Chance: 7,
  Cooldown: 8,
} as const;
export type BehaviorNodeKind = (typeof BehaviorNodeKind)[keyof typeof BehaviorNodeKind];

export interface BehaviorNode {
  kind?: number;
  children?: number[];
  weight?: number;
  leaf?: number;
  args?: number[];
}

/** A flat, index-linked tree; `nodes[0]` is the root. */
export interface BehaviorTree {
  nodes?: BehaviorNode[];
}

/**
 * Per-agent state: which tree it runs and when each cooldown node is ready again.
 * `readyAt` and `last` index into the tree whose fingerprint is `fingerprint`.
 */
export interface Brain {
  tree?: string;
  readyAt?: number[];
  last?: number;
  fingerprint?: number;
}

/**
 * The randomness a tree consumes. A seeded `@vampgg/rot` `RNG` satisfies it, so
 * a world that owns its RNG replays the same choices.
 */
export interface BehaviorRandom {
  getUniform(): number;
  getWeightedValue(data: Record<number, number>): string | number | undefined;
}

export type BehaviorCondition<W, E> = (world: W, entity: E, args: readonly number[]) => boolean;

/** A task succeeds when it returns intents to dispatch, and fails on `undefined`. */
export type BehaviorTask<W, E, A> = (
  world: W,
  entity: E,
  args: readonly number[],
) => A | A[] | undefined;

export type BehaviorStatus = "success" | "failure";
