/**
 * Per-root subscription lifecycle for the sharded (multi-provider) model.
 *
 * A lobby ({@link ECSDurableObject}) subscribes to a y-durablestream provider
 * DO per **root** (the shard key on `BaseEntity.sk`). Which roots a lobby
 * holds is *implicit, refcounted, and persisted*: each reason to keep a root
 * (a connected player whose character lives there, an entity the lobby authored
 * into it, the lobby's own game shard) is a **pin**; the root stays subscribed
 * while it has ≥1 pin. When the last pin is released the subscription is torn
 * down only after a **grace period** (hysteresis), so brief churn — a player
 * reconnecting, an entity flickering in and out — doesn't thrash the
 * connect/disconnect cycle. The set of pinned roots is the persisted set the
 * lobby re-subscribes to on hibernation wake.
 *
 * This is pure, runtime-free bookkeeping (no Yjs / Durable Object / clock) so it
 * is unit-testable without a workerd isolate; the DO supplies `now` and acts on
 * the returned signals (subscribe / tear down).
 */
export class ShardSubscriptions {
  /** root → live pin count (a root is subscribed iff count > 0). */
  private readonly pins = new Map<string, number>();
  /** root → timestamp after which a 0-pin root may be torn down. */
  private readonly dropAt = new Map<string, number>();
  private readonly graceMs: number;

  /**
   * @param gracePeriodMs - How long a root with no pins is kept subscribed
   *   before it becomes eligible for teardown. A re-acquire within this window
   *   cancels the teardown. Default 30s.
   */
  constructor(gracePeriodMs = 30_000) {
    this.graceMs = gracePeriodMs;
  }

  /**
   * Add a pin to `root`. Returns `true` when this is the first pin (count 0→1),
   * i.e. the caller should establish the subscription. Cancels any pending
   * teardown for the root.
   */
  acquire(root: string): boolean {
    this.dropAt.delete(root);
    const next = (this.pins.get(root) ?? 0) + 1;
    this.pins.set(root, next);
    return next === 1;
  }

  /**
   * Remove a pin from `root`. When the count reaches 0 the root is scheduled for
   * teardown at `now + gracePeriodMs` (it stays subscribed until then). Returns
   * `true` when the count hit 0 (teardown scheduled), `false` otherwise.
   * Releasing an unpinned root is a no-op returning `false`.
   */
  release(root: string, now: number): boolean {
    const current = this.pins.get(root) ?? 0;
    if (current <= 0) return false;
    if (current === 1) {
      this.pins.delete(root);
      this.dropAt.set(root, now + this.graceMs);
      return true;
    }
    this.pins.set(root, current - 1);
    return false;
  }

  /**
   * Roots whose grace period has elapsed and which still have no pins — the
   * caller should tear these subscriptions down now, then call
   * {@link finalizeTeardown} for each.
   */
  expired(now: number): string[] {
    const out: string[] = [];
    for (const [root, deadline] of this.dropAt) {
      if (deadline <= now && !this.pins.has(root)) out.push(root);
    }
    return out;
  }

  /** Clear teardown bookkeeping for `root` after its subscription is torn down. */
  finalizeTeardown(root: string): void {
    this.dropAt.delete(root);
  }

  /** Whether `root` is currently subscribed (has ≥1 pin). */
  has(root: string): boolean {
    return (this.pins.get(root) ?? 0) > 0;
  }

  /** Pin count for `root` (0 if none). */
  count(root: string): number {
    return this.pins.get(root) ?? 0;
  }

  /**
   * The currently-pinned roots — the set to **persist** (DO storage) and
   * re-subscribe to on hibernation wake. Excludes roots merely pending teardown.
   */
  active(): string[] {
    return [...this.pins.keys()];
  }
}
