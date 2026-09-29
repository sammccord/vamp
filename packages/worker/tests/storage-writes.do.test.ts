import type { BaseEntity } from "@vampgg/ecs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ECSStorage } from "../src/storage.ts";

type TestEntity = BaseEntity & { hp?: number; mp?: number; pos?: { x: number; y: number } };

/**
 * A `DurableObjectState` whose SQL storage is a real in-memory SQLite database,
 * so the provider's own `DurableObjectSqlStorage` persists each doc update as a
 * `yjs_updates` row exactly as it would in workerd.
 */
function makeCtx() {
  const db = new DatabaseSync(":memory:");
  let started: Promise<unknown> = Promise.resolve();
  const toInput = (v: ArrayBuffer | number): SQLInputValue =>
    v instanceof ArrayBuffer ? new Uint8Array(v) : v;
  const sql = {
    exec(query: string, ...bindings: (ArrayBuffer | number)[]) {
      if (bindings.length === 0 && !/^\s*SELECT/i.test(query)) {
        db.exec(query);
        return { toArray: () => [], one: () => undefined };
      }
      const stmt = db.prepare(query);
      if (!/^\s*SELECT/i.test(query)) {
        stmt.run(...bindings.map(toInput));
        return { toArray: () => [], one: () => undefined };
      }
      const rows = stmt.all(...bindings.map(toInput));
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  const ctx = {
    storage: {
      sql,
      transactionSync<T>(fn: () => T): T {
        db.exec("BEGIN");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      },
      async get(_key: string) {
        return undefined;
      },
    },
    waitUntil(_promise: Promise<unknown>) {},
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const p = fn();
      started = p;
      return p;
    },
  };
  const persistedUpdates = () =>
    Number(db.prepare("SELECT COUNT(*) AS n FROM yjs_updates").get()?.n);
  return { ctx, started: () => started, persistedUpdates };
}

async function makeStorage() {
  const fake = makeCtx();
  // SAFETY: `ECSStorage` and its `YStreamProvider` base touch only `storage.sql`,
  // `storage.transactionSync`, `storage.get`, `waitUntil` and
  // `blockConcurrencyWhile` on the state, all of which the fake implements.
  const storage = new ECSStorage<TestEntity>(
    fake.ctx as ConstructorParameters<typeof ECSStorage>[0],
    {},
  );
  await fake.started();
  const read = (id: string) => storage.entity(id);
  const ids = () =>
    storage
      .entities()
      .flatMap((e) => e.id ?? [])
      .sort();
  return { storage, persistedUpdates: fake.persistedUpdates, read, ids };
}

describe("ECSStorage write methods", () => {
  let h: Awaited<ReturnType<typeof makeStorage>>;

  beforeEach(async () => {
    h = await makeStorage();
  });

  it("putEntity stores components and reads back with id backfilled", () => {
    h.storage.putEntity({ id: "e1", hp: 10, pos: { x: 1, y: 2 } });
    expect(h.read("e1")).toEqual({ id: "e1", hp: 10, pos: { x: 1, y: 2 } });
    expect(h.ids()).toEqual(["e1"]);
  });

  it("putEntity requires a non-empty string id", () => {
    expect(() => h.storage.putEntity({ hp: 1 })).toThrow(/string id/);
    expect(() => h.storage.putEntity({ id: "", hp: 1 })).toThrow(/string id/);
  });

  it("putEntity fires exactly one persist/broadcast", () => {
    const before = h.persistedUpdates();
    h.storage.putEntity({ id: "e2", hp: 5 });
    expect(h.persistedUpdates()).toBe(before + 1);
  });

  it("putEntities writes the whole batch in one transaction (one persist)", () => {
    const before = h.persistedUpdates();
    h.storage.putEntities([
      { id: "a", hp: 1 },
      { id: "b", hp: 2 },
      { id: "c", hp: 3 },
    ]);
    expect(h.persistedUpdates()).toBe(before + 1); // single update event for the batch
    expect(h.ids()).toEqual(["a", "b", "c"]);
  });

  it("putEntities validates up front — a bad record aborts before any write", () => {
    const before = h.persistedUpdates();
    expect(() => h.storage.putEntities([{ id: "ok" }, { hp: 1 }])).toThrow(/string id/);
    expect(h.persistedUpdates()).toBe(before); // nothing persisted
    expect(h.read("ok")).toBeUndefined(); // no partial write
  });

  it("removeEntity returns whether it existed and skips the no-op delete", () => {
    h.storage.putEntity({ id: "e1", hp: 10 });
    expect(h.storage.removeEntity("e1")).toBe(true);
    expect(h.read("e1")).toBeUndefined();

    const before = h.persistedUpdates();
    expect(h.storage.removeEntity("nope")).toBe(false);
    expect(h.persistedUpdates()).toBe(before); // no transact, no broadcast on a miss
  });

  it("updateEntity applies a delta (undefined deletes) and no-ops on a miss", () => {
    h.storage.putEntity({ id: "u1", hp: 10, mp: 5 });
    expect(h.storage.updateEntity("u1", { hp: 12, mp: undefined })).toBe(true);
    expect(h.read("u1")).toEqual({ id: "u1", hp: 12 });

    const before = h.persistedUpdates();
    expect(h.storage.updateEntity("ghost", { hp: 1 })).toBe(false);
    expect(h.persistedUpdates()).toBe(before);
  });

  it("removeEntities returns the count removed in one transaction", () => {
    h.storage.putEntities([{ id: "x" }, { id: "y" }, { id: "z" }]);
    const before = h.persistedUpdates();
    expect(h.storage.removeEntities(["x", "y", "missing"])).toBe(2);
    expect(h.persistedUpdates()).toBe(before + 1);
    expect(h.ids()).toEqual(["z"]);
    expect(h.storage.removeEntities(["missing"])).toBe(0); // no persist
  });
});
