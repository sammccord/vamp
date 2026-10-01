import { type BehaviorNode, BehaviorNodeKind, type BehaviorTree } from "./types";

/** A nested node, before {@link tree} flattens it into index-linked form. */
export interface BehaviorSpec {
  kind: BehaviorNodeKind;
  children: BehaviorSpec[];
  weight?: number;
  leaf?: number;
  args?: number[];
}

/** Succeeds with the first child that succeeds. */
export const selector = (...children: BehaviorSpec[]): BehaviorSpec => ({
  kind: BehaviorNodeKind.Selector,
  children,
});

/** Succeeds when every child succeeds, in order. */
export const seq = (...children: BehaviorSpec[]): BehaviorSpec => ({
  kind: BehaviorNodeKind.Sequence,
  children,
});

/** Runs every branch, then picks one of those that succeeded by relative weight. */
export const weighted = (...branches: [weight: number, child: BehaviorSpec][]): BehaviorSpec => ({
  kind: BehaviorNodeKind.Weighted,
  children: branches.map(([, child]) => child),
  args: branches.map(([weight]) => weight),
});

/** A registered predicate, e.g. `cond(Condition.PlayerNear, 6)`. */
export const cond = (leaf: number, ...args: number[]): BehaviorSpec => ({
  kind: BehaviorNodeKind.Condition,
  children: [],
  leaf,
  args,
});

/** A registered task that returns action intents. */
export const task = (leaf: number, ...args: number[]): BehaviorSpec => ({
  kind: BehaviorNodeKind.Task,
  children: [],
  leaf,
  args,
});

export const invert = (child: BehaviorSpec): BehaviorSpec => ({
  kind: BehaviorNodeKind.Invert,
  children: [child],
});

/** Passes `percent`% of the time, then runs `child` if given. */
export const chance = (percent: number, child?: BehaviorSpec): BehaviorSpec => ({
  kind: BehaviorNodeKind.Chance,
  children: child ? [child] : [],
  weight: percent,
});

/** Fails until `ticks` have passed since it last succeeded, then runs `child` if given. */
export const cooldown = (ticks: number, child?: BehaviorSpec): BehaviorSpec => ({
  kind: BehaviorNodeKind.Cooldown,
  children: child ? [child] : [],
  weight: ticks,
});

/** Flatten a nested spec into a {@link BehaviorTree} with the root at `nodes[0]`. */
export function tree(root: BehaviorSpec): Required<BehaviorTree> {
  const nodes: BehaviorNode[] = [];
  const add = (spec: BehaviorSpec): number => {
    const index = nodes.length;
    const node: BehaviorNode = { kind: spec.kind, children: [] };
    if (spec.weight !== undefined) node.weight = spec.weight;
    if (spec.leaf !== undefined) node.leaf = spec.leaf;
    if (spec.args !== undefined) node.args = spec.args;
    nodes.push(node);
    node.children = spec.children.map(add);
    return index;
  };
  add(root);
  return { nodes };
}
