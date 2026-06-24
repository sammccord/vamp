import { describe, expect, it } from "vitest";
import {
  ECS,
  type ECSOptions,
  type EntityMutator,
  MutationRecord,
  MutationType,
  type QueryBuilder,
} from "../src/index.ts";

interface Entity {
  id?: string;
  tags?: number[];
  hp?: number;
  faction?: number;
}
type EntityDelta = { id?: string; tags?: number[]; hp?: number; faction?: number };

const components = { id: 1, hp: 2, faction: 3 };

function materializeDelta(delta: EntityDelta, base?: Partial<Entity>): Entity {
  return {
    id: delta.id ?? base?.id ?? "",
    tags: delta.tags ?? base?.tags ?? [],
    hp: (base?.hp ?? 0) + (delta.hp ?? 0),
    faction: delta.faction ?? base?.faction,
  };
}
function mergeDelta(entity: Entity, delta: EntityDelta): void {
  if (delta.id !== undefined) entity.id = delta.id;
  if (delta.tags !== undefined) entity.tags = delta.tags;
  if (delta.hp !== undefined) entity.hp = (entity.hp ?? 0) + delta.hp; // additive
  if (delta.faction !== undefined) entity.faction = delta.faction; // replace
}
function accumulateDelta(from: EntityDelta, to: EntityDelta): EntityDelta {
  if (from.hp !== undefined) to.hp = (to.hp ?? 0) + from.hp;
  if (from.faction !== undefined) to.faction = from.faction;
  return to;
}

function createWorld() {
  const entities = new Map<string, Entity>();
  const mutate: EntityMutator<Entity, EntityDelta> = (
    id: string,
    mutation: MutationRecord<Entity, EntityDelta>,
  ) => {
    switch (mutation.tag) {
      case MutationType.Insert:
        entities.set(id, mutation.value.entity);
        return;
      case MutationType.Update: {
        const entity = entities.get(id);
        if (!entity) entities.set(id, materializeDelta(mutation.value.delta, { id }));
        else mergeDelta(entity, mutation.value.delta);
        return;
      }
      case MutationType.Delete:
        entities.delete(id);
    }
  };
  const options: ECSOptions<Entity, EntityDelta> = {
    createId: () => crypto.randomUUID(),
    components: components as unknown as Record<Exclude<keyof Entity, "tags">, number>,
    materializeDelta,
    mergeDelta,
    accumulateDelta,
  };
  const world = new ECS(entities, mutate, {}, options);
  world.initialize();
  return world;
}

const insert = (entity: Entity): MutationRecord<Entity, EntityDelta> =>
  MutationRecord.fromInsert<Entity, EntityDelta>({ entity });
const update = (delta: EntityDelta): MutationRecord<Entity, EntityDelta> =>
  MutationRecord.fromUpdate<Entity, EntityDelta>({ delta });
const del = (entity: Entity): MutationRecord<Entity, EntityDelta> =>
  MutationRecord.fromDelete<Entity, EntityDelta>({ entity });

describe("ECS.applyMutations", () => {
  it("ingests insert, additive update, and delete", async () => {
    const world = createWorld();

    await world.withScope(() =>
      world.applyMutations(new Map([["a", insert({ id: "a", hp: 100, tags: [] })]])),
    );
    expect(world.entity("a")?.hp).toBe(100);

    await world.withScope(() => world.applyMutations(new Map([["a", update({ hp: -30 })]])));
    expect(world.entity("a")?.hp).toBe(70); // additive mergeDelta ran

    await world.withScope(() => world.applyMutations(new Map([["a", del({ id: "a" })]])));
    expect(world.hasEntity("a")).toBe(false);
  });

  it("is the inverse of snapshotMutations — a snapshot round-trips into a fresh world", async () => {
    const source = createWorld();
    await source.withScope(() =>
      source.applyMutations(
        new Map([
          ["a", insert({ id: "a", hp: 70, tags: [] })],
          ["b", insert({ id: "b", hp: 5, tags: [], faction: 2 })],
        ]),
      ),
    );

    const snapshot = source.snapshotMutations(() => true);

    const replica = createWorld();
    await replica.withScope(() => replica.applyMutations(snapshot));

    expect(replica.entity("a")?.hp).toBe(70);
    expect(replica.entity("b")?.faction).toBe(2);
    expect(replica.query((q: QueryBuilder) => q.every(components.faction))).toEqual(["b"]);
  });

  it("replaces an existing entity on Insert (authoritative re-sync, not additive)", async () => {
    const world = createWorld();
    await world.withScope(() =>
      world.applyMutations(new Map([["a", insert({ id: "a", hp: 100, tags: [] })]])),
    );
    await world.withScope(() =>
      world.applyMutations(new Map([["a", insert({ id: "a", hp: 5, tags: [] })]])),
    );
    expect(world.entity("a")?.hp).toBe(5);
  });
});
