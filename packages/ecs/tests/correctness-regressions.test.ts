import { describe, expect, it } from "vitest";
import {
  createBaseMutator,
  createBehavior,
  createEntitySystem,
  createEventSystem,
  ECS,
  type ECSOptions,
  type MutationBatch,
  query,
  type QueryBuilder,
} from "../src/index.ts";

interface Entity {
  id?: string;
  tags?: number[];
  hp?: number;
  mp?: number;
}
type Delta = { id?: string; tags?: number[]; hp?: number; mp?: number };
type Action = { tag: number; value: unknown };
type World = ECS<{}, [], Action, number, Entity, Delta>;

const components = { id: 1, hp: 2, mp: 3 };

function createWorld() {
  let n = 0;
  const options: ECSOptions<Entity, Delta> = {
    createId: () => `gen${n++}`,
    components,
    materializeDelta: (delta: Delta, base?: Partial<Entity>): Entity => ({ ...base, ...delta }),
    mergeDelta: (entity: Entity, delta: Delta): void => {
      if (delta.hp !== undefined) entity.hp = (entity.hp ?? 0) + delta.hp;
      if (delta.mp !== undefined) entity.mp = (entity.mp ?? 0) + delta.mp;
    },
    accumulateDelta: (from: Delta, to: Delta): Delta => {
      if (from.hp !== undefined) to.hp = (to.hp ?? 0) + from.hp;
      if (from.mp !== undefined) to.mp = (to.mp ?? 0) + from.mp;
      return to;
    },
  };
  const entities = new Map<string, Entity>();
  const world: World = new ECS(entities, createBaseMutator(entities, options), {}, options);
  world.initialize();
  return { world, entities };
}

const withHp = (q: QueryBuilder) => q.every(components.hp);

describe("aborted scopes", () => {
  it("roll back archetype membership of an insert", async () => {
    const { world } = createWorld();
    await world
      .withScope(() => {
        world.insert({ id: "x", hp: 1 });
        throw new Error("boom");
      })
      .catch(() => {});
    expect(world.hasEntity("x")).toBe(false);
    expect(world.query(withHp)).toEqual([]);
  });

  it("roll back a delete", async () => {
    const { world } = createWorld();
    world.insert({ id: "y", hp: 1 });
    await world
      .withScope(() => {
        world.delete({ id: "y" });
        throw new Error("boom");
      })
      .catch(() => {});
    expect(world.hasEntity("y")).toBe(true);
    expect(world.query(withHp)).toEqual(["y"]);
  });

  it("roll back a component change", async () => {
    const { world } = createWorld();
    world.insert({ id: "z", hp: 1 });
    await world
      .withScope(() => {
        world.put("z", { mp: 5 });
        throw new Error("boom");
      })
      .catch(() => {});
    expect(world.hasComponent("z", "mp")).toBe(false);
  });
});

describe("reads inside a scope", () => {
  it("see staged updates to entities that existed before the scope", async () => {
    const { world } = createWorld();
    world.insert({ id: "a", hp: 10 });
    let seen: number | undefined;
    await world.withScope(() => {
      world.put("a", { hp: -5 });
      seen = world.entity("a")?.hp;
      world.put("a", { hp: -1 });
    });
    expect(seen).toBe(5);
    expect(world.entity("a")?.hp).toBe(4);
  });

  it("see a parent scope's staged updates from a nested scope", async () => {
    const { world } = createWorld();
    world.insert({ id: "a", hp: 10 });
    let seen: number | undefined;
    await world.withScope(async () => {
      world.put("a", { hp: -3 });
      await world.withScope(() => {
        world.put("a", { hp: -1 });
        seen = world.entity("a")?.hp;
      });
    });
    expect(seen).toBe(6);
    expect(world.entity("a")?.hp).toBe(6);
  });
});

describe("behaviors", () => {
  it("run for an entity inserted earlier in the same scope", async () => {
    const { world } = createWorld();
    let runs = 0;
    world.registerBehavior(
      createBehavior<{}, [], Action, number, Entity, Delta>(1, () => void runs++, withHp),
    );
    await world.withScope(async () => {
      world.insert({ id: "a", hp: 1 });
      await world.act("a", { tag: 1, value: undefined });
    });
    await world.act("a", { tag: 1, value: undefined });
    expect(runs).toBe(2);
  });
});

describe("registration", () => {
  it("a second unsubscribe is a no-op", () => {
    const { world } = createWorld();
    const a = createEntitySystem<{}, [], Action, number, Entity, Delta>(() => {}, withHp);
    const b = createEntitySystem<{}, [], Action, number, Entity, Delta>(() => {}, withHp);
    const offA = world.registerSystem(a);
    world.registerSystem(b);
    offA();
    offA();
    expect(world.systems).toEqual([b]);
  });

  it("rejects a system already registered with another world", () => {
    const system = createEntitySystem<{}, [], Action, number, Entity, Delta>(() => {}, withHp);
    createWorld().world.registerSystem(system);
    expect(() => createWorld().world.registerSystem(system)).toThrow(/another ECS world/);
  });
});

describe("entity writes", () => {
  it("inserting an existing id replaces the entity and its archetype", () => {
    const { world } = createWorld();
    world.insert({ id: "d", hp: 1 });
    world.insert({ id: "d", mp: 1 });
    expect(world.entity("d")).toEqual({ id: "d", mp: 1 });
    expect(world.query(withHp)).toEqual([]);
  });

  it("put with an undefined key adds no component unless mutating", () => {
    const { world } = createWorld();
    world.insert({ id: "a", hp: 1, mp: 1 });
    world.put("a", { hp: undefined });
    expect(world.hasComponent("a", "hp")).toBe(true);
    world.put("a", { mp: undefined }, true);
    expect(world.hasComponent("a", "mp")).toBe(false);
    world.insert({ id: "b", hp: 1 });
    world.put("b", { mp: undefined });
    expect(world.hasComponent("b", "mp")).toBe(false);
  });
});

describe("queries", () => {
  it("or() ORs the whole sub-query, not each of its terms", () => {
    const { world } = createWorld();
    const bare = world.prefabricate([20]);
    const q = query((b: QueryBuilder) =>
      b.every(components.hp).or((s: QueryBuilder) => s.every(components.mp).not(30)),
    );
    expect(q.tryAdd(bare, false)).toBe(false);
  });

  it("none() excludes only archetypes holding every listed component", () => {
    const { world } = createWorld();
    world.insert({ id: "both", hp: 1, mp: 1 });
    world.insert({ id: "one", hp: 1 });
    const ids = world.query((q: QueryBuilder) => q.none(components.hp, components.mp));
    expect(ids).toContain("one");
    expect(ids).not.toContain("both");
  });
});

describe("update()", () => {
  it("runs each deferred action once even when one throws", () => {
    const { world } = createWorld();
    let calls = 0;
    let after = 0;
    world.defer(() => {
      calls++;
      throw new Error("deferred boom");
    });
    world.defer(() => void after++);
    expect(() => world.update()).toThrow("deferred boom");
    world.update();
    expect([calls, after]).toEqual([1, 1]);
  });

  it("does not process an entity twice when a system moves it to a later archetype", () => {
    const { world } = createWorld();
    const visits = new Map<string, number>();
    world.registerSystem(
      createEntitySystem<{}, [], Action, number, Entity, Delta>((ids: string[], w: World) => {
        for (const id of ids) {
          visits.set(id, (visits.get(id) ?? 0) + 1);
          if (!w.hasComponent(id, "mp")) w.put(id, { mp: 1 });
        }
      }, withHp),
    );
    world.insert({ id: "a", hp: 1 });
    world.update();
    expect(visits.get("a")).toBe(1);
  });
});

describe("cost of reactive paths", () => {
  it("event systems receive only the ids that changed", () => {
    const { world } = createWorld();
    let handed = 0;
    world.subscribe(createEventSystem((ids: string[]) => void (handed += ids.length), withHp));
    for (let i = 0; i < 1000; i++) world.insert({ id: `e${i}`, hp: 1 });
    expect(handed).toBe(1000);
  });

  it("subscribe(system, true) still emits every current match once", () => {
    const { world } = createWorld();
    world.insert({ id: "a", hp: 1 });
    world.insert({ id: "b", hp: 1 });
    const seen: string[][] = [];
    world.subscribe(
      createEventSystem((ids: string[]) => void seen.push([...ids]), withHp),
      true,
    );
    expect(seen.map((ids) => ids.sort((x, y) => x.localeCompare(y)))).toEqual([["a", "b"]]);
  });

  it("an observer interested in a whole batch receives the batch itself", async () => {
    const { world } = createWorld();
    const delivered: MutationBatch<Entity, Delta>[] = [];
    world.observeMutations({
      interested: () => true,
      deliver: (b: MutationBatch<Entity, Delta>) => void delivered.push(b),
    });
    world.observeMutations({
      interested: () => true,
      deliver: (b: MutationBatch<Entity, Delta>) => void delivered.push(b),
    });
    const { mutations } = await world.withScope(() => {
      world.insert({ id: "a", hp: 1 });
      world.insert({ id: "b", hp: 1 });
    });
    expect(delivered).toEqual([mutations, mutations]);
    expect(delivered[0]).toBe(mutations);
  });
});
