import { Doc } from "yjs";

import { ShardSubscriptions } from "./shard-subscriptions";

/**
 * A live sync client for one shard's doc. The {@link ShardManager} only needs to
 * be able to stop it; connecting is the factory's job. (In the worker this wraps
 * a `YStreamClient`; injected so this module stays node-testable and free of the
 * `cloudflare:workers` import.)
 */
export interface ShardClient {
  disconnect(): void;
}

export interface ShardManagerOptions {
  /**
   * Open + start syncing a shard's doc against its provider, returning a handle
   * the manager can later stop. Called once per shard when its first pin is
   * acquired (or on {@link ShardManager.restore}).
   */
  createClient: (root: string, doc: Doc) => ShardClient;
  /** Hysteresis before an unpinned shard is torn down. @default 30_000 */
  gracePeriodMs?: number;
  /** Invoked after a shard's doc is opened — wire ECS observers / seeding here. */
  onShardOpen?: (root: string, doc: Doc) => void;
  /** Invoked just before a shard is torn down — unwire observers / drop its entities here. */
  onShardClose?: (root: string, doc: Doc) => void;
}

/**
 * Owns the set of shard subscriptions a lobby holds: one `Y.Doc` + sync client
 * per **root**, their pin refcount + hysteresis (via {@link ShardSubscriptions}),
 * and the open/close lifecycle. The `ECSDurableObject` drives it (acquire on a
 * player join / an entity authored into a root; release on disconnect / delete;
 * `reap` on the alarm tick) and bridges each shard doc to the one ECS world via
 * the `onShardOpen`/`onShardClose` callbacks.
 *
 * Network/runtime concerns (the actual `YStreamClient`) are injected via
 * `createClient`, so the registry + routing + lifecycle logic here is pure and
 * unit-testable with mock clients + real `Y.Doc`s.
 */
export class ShardManager {
  private readonly shards = new Map<string, { doc: Doc; client: ShardClient }>();
  private readonly subs: ShardSubscriptions;
  private readonly opts: ShardManagerOptions;

  constructor(opts: ShardManagerOptions) {
    this.opts = opts;
    this.subs = new ShardSubscriptions(opts.gracePeriodMs);
  }

  /**
   * Pin `root` and ensure it is subscribed, returning its shard doc. The first
   * pin opens the doc + client and fires `onShardOpen`; later pins reuse it.
   * Re-pinning a root pending teardown cancels the teardown.
   */
  acquire(root: string): Doc {
    const first = this.subs.acquire(root);
    if (first && !this.shards.has(root)) this.open(root);
    // biome-ignore lint/style/noNonNullAssertion: open() guarantees presence
    return this.shards.get(root)!.doc;
  }

  /**
   * Release a pin on `root`. When the last pin goes the shard is *not* closed
   * immediately — it stays open for the grace period (see {@link reap}).
   */
  release(root: string, now: number): void {
    this.subs.release(root, now);
  }

  /**
   * Close shards whose grace period has elapsed with no pins. Call from the
   * alarm tick. Fires `onShardClose`, disconnects the client, and drops the doc.
   */
  reap(now: number): void {
    for (const root of this.subs.expired(now)) {
      this.close(root);
      this.subs.finalizeTeardown(root);
    }
  }

  /** The shard doc for `root`, or `undefined` if that shard isn't subscribed. */
  docFor(root: string): Doc | undefined {
    return this.shards.get(root)?.doc;
  }

  /** Whether `root` is currently subscribed (open). */
  has(root: string): boolean {
    return this.shards.has(root);
  }

  /** Currently-pinned roots — the set to persist for hibernation re-subscribe. */
  activeRoots(): string[] {
    return this.subs.active();
  }

  /**
   * Re-open a persisted set of roots on hibernation wake (each gets one pin).
   * The DO should then re-pin per live player/entity so unconfirmed roots fall
   * back out via {@link reap} once their provisional pin is released.
   */
  restore(roots: Iterable<string>): void {
    for (const root of roots) this.acquire(root);
  }

  /** Disconnect every shard (e.g. on full teardown). Does not fire onShardClose pins. */
  teardownAll(): void {
    for (const root of [...this.shards.keys()]) this.close(root);
  }

  // ── internals ──────────────────────────────────────────────────

  private open(root: string): void {
    const doc = new Doc();
    const client = this.opts.createClient(root, doc);
    this.shards.set(root, { doc, client });
    this.opts.onShardOpen?.(root, doc);
  }

  private close(root: string): void {
    const shard = this.shards.get(root);
    if (!shard) return;
    this.opts.onShardClose?.(root, shard.doc);
    try {
      shard.client.disconnect();
    } catch {
      // already gone — ignore
    }
    shard.doc.destroy();
    this.shards.delete(root);
  }
}
