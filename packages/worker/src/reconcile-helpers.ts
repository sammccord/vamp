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
 * Doc-level Y.Map names for the shared, cross-namespace entity model.
 *
 * Entities are **global**: a given id maps to one nested `Y.Map` of components
 * that any namespace (lobby) may read and mutate, so changes propagate across
 * lobbies. Two side indexes track lobby membership for scoping and refcounted
 * garbage collection (a numeric counter can't be used — Y.Map values are
 * last-write-wins, so concurrent increments would be lost; membership is
 * therefore modeled as a set of referencing namespaces, whose size is the
 * refcount).
 *
 * All names are prefixed so they never collide with entity ids (used as keys
 * inside these maps) or the legacy per-namespace `Y.Array` (named by the bare
 * namespace), keeping migration free of same-name type conflicts.
 */
/** Global store: `id → Y.Map` of components. Shared by every namespace. */
export const GLOBAL_ENTITIES_KEY = "__vamp:entities";
/** Refcount index: `id → Y.Map<namespace, true>` (size = number of referencing lobbies). */
export const ENTITY_REFS_KEY = "__vamp:refs";
/** Per-namespace membership set: `id → true` for entities this lobby tracks. */
export function membershipKey(namespace: string): string {
  return `__vamp:members:${namespace}`;
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
