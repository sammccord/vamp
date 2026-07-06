import { beforeEach, describe, expect, it } from "vitest";
import type { YDocStorage } from "y-durablestream";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";

import { ECSStorage } from "../src/storage.ts";

// The ECSStorage write methods (`putEntity`/`removeEntity`/`updateEntity`/
// `putEntities`/`removeEntities`) transact directly on the provider's
// authoritative `doc`; the base `YStreamProvider` doc `update` observer then
// persists (`storage.storeUpdate`) and broadcasts. We exercise the real methods
// under plain Node by swapping the SQLite-backed storage for an in-memory
// `YDocStorage` (so no workerd is needed) and counting `storeUpdate` calls to
// prove the persist/broadcast trigger fires exactly once per mutation — and not
// at all on a no-op.

class MemStorage implements YDocStorage {
  /** Number of persisted updates == number of doc `update` events fired. */
  updateCount = 0;
  private snapshot = new Doc();

  async getYDoc(): Promise<Doc> {
    const d = new Doc();
    applyUpdate(d, encodeStateAsUpdate(this.snapshot));
    return d;
  }
  async storeUpdate(update: Uint8Array): Promise<void> {
    this.updateCount++;
    applyUpdate(this.snapshot, update);
  }
  async commit(doc: Doc): Promise<void> {
    this.snapshot = new Doc();
    applyUpdate(this.snapshot, encodeStateAsUpdate(doc));
  }
}

/** Storage provider wired to the in-memory backend passed via `env.mem`. */
class TestStorage extends ECSStorage {
  protected override createStorage(): YDocStorage {
    // `createStorage()` runs inside `super()` before subclass fields are set, so
    // the backend must arrive via `env` (assigned by the DurableObject base ctor).
    return (this.env as { mem: MemStorage }).mem;
  }
}

function makeStorage() {
  const mem = new MemStorage();
  const waited: Promise<unknown>[] = [];
  let onStart: Promise<unknown> = Promise.resolve();
  const ctx = {
    // Only `.get` is touched by `onStart` (persisted subscriber registry).
    storage: { get: async () => undefined },
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      onStart = Promise.resolve().then(fn);
      return onStart;
    },
  };
  const storage = new TestStorage(ctx as never, { mem } as never);
  // Flush the `waitUntil`-scheduled persists so `mem.updateCount` is settled.
  const flush = () => Promise.all(waited.splice(0));
  const read = (id: string) => storage.entity(id) as Record<string, unknown> | undefined;
  const ids = () => (storage.entities() as Array<{ id: string }>).map((e) => e.id).sort();
  return { storage, mem, flush, read, ids, ready: () => onStart };
}

describe("ECSStorage write methods", () => {
  let h: ReturnType<typeof makeStorage>;

  beforeEach(async () => {
    h = makeStorage();
    await h.ready(); // gate on onStart, as blockConcurrencyWhile does at runtime
  });

  it("putEntity stores components and reads back with id backfilled", async () => {
    h.storage.putEntity({ id: "e1", hp: 10, pos: { x: 1, y: 2 } });
    await h.flush();
    expect(h.read("e1")).toEqual({ id: "e1", hp: 10, pos: { x: 1, y: 2 } });
    expect(h.ids()).toEqual(["e1"]);
  });

  it("putEntity requires a non-empty string id", () => {
    expect(() => h.storage.putEntity({ hp: 1 })).toThrow(/string id/);
    expect(() => h.storage.putEntity({ id: "", hp: 1 })).toThrow(/string id/);
  });

  it("putEntity fires exactly one persist/broadcast", async () => {
    const before = h.mem.updateCount;
    h.storage.putEntity({ id: "e2", hp: 5 });
    await h.flush();
    expect(h.mem.updateCount).toBe(before + 1);
  });

  it("putEntities writes the whole batch in one transaction (one persist)", async () => {
    const before = h.mem.updateCount;
    h.storage.putEntities([
      { id: "a", hp: 1 },
      { id: "b", hp: 2 },
      { id: "c", hp: 3 },
    ]);
    await h.flush();
    expect(h.mem.updateCount).toBe(before + 1); // single update event for the batch
    expect(h.ids()).toEqual(["a", "b", "c"]);
  });

  it("putEntities validates up front — a bad record aborts before any write", async () => {
    const before = h.mem.updateCount;
    expect(() => h.storage.putEntities([{ id: "ok" }, { hp: 1 }])).toThrow(/string id/);
    await h.flush();
    expect(h.mem.updateCount).toBe(before); // nothing persisted
    expect(h.read("ok")).toBeUndefined(); // no partial write
  });

  it("removeEntity returns whether it existed and skips the no-op delete", async () => {
    h.storage.putEntity({ id: "e1", hp: 10 });
    await h.flush();
    expect(h.storage.removeEntity("e1")).toBe(true);
    expect(h.read("e1")).toBeUndefined();

    const before = h.mem.updateCount;
    expect(h.storage.removeEntity("nope")).toBe(false);
    await h.flush();
    expect(h.mem.updateCount).toBe(before); // no transact, no broadcast on a miss
  });

  it("updateEntity applies a delta (undefined deletes) and no-ops on a miss", async () => {
    h.storage.putEntity({ id: "u1", hp: 10, mp: 5 });
    await h.flush();
    expect(h.storage.updateEntity("u1", { hp: 12, mp: undefined })).toBe(true);
    expect(h.read("u1")).toEqual({ id: "u1", hp: 12 });

    const before = h.mem.updateCount;
    expect(h.storage.updateEntity("ghost", { hp: 1 })).toBe(false);
    await h.flush();
    expect(h.mem.updateCount).toBe(before);
  });

  it("removeEntities returns the count removed in one transaction", async () => {
    h.storage.putEntities([{ id: "x" }, { id: "y" }, { id: "z" }]);
    await h.flush();
    const before = h.mem.updateCount;
    expect(h.storage.removeEntities(["x", "y", "missing"])).toBe(2);
    await h.flush();
    expect(h.mem.updateCount).toBe(before + 1);
    expect(h.ids()).toEqual(["z"]);
    expect(h.storage.removeEntities(["missing"])).toBe(0); // no persist
  });
});
