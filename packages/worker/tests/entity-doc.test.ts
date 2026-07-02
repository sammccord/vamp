import { describe, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";

import {
  cloneComponentValue,
  entitiesMap,
  removeEntity,
  writeEntityInsert,
  writeUpdate,
} from "../src/entity-doc.ts";

// Two-way Yjs sync so we can model two lobbies backed by separate replicas of
// the same shard document.
function sync(a: Doc, b: Doc): void {
  applyUpdate(b, encodeStateAsUpdate(a));
  applyUpdate(a, encodeStateAsUpdate(b));
}

describe("entity-doc: sharded entity set", () => {
  it("writeEntityInsert stores components, drops the redundant id key", () => {
    const doc = new Doc();
    doc.transact(() => {
      writeEntityInsert(doc, "e1", { id: "e1", hp: 10, pos: { x: 1, y: 2 } });
    });

    const map = entitiesMap(doc).get("e1");
    expect(map?.has("id")).toBe(false);
    expect(map?.get("hp")).toBe(10);
    expect(map?.get("pos")).toEqual({ x: 1, y: 2 });
  });

  it("re-insert from a co-subscriber reuses the existing nested map", () => {
    const a = new Doc();
    const b = new Doc();
    a.transact(() => writeEntityInsert(a, "e1", { hp: 10 }));
    sync(a, b);
    b.transact(() => writeEntityInsert(b, "e1", { mp: 5 }));
    sync(a, b);

    for (const doc of [a, b]) {
      const map = entitiesMap(doc).get("e1");
      expect(map?.get("hp")).toBe(10);
      expect(map?.get("mp")).toBe(5);
    }
  });

  it("writeUpdate sets component keys; undefined deletes them", () => {
    const doc = new Doc();
    doc.transact(() => writeEntityInsert(doc, "e1", { hp: 10, mp: 5 }));
    doc.transact(() => writeUpdate(doc, "e1", { hp: 12, mp: undefined }));

    const map = entitiesMap(doc).get("e1");
    expect(map?.get("hp")).toBe(12);
    expect(map?.has("mp")).toBe(false);
  });

  it("writeUpdate on an unknown id is a no-op", () => {
    const doc = new Doc();
    expect(() => doc.transact(() => writeUpdate(doc, "ghost", { hp: 1 }))).not.toThrow();
    expect(entitiesMap(doc).has("ghost")).toBe(false);
  });

  it("removeEntity drops the entity everywhere — the set IS the membership", () => {
    const a = new Doc();
    const b = new Doc();
    a.transact(() => writeEntityInsert(a, "e1", { hp: 10 }));
    sync(a, b);
    a.transact(() => removeEntity(a, "e1"));
    sync(a, b);

    expect(entitiesMap(a).has("e1")).toBe(false);
    expect(entitiesMap(b).has("e1")).toBe(false);
  });

  it("cloneComponentValue decouples object values from later in-place mutation", () => {
    const doc = new Doc();
    const pos = { x: 1, y: 2 };
    doc.transact(() => writeEntityInsert(doc, "e1", { pos }));
    pos.x = 99; // mutate the caller's object after the write

    expect(entitiesMap(doc).get("e1")?.get("pos")).toEqual({ x: 1, y: 2 });
    expect(cloneComponentValue(null)).toBe(null);
    expect(cloneComponentValue(3)).toBe(3);
  });
});
