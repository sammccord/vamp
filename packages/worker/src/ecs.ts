// src/receiver.ts

import {
  type BaseEntity,
  ECS,
  type ECSOptions,
  type GenericAction,
  MutationRecord,
} from "@vamp/ecs";
import { Message } from "@vamp/utils/bebop";
import type { ContextLogger } from "@vamp/utils/context-logger";
import { PinoLogger } from "@vamp/utils/pino-logger";
import { TempoWsRouter } from "@vamp/utils/ws-router";
import { HookRegistry, TempoLogLevel, TempoStatusCode } from "@tempojs/common";
import { type ServerContext, ServiceRegistry, TempoRouterConfiguration } from "@tempojs/server";
import { DurableObject } from "cloudflare:workers";
import { YStreamClient } from "y-durablestream";
import { Doc } from "yjs";
import type { YArrayEvent, YMapEvent } from "yjs";
import {
  applyKeyChange,
  componentKeysToReconcile,
  nextAlarmTime,
  occurrenceIndicesDescending,
  raceWithBoundedTimer,
  shouldCompactThisTick,
  shouldPushId,
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
  private doc = new Doc();
  private client: YStreamClient | null = null;
  private static LOCAL_ORIGIN = Symbol("ecs-local");

  // Per-instance state synced from the Yjs doc (working copy)
  private _entityStore = new Map<string, Entity>();
  // Mirror of entity ids in the namespace array for diff on observe
  private _entityIdMirror = new Set<string>();
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
  // Cleanup for the namespace array observer
  private _arrayObserverCleanup: (() => void) | null = null;
  // Whether we have seeded the local ECS from the Yjs doc
  private _seeded = false;
  // The namespace (Y.Array key) for this instance's entity list
  private _namespace = "";
  // The resolved Yjs document name this instance connects to
  private _document = "global";
  // Unsubscribe for the sync status listener (tracked so re-bootstrap on wake
  // does not stack a second listener).
  private _statusUnsub: (() => void) | null = null;
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
          const document = await this.ctx.storage.get<string>("__vamp:document");
          // Restore the runtime context seed persisted at first bootstrap so
          // `resolveContext` can re-derive the world's context with fresh data.
          // Absent (older DOs / never seeded) yields `undefined`, which falls back
          // to the static `config.context` — identical to the pre-seed behavior.
          const seed = await this.ctx.storage.get<Record<string, unknown>>("__vamp:context");
          await this.setup(namespace, seed, document);
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
    },
  ) {
    // Guard against double bootstrap. `this.ecs` is assigned synchronously below,
    // before any await, so concurrent setup() calls are safe. Note: `initialized()`
    // only reflects post-seed state, so it must not be used as the guard here.
    if (this.ecs) return;

    this._namespace = namespace;
    const document = configuration.document ?? "global";
    this._document = document;
    this._onConnectionClose = configuration.onConnectionClose;
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
        "__vamp:document": document,
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
      // Base mutator: pure read-copy update of the working entity store
      (id: string, mutation: MutationRecord<Entity, EntityDelta>) => {
        switch (mutation.tag) {
          case 1:
            entities.set(id, mutation.value.entity);
            break;
          case 2: {
            const entity = entities.get(id);
            if (entity) {
              configuration.ecs.mergeDelta(entity, mutation.value.delta);
            }
            break;
          }
          case 3:
            entities.delete(id);
            break;
        }
      },
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

    // Flush handler: batch all coalesced mutations in a single doc.transact
    this.ecs.setFlushHandler((mutations) => {
      this.doc.transact(() => {
        for (const [id, mutation] of mutations) {
          if (this._reconcilingIds.has(id)) {
            // Reconciled from remote: copy shadow entity (avoids additive mergeDelta)
            const scope = this.ecs!.context.scope;
            if (scope) {
              const shadow = scope.shadowEntities.get(id);
              if (shadow) {
                entities.set(id, shadow);
              } else if (scope.deletedIds.has(id)) {
                entities.delete(id);
              }
            }
          } else {
            // Locally-authored mutation: apply it to the working entity store so
            // reads (`ecs.entities` / `ecs.entity`) reflect local changes. Remote
            // changes instead arrive through the Yjs observers above.
            switch (mutation.tag) {
              case 1:
                entities.set(id, mutation.value.entity);
                break;
              case 2: {
                const entity = entities.get(id);
                if (entity) configuration.ecs.mergeDelta(entity, mutation.value.delta);
                break;
              }
              case 3:
                entities.delete(id);
                break;
            }
          }
          // Always mirror to Yjs (idempotent; includes local changes for mixed-case)
          this._writeMutationToDoc(id, mutation);
        }
      }, ECSDurableObject.LOCAL_ORIGIN);
      this._reconcilingIds.clear();
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

    // Connect to the Yjs document and seed ECS once synced
    this.connectToDoc(document);
    this._ensureSyncedAndSeed();

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

  connectToDoc(docName: string) {
    const bindings = this.env as CloudflareBindings;
    // `GAME_STORAGE` is typed as `DurableObjectNamespace<YStreamProviderStub>`
    // in the shim, so `get` returns a correctly-typed stub without a double cast.
    const stub = bindings.GAME_STORAGE.get(bindings.GAME_STORAGE.idFromName(docName));
    this.client = new YStreamClient(this.doc, { stub });
    // Attach the namespace array observer BEFORE connect so the SyncStep2 burst
    // is observed: remote additions that arrive during initial sync land in
    // `_pendingReconcile` instead of being silently dropped.
    this._setupArrayObserver();
    // Do NOT wrap in waitUntil: connect() resolves only when the sync stream
    // ends, so waitUntil would pin the isolate for the whole connection lifetime
    // and defeat hibernation. Fire-and-forget; connect() is documented never to
    // reject. Re-establishment after wake is handled by the constructor's
    // re-bootstrap re-running connectToDoc.
    void this.client.connect();
  }

  disconnect() {
    this._teardownObservers();
    // Clear the sync status listener so a re-bootstrap (hibernation wake) does
    // not stack a second listener.
    this._statusUnsub?.();
    this._statusUnsub = null;
    this.client?.disconnect();
    this.client = null;
  }

  /**
   * Wait for the YStreamClient to finish initial sync, then seed the local
   * ECS from the Yjs doc (namespace array + per-entity maps), attach observers,
   * and finalize ECS initialization.
   */
  private _ensureSyncedAndSeed() {
    if (this._seeded) return;

    // Subscribe first, capturing the unsubscribe so we self-unsubscribe once
    // seeded and so re-bootstrap (hibernation wake) does not stack listeners.
    const unsub = this.client?.onStatusChange((status) => {
      if (status === "synced" && !this._seeded) {
        this._seedFromDoc();
        this._statusUnsub?.();
        this._statusUnsub = null;
      }
    });
    this._statusUnsub = unsub ?? null;

    // Re-check `synced` synchronously: connect() may have reached `synced`
    // between the field read inside the subscription wiring and now.
    // onStatusChange does NOT replay the current status, so without this a fast
    // sync is missed and `ready()` would force-init an empty world.
    if (this.client?.synced && !this._seeded) {
      this._seedFromDoc();
      this._statusUnsub?.();
      this._statusUnsub = null;
    }
  }

  /// ── Doc seeding ──────────────────────────────────────────────

  private _seedFromDoc() {
    if (this._seeded || !this.ecs || !this.client?.synced) return;
    this._seeded = true;

    const entitiesList = this.doc.getArray<string>(this._namespace);

    // The array observer is already attached (connectToDoc), so additions that
    // arrived during the sync burst are already captured. Diff the current doc
    // ids against what we have mirrored and add any not yet seen; this is
    // idempotent against the array observer's own diff (both guard on
    // `_entityIdMirror`), so an id is never double-processed.
    for (const id of entitiesList.toArray()) {
      if (!this._entityIdMirror.has(id)) {
        this._addEntityFromDoc(id);
      }
    }

    this.ecs.initialize();
    this._resolveReady();
  }

  private _setupArrayObserver() {
    const entitiesList = this.doc.getArray<string>(this._namespace);
    const handler = (event: YArrayEvent<string>) => {
      if (event.transaction.origin === ECSDurableObject.LOCAL_ORIGIN) return;

      const current = new Set(entitiesList.toArray());

      // Removed ids
      for (const id of this._entityIdMirror) {
        if (!current.has(id)) {
          this._removeEntityFromDoc(id);
        }
      }
      // Added ids
      for (const id of current) {
        if (!this._entityIdMirror.has(id)) {
          this._addEntityFromDoc(id);
          this._pendingReconcile.set(id, { type: "insert" });
        }
      }

      this._entityIdMirror = current;
    };
    entitiesList.observe(handler);
    this._arrayObserverCleanup = () => entitiesList.unobserve(handler);
  }

  private _addEntityFromDoc(id: string) {
    if (!this.ecs) return;
    const map = this.doc.getMap<unknown>(id);
    const raw = map.toJSON() as Entity;
    // If entity doesn't exist locally, register it in the ECS archetype graph
    if (!this.ecs.hasEntity(id)) {
      // ensure id is set
      if (!raw.id) (raw as Record<string, unknown>).id = id;
      this.ecs.insert(raw);
    }
    this._entityIdMirror.add(id);
    this._observeEntity(id);
  }

  private _removeEntityFromDoc(id: string) {
    if (!this.ecs) return;
    const entity = this._entityStore.get(id);
    if (entity) {
      this.ecs.delete(entity);
      this._pendingReconcile.set(id, { type: "delete", entity });
    }
    this._unobserveEntity(id);
    this._entityIdMirror.delete(id);
  }

  /// ── Per-entity Y.Map observers ───────────────────────────────

  private _observeEntity(id: string) {
    if (this._entityObserverCleanups.has(id)) return;
    const map = this.doc.getMap<unknown>(id);
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
    if (this._arrayObserverCleanup) {
      this._arrayObserverCleanup();
      this._arrayObserverCleanup = null;
    }
  }

  /// ── Writing local mutations back to the Yjs doc ──────────────

  private _writeMutationToDoc(id: string, mutation: MutationRecord<Entity, EntityDelta>) {
    const map = this.doc.getMap<unknown>(id);
    switch (mutation.tag) {
      case 1: {
        // Insert: populate entity map
        const entity = mutation.value.entity as Record<string, unknown>;
        for (const key in entity) {
          if (Object.prototype.hasOwnProperty.call(entity, key)) {
            const val = entity[key];
            if (val !== undefined) {
              map.set(key, val);
            }
          }
        }
        // Ensure entity is in the namespace array. Guard the push against the
        // authoritative CRDT array (not just the lossy local mirror) so a
        // local-insert / remote-array race cannot push the same id twice.
        const idArr = this.doc.getArray<string>(this._namespace);
        if (shouldPushId(idArr.toArray(), id)) {
          idArr.push([id]);
        }
        this._entityIdMirror.add(id);
        break;
      }
      case 2: {
        // Update: set changed component keys
        const delta = mutation.value.delta as Record<string, unknown>;
        for (const key in delta) {
          if (Object.prototype.hasOwnProperty.call(delta, key)) {
            const val = delta[key];
            if (val === undefined) {
              map.delete(key);
            } else {
              map.set(key, val);
            }
          }
        }
        break;
      }
      case 3: {
        // Delete: remove ALL occurrences from the namespace array (high index
        // first) so a double-written id leaves no surviving occurrence that the
        // array observer would re-add as a ghost. Then clear the entity map.
        const arr = this.doc.getArray<string>(this._namespace);
        for (const i of occurrenceIndicesDescending(arr.toArray(), id)) {
          arr.delete(i, 1);
        }
        for (const key of map.keys()) {
          map.delete(key);
        }
        this._entityIdMirror.delete(id);
        this._unobserveEntity(id);
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
   * Force the storage provider Durable Object to compact its world document into
   * a snapshot, bounding the incremental-update log. The provider owns the
   * authoritative doc; we invoke its `compact()` RPC (added to `ECSStorage`)
   * rather than its in-memory doc, so this is the time-based backstop the byte/
   * update thresholds alone cannot provide for single-large-update and
   * quiet-but-large worlds.
   */
  private async _commitDoc(): Promise<void> {
    try {
      const bindings = this.env as CloudflareBindings;
      const stub = bindings.GAME_STORAGE.get(bindings.GAME_STORAGE.idFromName(this._document));
      await stub.compact();
    } catch (err) {
      this.log.error("Error committing doc for compaction", {}, err as Error);
    }
  }
}
