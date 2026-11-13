import { describe, expect, it } from "vitest";
import {
  createBaseMutator,
  createLifecycleSystem,
  ECS,
  type ECSOptions,
  type MutationBatch,
  MutationRecord,
  type MutationScope,
  type QueryBuilder,
} from "../src/index.ts";

interface Entity {
  id?: string;
  tags?: number[];
  hp?: number;
  mp?: number;
}
type Delta = { id?: string; tags?: number[]; hp?: number; mp?: number };

const components = { id: 1, hp: 2, mp: 3 };

const options: ECSOptions<Entity, Delta> = {
  createId: (() => {
    let n = 0;
    return () => `gen${n++}`;
  })(),
  components,
  materializeDelta: (delta: Delta, base?: Partial<Entity>): Entity => {
    const out: Entity = { ...base };
    if (delta.id !== undefined) out.id = delta.id;
    if (delta.hp !== undefined) out.hp = (out.hp ?? 0) + delta.hp;
    if (delta.mp !== undefined) out.mp = (out.mp ?? 0) + delta.mp;
    if (delta.tags !== undefined) out.tags = delta.tags;
    return out;
  },
  mergeDelta: (entity: Entity, delta: Delta): void => {
    if (delta.hp !== undefined) entity.hp = (entity.hp ?? 0) + delta.hp;
    if (delta.mp !== undefined) entity.mp = (entity.mp ?? 0) + delta.mp;
    if (delta.tags !== undefined) entity.tags = delta.tags;
  },
  accumulateDelta: (from: Delta, to: Delta): Delta => {
    if (from.hp !== undefined) to.hp = (to.hp ?? 0) + from.hp;
    if (from.mp !== undefined) to.mp = (to.mp ?? 0) + from.mp;
    if (from.tags !== undefined) to.tags = from.tags;
    return to;
  },
};

function createWorld() {
  const entities = new Map<string, Entity>();
  const world = new ECS<{}, [], { tag: number; value: unknown }, number, Entity, Delta>(
    entities,
    createBaseMutator(entities, options),
    {},
    options,
  );
  world.initialize();
  return { world, entities };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mutation scope coalescing", () => {
  it("accumulates every update to one entity in a scope", async () => {
    const { world, entities } = createWorld();
    world.insert({ id: "a", hp: 10 });
    const { mutations } = await world.withScope(() => {
      world.put("a", { hp: -1 });
      world.put("a", { hp: -2 });
    });
    expect(mutations.get("a")).toEqual(MutationRecord.fromUpdate({ delta: { hp: -3 } }));
    expect(entities.get("a")?.hp).toBe(7);
  });

  it("never writes through to the caller's delta object", async () => {
    const { world } = createWorld();
    world.insert({ id: "a", hp: 10 });
    const tick = { hp: -1 };
    await world.withScope(() => {
      world.put("a", tick);
      world.put("a", tick);
    });
    expect(tick).toEqual({ hp: -1 });
  });
});

describe("overlapping scopes", () => {
  it("commits both scopes and leaves no active scope behind", async () => {
    const { world, entities } = createWorld();
    world.insert({ id: "a", hp: 100 });
    world.insert({ id: "b", hp: 100 });
    const first = world.withScope(async () => {
      world.put("a", { hp: -1 });
      await sleep(10);
      world.put("a", { hp: -1 });
    });
    await sleep(2);
    const second = world.withScope(async () => {
      world.put("b", { hp: -1 });
      await sleep(30);
      world.put("b", { hp: -1 });
    });
    await Promise.all([first, second]);
    expect(entities.get("a")?.hp).toBe(98);
    expect(entities.get("b")?.hp).toBe(98);
    expect(world.context.scope).toBeUndefined();

    await world.withScope(() => world.put("a", { hp: -10 }));
    expect(entities.get("a")?.hp).toBe(88);
  });

  it("discards a failed overlapping scope without stranding its parent", async () => {
    const { world, entities } = createWorld();
    world.insert({ id: "a", hp: 100 });
    const first = world.withScope(async () => {
      world.put("a", { hp: -1 });
      await sleep(10);
    });
    await sleep(2);
    const second = world.withScope(async () => {
      world.put("a", { hp: -50 });
      throw new Error("boom");
    });
    await expect(second).rejects.toThrow("boom");
    await first;
    expect(entities.get("a")?.hp).toBe(99);
    expect(world.context.scope).toBeUndefined();
  });
});

describe("mutations outside a scope with a flush handler", () => {
  it("commits and broadcasts immediately", () => {
    const { world, entities } = createWorld();
    const flushed: MutationBatch<Entity, Delta>[] = [];
    world.setFlushHandler(
      (batch: MutationBatch<Entity, Delta>, scope?: MutationScope<Entity, Delta>) => {
        expect(scope).toBeUndefined();
        flushed.push(batch);
        for (const [id, m] of batch) if (m.tag === 1) entities.set(id, m.value.entity);
      },
    );
    const delivered: string[] = [];
    world.observeMutations({
      interested: () => true,
      deliver: (b: MutationBatch<Entity, Delta>) => delivered.push(...b.keys()),
    });
    world.insert({ id: "a", hp: 1 });
    expect(flushed).toHaveLength(1);
    expect(entities.has("a")).toBe(true);
    expect(delivered).toEqual(["a"]);
  });

  it("hands the committing scope to the flush handler", async () => {
    const { world } = createWorld();
    let seen: number | undefined;
    world.setFlushHandler(
      (_batch: MutationBatch<Entity, Delta>, scope?: MutationScope<Entity, Delta>) => {
        seen = scope?.shadowEntities.get("a")?.hp;
      },
    );
    await world.withScope(() => world.insert({ id: "a", hp: 4 }));
    expect(seen).toBe(4);
  });
});

describe("entity ids", () => {
  it("put on an unknown id inserts under that id", () => {
    const { world, entities } = createWorld();
    world.put("server-id", { hp: 5 });
    expect([...entities.keys()]).toEqual(["server-id"]);
  });

  it("generates an id for an empty-string id", () => {
    const { world, entities } = createWorld();
    world.insert({ id: "", hp: 1 });
    world.upsert({ hp: 2 }, () => false);
    expect(entities.has("")).toBe(false);
    expect(entities.size).toBe(2);
  });
});

describe("applyMutations Insert on an existing entity", () => {
  it("replaces in place: archetype follows the snapshot, no lifecycle churn", async () => {
    const { world } = createWorld();
    const lifecycle: string[] = [];
    world.onCreate(
      createLifecycleSystem(
        (id: string) => lifecycle.push(`create ${id}`),
        (q: QueryBuilder) => q,
      ),
    );
    world.onDelete(
      createLifecycleSystem(
        (id: string) => lifecycle.push(`delete ${id}`),
        (q: QueryBuilder) => q,
      ),
    );
    await world.withScope(() =>
      world.applyMutations(
        new Map([["a", MutationRecord.fromInsert({ entity: { id: "a", hp: 1, mp: 1 } })]]),
      ),
    );
    lifecycle.length = 0;
    await world.withScope(() =>
      world.applyMutations(
        new Map([["a", MutationRecord.fromInsert({ entity: { id: "a", hp: 9 } })]]),
      ),
    );
    expect(world.entity("a")).toEqual({ id: "a", hp: 9 });
    expect(world.query((q: QueryBuilder) => q.every(components.mp))).toEqual([]);
    expect(world.query((q: QueryBuilder) => q.every(components.hp))).toEqual(["a"]);
    expect(lifecycle).toEqual([]);
  });
});
