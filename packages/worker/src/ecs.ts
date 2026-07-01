// src/receiver.ts

import {
  applyMutation,
  type BaseEntity,
  createBaseMutator,
  ECS,
  type ECSOptions,
  type GenericAction,
  MutationRecord,
  MutationType,
} from "@vamp/ecs";
import { Message } from "@vamp/utils/bebop";
import type { ContextLogger } from "@vamp/utils/context-logger";
import { PinoLogger } from "@vamp/utils/pino-logger";
import { TempoWsRouter } from "@vamp/utils/ws-router";
import { HookRegistry, TempoLogLevel, TempoStatusCode } from "@tempojs/common";
import { type ServerContext, ServiceRegistry, TempoRouterConfiguration } from "@tempojs/server";
import { DurableObject } from "cloudflare:workers";
import { YStreamClient } from "y-durablestream";
import { applyUpdate, mergeUpdates } from "yjs";
import type { Doc, Map as YMap, YMapEvent } from "yjs";
import { entitiesMap, removeEntity, writeEntityInsert, writeUpdate } from "./entity-doc";
import { ShardManager } from "./shard-manager";
import {
  applyKeyChange,
  componentKeysToReconcile,
  nextAlarmTime,
  raceWithBoundedTimer,
  shouldCompactThisTick,
  shouldScheduleAlarm,
} from "./reconcile-helpers";

export type RuntimeContext<UserSession extends {}, Context extends {}> = Context & {
  // internal properties extended by ecs runtime, available to ecs systems for low-level usage
  _: {
    sessions: Map<WebSocket, UserSession>;
    saveSession(ws: WebSocket, session: UserSession): void;
  };
};

export type RPCContext<
  UserSession extends {},
  Context extends Record<string, unknown>,
  UpdateArguments extends Array<unknown>,
  Actions extends GenericAction,
  Tags extends number = number,
  Entity extends BaseEntity<Tags> = BaseEntity<Tags>,
  EntityDelta = unknown,
> = [
  ECS<RuntimeContext<UserSession, Context>, UpdateArguments, Actions, Tags, Entity, EntityDelta>,
  WebSocket,
];

/**
 * The non-serializable runtime configuration required to bootstrap an
 * {@link ECSDurableObject}. It contains functions (ECS options) and a class
 * instance (the tempo service registry) that cannot cross the Durable Object
 * RPC boundary, so it must be constructed inside the DO isolate.
 */
export interface ECSRuntimeConfiguration<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
  Actions extends GenericAction = GenericAction,
  Tags extends number = number,
  Entity extends BaseEntity<Tags> = BaseEntity<Tags>,
  EntityDelta = unknown,
> {
  // Custom logger to use with tempo rpc.
  logger?: ContextLogger;
  // The yjs document to connect to, defaults to 'global'.
  document?: string;
  // This lobby DO's OWN namespace binding name (e.g. "GAME_ECS"). Required for
  // live cross-lobby sync: a shard provider RPCs `onShardUpdate` back on this
  // lobby through `env[lobbyBinding]`, so the lobby registers it as its address.
  // Omit to disable notify-push registration (snapshot-on-connect only).
  lobbyBinding?: string;
  // The tempo rpc service registry the generated game services are registered with.
  serviceRegistry: ServiceRegistry;
  // Optional hooks for tempo rpc middleware.
  hooks?: HookRegistry<
    ServerContext,
    RPCContext<UserSession, Context, UpdateArguments, Actions, Tags, Entity, EntityDelta>
  >;
  // ECS options to configure the ecs runtime.
  ecs: ECSOptions<Entity, EntityDelta>;
  // General context to make available within ecs systems. Treated as the static
  // default; any runtime-resolved context (see `resolveContext`) is merged over it.
  context?: Context;
  // Derive the typed `Context` from the serializable seed passed to `setup()`
  // (and re-passed on hibernation wake). This is the place to run an async
  // DB/binding lookup. It is re-run on every cold bootstrap, INCLUDING after a
  // hibernation wake, so the world is re-derived with fresh data — only the seed
  // is persisted/serialized, the resolved context need not be. If omitted, the
  // seed itself is spread directly as the context (the plain query-params case).
  resolveContext?: (seed: Record<string, unknown>) => Context | Promise<Context>;
  // Register systems/behaviors/subscriptions on the ECS world during bootstrap,
  // before it is initialized. Invoked synchronously inside the DO isolate with
  // the freshly-constructed world, so apps can wire `registerSystem`,
  // `registerBehavior`, `subscribe`, `onCreate`, etc. without crossing the RPC
  // boundary. Runs before `initialize()`, so the system queries are swept over
  // the full archetype graph during the same bootstrap.
  registerSystems?: (
    ecs: ECS<
      RuntimeContext<UserSession, Context>,
      UpdateArguments,
      Actions,
      Tags,
      Entity,
      EntityDelta
    >,
  ) => void;
  // Max decodable frame size (bytes) for the YStreamClient. The whole global
  // doc syncs as one frame on connect, so this caps the syncable world size:
  // ceiling ≈ maxFrameSize / per-entity-bytes. Defaults to 8 MB (≈18k rich /
  // 35k lean entities) — well above y-durablestream's conservative 1 MB guard,
  // safe because the provider↔subscriber stream is trusted DO-to-DO. Raise
  // further if entities are small / worlds are huge (bounded by DO memory).
  maxFrameSize?: number;
  // Opt-in server-authoritative tick loop. When set (> 0), an `alarm()` runs
  // `ecs.update(...)` inside a scope on this cadence and reschedules itself.
  // Unset/zero keeps the DO purely reactive (and fully hibernatable).
  tickIntervalMs?: number;
  // Provider of the `update(...)` arguments for each tick (e.g. `[dt]`).
  tickArgs?: () => UpdateArguments;
  // Hook to broadcast the tick's coalesced mutations to observers, mirroring the
  // app's RPC broadcast. If omitted, tick mutations are flushed to the doc only.
  broadcastTick?: (mutations: Map<string, MutationRecord<Entity, EntityDelta>>) => void;
  // Force a periodic `commit`/compaction every N ticks (0 disables).
  compactEveryNTicks?: number;
  // Called on the close/error path for each connection. Apps register this to
  // tear down per-connection state they own outside a returnable generator
  // (e.g. observer sinks registered in a module-level set keyed by socket).
  onConnectionClose?: (ws: WebSocket) => void;
  // Called once per live WebSocket during hibernation re-bootstrap, after the
  // world has been re-seeded. The DO's in-memory state (incl. the ECS
  // `observeMutations` registry and any RPC stream generators) is destroyed on
  // hibernation; the sockets survive. Apps use this to REBUILD per-connection
  // ECS observers from durable state persisted in the socket's attachment
  // (`ws.serializeAttachment`), so the generator-free interest-managed broadcast
  // resumes without the original `observe` generator. See README §hibernation.
  rehydrateConnection?: (
    ecs: ECS<
      RuntimeContext<UserSession, Context>,
      UpdateArguments,
      Actions,
      Tags,
      Entity,
      EntityDelta
    >,
    ws: WebSocket,
  ) => void;
}

export type ECSRuntimeProvider<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
  Actions extends GenericAction = GenericAction,
  Tags extends number = number,
  Entity extends BaseEntity<Tags> = BaseEntity<Tags>,
  EntityDelta = unknown,
> = () => ECSRuntimeConfiguration<
  UserSession,
  Context,
  UpdateArguments,
  Actions,
  Tags,
  Entity,
  EntityDelta
>;

/**
 * Module-level runtime provider. The application's worker entry registers it via
 * {@link defineECSRuntime}. Because the worker entry module is evaluated inside
 * the Durable Object isolate, the provider (and the non-serializable values it
 * returns) are available to the DO without crossing the RPC boundary.
 */
// The configuration shape stored after erasing the app provider's type
// parameters. `setup()` re-casts each field to the DO's concrete generic
// parameters before use, so this loose all-`any` shape keeps those casts valid
// (and mirrors the pre-generic provider, whose members were `any`). The
// strongly-typed app provider is widened into this on register.
// biome-ignore lint/suspicious/noExplicitAny: provider is app-defined and erased at the boundary
type ErasedRuntimeConfiguration = ECSRuntimeConfiguration<any, any, any, any, any, any, any>;

let _runtimeProvider: (() => ErasedRuntimeConfiguration) | undefined;

/**
 * Register the runtime configuration provider used by {@link ECSDurableObject.setup}.
 * Call this at module scope in your worker entry so it runs inside the DO isolate.
 *
 * The provider is stored erased to the base {@link ECSRuntimeConfiguration} type:
 * `setup()` re-casts each field to the DO's concrete generic parameters before
 * use, so the strongly-typed app provider is safe to widen here.
 */
export function defineECSRuntime<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
  Actions extends GenericAction = GenericAction,
  Tags extends number = number,
  Entity extends BaseEntity<Tags> = BaseEntity<Tags>,
  EntityDelta = unknown,
>(
  provider: ECSRuntimeProvider<
    UserSession,
    Context,
    UpdateArguments,
    Actions,
    Tags,
    Entity,
    EntityDelta
  >,
): void {
  _runtimeProvider = provider as unknown as () => ErasedRuntimeConfiguration;
}

export class ECSDurableObject<
  UserSession extends {},
  Context extends Record<string, unknown>,
  UpdateArguments extends Array<unknown>,
  Actions extends GenericAction,
  Tags extends number = number,
  Entity extends BaseEntity<Tags> = BaseEntity<Tags>,
  EntityDelta = unknown,
  Env = CloudflareBindings,
> extends DurableObject<Env> {
  static log = new PinoLogger("ecs", TempoLogLevel.Info);
  _log: ContextLogger | undefined;

  // User sessions
  sessions = new Map<WebSocket, UserSession>();

  // Tempo RPC properties
  private router:
    | TempoWsRouter<
        ECS<
          RuntimeContext<UserSession, Context>,
          UpdateArguments,
          Actions,
          Tags,
          Entity,
          EntityDelta
        >,
        WebSocket
      >
    | undefined;

  // Sync properties
  // Transaction origin for THIS lobby's own writes (so observers + the write
  // forwarder can tell local authorship from synced-in changes).
  private static LOCAL_ORIGIN = Symbol("ecs-local");
  // Transaction origin for updates applied from a remote notify-push
  // (`onShardUpdate`): distinct from LOCAL_ORIGIN so the entity-set/entity
  // observers PROCESS it (reconcile) while the write forwarder SKIPS it (never
  // re-forwards a synced-in change — that would echo-loop across co-subscribers).
  private static REMOTE_ORIGIN = Symbol("ecs-remote");

  // ── D1b/E: multi-provider sharding + live cross-lobby sync ───
  // One `Y.Doc` + sync client per `root` (= shard = provider DO name), owned by
  // the ShardManager. The ECS `_entityStore` is the union of entities across all
  // subscribed shard docs. Live cross-lobby delivery is notify-push: the lobby
  // forwards its own writes to each shard provider and registers for the
  // provider to RPC `onShardUpdate` back when a co-subscriber writes.
  private shards!: ShardManager;
  // This lobby DO's own namespace binding name (e.g. "GAME_ECS"), so a shard
  // provider can RPC this lobby back via `register({binding, name, root})`.
  private _lobbyBinding = "";
  // Roots currently registered for notify-push (gated by players || tick), to
  // keep register/deregister idempotent.
  private _registeredRoots = new Set<string>();
  // Coalescing window (ms) for forwarding local writes to shard providers: a
  // burst of flushes merges into one RPC instead of one-per-flush (which
  // saturates the DO under load). Bounds durability + cross-lobby latency.
  private _forwardDebounceMs = 16;
  // id → its home shard root. Update/Delete mutation records carry no `root`, so
  // we remember where each entity was inserted to route later writes and to drop
  // a shard's entities on teardown.
  private _entityRoot = new Map<string, string>();
  // The lobby's own shard (`game/${ns}`); locally-spawned entities default here.
  private _defaultRoot = "";
  // Hysteresis (ms) before an unpinned shard is torn down; the alarm reaps.
  private _shardGraceMs = 30_000;
  // Per-shard entity-set observer cleanups (replaces the single membership obs.).
  private _shardEntitySetCleanups = new Map<string, () => void>();

  // Per-instance state synced from the Yjs doc (working copy)
  private _entityStore = new Map<string, Entity>();
  // Remote changes pending reconciliation into the next scope. "update" entries
  // also carry the component keys added/removed by the remote change so the
  // reconcile path can route them through `addComponent`/`removeComponent` and
  // keep archetype membership consistent.
  private _pendingReconcile = new Map<
    string,
    | { type: "insert"; entity?: Entity }
    | { type: "update"; addedKeys: Set<string>; removedKeys: Set<string> }
    | { type: "delete"; entity?: Entity }
  >();
  // Entity ids that were reconciled in the currently-flushing scope
  private _reconcilingIds = new Set<string>();
  // Cleanup functions for per-entity Y.Map observers
  private _entityObserverCleanups = new Map<string, () => void>();
  // Whether the lobby's own shard has seeded the ECS + finalized initialize().
  private _seeded = false;
  // The namespace (Y.Array key) for this instance's entity list
  private _namespace = "";
  // Max decodable frame size for the sync client (see ECSRuntimeConfiguration).
  // Defaults to 8 MB; the whole global doc syncs as one frame, so this caps the
  // syncable world size (≈ maxFrameSize / per-entity-bytes).
  private _maxFrameSize = 8 * 1024 * 1024;
  // Tick loop (alarm) configuration, populated from the runtime configuration.
  private _tickIntervalMs = 0;
  private _tickArgsProvider: (() => UpdateArguments) | undefined;
  private _broadcastTick:
    | ((mutations: Map<string, MutationRecord<Entity, EntityDelta>>) => void)
    | undefined;
  private _compactEveryNTicks = 0;
  private _tickCount = 0;
  // App-level per-connection close hook (e.g. to unsubscribe observer sinks).
  private _onConnectionClose: ((ws: WebSocket) => void) | undefined;
  // App-level per-connection rehydrate hook, invoked on hibernation wake for each
  // live socket so apps can rebuild ECS observers from the socket attachment.
  private _rehydrateConnection:
    | ((
        ecs: ECS<
          RuntimeContext<UserSession, Context>,
          UpdateArguments,
          Actions,
          Tags,
          Entity,
          EntityDelta
        >,
        ws: WebSocket,
      ) => void)
    | undefined;

  // Readiness: resolves once the ECS has been seeded + initialized.
  private _readyResolvers: Array<() => void> = [];

  // ECS properties
  ecs:
    | ECS<RuntimeContext<UserSession, Context>, UpdateArguments, Actions, Tags, Entity, EntityDelta>
    | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // As part of constructing the Durable Object,
    // we wake up any hibernating WebSockets and
    // place them back in the `sessions` map.

    // Get all WebSocket connections from the DO
    const hibernating = this.ctx.getWebSockets();
    for (const ws of hibernating) {
      const attachment = ws.deserializeAttachment() as UserSession | null;
      if (attachment) {
        // If we previously attached state to our WebSocket,
        // let's add it to `sessions` map to restore the state of the connection.
        this.sessions.set(ws, attachment);
      }
    }

    // Sets an application level auto response that does not wake hibernated WebSockets.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    // Hibernation recovery: if this isolate was recreated to service live sockets,
    // the runtime ran only this constructor — `ecs`/`router`/`doc`/`client` are all
    // at their field initializers. Re-bootstrap before any handler runs. We block
    // concurrency so `webSocketMessage`/`alarm` cannot observe a half-initialized
    // runtime. A cold DO with no live sockets stays lazy and is bootstrapped on its
    // first HTTP upgrade as before.
    if (hibernating.length > 0) {
      // `blockConcurrencyWhile` runs to completion before any handler (including
      // webSocketMessage/alarm) is delivered, so the runtime tracks this promise;
      // we `void` the returned promise and log re-bootstrap failures rather than
      // letting them float as an unhandled rejection.
      void this.ctx
        .blockConcurrencyWhile(async () => {
          const namespace = await this.ctx.storage.get<string>("__vamp:namespace");
          if (namespace === undefined) {
            // No persisted namespace: the DO was never initialized (or storage was
            // wiped). Leave the runtime undefined; webSocketMessage surfaces a framed
            // error rather than a thrown "uninitialized".
            this.log.error("Hibernation wake with live sockets but no persisted namespace");
            return;
          }
          // Restore the runtime context seed persisted at first bootstrap so
          // `resolveContext` can re-derive the world's context with fresh data.
          // Absent (older DOs / never seeded) yields `undefined`, which falls back
          // to the static `config.context` — identical to the pre-seed behavior.
          const seed = await this.ctx.storage.get<Record<string, unknown>>("__vamp:context");
          await this.setup(namespace, seed);
          // Re-subscribe the persisted shard set so a hibernation-recreated DO
          // re-aggregates the same multi-provider world. setup()/initialize()
          // already re-opened the lobby's own default shard; restore re-opens the
          // additional players' shards (character/* etc.). Live players re-pin on
          // reconnect; provisional pins that no player re-confirms fall back out
          // via the alarm reap once released (D2/D3 refines the release drivers).
          const persistedShards = await this.ctx.storage.get<string[]>("__vamp:shards");
          if (persistedShards && this.shards) this.shards.restore(persistedShards);
          // Re-register restored shards for notify-push (the wake was triggered by
          // a live socket, so we have players and should receive live updates).
          this._syncRegistrations();
          // Rebuild per-connection ECS observers from each live socket's durable
          // attachment, so the generator-free interest-managed broadcast resumes
          // after wake WITHOUT the original `observe` generator (destroyed with
          // the isolate). The app reads its persisted subscription from the
          // attachment inside the hook and re-registers via `observeMutations`.
          if (this._rehydrateConnection && this.ecs) {
            for (const ws of hibernating) {
              try {
                this._rehydrateConnection(this.ecs, ws);
              } catch (err) {
                this.log.error("Error rehydrating connection on wake", {}, err as Error);
              }
            }
          }
        })
        .catch((err) => {
          this.log.error("Hibernation re-bootstrap failed", {}, err as Error);
        });
    }
  }

  get log() {
    return this._log || ECSDurableObject.log;
  }

  initialized() {
    return this.ecs?.initialized;
  }

  initialize(
    namespace: string,
    configuration: {
      // Custom logger to use with tempo rpc
      logger?: ContextLogger;
      // The yjs document to connect to, defaults to 'global', can specify alternate to shard entity state across multiple documents
      document?: string;
      // This lobby DO's own namespace binding name, for live cross-lobby sync.
      lobbyBinding?: string;
      // Max decodable sync frame size (bytes); caps syncable world size. Default 8 MB.
      maxFrameSize?: number;
      // The tempo rpc service registry registered with the generated game services
      serviceRegistry: ServiceRegistry;
      // Optional hooks for tempo rpc middleware
      hooks?: HookRegistry<
        ServerContext,
        RPCContext<UserSession, Context, UpdateArguments, Actions, Tags, Entity, EntityDelta>
      >;
      // ECS options to configure the ecs runtime
      ecs: ECSOptions<Entity, EntityDelta>;
      // General context to make available within ecs systems (already resolved by
      // setup() — static default merged with any runtime-resolved context)
      context: Context;
      // The serializable seed that produced `context`, persisted so a
      // hibernation-recreated constructor can re-derive context via resolveContext.
      seed?: Record<string, unknown>;
      // Register systems/behaviors on the world during bootstrap (see
      // ECSRuntimeConfiguration.registerSystems).
      registerSystems?: (
        ecs: ECS<
          RuntimeContext<UserSession, Context>,
          UpdateArguments,
          Actions,
          Tags,
          Entity,
          EntityDelta
        >,
      ) => void;
      // Opt-in tick loop configuration (see ECSRuntimeConfiguration).
      tickIntervalMs?: number;
      tickArgs?: () => UpdateArguments;
      broadcastTick?: (mutations: Map<string, MutationRecord<Entity, EntityDelta>>) => void;
      compactEveryNTicks?: number;
      // App-level per-connection close hook.
      onConnectionClose?: (ws: WebSocket) => void;
      // App-level per-connection rehydrate hook (see ECSRuntimeConfiguration).
      rehydrateConnection?: (
        ecs: ECS<
          RuntimeContext<UserSession, Context>,
          UpdateArguments,
          Actions,
          Tags,
          Entity,
          EntityDelta
        >,
        ws: WebSocket,
      ) => void;
    },
  ) {
    // Guard against double bootstrap. `this.ecs` is assigned synchronously below,
    // before any await, so concurrent setup() calls are safe. Note: `initialized()`
    // only reflects post-seed state, so it must not be used as the guard here.
    if (this.ecs) return;

    this._namespace = namespace;
    // The lobby's own shard. Locally-spawned entities default their `root` here;
    // the lobby owns + writes it, and also subscribes to participants' shards.
    this._defaultRoot = `game/${this._namespace}`;
    this._lobbyBinding = configuration.lobbyBinding ?? "";
    if (configuration.maxFrameSize !== undefined) this._maxFrameSize = configuration.maxFrameSize;
    this._onConnectionClose = configuration.onConnectionClose;
    this._rehydrateConnection = configuration.rehydrateConnection;
    // Persist the namespace (and resolved document) so a hibernation-recreated
    // constructor can re-bootstrap without a fresh HTTP upgrade. This is durable,
    // per-DO, structured-clone-safe state. Fired via waitUntil so it does not
    // block bootstrap; it runs before the first eviction is possible because
    // initialize() runs during the initial setup().
    // Persist the runtime context seed alongside the namespace/document so the
    // hibernation-recreated constructor can re-derive context. Written only when a
    // seed was supplied (DO storage cannot hold `undefined`, and omitting the key
    // lets the wake path distinguish "no seed" from "empty seed"). This write sits
    // behind the `if (this.ecs) return` guard above, so it is first-bootstrap-only
    // — matching the first-connection-wins semantics of the per-world context.
    this.ctx.waitUntil(
      this.ctx.storage.put({
        "__vamp:namespace": namespace,
        ...(configuration.seed !== undefined ? { "__vamp:context": configuration.seed } : {}),
      }),
    );

    // Create ECS with shared entity store
    const entities = this._entityStore;
    // Capture `sessions` lexically so the `saveSession` closure handed to ECS
    // systems does not depend on `this` (systems may invoke it unbound).
    const sessions = this.sessions;
    this.ecs = new ECS<
      RuntimeContext<UserSession, Context>,
      UpdateArguments,
      Actions,
      Tags,
      Entity,
      EntityDelta
    >(
      entities,
      // Base mutator: pure read-copy update of the working entity store. The
      // server authored every Insert, so a missing Update target is a no-op
      // (no `materializeOnMissingUpdate`).
      createBaseMutator(entities, configuration.ecs),
      {
        ...configuration.context,
        _: {
          sessions,
          saveSession(ws: WebSocket, session: UserSession) {
            ws.serializeAttachment(session);
            // Lexical capture: safe when invoked unbound (was `this.sessions`,
            // which threw AFTER serializeAttachment had already mutated the
            // attachment — a partial write).
            sessions.set(ws, session);
          },
        },
      },
      configuration.ecs,
    );

    // Flush handler: mirror coalesced mutations to the Yjs docs. Each mutation is
    // routed to its entity's home shard (`root`) and grouped so every shard doc
    // gets ONE transaction. Cross-shard writes are therefore NOT atomic — a flush
    // touching entities in multiple roots is eventually consistent across shards.
    this.ecs.setFlushHandler((mutations) => {
      // Group by shard root. The working-store application below is doc-agnostic,
      // so it runs in this first pass; the per-shard transactions run in the second.
      const byRoot = new Map<string, Array<[string, MutationRecord<Entity, EntityDelta>]>>();
      for (const [id, mutation] of mutations) {
        if (this._reconcilingIds.has(id)) {
          // Reconciled from remote: copy the shadow into the working store, but DO
          // NOT write it back to the shard doc — it CAME FROM the doc, and
          // re-writing it would forward an echo to every co-subscriber, an
          // unbounded ping-pong. (Ownership model: a non-owner that also mutates a
          // reconciled entity in the SAME scope will not propagate that local
          // delta — an accepted edge; co-subscribers read, the owner writes.)
          const scope = this.ecs!.context.scope;
          if (scope) {
            const shadow = scope.shadowEntities.get(id);
            if (shadow) {
              entities.set(id, shadow);
            } else if (scope.deletedIds.has(id)) {
              entities.delete(id);
            }
          }
          continue;
        }
        // Locally-authored mutation: apply it to the working entity store so reads
        // (`ecs.entities` / `ecs.entity`) reflect local changes, and route it to
        // its home shard doc (which forwards it to co-subscribers).
        applyMutation(entities, id, mutation, configuration.ecs);
        const root = this._rootForMutation(id, mutation);
        let group = byRoot.get(root);
        if (!group) {
          group = [];
          byRoot.set(root, group);
        }
        group.push([id, mutation]);
      }

      // One transaction per shard doc, opening the shard if a new root appeared.
      let acquiredNew = false;
      for (const [root, group] of byRoot) {
        let doc = this.shards.docFor(root);
        if (!doc) {
          doc = this._acquireShard(root);
          acquiredNew = true;
        }
        doc.transact(() => {
          for (const [id, mutation] of group) {
            this._writeMutationToDoc(id, mutation, doc!, root);
          }
        }, ECSDurableObject.LOCAL_ORIGIN);
      }
      this._reconcilingIds.clear();
      // Persist the shard set only when a new root opened — the common
      // all-known-roots flush touches no storage.
      if (acquiredNew) this._persistActiveShards();
    });

    // Scope-open handler: drain pending remote changes into the scope
    this.ecs.onScopeOpen((scope) => {
      for (const [id, pending] of this._pendingReconcile) {
        const entity = entities.get(id);
        switch (pending.type) {
          case "insert":
            if (entity) {
              // Clone once and reuse the same reference for the mutation value
              // and the shadow (the flush handler copies the shadow into the
              // store, so a shared reference stays consistent and we avoid the
              // previous double clone).
              const cloned = structuredClone(entity);
              scope.mutations.set(
                id,
                MutationRecord.fromInsert<Entity, EntityDelta>({ entity: cloned }),
              );
              scope.shadowEntities.set(id, cloned);
              scope.deletedIds.delete(id);
            }
            break;
          case "update":
            if (entity) {
              // Clone once and reuse the snapshot for both the mutation value
              // (broadcast to observers) and the shadow (copied into the store
              // by the flush handler). Using the live `entity` reference here
              // would let a later remote observer event mutate the value that a
              // pending broadcast still holds.
              const cloned = structuredClone(entity);
              scope.mutations.set(
                id,
                MutationRecord.fromUpdate<Entity, EntityDelta>({
                  delta: cloned as unknown as EntityDelta,
                }),
              );
              scope.shadowEntities.set(id, cloned);
              scope.deletedIds.delete(id);
              // Route remote component add/remove through the archetype graph so
              // queries reflect the new component reality. `executeSystems=false`
              // avoids firing event systems mid-reconcile; the deferred cache
              // rebuild is flushed by the surrounding update/scope flush.
              this._reconcileComponentKeys(id, pending.addedKeys, pending.removedKeys);
            }
            break;
          case "delete": {
            const stale = entity ?? entities.get(id);
            if (stale) {
              scope.mutations.set(
                id,
                MutationRecord.fromDelete<Entity, EntityDelta>({ entity: stale }),
              );
              scope.shadowEntities.delete(id);
              scope.deletedIds.add(id);
            }
            break;
          }
        }
        this._reconcilingIds.add(id);
      }
      this._pendingReconcile.clear();
    });

    // Let the app register systems/behaviors before the world is initialized, so
    // their queries are swept over the full archetype graph during seed/init.
    configuration.registerSystems?.(this.ecs);

    // TODO make this generic parameter ECS
    this.router = new TempoWsRouter<
      ECS<
        RuntimeContext<UserSession, Context>,
        UpdateArguments,
        Actions,
        Tags,
        Entity,
        EntityDelta
      >,
      WebSocket
    >(this.log, configuration.serviceRegistry, new TempoRouterConfiguration());
    if (configuration.hooks) {
      this.router.useHooks(configuration.hooks);
    }

    // Build the shard manager and open the lobby's own shard. Opening the default
    // root seeds the ECS + finalizes initialize() once that shard syncs (see
    // `_onShardSynced`). Additional shards (participants' `character/*` etc.) are
    // acquired on demand (an entity authored into a new root, or a future explicit
    // subscribe driver — D2) and stream their entities in post-init.
    this._initShardManager();
    this._acquireShard(this._defaultRoot);
    this._persistActiveShards();

    // If the runtime configuration enables a tick loop, schedule the first alarm.
    if (configuration.tickIntervalMs && configuration.tickIntervalMs > 0) {
      this._tickIntervalMs = configuration.tickIntervalMs;
      this._tickArgsProvider = configuration.tickArgs as (() => UpdateArguments) | undefined;
      this._broadcastTick = configuration.broadcastTick as
        | ((mutations: Map<string, MutationRecord<Entity, EntityDelta>>) => void)
        | undefined;
      this._compactEveryNTicks = configuration.compactEveryNTicks ?? 0;
      this.ctx.waitUntil(this._scheduleNextTick());
    }
  }

  /**
   * Bootstrap the durable object using the runtime configuration registered via
   * {@link defineECSRuntime}. Unlike {@link initialize}, all arguments are
   * structured-clone serializable, so this is safe to invoke across the Durable
   * Object RPC boundary (e.g. `stub.setup(namespace)`). The non-serializable
   * pieces (service registry, ecs options, hooks) are constructed inside the DO
   * isolate by the provider. Resolves once the ECS has been seeded + initialized.
   *
   * `seed` is a structured-clone-serializable input (e.g. handler query params or
   * a lookup key) that the provider's `resolveContext(seed)` turns into the world
   * context; if no `resolveContext` is configured, the seed is used as the context
   * directly. The seed is persisted so a hibernation-recreated constructor can
   * re-derive context — only the seed crosses the RPC boundary / hits storage, so
   * the resolved context may hold non-serializable values.
   *
   * Context is per-DO (one ECS world per namespace) and `setup` is idempotent: the
   * FIRST connection to a namespace configures the shared context; later `setup`
   * calls with a different seed are no-ops. Per-client state belongs in
   * `UserSession` (which survives hibernation via `serializeAttachment`), not here.
   */
  async setup(namespace: string, seed?: Record<string, unknown>, document?: string): Promise<void> {
    if (!this.ecs) {
      if (!_runtimeProvider) {
        throw new Error(
          "ECS runtime is not configured. Call defineECSRuntime(...) at module scope in your worker entry.",
        );
      }
      const config = _runtimeProvider();
      // Resolve the runtime context from the seed BEFORE initialize(): initialize
      // is synchronous and constructs the ECS world inline (which stores context as
      // readonly), so the fully-resolved object must exist first. resolveContext may
      // be async (e.g. a DB lookup) and may throw — the throw propagates to the
      // caller (handler 500) or, on the wake path, to blockConcurrencyWhile's catch.
      let resolved: Record<string, unknown> | undefined;
      if (seed !== undefined) {
        resolved = config.resolveContext ? await config.resolveContext(seed) : seed;
      }
      // Static defaults first, runtime-resolved context overrides.
      const context = { ...config.context, ...resolved };
      this.initialize(namespace, {
        logger: config.logger,
        document: document ?? config.document,
        lobbyBinding: config.lobbyBinding,
        serviceRegistry: config.serviceRegistry,
        hooks: config.hooks,
        ecs: config.ecs as ECSOptions<Entity, EntityDelta>,
        context: context as Context,
        seed,
        registerSystems: config.registerSystems as
          | ((
              ecs: ECS<
                RuntimeContext<UserSession, Context>,
                UpdateArguments,
                Actions,
                Tags,
                Entity,
                EntityDelta
              >,
            ) => void)
          | undefined,
        tickIntervalMs: config.tickIntervalMs,
        tickArgs: config.tickArgs as (() => UpdateArguments) | undefined,
        broadcastTick: config.broadcastTick as
          | ((mutations: Map<string, MutationRecord<Entity, EntityDelta>>) => void)
          | undefined,
        compactEveryNTicks: config.compactEveryNTicks,
        onConnectionClose: config.onConnectionClose,
        rehydrateConnection: config.rehydrateConnection as
          | ((
              ecs: ECS<
                RuntimeContext<UserSession, Context>,
                UpdateArguments,
                Actions,
                Tags,
                Entity,
                EntityDelta
              >,
              ws: WebSocket,
            ) => void)
          | undefined,
      });
    }
    await this.ready();
  }

  /**
   * Resolves once the ECS has been seeded from the Yjs document and initialized.
   * If seeding does not complete within `timeoutMs`, the ECS is force-initialized
   * so callers (and incoming RPC) are never blocked indefinitely.
   */
  ready(timeoutMs = 10_000): Promise<void> {
    if (this.ecs?.initialized) return Promise.resolve();

    const pending = new Promise<void>((resolve) => {
      this._readyResolvers.push(resolve);
    });

    // Race the seed completion against a bounded fallback timer. The helper
    // clears the timer on EVERY exit (fast path included) so no live timer
    // outlives the call — a pending timer keeps the isolate resident and fights
    // hibernation.
    return raceWithBoundedTimer(pending, timeoutMs, () => {
      if (this.ecs && !this.ecs.initialized) {
        // Seeding has genuinely stalled. Force-init so RPC is not blocked
        // forever, but log loudly: this publishes a (possibly empty) world.
        // The synchronous `client.synced` re-check in `_ensureSyncedAndSeed`
        // makes this far less likely to fire on a healthy-but-slow sync.
        this.log.warn("ECS seeding timed out; force-initializing", { timeoutMs });
        this.ecs.initialize();
      }
      this._resolveReady();
    });
  }

  private _resolveReady() {
    const resolvers = this._readyResolvers;
    this._readyResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  disconnect() {
    this._teardownObservers();
    this.shards?.teardownAll();
  }

  // ── D1b: shard manager wiring ────────────────────────────────

  /**
   * Construct the {@link ShardManager}. Each shard's sync client is a
   * `YStreamClient` over that root's provider DO; opening a shard wires its
   * entity-set observer (so the SyncStep2 burst is captured) and, once it syncs,
   * seeds its entities into the one ECS world (see {@link _onShardSynced}).
   */
  private _initShardManager() {
    const bindings = this.env as CloudflareBindings;
    this.shards = new ShardManager({
      gracePeriodMs: this._shardGraceMs,
      createClient: (root, doc) => {
        // `GAME_STORAGE` is typed as `DurableObjectNamespace<YStreamProviderStub>`
        // in the shim, so `get` returns a correctly-typed stub without a cast.
        const stub = bindings.GAME_STORAGE.get(bindings.GAME_STORAGE.idFromName(root));
        // clientId = this lobby's namespace, so the provider suppresses echoing
        // our own writes back and matches us to our `register()` entry.
        const client = new YStreamClient(doc, {
          stub,
          clientId: this._namespace,
          maxFrameSize: this._maxFrameSize,
        });
        // Persistent write-forwarder: forward THIS lobby's own writes
        // (LOCAL_ORIGIN) to the provider so co-subscribers receive them. Synced-in
        // changes carry REMOTE_ORIGIN and are deliberately not re-forwarded (no
        // echo loop). Survives across requests because it is a plain doc observer,
        // not a stream read-loop (which a DO cannot keep alive past its request).
        //
        // Updates are COALESCED over a short window: a burst of scopes (e.g. many
        // RPCs/frames in flight) merges into ONE `pushLocalUpdate` RPC instead of
        // one per flush, which otherwise saturates the DO under load. Bounded
        // latency (≤ _forwardDebounceMs) to durability + cross-lobby; merged
        // updates are CRDT-equivalent, and `syncOnce` on the next wake re-pushes
        // anything a dropped flush left behind, so no durability loss.
        let pending: Uint8Array[] = [];
        let timer: ReturnType<typeof setTimeout> | null = null;
        const flushForward = () => {
          timer = null;
          if (pending.length === 0) return;
          const merged = pending.length === 1 ? pending[0] : mergeUpdates(pending);
          pending = [];
          this.ctx.waitUntil(client.pushLocalUpdate(merged));
        };
        const forwarder = (update: Uint8Array, origin: unknown) => {
          if (origin !== ECSDurableObject.LOCAL_ORIGIN) return;
          pending.push(update);
          if (timer === null) timer = setTimeout(flushForward, this._forwardDebounceMs);
        };
        doc.on("update", forwarder);
        // One-shot initial bidirectional sync (no persistent read-loop): pulls the
        // shard's current state + pushes ours, then seeds the ECS + gates ready().
        // Live updates afterward arrive via notify-push (`onShardUpdate`).
        this.ctx.waitUntil(client.syncOnce().then(() => this._onShardSynced(root, doc)));
        return {
          disconnect() {
            doc.off("update", forwarder);
            if (timer !== null) clearTimeout(timer);
            flushForward(); // flush any buffered writes before tearing down
            client.disconnect();
          },
        };
      },
      // ShardManager.open() fires onShardOpen before createClient, so the
      // entity-set observer is attached before the client's initial sync burst.
      onShardOpen: (root, doc) => this._observeShardEntitySet(root, doc),
      onShardClose: (root, doc) => this._closeShard(root, doc),
    });
  }

  /** Open (pin) `root`, returning its shard doc, and (de)register for notify-push. */
  private _acquireShard(root: string): Doc {
    const doc = this.shards.acquire(root);
    this._syncRegistrations();
    return doc;
  }

  /**
   * Persist the currently-subscribed root set so a hibernation-recreated
   * constructor can re-subscribe (see the constructor's wake path). Fire-and-
   * forget; cheap + idempotent.
   */
  private _persistActiveShards() {
    this.ctx.waitUntil(this.ctx.storage.put("__vamp:shards", this.shards.activeRoots()));
  }

  /// ── E: live cross-lobby notify-push ──────────────────────────

  /**
   * Whether this lobby should receive live shard updates right now. Gated so an
   * idle lobby (no players, no tick) registers for nothing and can hibernate:
   * receive iff a player is connected OR a server tick is configured.
   */
  private _shouldReceive(excludeWs?: WebSocket): boolean {
    if (this._tickIntervalMs > 0) return true;
    const sockets = this.ctx.getWebSockets();
    // On the close path the closing socket may still be listed; exclude it so the
    // last player leaving correctly gates the lobby off.
    const count = excludeWs ? sockets.filter((s) => s !== excludeWs).length : sockets.length;
    return count > 0;
  }

  /**
   * Reconcile the set of shards registered for notify-push with the gating rule
   * ({@link _shouldReceive}) and the set of active shards. Registering tells a
   * shard provider to RPC `onShardUpdate` on this lobby when a co-subscriber
   * writes. Idempotent — only RPCs on an actual change. Call on shard acquire,
   * player connect/disconnect, and hibernation wake.
   */
  private _syncRegistrations(excludeWs?: WebSocket): void {
    if (!this.shards) return;
    const want = this._shouldReceive(excludeWs);
    const active = new Set(this.shards.activeRoots());
    if (want) {
      for (const root of active) {
        if (!this._registeredRoots.has(root)) {
          this._registeredRoots.add(root);
          this.ctx.waitUntil(this._registerShard(root));
        }
      }
    }
    // Deregister anything no longer wanted: gated off, or no longer active.
    for (const root of [...this._registeredRoots]) {
      if (!want || !active.has(root)) {
        this._registeredRoots.delete(root);
        this.ctx.waitUntil(this._deregisterShard(root));
      }
    }
  }

  private _shardStub(root: string) {
    const bindings = this.env as CloudflareBindings;
    return bindings.GAME_STORAGE.get(bindings.GAME_STORAGE.idFromName(root));
  }

  private async _registerShard(root: string): Promise<void> {
    try {
      await this._shardStub(root).register(this._namespace, {
        binding: this._lobbyBinding,
        name: this._namespace,
        root,
      });
    } catch (err) {
      this.log.error("Failed to register shard for notify-push", { root }, err as Error);
    }
  }

  private async _deregisterShard(root: string): Promise<void> {
    try {
      await this._shardStub(root).deregister(this._namespace);
    } catch (err) {
      this.log.error("Failed to deregister shard", { root }, err as Error);
    }
  }

  /**
   * RPC entrypoint: a shard provider delivers a co-subscriber's update here (the
   * notify-push live-delivery path). Wakes this lobby from hibernation if needed
   * (the constructor re-bootstraps + restores shards first). Applies the update
   * under REMOTE_ORIGIN — so the entity-set/entity observers reconcile it while
   * the write forwarder ignores it — then opens a scope to drain the reconcile
   * and broadcast to connected game clients.
   */
  async onShardUpdate(root: string, update: Uint8Array): Promise<void> {
    if (!this.ecs?.initialized) return;
    const doc = this.shards?.docFor(root);
    // We no longer hold this shard, or we are gated off (no players, no tick):
    // stop receiving and drop the update. Self-heals a stale provider registry.
    if (!doc || !this._shouldReceive()) {
      this._registeredRoots.delete(root);
      this.ctx.waitUntil(this._deregisterShard(root));
      return;
    }
    applyUpdate(doc, update, ECSDurableObject.REMOTE_ORIGIN);
    // An empty scope still fires onScopeOpen (drains _pendingReconcile) + the
    // flush handler + routeMutations, broadcasting the change to game clients.
    await this.ecs.withScope(() => {});
  }

  /// ── Doc seeding (per shard) ──────────────────────────────────

  /**
   * Called when a shard finishes initial sync. Seeds every entity in that shard's
   * doc into the ECS. The lobby's own (default-root) shard additionally gates ECS
   * initialization + `ready()`: once it has synced + seeded, the world is
   * publishable. A shard that syncs AFTER init streams its entities in via
   * `_pendingReconcile` so they broadcast to clients like any remote change.
   */
  private _onShardSynced(root: string, doc: Doc) {
    if (!this.ecs) return;
    const alreadyInit = this.ecs.initialized;
    for (const id of entitiesMap(doc).keys()) {
      this._addEntityFromDoc(id, doc, root);
      if (alreadyInit) this._pendingReconcile.set(id, { type: "insert" });
    }
    if (root === this._defaultRoot && !this._seeded) {
      this._seeded = true;
      this.ecs.initialize();
      this._resolveReady();
    }
  }

  /**
   * Observe a shard's entity-set (`__vamp:entities`). In the sharded model a
   * shard's entity set IS its membership: an add pulls the entity into the ECS, a
   * delete evicts it. Replaces the former per-namespace membership-map observer.
   */
  private _observeShardEntitySet(root: string, doc: Doc) {
    const entities = entitiesMap(doc);
    const handler = (event: YMapEvent<YMap<unknown>>) => {
      if (event.transaction.origin === ECSDurableObject.LOCAL_ORIGIN) return;
      for (const [id, change] of event.changes.keys) {
        if (change.action === "delete") {
          this._removeEntityFromDoc(id);
        } else {
          // add or re-add: pull the entity into the ECS from this shard.
          this._addEntityFromDoc(id, doc, root);
          this._pendingReconcile.set(id, { type: "insert" });
        }
      }
    };
    entities.observe(handler);
    this._shardEntitySetCleanups.set(root, () => entities.unobserve(handler));
  }

  /**
   * Tear down a shard: unwire its entity-set observer and locally evict its
   * entities from the ECS world. This is a LOCAL eviction, not a synced delete —
   * the entities still live in their provider doc, so other lobbies keep them.
   */
  private _closeShard(root: string, _doc: Doc) {
    // Stop receiving notify-push for this shard (the provider drops us from its
    // registry), so it can quiesce once no lobby is subscribed.
    if (this._registeredRoots.delete(root)) {
      this.ctx.waitUntil(this._deregisterShard(root));
    }
    const cleanup = this._shardEntitySetCleanups.get(root);
    if (cleanup) {
      cleanup();
      this._shardEntitySetCleanups.delete(root);
    }
    if (this.ecs) {
      // Snapshot the ids first — the loop mutates `_entityRoot`.
      const ids: string[] = [];
      for (const [id, r] of this._entityRoot) if (r === root) ids.push(id);
      for (const id of ids) {
        this._unobserveEntity(id);
        const entity = this._entityStore.get(id);
        if (entity) {
          this.ecs.delete(entity);
          this._pendingReconcile.set(id, { type: "delete", entity });
        }
        this._entityRoot.delete(id);
      }
    }
    this._persistActiveShards();
  }

  private _addEntityFromDoc(id: string, doc: Doc, root: string) {
    if (!this.ecs) return;
    const map = entitiesMap(doc).get(id);
    if (!map) return;
    this._entityRoot.set(id, root);
    const raw = map.toJSON() as Entity;
    // ensure id is set (it is the map key, dropped from the component data)
    if (!raw.id) (raw as Record<string, unknown>).id = id;
    // If entity doesn't exist locally, register it in the ECS archetype graph.
    if (!this.ecs.hasEntity(id)) {
      this.ecs.insert(raw);
    }
    // Backfill the working store. Post-init, `ecs.insert()` called outside a
    // scope defers its data write into an auto-created scope that this (non-scope)
    // call never commits — so the entity registers in the archetype graph but not
    // the working store, and the reconcile drain (onScopeOpen) reads the store
    // directly. Pre-init seeding writes the store via the immediate base mutator,
    // making this a no-op there; idempotent on a re-add.
    if (!this._entityStore.has(id)) {
      this._entityStore.set(id, raw);
    }
    this._observeEntity(id, doc);
  }

  private _removeEntityFromDoc(id: string) {
    if (!this.ecs) return;
    const entity = this._entityStore.get(id);
    if (entity) {
      this.ecs.delete(entity);
      this._pendingReconcile.set(id, { type: "delete", entity });
    }
    this._unobserveEntity(id);
    this._entityRoot.delete(id);
  }

  /// ── Per-entity Y.Map observers ───────────────────────────────

  private _observeEntity(id: string, doc: Doc) {
    if (this._entityObserverCleanups.has(id)) return;
    const map = entitiesMap(doc).get(id);
    if (!map) return;
    const handler = (event: YMapEvent<unknown>) => {
      if (event.transaction.origin === ECSDurableObject.LOCAL_ORIGIN) return;
      if (event.keysChanged.size === 0) return;

      const entity = this._entityStore.get(id);
      if (!entity) return;

      const pending = this._getOrCreatePendingUpdate(id);
      for (const key of event.keysChanged) {
        const change = event.changes.keys.get(key);
        const existed = key in (entity as Record<string, unknown>);
        if (change && change.action === "delete") {
          delete (entity as Record<string, unknown>)[key];
        } else {
          (entity as Record<string, unknown>)[key] = map.get(key);
        }
        applyKeyChange(pending, key, change?.action, existed);
      }
    };
    map.observe(handler);
    this._entityObserverCleanups.set(id, () => map.unobserve(handler));
  }

  /**
   * Get (or create) the pending "update" reconcile entry for `id`, merging into
   * an existing update entry so multiple remote bursts before the next scope
   * accumulate their added/removed keys.
   */
  private _getOrCreatePendingUpdate(id: string): {
    type: "update";
    addedKeys: Set<string>;
    removedKeys: Set<string>;
  } {
    const existing = this._pendingReconcile.get(id);
    if (existing && existing.type === "update") return existing;
    const entry = {
      type: "update" as const,
      addedKeys: new Set<string>(),
      removedKeys: new Set<string>(),
    };
    this._pendingReconcile.set(id, entry);
    return entry;
  }

  /**
   * Translate a set of added/removed component keys into archetype transitions
   * via the ECS API. `addComponent`/`removeComponent` are the only methods that
   * transform archetype membership; routing through them keeps the archetype
   * graph consistent after a remote component add/remove. Reserved keys
   * (`id`/`tags`) are skipped, and the ECS no-ops for unknown component ids.
   */
  private _reconcileComponentKeys(id: string, addedKeys: Set<string>, removedKeys: Set<string>) {
    if (!this.ecs) return;
    for (const key of componentKeysToReconcile(addedKeys)) {
      this.ecs.addComponent(id, key as Exclude<keyof Entity, "tags">, false);
    }
    for (const key of componentKeysToReconcile(removedKeys)) {
      this.ecs.removeComponent(id, key as Exclude<keyof Entity, "tags">, false);
    }
  }

  private _unobserveEntity(id: string) {
    const cleanup = this._entityObserverCleanups.get(id);
    if (cleanup) {
      cleanup();
      this._entityObserverCleanups.delete(id);
    }
  }

  private _teardownObservers() {
    for (const cleanup of this._entityObserverCleanups.values()) {
      cleanup();
    }
    this._entityObserverCleanups.clear();
    for (const cleanup of this._shardEntitySetCleanups.values()) {
      cleanup();
    }
    this._shardEntitySetCleanups.clear();
  }

  /// ── Writing local mutations back to the Yjs docs ─────────────

  /**
   * The home shard `root` for a mutation. An Insert may carry an explicit `root`
   * on the entity (placing it in a specific shard, e.g. a `character/${player}`);
   * otherwise it defaults to the lobby's own shard. Update/Delete records carry no
   * entity, so they resolve to the entity's remembered home shard.
   */
  private _rootForMutation(id: string, mutation: MutationRecord<Entity, EntityDelta>): string {
    if (mutation.tag === MutationType.Insert) {
      const entity = mutation.value.entity as Record<string, unknown>;
      return (entity.root as string | undefined) ?? this._entityRoot.get(id) ?? this._defaultRoot;
    }
    return this._entityRoot.get(id) ?? this._defaultRoot;
  }

  /**
   * Mirror one mutation into its shard's `doc`. Runs inside the flush handler's
   * per-shard `doc.transact(LOCAL_ORIGIN)`, so the entity-doc `write*` helpers
   * (which assume a surrounding transaction) batch into one update message.
   * Writes **entity data only** — the shard's entity-set is its membership, so
   * there is no separate refcount/membership index to maintain.
   */
  private _writeMutationToDoc(
    id: string,
    mutation: MutationRecord<Entity, EntityDelta>,
    doc: Doc,
    root: string,
  ) {
    switch (mutation.tag) {
      case MutationType.Insert: {
        const entity = mutation.value.entity as Record<string, unknown>;
        // Stamp the resolved home shard onto the entity so subscribers (and a
        // later read) see where it lives; defaults the lobby's own shard.
        if (entity.root === undefined) entity.root = root;
        writeEntityInsert(doc, id, entity);
        this._entityRoot.set(id, root);
        // Observe so a co-subscriber's mutation to this entity reconciles here,
        // even though this insert originated locally.
        this._observeEntity(id, doc);
        break;
      }
      case MutationType.Update: {
        writeUpdate(doc, id, mutation.value.delta as Record<string, unknown>);
        break;
      }
      case MutationType.Delete: {
        // Remove from the home shard doc; syncs to every subscriber. Owner-only
        // delete is an app-level policy; cross-shard ops are eventually consistent.
        removeEntity(doc, id);
        this._unobserveEntity(id);
        this._entityRoot.delete(id);
        break;
      }
    }
  }

  async fetch(_req: Request): Promise<Response> {
    // Creates two ends of a WebSocket connection.
    // @ts-expect-error
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Calling `acceptWebSocket()` informs the runtime that this WebSocket is to begin terminating
    // request within the Durable Object. It has the effect of "accepting" the connection,
    // and allowing the WebSocket to send and receive messages.
    // Unlike `ws.accept()`, `this.ctx.acceptWebSocket(ws)` informs the Workers Runtime that the WebSocket
    // is "hibernatable", so the runtime does not need to pin this Durable Object to memory while
    // the connection is open. During periods of inactivity, the Durable Object can be evicted
    // from memory, but the WebSocket connection will remain open. If at some later point the
    // WebSocket receives a message, the runtime will recreate the Durable Object
    // (run the `constructor`) and deliver the message to the appropriate handler.
    // @ts-expect-error
    this.ctx.acceptWebSocket(server);

    // A player connected: this lobby now has a downstream client, so register its
    // active shards for live notify-push (idempotent; no-op if already on/ticking).
    this._syncRegistrations();

    return new Response(null, {
      status: 101,
      //@ts-expect-error
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Error boundary: no throw may escape as an unhandled rejection. Both the
    // uninitialized case (rare with hibernation re-bootstrap; only reached if
    // persisted state was lost) and any decode/handler throw that escapes
    // `router.process` become a framed error to the client rather than a crash.
    try {
      if (!this.ecs || !this.router) {
        this.log.error("Received message on uninitialized DO");
        this._sendFramedError(ws, "uninitialized");
        return;
      }
      // Provide the ecs instance and underlying websocket as context to the service.
      await this.router.process(message as ArrayBuffer, Message({}), [this.ecs, ws]);
    } catch (err) {
      this.log.error("Error processing WebSocket message", {}, err as Error);
      this._sendFramedError(ws, "internal");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.log.debug("WebSocket closing", { code, reason, wasClean });
    await this._teardownConnection(ws);
    ws.close(code, "Durable Object is closing WebSocket");
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    this.log.error("WebSocket errored; tearing down", {}, error as Error);
    await this._teardownConnection(ws);
    // The socket is already errored; closing is best-effort.
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      /* socket may already be gone */
    }
  }

  /**
   * Single per-connection teardown path, called from both `webSocketClose` and
   * `webSocketError`. Drives the router's in-flight client/duplex streams to
   * completion (so each iterator's cleanup runs and the router reaps its
   * per-connection bookkeeping), invokes the app-level connection-close hook
   * (e.g. to unsubscribe observer sinks), and drops the session. Idempotent:
   * a socket may receive both `error` and `close`.
   */
  private async _teardownConnection(ws: WebSocket): Promise<void> {
    try {
      await this.router?.closeConnection();
    } catch (err) {
      this.log.error("Error tearing down connection streams", {}, err as Error);
    }
    // App-level teardown (e.g. observer sinks registered by the `observe` RPC).
    if (this._onConnectionClose) {
      try {
        this._onConnectionClose(ws);
      } catch (err) {
        this.log.error("Error in app connection-close hook", {}, err as Error);
      }
    }
    this.sessions.delete(ws);
    // A player left: if this was the last one and we are not ticking, gate off —
    // deregister from notify-push so providers stop RPC-ing us and we can quiesce.
    // Exclude this (closing) socket, which may still be listed during close.
    this._syncRegistrations(ws);
  }

  /**
   * Encode a minimal error `Message` and send it to the client, guarded on the
   * socket's readiness so a closed/closing socket is a no-op. Matches the
   * router's framed-error envelope (status + msg) so the client transport
   * surfaces it as a failed call rather than a hang.
   */
  private _sendFramedError(ws: WebSocket, msg: string): void {
    try {
      // readyState 1 === OPEN; skip if not open.
      if (ws.readyState !== 1) return;
      const frame = Message({ status: TempoStatusCode.INTERNAL, msg });
      ws.send(new Uint8Array(Message.encode(frame)) as unknown as ArrayBuffer);
    } catch {
      /* best-effort: socket may be gone */
    }
  }

  /**
   * The `alarm()` tick loop. Runs `ecs.update(...)` inside a scope (so tick
   * mutations flow through the same flush/broadcast pipeline as RPC mutations),
   * optionally forces a periodic `commit`/compaction, and reschedules itself.
   * Opt-in: only fires when `tickIntervalMs` is configured.
   */
  async alarm(): Promise<void> {
    // With hibernation re-bootstrap, a recreated DO re-initializes in the
    // constructor before alarm() runs. Still guard: if not initialized, do not
    // throw — reschedule and bail (liveness, not crash).
    if (!this.ecs?.initialized) {
      await this._scheduleNextTick();
      return;
    }

    this._tickCount++;

    // Hysteresis teardown: close shards whose grace period elapsed with no pins.
    this.shards.reap(Date.now());

    try {
      const tickArgs = (this._tickArgsProvider?.() ?? []) as UpdateArguments;
      // Run time-based systems through a scope so tick mutations are batched into
      // one doc.transact (flush handler) and can be broadcast to observers
      // exactly like RPC mutations.
      const { mutations } = await this.ecs.withScope(() => {
        this.ecs!.update(...tickArgs);
      });
      this._broadcastTick?.(mutations);
    } catch (err) {
      this.log.error("Error during alarm tick", {}, err as Error);
    }

    // Periodic compaction backstop: force the provider to compact the world doc
    // into a snapshot on a slower cadence than the per-tick interval. This bounds
    // the single-large-update row and quiet-but-large worlds. Run via waitUntil so
    // it does not block the tick or race the flush handler's doc.transact.
    if (shouldCompactThisTick(this._tickCount, this._compactEveryNTicks)) {
      // Compact every subscribed shard's provider. (The cross-namespace orphan
      // GC is gone: in the sharded model an entity lives in exactly one home
      // shard whose subscriber set IS its references — no global refcount to
      // reap; a shard's lifecycle governs its entities.)
      this.ctx.waitUntil(this._commitDoc());
    }

    await this._scheduleNextTick();
  }

  /** Schedule the next tick alarm, without clobbering an already-pending alarm. */
  private async _scheduleNextTick(): Promise<void> {
    const next = nextAlarmTime(Date.now(), this._tickIntervalMs);
    if (next === null) return; // tick disabled (purely-reactive app)
    const existing = await this.ctx.storage.getAlarm();
    if (shouldScheduleAlarm(existing)) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * Force each subscribed shard's storage provider Durable Object to compact its
   * world document into a snapshot, bounding the incremental-update log. The
   * provider owns the authoritative doc; we invoke its `compact()` RPC (added to
   * `ECSStorage`), so this is the time-based backstop the byte/update thresholds
   * alone cannot provide for single-large-update and quiet-but-large worlds.
   */
  private async _commitDoc(): Promise<void> {
    const bindings = this.env as CloudflareBindings;
    await Promise.all(
      this.shards.activeRoots().map(async (root) => {
        try {
          const stub = bindings.GAME_STORAGE.get(bindings.GAME_STORAGE.idFromName(root));
          await stub.compact();
        } catch (err) {
          this.log.error("Error committing shard for compaction", { root }, err as Error);
        }
      }),
    );
  }
}
