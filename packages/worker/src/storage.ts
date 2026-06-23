import { type BaseEntity } from "@vamp/ecs";
import { type Env } from "cloudflare:workers";
import type { YDocStorage } from "y-durablestream";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_UPDATES,
  DurableObjectSqlStorage,
  YStreamProvider,
} from "y-durablestream";

/**
 * Storage provider for the ECS world document.
 *
 * Compaction thresholds are configurable and default to `y-durablestream`'s own
 * documented defaults (≈10 KB / 500 updates) rather than a hard-coded magic
 * pair. Because the provider stores the **entire world** as a single document
 * (every entity's Y.Map under one namespace), the right thresholds are
 * world-size-dependent — size them to your world via {@link maxBytes}/
 * {@link maxUpdates}, which the base provider exposes and forwards to storage.
 *
 * The threshold crossings only compact incrementally; a single large flush can
 * land as one uncompacted row and a quiet-but-large world is never folded down.
 * The DO's `alarm()` tick loop drives {@link compact} on a slower cadence
 * (`compactEveryNTicks`) as the time-based backstop for both cases.
 */
export class ECSStorage<E extends BaseEntity = BaseEntity> extends YStreamProvider<Env> {
  protected override createStorage(): YDocStorage {
    return new DurableObjectSqlStorage(this.ctx.storage, {
      // `this.maxBytes`/`this.maxUpdates` are protected fields set from the
      // `YStreamProviderOptions` passed to `super(...)` (or overridden in a
      // subclass constructor before `super()` returns). They default to
      // `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_UPDATES` so behavior is predictable.
      maxBytes: this.maxBytes ?? DEFAULT_MAX_BYTES,
      maxUpdates: this.maxUpdates ?? DEFAULT_MAX_UPDATES,
    });
  }

  entity(id: string): E {
    return this.doc.getMap(id).toJSON() as E;
  }

  /**
   * Force the world document to compact into a snapshot, regardless of whether
   * the byte/update thresholds have been crossed. Exposed on the provider's RPC
   * surface so the ECS DO's `alarm()` tick loop can drive periodic compaction
   * (the time-based backstop the incremental thresholds cannot provide). Safe to
   * run concurrently with reads — it snapshots the current state.
   */
  async compact(): Promise<void> {
    await this.storage.commit(this.doc);
  }
}
