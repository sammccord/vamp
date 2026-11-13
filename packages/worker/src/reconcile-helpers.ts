/**
 * Pure, runtime-free helpers extracted from {@link ECSDurableObject} so the
 * reconciliation, id-array, and tick-scheduling logic can be unit-tested
 * without a Durable Object isolate (which requires the workerd runtime /
 * wrangler). The DO methods delegate to these so there is a single source of
 * truth for the logic.
 */

/**
 * The doc-level Y.Map name for a shard's entity set: `id → Y.Map` of
 * components. In the root-keyed sharding model this one map is both the
 * entity data and the shard's membership — an entity exists in a shard iff
 * its id is a key here. Prefixed so it never collides with entity ids.
 */
export const GLOBAL_ENTITIES_KEY = "__vamp:entities";

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
