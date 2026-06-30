import { type BaseEntity } from "@vamp/ecs";
import { PinoLogger } from "@vamp/utils/pino-logger";
import { TempoLogLevel } from "@tempojs/common";
import { type Env } from "cloudflare:workers";
import type { YDocStorage } from "y-durablestream";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_UPDATES,
  DurableObjectSqlStorage,
  YStreamProvider,
} from "y-durablestream";
import type { Map as YMap } from "yjs";

import { GLOBAL_ENTITIES_KEY } from "./reconcile-helpers";

/**
 * Minimal shape of a lobby DO namespace this provider RPCs back for notify-push
 * (resolved by binding name from `this.env`). Only the surface used here.
 */
interface LobbyNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { onShardUpdate(root: string, update: Uint8Array): Promise<void> };
}

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
  private static log = new PinoLogger("ecs-storage", TempoLogLevel.Info);

  /**
   * Surface background storage failures (a failed update persist or end-of-life
   * compaction) through the app logger instead of the base provider's bare
   * `console.error`. These run under `waitUntil`, so without this they would be
   * invisible; a failed persist is recovered from a subscriber on the next
   * SyncStep handshake, so this is an observability hook, not a data-loss path.
   */
  protected override onStorageError(error: unknown): void {
    ECSStorage.log.error("y-durablestream storage operation failed", {}, error as Error);
  }

  /**
   * Deliver a co-subscriber's update to a registered lobby DO (the notify-push
   * live path; see `ECSDurableObject.register`/`onShardUpdate`). The `address`
   * is what the lobby passed to `register`: its own DO binding name + namespace +
   * the shard `root`. Both DOs share one Worker, so `this.env` carries the lobby
   * binding even though it is not in the worker-package's `CloudflareBindings`
   * shim — resolve it by name. Fire-and-forget via `waitUntil` (the RPC also
   * wakes a hibernating lobby); errors are observability-only (the lobby re-syncs
   * via `syncOnce` on its next wake, so a dropped push is never divergence).
   */
  protected override pushToSubscriber(address: unknown, update: Uint8Array): void {
    const { binding, name, root } = address as { binding: string; name: string; root: string };
    if (!binding) return;
    const ns = (this.env as unknown as Record<string, LobbyNamespace | undefined>)[binding];
    if (!ns) return;
    const lobby = ns.get(ns.idFromName(name));
    this.ctx.waitUntil(lobby.onShardUpdate(root, update).catch((err) => this.onStorageError(err)));
  }

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

  /**
   * Read a single entity's current state from the authoritative doc. Entities
   * are global (shared across namespaces) and live as nested `Y.Map`s under the
   * single {@link GLOBAL_ENTITIES_KEY} store, so lookup is by id alone.
   */
  entity(id: string): E | undefined {
    const entities = this.doc.getMap<YMap<unknown>>(GLOBAL_ENTITIES_KEY);
    const emap = entities.get(id);
    if (!emap) return undefined;
    // `id` is not stored as a component (it is the map key); backfill it so
    // callers always get a complete entity. Mirrors `_addEntityFromDoc`.
    const raw = emap.toJSON() as Record<string, unknown>;
    if (raw.id === undefined) raw.id = id;
    return raw as E;
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
