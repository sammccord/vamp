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
 * Whether an id should be pushed into the namespace CRDT array, guarding
 * against the authoritative array (not a lossy local mirror) so a
 * local-insert / remote-array race cannot push the same id twice.
 */
export function shouldPushId(currentIds: readonly string[], id: string): boolean {
  return !currentIds.includes(id);
}

/**
 * Indices of every occurrence of `id` in `ids`, in descending order so the
 * caller can delete them from a `Y.Array` without index shifting invalidating
 * later deletions. Deleting ALL occurrences (not just the first) guarantees a
 * double-written id cannot survive a delete and resurrect as a ghost.
 */
export function occurrenceIndicesDescending(ids: readonly string[], id: string): number[] {
  const out: number[] = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i] === id) out.push(i);
  }
  return out;
}

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
 * Next absolute alarm time for a tick loop. Returns `null` when ticking is
 * disabled (`intervalMs <= 0`).
 */
export function nextAlarmTime(now: number, intervalMs: number): number | null {
  if (!intervalMs || intervalMs <= 0) return null;
  return now + intervalMs;
}

/**
 * Whether to set a new alarm given the currently-pending alarm time. A new alarm
 * is only scheduled when none is pending, so the tick loop never clobbers an
 * already-scheduled alarm (the single-alarm-per-DO constraint).
 */
export function shouldScheduleAlarm(existing: number | null | undefined): boolean {
  return existing == null;
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
