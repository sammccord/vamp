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
import { HookRegistry, TempoLogLevel } from "@tempojs/common";
import { type ServerContext, ServiceRegistry, TempoRouterConfiguration } from "@tempojs/server";
import { DurableObject } from "cloudflare:workers";
import { YStreamClient, type YStreamProviderStub } from "y-durablestream";
import { Doc } from "yjs";
import type { YArrayEvent, YMapEvent } from "yjs";

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
export interface ECSRuntimeConfiguration {
  // Custom logger to use with tempo rpc.
  logger?: ContextLogger;
  // The yjs document to connect to, defaults to 'global'.
  document?: string;
  // The tempo rpc service registry the generated game services are registered with.
  serviceRegistry: ServiceRegistry;
  // Optional hooks for tempo rpc middleware.
  // biome-ignore lint/suspicious/noExplicitAny: provider is app-defined and erased at the boundary
  hooks?: HookRegistry<ServerContext, any>;
  // ECS options to configure the ecs runtime.
  // biome-ignore lint/suspicious/noExplicitAny: entity/delta types are app-specific
  ecs: ECSOptions<any, any>;
  // General context to make available within ecs systems.
  context?: Record<string, unknown>;
}

export type ECSRuntimeProvider = () => ECSRuntimeConfiguration;

/**
 * Module-level runtime provider. The application's worker entry registers it via
 * {@link defineECSRuntime}. Because the worker entry module is evaluated inside
 * the Durable Object isolate, the provider (and the non-serializable values it
 * returns) are available to the DO without crossing the RPC boundary.
 */
let _runtimeProvider: ECSRuntimeProvider | undefined;

/**
 * Register the runtime configuration provider used by {@link ECSDurableObject.setup}.
 * Call this at module scope in your worker entry so it runs inside the DO isolate.
 */
export function defineECSRuntime(provider: ECSRuntimeProvider): void {
  _runtimeProvider = provider;
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
  // Remote changes pending reconciliation into the next scope
  private _pendingReconcile = new Map<
    string,
    { type: "insert" | "update" | "delete"; entity?: Entity }
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
    this.ctx.getWebSockets().forEach((ws) => {
      let attachment = ws.deserializeAttachment() as UserSession | null;
      if (attachment) {
        // If we previously attached state to our WebSocket,
        // let's add it to `sessions` map to restore the state of the connection.
        this.sessions.set(ws, attachment);
      }
    });

    // Sets an application level auto response that does not wake hibernated WebSockets.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
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
      // General context to make available within ecs systems
      context: Context;
    },
  ) {
    // Guard against double bootstrap. `this.ecs` is assigned synchronously below,
    // before any await, so concurrent setup() calls are safe. Note: `initialized()`
    // only reflects post-seed state, so it must not be used as the guard here.
    if (this.ecs) return;

    this._namespace = namespace;

    // Create ECS with shared entity store
    const entities = this._entityStore;
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
          sessions: this.sessions,
          saveSession(ws: WebSocket, session: UserSession) {
            ws.serializeAttachment(session);
            this.sessions.set(ws, session);
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
      for (const [id, { type }] of this._pendingReconcile) {
        const entity = entities.get(id);
        switch (type) {
          case "insert":
            if (entity) {
              scope.mutations.set(
                id,
                MutationRecord.fromInsert<Entity, EntityDelta>({ entity: structuredClone(entity) }),
              );
              scope.shadowEntities.set(id, structuredClone(entity));
              scope.deletedIds.delete(id);
            }
            break;
          case "update":
            if (entity) {
              scope.mutations.set(
                id,
                MutationRecord.fromUpdate<Entity, EntityDelta>({
                  delta: entity as unknown as EntityDelta,
                }),
              );
              scope.shadowEntities.set(id, structuredClone(entity));
              scope.deletedIds.delete(id);
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
    this.connectToDoc(configuration.document ?? "global");
    this._ensureSyncedAndSeed();
  }

  /**
   * Bootstrap the durable object using the runtime configuration registered via
   * {@link defineECSRuntime}. Unlike {@link initialize}, all arguments are
   * structured-clone serializable, so this is safe to invoke across the Durable
   * Object RPC boundary (e.g. `stub.setup(namespace)`). The non-serializable
   * pieces (service registry, ecs options, hooks) are constructed inside the DO
   * isolate by the provider. Resolves once the ECS has been seeded + initialized.
   */
  async setup(namespace: string, context?: Context, document?: string): Promise<void> {
    if (!this.ecs) {
      if (!_runtimeProvider) {
        throw new Error(
          "ECS runtime is not configured. Call defineECSRuntime(...) at module scope in your worker entry.",
        );
      }
      const config = _runtimeProvider();
      this.initialize(namespace, {
        logger: config.logger,
        document: document ?? config.document,
        serviceRegistry: config.serviceRegistry,
        hooks: config.hooks,
        ecs: config.ecs as ECSOptions<Entity, EntityDelta>,
        context: (context ?? config.context ?? {}) as Context,
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

    const fallback = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.ecs && !this.ecs.initialized) {
          this.log.warn("ECS seeding timed out; force-initializing");
          this.ecs.initialize();
        }
        this._resolveReady();
        resolve();
      }, timeoutMs);
    });

    return Promise.race([pending, fallback]);
  }

  private _resolveReady() {
    const resolvers = this._readyResolvers;
    this._readyResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  connectToDoc(docName: string) {
    const bindings = this.env as CloudflareBindings;
    const stub = bindings.GAME_STORAGE.get(
      bindings.GAME_STORAGE.idFromName(docName),
    )! as unknown as YStreamProviderStub;
    this.client = new YStreamClient(this.doc, { stub });
    this.ctx.waitUntil(this.client.connect());
  }

  disconnect() {
    this._teardownObservers();
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
    if (this.client?.synced) {
      this._seedFromDoc();
    } else {
      this.client?.onStatusChange((status) => {
        if (status === "synced" && !this._seeded) {
          this._seedFromDoc();
        }
      });
    }
  }

  /// ── Doc seeding ──────────────────────────────────────────────

  private _seedFromDoc() {
    if (this._seeded || !this.ecs || !this.client?.synced) return;
    this._seeded = true;

    const entitiesList = this.doc.getArray<string>(this._namespace);

    // Attach namespace array observer (before seeding to catch future changes)
    this._setupArrayObserver();

    // Seed existing entities
    const ids = entitiesList.toArray();
    for (let i = 0; i < ids.length; i++) {
      this._addEntityFromDoc(ids[i]);
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

      for (const key of event.keysChanged) {
        const change = event.changes.keys.get(key);
        if (change && change.action === "delete") {
          delete (entity as Record<string, unknown>)[key];
        } else {
          (entity as Record<string, unknown>)[key] = map.get(key);
        }
      }

      this._pendingReconcile.set(id, { type: "update" });
    };
    map.observe(handler);
    this._entityObserverCleanups.set(id, () => map.unobserve(handler));
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
        // Ensure entity is in the namespace array
        if (!this._entityIdMirror.has(id)) {
          this.doc.getArray<string>(this._namespace).push([id]);
          this._entityIdMirror.add(id);
        }
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
        // Delete: remove from namespace array and clear entity map
        const arr = this.doc.getArray<string>(this._namespace);
        const idx = arr.toArray().indexOf(id);
        if (idx !== -1) {
          arr.delete(idx, 1);
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
    if (!this.ecs || !this.router) throw new Error("uninitialized");
    // Whenever we receive a message, provide the ecs instance and underlying websocket as context to the service.
    await this.router.process(message as ArrayBuffer, Message({}), [this.ecs!, ws]);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.log.debug("Durable object closing WebSocket", {
      code,
      reason,
      wasClean,
    });
    // If the client closes the connection, the runtime will invoke the webSocketClose() handler.
    this.sessions.delete(ws);
    ws.close(code, "Durable Object is closing WebSocket");
  }

  async webSocketError?(ws: WebSocket, error: unknown) {
    this.log.error("Durable object closing WebSocket", {}, error as Error);
  }
}
