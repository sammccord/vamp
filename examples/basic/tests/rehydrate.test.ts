import { TempoStatusCode } from "@tempojs/common";
import { ECS, type ECSOptions, type MutationRecord } from "@vamp/ecs";
import { Message } from "@vamp/utils/bebop";
import { expect, test } from "vitest";
import { Entity, MutationScope } from "../src/bebop";
import type { Actions, Tags } from "../src/bebop";
// Type-only imports: keep this suite a plain node test. Importing values from
// `game.generated` / `@vamp/worker` would pull in `cloudflare:workers`, which is
// unavailable outside the workerd runtime. `rpc.service`'s runtime imports are
// cloudflare-free, so `rehydrateGameConnection` loads fine here.
import type { EntityDelta } from "../src/game.generated";
import type { RuntimeContext } from "@vamp/worker";
import { type GameWorldContext, rehydrateGameConnection } from "../src/observe-routing";

/**
 * Unit coverage for the hibernation-safe broadcast resume path (plan §8b/§12):
 * given live sockets whose durable attachment holds an `observe` subscription,
 * `rehydrateGameConnection` must rebuild the ECS interest observers so a
 * subsequent commit auto-routes framed pushes to the right sockets — entirely
 * generator-free (no `wrangler`, no live `observe` generator).
 */

type GameWorld = ECS<RuntimeContext<{}, GameWorldContext>, [], Actions, Tags, Entity, EntityDelta>;

// Minimal ECS options built inline (rather than the worker-coupled
// `createECSOptions`) so this suite stays cloudflare-free. The interest-routing
// path only reads entity data from the store, so component archetype ids and
// delta merging are irrelevant here.
function materializeDelta(delta: EntityDelta): Entity {
  return delta as unknown as Entity;
}
function mergeDelta(entity: Entity, delta: EntityDelta): void {
  Object.assign(entity as Record<string, unknown>, delta);
}
function accumulateDelta(from: EntityDelta, to: EntityDelta): EntityDelta {
  const merged: Record<string, unknown> = {
    ...(from as Record<string, unknown>),
    ...(to as Record<string, unknown>),
  };
  return merged as unknown as EntityDelta;
}
const options = {
  createId: () => crypto.randomUUID(),
  components: {},
  materializeDelta,
  mergeDelta,
  accumulateDelta,
} as unknown as ECSOptions<Entity, EntityDelta>;

/** A bare ECS world wired like the durable object's, minus Yjs/flush. */
function makeWorld(): GameWorld {
  const entities = new Map<string, Entity>();
  const mutate = (id: string, m: MutationRecord<Entity, EntityDelta>) => {
    switch (m.tag) {
      case 1:
        entities.set(id, m.value.entity);
        break;
      case 2: {
        const e = entities.get(id);
        if (e) options.mergeDelta(e, m.value.delta);
        break;
      }
      case 3:
        entities.delete(id);
        break;
    }
  };
  const context = {
    faction: 0,
    seededAt: 0,
    _: { sessions: new Map(), saveSession: () => {} },
  } as unknown as RuntimeContext<{}, GameWorldContext>;
  const ecs = new ECS<RuntimeContext<{}, GameWorldContext>, [], Actions, Tags, Entity, EntityDelta>(
    entities,
    mutate,
    context,
    options,
  );
  ecs.initialize();
  return ecs;
}

/** A minimal hibernatable-WebSocket stand-in capturing attachment + sends. */
function makeFakeWs() {
  let attachment: unknown = null;
  const sent: Uint8Array[] = [];
  const ws = {
    readyState: 1,
    serializeAttachment(v: unknown) {
      attachment = structuredClone(v);
    },
    deserializeAttachment() {
      return attachment;
    },
    send(data: Uint8Array) {
      sent.push(data);
    },
  } as unknown as WebSocket;
  return { ws, sent };
}

function frameKeys(frame: Uint8Array): string[] {
  const message = Message.decode(frame);
  const scope = MutationScope.decode(message.data as Uint8Array);
  return [...(scope.mutations?.keys() ?? [])];
}

test("rehydrateGameConnection rebuilds observers and routes framed pushes to the right sockets", async () => {
  const ecs = makeWorld();

  // A viewer entity at the origin for the AOI socket to filter around.
  const viewerId = crypto.randomUUID();
  ecs.insert({ id: viewerId, position: { x: 0, y: 0 } } as Entity);

  // Socket 1: global observer (no viewer → sees every mutation).
  const global = makeFakeWs();
  const globalMsgId = crypto.randomUUID();
  global.ws.serializeAttachment({
    sub: { messageId: globalMsgId, methodId: 11, viewerId: undefined },
  });
  rehydrateGameConnection(ecs, global.ws);

  // Socket 2: AOI observer around `viewerId`.
  const aoi = makeFakeWs();
  const aoiMsgId = crypto.randomUUID();
  aoi.ws.serializeAttachment({ sub: { messageId: aoiMsgId, methodId: 22, viewerId } });
  rehydrateGameConnection(ecs, aoi.ws);

  expect(ecs.observerCount).toBe(2);

  const near = crypto.randomUUID(); // inside the viewer's AOI
  const far = crypto.randomUUID(); // outside the viewer's AOI
  await ecs.withScope(() => {
    ecs.insert({ id: near, position: { x: 5, y: 5 } } as Entity);
    ecs.insert({ id: far, position: { x: 9999, y: 9999 } } as Entity);
  });

  // Global socket: a single frame (its messageId) carrying BOTH inserts.
  expect(global.sent.length).toBe(1);
  expect(Message.decode(global.sent[0]).messageId).toBe(globalMsgId);
  expect(Message.decode(global.sent[0]).status).toBe(TempoStatusCode.OK);
  const globalKeys = frameKeys(global.sent[0]);
  expect(globalKeys).toContain(near);
  expect(globalKeys).toContain(far);

  // AOI socket: a single frame (its messageId) carrying ONLY the near insert.
  expect(aoi.sent.length).toBe(1);
  expect(Message.decode(aoi.sent[0]).messageId).toBe(aoiMsgId);
  const aoiKeys = frameKeys(aoi.sent[0]);
  expect(aoiKeys).toContain(near);
  expect(aoiKeys).not.toContain(far);
});

test("rehydrateGameConnection is a no-op for a socket without a persisted subscription", () => {
  const ecs = makeWorld();
  const { ws } = makeFakeWs(); // attachment is null
  rehydrateGameConnection(ecs, ws);
  expect(ecs.observerCount).toBe(0);
});
