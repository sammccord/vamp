/**
 * Canonical delta algebra for entity components: set/add/remove on array fields
 * and additive merge on pool (`Record<string, number>`) fields.
 *
 * This is the SINGLE source of truth for those semantics. Generated code
 * (`materializeDelta`, `mergeDelta`, `accumulateDelta` in each app's
 * `game.generated.ts`) and any client replica route through these functions
 * instead of re-inlining the loops, so the three operations can never drift.
 */

/** A delta over an array field: replace wholesale (`set`), or `add`/`remove` members. */
export interface ArrayDelta<T> {
  set?: T[];
  add?: T[];
  remove?: T[];
}

/**
 * Resolve an array delta against a base array (entity-level). `set` replaces;
 * otherwise `add` appends de-duplicated members and `remove` filters them out.
 * Returns a new array and never mutates `base`.
 */
export function applyArrayDelta<T>(base: T[], d?: ArrayDelta<T>): T[] {
  if (!d) return base;
  if (d.set) return d.set;
  let out = base.slice();
  if (d.add) for (const x of d.add) if (!out.includes(x)) out.push(x);
  if (d.remove) out = out.filter((x) => !d.remove!.includes(x));
  return out;
}

/**
 * Additively merge a pool delta onto a base pool (entity-level), returning a new
 * object: `result[k] = (base[k] ?? 0) + delta[k]` for each key present in `delta`.
 */
export function applyPoolDelta<T>(base: T, delta: Record<string, number>): T {
  const result = { ...base } as Record<string, number>;
  for (const key in delta) {
    if (delta[key] !== undefined) {
      result[key] = (result[key] ?? 0) + delta[key];
    }
  }
  return result as unknown as T;
}

/**
 * Accumulate an array delta INTO another array delta (delta-on-delta, used when
 * coalescing successive updates in a mutation scope). A `set` wins outright;
 * otherwise the `add`/`remove` lists concatenate. Returns the merged delta
 * (mutates `to` when present, else builds a fresh object).
 */
export function accumulateArrayDelta<T>(
  to: ArrayDelta<T> | undefined,
  from: ArrayDelta<T>,
): ArrayDelta<T> {
  if (from.set) return from;
  const out: ArrayDelta<T> = to ?? {};
  if (from.add) out.add = [...(out.add ?? []), ...from.add];
  if (from.remove) out.remove = [...(out.remove ?? []), ...from.remove];
  return out;
}

/**
 * Accumulate a pool delta INTO another pool delta (delta-on-delta). Additive on
 * overlapping keys. Returns a fresh object when `to` is absent, else mutates and
 * returns `to`.
 */
export function accumulatePoolDelta(
  to: Record<string, number> | undefined,
  from: Record<string, number>,
): Record<string, number> {
  if (!to) return { ...from };
  for (const key in from) {
    if (from[key] !== undefined) to[key] = (to[key] ?? 0) + from[key];
  }
  return to;
}
