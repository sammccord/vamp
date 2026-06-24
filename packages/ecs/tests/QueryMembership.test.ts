/**
 * Unit tests for the framework-agnostic query-membership tracker. These pin the
 * membership semantics (seed, insert-in, transition-out, delete, untrack) that
 * the Solid `createQueryRegistry` — and any future UI binding — relies on.
 */
import { beforeEach, describe, expect, test } from "vite-plus/test";
import {
  createBaseMutator,
  createQueryMembershipTracker,
  ECS,
  type ECSOptions,
  MutationType,
} from "../src/index.ts";
import { query } from "../src/Query.ts";

type Entity = { id?: string; tags?: number[]; a?: number; b?: number };
type EntityDelta = Partial<Entity>;

const components = { id: 1, a: 2, b: 3 } as const;
const A = components.a;

function materializeDelta(delta: EntityDelta, base: Partial<Entity> = {}): Entity {
  return { ...base, ...delta } as Entity;
}
function mergeDelta(entity: Entity, delta: EntityDelta): void {
  Object.assign(entity, delta);
}
function accumulateDelta(from: EntityDelta, to: EntityDelta): EntityDelta {
  return { ...from, ...to };
}

type World = ECS<
  Record<string, unknown>,
  [],
  { tag: number; value: unknown },
  number,
  Entity,
  EntityDelta
>;

function makeWorld(): World {
  const entities = new Map<string, Entity>();
  const options: ECSOptions<Entity, EntityDelta> = {
    createId: () => `e_${entities.size}`,
    components,
    materializeDelta,
    mergeDelta,
    accumulateDelta,
  };
  const ecs: World = new ECS(entities, createBaseMutator(entities, options), {}, options);
  ecs.initialize();
  return ecs;
}

describe("createQueryMembershipTracker", () => {
  let world: World;

  beforeEach(() => {
    world = makeWorld();
  });

  test("track seeds members from the world's current matches", () => {
    world.insert({ id: "e1", a: 1 });
    world.insert({ id: "e2", b: 1 });
    const tracker = createQueryMembershipTracker(world);
    const tracked = tracker.track(query((b) => b.every(A)));
    expect([...tracked.members]).toEqual(["e1"]);
  });

  test("update adds a newly-inserted match and reports the change", () => {
    const tracker = createQueryMembershipTracker(world);
    const tracked = tracker.track(query((b) => b.every(A)));
    expect([...tracked.members]).toEqual([]);

    world.insert({ id: "e1", a: 1 });
    const changed = tracker.update(new Map([["e1", { tag: MutationType.Insert }]]));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toBe(tracked);
    expect(tracked.members.has("e1")).toBe(true);
  });

  test("update ignores a non-matching insert", () => {
    const tracker = createQueryMembershipTracker(world);
    const tracked = tracker.track(query((b) => b.every(A)));
    world.insert({ id: "e2", b: 1 });
    const changed = tracker.update(new Map([["e2", { tag: MutationType.Insert }]]));
    expect(changed).toHaveLength(0);
    expect(tracked.members.has("e2")).toBe(false);
  });

  test("update removes an entity that transitions OUT of the query (archetype change)", () => {
    world.insert({ id: "e1", a: 1 });
    const tracker = createQueryMembershipTracker(world);
    const tracked = tracker.track(query((b) => b.every(A)));
    expect(tracked.members.has("e1")).toBe(true);

    // Remove component `a`: the entity still exists but its new archetype no
    // longer matches `every(a)` — the case a `subscribe(Q)` event system misses.
    world.put("e1", { a: undefined } as EntityDelta, true);
    const changed = tracker.update(new Map([["e1", { tag: MutationType.Update }]]));
    expect(changed).toHaveLength(1);
    expect(tracked.members.has("e1")).toBe(false);
  });

  test("update removes a deleted entity", () => {
    world.insert({ id: "e1", a: 1 });
    const tracker = createQueryMembershipTracker(world);
    const tracked = tracker.track(query((b) => b.every(A)));
    expect(tracked.members.has("e1")).toBe(true);

    world.delete({ id: "e1" } as Entity);
    const changed = tracker.update(new Map([["e1", { tag: MutationType.Delete }]]));
    expect(changed).toHaveLength(1);
    expect(tracked.members.has("e1")).toBe(false);
  });

  test("untrack stops tracking and update returns nothing", () => {
    const tracker = createQueryMembershipTracker(world);
    const q = query((b) => b.every(A));
    tracker.track(q);
    tracker.untrack(q);
    world.insert({ id: "e1", a: 1 });
    expect(tracker.update(new Map([["e1", { tag: MutationType.Insert }]]))).toEqual([]);
  });

  test("update on an empty tracker is a no-op", () => {
    const tracker = createQueryMembershipTracker(world);
    world.insert({ id: "e1", a: 1 });
    expect(tracker.update(new Map([["e1", { tag: MutationType.Insert }]]))).toEqual([]);
  });
});
