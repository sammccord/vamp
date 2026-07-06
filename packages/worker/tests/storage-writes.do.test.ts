import { beforeEach, describe, expect, it, vi } from "vitest";

// The real `y-durablestream` imports the workerd-only `cloudflare:workers`
// module, which the vite alias (see vite.config.ts) only rewrites for
// vite-transformed code — not the externalized node_modules copy. So, exactly as
// `ecs-do-lifecycle.do.test.ts` does for `YStreamClient`, we mock the package to
// let the real `ECSStorage` load under plain Node.
//
// The fake `YStreamProvider` base keeps a REAL `Y.Doc` and wires a REAL doc
// `update` observer, so the methods under test run against genuine yjs
// transaction/observer semantics; only the persist/broadcast transport (which is
// y-durablestream's own tested concern) is stubbed — counted via `updateCount`,
// which equals the number of doc `update` events the base would persist +
// broadcast. This proves each mutation fires exactly one, and a no-op fires none.
vi.mock("y-durablestream", async () => {
  const Yjs = await import("yjs");
  class YStreamProvider {
    protected doc = new Yjs.Doc();
    /** doc `update` events == persist/broadcast triggers the base would fire. */
    updateCount = 0;
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {
      this.doc.on("update", () => {
        this.updateCount++;
      });
    }
  }
  return {
    YStreamProvider,
    DurableObjectSqlStorage: class {},
    DurableObjectKvStorage: class {},
    DEFAULT_MAX_BYTES: 10240,
    DEFAULT_MAX_UPDATES: 500,
  };
});

// Imported AFTER vi.mock so `ECSStorage` extends the mocked base.
const { ECSStorage } = await import("../src/storage.ts");

interface Counting {
  updateCount: number;
}

function makeStorage() {
  const storage = new ECSStorage(undefined as never, undefined as never);
  const counted = storage as unknown as Counting;
  const read = (id: string) => storage.entity(id) as Record<string, unknown> | undefined;
  const ids = () => (storage.entities() as Array<{ id: string }>).map((e) => e.id).sort();
  return { storage, counted, read, ids };
}

describe("ECSStorage write methods", () => {
  let h: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    h = makeStorage();
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
    const before = h.counted.updateCount;
    h.storage.putEntity({ id: "e2", hp: 5 });
    expect(h.counted.updateCount).toBe(before + 1);
  });

  it("putEntities writes the whole batch in one transaction (one persist)", () => {
    const before = h.counted.updateCount;
    h.storage.putEntities([
      { id: "a", hp: 1 },
      { id: "b", hp: 2 },
      { id: "c", hp: 3 },
    ]);
    expect(h.counted.updateCount).toBe(before + 1); // single update event for the batch
    expect(h.ids()).toEqual(["a", "b", "c"]);
  });

  it("putEntities validates up front — a bad record aborts before any write", () => {
    const before = h.counted.updateCount;
    expect(() => h.storage.putEntities([{ id: "ok" }, { hp: 1 }])).toThrow(/string id/);
    expect(h.counted.updateCount).toBe(before); // nothing persisted
    expect(h.read("ok")).toBeUndefined(); // no partial write
  });

  it("removeEntity returns whether it existed and skips the no-op delete", () => {
    h.storage.putEntity({ id: "e1", hp: 10 });
    expect(h.storage.removeEntity("e1")).toBe(true);
    expect(h.read("e1")).toBeUndefined();

    const before = h.counted.updateCount;
    expect(h.storage.removeEntity("nope")).toBe(false);
    expect(h.counted.updateCount).toBe(before); // no transact, no broadcast on a miss
  });

  it("updateEntity applies a delta (undefined deletes) and no-ops on a miss", () => {
    h.storage.putEntity({ id: "u1", hp: 10, mp: 5 });
    expect(h.storage.updateEntity("u1", { hp: 12, mp: undefined })).toBe(true);
    expect(h.read("u1")).toEqual({ id: "u1", hp: 12 });

    const before = h.counted.updateCount;
    expect(h.storage.updateEntity("ghost", { hp: 1 })).toBe(false);
    expect(h.counted.updateCount).toBe(before);
  });

  it("removeEntities returns the count removed in one transaction", () => {
    h.storage.putEntities([{ id: "x" }, { id: "y" }, { id: "z" }]);
    const before = h.counted.updateCount;
    expect(h.storage.removeEntities(["x", "y", "missing"])).toBe(2);
    expect(h.counted.updateCount).toBe(before + 1);
    expect(h.ids()).toEqual(["z"]);
    expect(h.storage.removeEntities(["missing"])).toBe(0); // no persist
  });
});
