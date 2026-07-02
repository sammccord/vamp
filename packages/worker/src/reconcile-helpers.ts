/**
 * Pure, runtime-free helpers extracted from {@link ECSDurableObject} so the
 * reconciliation, id-array, and tick-scheduling logic can be unit-tested
 * without a Durable Object isolate (which requires the workerd runtime /
 * wrangler). The DO methods delegate to these so there is a single source of
 * truth for the logic.
 */

/** Accumulated component-key deltas for a pending remote "update" reconcile. */
export interface PendingKeyDelta {
  addedKeys: Set<string>;
  removedKeys: Set<string>;
}

/** The Yjs key-change action surfaced by a `YMapEvent`. */
export type KeyChangeAction = "add" | "update" | "delete" | undefined;

/**
 * Fold a single remote Y.Map key change into a pending update's added/removed
 * key sets. Mirrors the per-entity observer's bookkeeping:
 *
 *  - a delete records a removed key and clears any pending add for it;
 *  - an add (of a key that did not already exist locally) records an added key;
 *  - any set clears a pending removal for that key.
 *
 * `existed` is whether the key was present on the local entity *before* this
 * change was applied. The function mutates `pending` in place.
 */
export function applyKeyChange(
  pending: PendingKeyDelta,
  key: string,
  action: KeyChangeAction,
  existed: boolean,
): void {
  if (action === "delete") {
    pending.removedKeys.add(key);
    pending.addedKeys.delete(key);
  } else {
    if (!existed && action === "add") pending.addedKeys.add(key);
    pending.removedKeys.delete(key);
  }
}

/**
 * The doc-level Y.Map name for a shard's entity set: `id → Y.Map` of
 * components. In the root-keyed sharding model this one map is both the
 * entity data and the shard's membership — an entity exists in a shard iff
 * its id is a key here. Prefixed so it never collides with entity ids.
 */
export const GLOBAL_ENTITIES_KEY = "__vamp:entities";

/**
 * The component keys (added/removed) that must be routed through
 * `addComponent`/`removeComponent`, with reserved identity/tag keys removed.
 */
export const RESERVED_RECONCILE_KEYS: ReadonlySet<string> = new Set(["id", "tags"]);

export function componentKeysToReconcile(keys: Iterable<string>): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (!RESERVED_RECONCILE_KEYS.has(key)) out.push(key);
  }
  return out;
}

/**
 * Whether the given tick should trigger periodic compaction. `compactEveryNTicks
 * <= 0` disables compaction entirely.
 */
export function shouldCompactThisTick(tickCount: number, compactEveryNTicks: number): boolean {
  if (!compactEveryNTicks || compactEveryNTicks <= 0) return false;
  return tickCount % compactEveryNTicks === 0;
}

/**
 * Race a `pending` completion against a bounded fallback timer, guaranteeing the
 * fallback `setTimeout` is cleared on EVERY exit (whether `pending` or the
 * fallback wins). This is the load-bearing fix for proposal 05 step 3: the prior
 * `ready()` armed a `setTimeout` that was never cleared when `pending` won, so
 * every call leaked a live 10s timer that kept the isolate resident and fought
 * hibernation.
 *
 * `onTimeout` runs only if the fallback timer actually fires (a genuinely
 * stalled completion); it is never invoked on the fast path.
 */
export function raceWithBoundedTimer(
  pending: Promise<void>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, timeoutMs);
  });
  return Promise.race([pending, fallback]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
