// src/receiver.ts

import {
  type BaseEntity,
  ECS,
  type ECSOptions,
  type GenericEvent,
  MutationRecord,
} from "@framework/ecs";
import { Message } from "@framework/utils/bebop";
import type { ContextLogger } from "@framework/utils/context-logger";
import { PinoLogger } from "@framework/utils/pino-logger";
import { TempoWsRouter } from "@framework/utils/ws-router";
import { HookRegistry, TempoLogLevel } from "@tempojs/common";
import { type ServerContext, ServiceRegistry, TempoRouterConfiguration } from "@tempojs/server";
import { DurableObject } from "cloudflare:workers";
import { EventEmitter } from "tseep";
import { YStreamClient, type YStreamProviderStub } from "y-durablestream";
import { Doc } from "yjs";

export type RuntimeContext<UserSession extends {}, Context extends {}> = Context & {
  // internal properties extended by ecs runtime, available to ecs systems for low-level usage
  _: {
    events: EventEmitter;
    sessions: Map<WebSocket, UserSession>;
    saveSession(ws: WebSocket, session: UserSession): void;
  };
};

export type RPCContext<
  UserSession extends {},
  Context extends Record<string, unknown>,
  UpdateArguments extends Array<unknown>,
  Events extends GenericEvent,
  E extends BaseEntity = BaseEntity,
  D = unknown,
> = [ECS<RuntimeContext<UserSession, Context>, UpdateArguments, Events, E, D>, WebSocket];

export class ECSDurableObject<
  UserSession extends {},
  Context extends Record<string, unknown>,
  UpdateArguments extends Array<unknown>,
  Events extends GenericEvent,
  E extends BaseEntity = BaseEntity,
  D = unknown,
> extends DurableObject {
  static log = new PinoLogger("ecs", TempoLogLevel.Info);
  _log: ContextLogger | undefined;

  // User sessions
  sessions = new Map<WebSocket, UserSession>();

  // Tempo RPC properties
  router:
    | TempoWsRouter<
        ECS<RuntimeContext<UserSession, Context>, UpdateArguments, Events, E, D>,
        WebSocket
      >
    | undefined;

  // Sync properties
  private doc = new Doc();
  private client: YStreamClient | null = null;

  // ECS properties
  ecs: ECS<RuntimeContext<UserSession, Context>, UpdateArguments, Events, E, D> | undefined;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    // As part of constructing the Durable Object,
    // we wake up any hibernating WebSockets and
    // place them back in the `sessions` map.

    // Get all WebSocket connections from the DO
    this.ctx.getWebSockets().forEach((ws) => {
      let attachment = ws.deserializeAttachment();
      if (attachment) {
        // If we previously attached state to our WebSocket,
        // let's add it to `sessions` map to restore the state of the connection.
        this.sessions.set(ws, { ...attachment });
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
      hooks: HookRegistry<
        ServerContext,
        RPCContext<UserSession, Context, UpdateArguments, Events, E, D>
      >;
      // ECS options to configure the ecs runtime
      ecs: ECSOptions<E, D>;
      // General context to make available within ecs systems
      context: Context;
    },
  ) {
    if (this.initialized()) return;

    // Ensure we are connected the the global entities yjs backend, make this "global" configurable
    this.connectToDoc(configuration.document ?? "global");

    // TODO
    this.log.info("registering services", {
      // log the service to trigger the service's decorator
    });

    this.ecs = new ECS<RuntimeContext<UserSession, Context>, UpdateArguments, Events, E, D>(
      new Map<string, E>(),
      (id: string, mutation: MutationRecord<E, D>) => {
        this.log.debug("mutate", { id, mutation });
      },
      {
        ...configuration.context,
        _: {
          sessions: this.sessions,
          events: new EventEmitter(),
          saveSession(ws: WebSocket, session: UserSession) {
            ws.serializeAttachment(session);
            this.sessions.set(ws, session);
          },
        },
      },
      configuration.ecs,
    );

    // TODO make this generic parameter ECS
    this.router = new TempoWsRouter<
      ECS<RuntimeContext<UserSession, Context>, UpdateArguments, Events, E, D>,
      WebSocket
    >(this.log, configuration.serviceRegistry, new TempoRouterConfiguration());
    if (configuration.hooks) {
      this.router.useHooks(configuration.hooks);
    }

    // TODO register systems
    // TODO pull entities in yjs uri set
    const entitiesList = this.doc.getArray<string>(namespace);
    // Whenever an entity is added/removed from this uri, reflect that change locally.
    entitiesList.observe((t) => {});
    for (const id in entitiesList) {
      // subscribe to entity
      const entity = this.doc.getMap(id); // key is component name, val is component value
      // Insert raw entity
      this.ecs.insert(entity.toJSON());
      // TODO subscribe to entity doc, transparently modify entity in doc without firing off additional scope mutations
    }

    this.ecs.initialize();
  }

  connectToDoc(docName: string) {
    const stub = this.env.ENTITIES!.get(
      this.env.ENTITIES!.idFromName(docName),
    )! as unknown as YStreamProviderStub;
    this.client = new YStreamClient(this.doc, { stub });
    this.ctx.waitUntil(this.client.connect());
  }

  disconnect() {
    this.client?.disconnect();
    this.client = null;
  }

  async fetch(_req: Request) {
    // Creates two ends of a WebSocket connection.
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
    await this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (!this.ecs || !this.router) throw new Error("uninitialized");
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
    await ws.close(code, "Durable Object is closing WebSocket");
  }

  async webSocketError?(ws: WebSocket, error: unknown) {
    await this.log.error("Durable object closing WebSocket", {}, error as Error);
  }
}
