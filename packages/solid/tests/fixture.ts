import { type ECSOptions, MutationRecord } from "@vamp/ecs";
import type { WireBatch } from "../src/types.ts";

/** A tiny entity for headless tests: `hp` is additive (pool-like), `faction` replaces. */
export interface TestEntity {
  id?: string;
  tags?: number[];
  hp?: number;
  faction?: number;
}

export type TestDelta = {
  id?: string;
  tags?: number[];
  hp?: number;
  faction?: number;
};

export const components = { id: 1, hp: 2, faction: 3 } as const;

export function materializeDelta(delta: TestDelta, base?: Partial<TestEntity>): TestEntity {
  return {
    id: delta.id ?? base?.id ?? "",
    tags: delta.tags ?? base?.tags ?? [],
    hp: (base?.hp ?? 0) + (delta.hp ?? 0),
    faction: delta.faction ?? base?.faction,
  };
}

export function mergeDelta(entity: TestEntity, delta: TestDelta): void {
  if (delta.id !== undefined) entity.id = delta.id;
  if (delta.tags !== undefined) entity.tags = delta.tags;
  if (delta.hp !== undefined) entity.hp = (entity.hp ?? 0) + delta.hp; // additive
  if (delta.faction !== undefined) entity.faction = delta.faction; // replace
}

export function accumulateDelta(from: TestDelta, to: TestDelta): TestDelta {
  if (from.id !== undefined) to.id = from.id;
  if (from.tags !== undefined) to.tags = from.tags;
  if (from.hp !== undefined) to.hp = (to.hp ?? 0) + from.hp;
  if (from.faction !== undefined) to.faction = from.faction;
  return to;
}

export function options(): ECSOptions<TestEntity, TestDelta> {
  let n = 0;
  return {
    createId: () => `gen${n++}`,
    components: components as unknown as Record<Exclude<keyof TestEntity, "tags">, number>,
    materializeDelta,
    mergeDelta,
    accumulateDelta,
  };
}

export function insert(entity: TestEntity): MutationRecord<TestEntity, TestDelta> {
  return MutationRecord.fromInsert<TestEntity, TestDelta>({ entity });
}
export function update(delta: TestDelta): MutationRecord<TestEntity, TestDelta> {
  return MutationRecord.fromUpdate<TestEntity, TestDelta>({ delta });
}
export function del(entity: TestEntity): MutationRecord<TestEntity, TestDelta> {
  return MutationRecord.fromDelete<TestEntity, TestDelta>({ entity });
}

export function frame(
  ...records: Array<[string, MutationRecord<TestEntity, TestDelta>]>
): WireBatch<TestEntity, TestDelta> {
  return { mutations: new Map(records) };
}
