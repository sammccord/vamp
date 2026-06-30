import { describe, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate, type Map as YMap } from "yjs";

import {
  entitiesMap,
  joinNamespace,
  leaveNamespace,
  membersMap,
  migrateLegacyNamespace,
  reapOrphanedEntities,
  refsMap,
  writeDelete,
  writeEntityInsert,
  writeInsert,
  writeUpdate,
} from "../src/entity-doc.ts";

// Two-way Yjs sync so we can model two lobbies (namespaces) backed by separate
// replicas of the shared world document.
function sync(a: Doc, b: Doc): void {
  applyUpdate(b, encodeStateAsUpdate(a));
  applyUpdate(a, encodeStateAsUpdate(b));
}

const A = "lobby-a";
const B = "lobby-b";

function comp(doc: Doc, id: string, key: string): unknown {
  return entitiesMap(doc).get(id)?.get(key);
}

function refCount(doc: Doc, id: string): number {
  return refsMap(doc).get(id)?.size ?? 0;
}

describe("entity-doc: global entity sharing across namespaces", () => {
  it("one lobby creates an entity, another references the SAME global entity", () => {
    const a = new Doc();
    const b = new Doc();

    // Lobby A creates entity "e1".
    writeInsert(a, A, "e1", { hp: 10 });
    sync(a, b);

    // Lobby B references the already-global entity (no new components).
    writeInsert(b, B, "e1", {});
    sync(a, b);

    for (const doc of [a, b]) {
      // A single shared global entity, not one per lobby.
      expect(entitiesMap(doc).size).toBe(1);
      expect(comp(doc, "e1", "hp")).toBe(10);
      // Referenced by both lobbies (refcount 2).
      expect(refCount(doc, "e1")).toBe(2);
      // Both lobbies track it in their membership.
      expect(membersMap(doc, A).has("e1")).toBe(true);
      expect(membersMap(doc, B).has("e1")).toBe(true);
    }
  });

  it("propagates a mutation made in one lobby to the other (shared CRDT object)", () => {
    const a = new Doc();
    const b = new Doc();
    writeInsert(a, A, "e1", { hp: 10 });
    sync(a, b);
    writeInsert(b, B, "e1", {});
    sync(a, b);

    // Lobby B mutates the shared entity.
    writeUpdate(b, "e1", { hp: 42 });
    sync(a, b);

    // Lobby A sees B's mutation — the entity is the same global object.
    expect(comp(a, "e1", "hp")).toBe(42);
  });
});

describe("entity-doc: refcounted garbage collection", () => {
  it("a delete from one lobby keeps the entity alive for the other", () => {
    const a = new Doc();
    const b = new Doc();
    writeInsert(a, A, "e1", { hp: 10 });
    sync(a, b);
    writeInsert(b, B, "e1", {});
    sync(a, b);
    expect(refCount(a, "e1")).toBe(2);

    // Lobby A deletes it — only A's reference/membership goes away.
    writeDelete(a, A, "e1");
    sync(a, b);

    for (const doc of [a, b]) {
      expect(entitiesMap(doc).has("e1")).toBe(true); // still alive globally
      expect(refCount(doc, "e1")).toBe(1);
      expect(membersMap(doc, A).has("e1")).toBe(false);
      expect(membersMap(doc, B).has("e1")).toBe(true);
    }

    // Lobby B deletes its (last) reference — now it is GC'd globally.
    writeDelete(b, B, "e1");
    sync(a, b);

    for (const doc of [a, b]) {
      expect(entitiesMap(doc).has("e1")).toBe(false);
      expect(refsMap(doc).has("e1")).toBe(false);
      expect(membersMap(doc, B).has("e1")).toBe(false);
    }
  });

  it("reaper GCs an entity orphaned by a concurrent last-reference release", () => {
    const a = new Doc();
    const b = new Doc();
    writeInsert(a, A, "e1", { hp: 1 });
    sync(a, b);
    writeInsert(b, B, "e1", {});
    sync(a, b);
    expect(refCount(a, "e1")).toBe(2);

    // CONCURRENT last-reference release: each lobby deletes before seeing the
    // other's delete, so neither observes refcount hit zero → no opportunistic GC.
    writeDelete(a, A, "e1");
    writeDelete(b, B, "e1");
    sync(a, b);

    // Converged state: the entity survives with an empty refcount set (the leak).
    expect(entitiesMap(a).has("e1")).toBe(true);
    expect(refCount(a, "e1")).toBe(0);

    // The periodic reaper cleans it up. Empty refs always means a genuine orphan
    // (inserts write entity + ref atomically), so this never deletes a live one.
    const reaped = reapOrphanedEntities(a);
    sync(a, b);

    expect(reaped).toEqual(["e1"]);
    for (const doc of [a, b]) {
      expect(entitiesMap(doc).has("e1")).toBe(false);
      expect(refsMap(doc).has("e1")).toBe(false);
    }
  });
});

describe("entity-doc: clone-on-write guard", () => {
  it("does not store a live reference to an object component", () => {
    const doc = new Doc();
    const pos = { x: 1, y: 2 };
    writeInsert(doc, A, "e1", { pos });

    // Mutating the source object after the write must NOT change the stored value
    // (otherwise the Y.Map cell would change with no Yjs update → silent divergence).
    pos.x = 999;
    expect(comp(doc, "e1", "pos")).toEqual({ x: 1, y: 2 });
  });
});

describe("entity-doc: legacy layout migration", () => {
  it("migrates a Y.Array + top-level maps doc into the shared layout", () => {
    const doc = new Doc();
    // Build the legacy layout: an id array named by the bare namespace + one
    // top-level Y.Map per entity.
    const legacy = doc.getArray<string>(A);
    legacy.push(["e1", "e2"]);
    (doc.getMap("e1") as YMap<unknown>).set("hp", 5);
    (doc.getMap("e2") as YMap<unknown>).set("name", "goblin");

    const migrated = migrateLegacyNamespace(doc, A);

    expect(migrated.sort()).toEqual(["e1", "e2"]);
    // Global store now holds the entities with their components.
    expect(comp(doc, "e1", "hp")).toBe(5);
    expect(comp(doc, "e2", "name")).toBe("goblin");
    // Referenced by, and members of, the migrating namespace.
    expect(refCount(doc, "e1")).toBe(1);
    expect(membersMap(doc, A).has("e1")).toBe(true);
    expect(membersMap(doc, A).has("e2")).toBe(true);
    // Legacy array drained so the migration never runs twice.
    expect(legacy.length).toBe(0);

    // Idempotent: a second run is a no-op.
    expect(migrateLegacyNamespace(doc, A)).toEqual([]);
  });

  it("shares a legacy entity already migrated by another namespace", () => {
    const doc = new Doc();
    // Two namespaces both listed the same entity id in their legacy arrays.
    doc.getArray<string>(A).push(["shared"]);
    doc.getArray<string>(B).push(["shared"]);
    (doc.getMap("shared") as YMap<unknown>).set("hp", 7);

    migrateLegacyNamespace(doc, A);
    migrateLegacyNamespace(doc, B);

    // One global entity, referenced by both namespaces.
    expect(entitiesMap(doc).size).toBe(1);
    expect(comp(doc, "shared", "hp")).toBe(7);
    expect(refCount(doc, "shared")).toBe(2);
    expect(membersMap(doc, A).has("shared")).toBe(true);
    expect(membersMap(doc, B).has("shared")).toBe(true);
  });
});

describe("entity-doc: AOI data-model split (entity data vs namespace membership)", () => {
  it("writeEntityInsert writes ONLY component data — no refs/membership", () => {
    const doc = new Doc();
    writeEntityInsert(doc, "e1", { id: "e1", hp: 7 });

    expect((entitiesMap(doc).get("e1") as YMap<unknown>).get("hp")).toBe(7);
    // The `id` component is dropped (it's the map key).
    expect((entitiesMap(doc).get("e1") as YMap<unknown>).has("id")).toBe(false);
    // No refcount, no membership recorded.
    expect(refsMap(doc).has("e1")).toBe(false);
    expect(membersMap(doc, "lobby").has("e1")).toBe(false);
  });

  it("joinNamespace records refcount + membership; size = number of lobbies", () => {
    const doc = new Doc();
    writeEntityInsert(doc, "e1", { hp: 1 });

    joinNamespace(doc, "A", "e1");
    joinNamespace(doc, "B", "e1");
    joinNamespace(doc, "A", "e1"); // idempotent

    expect(refsMap(doc).get("e1")?.size).toBe(2);
    expect(membersMap(doc, "A").has("e1")).toBe(true);
    expect(membersMap(doc, "B").has("e1")).toBe(true);
  });

  it("leaveNamespace drops membership and GCs the global entity at refcount 0", () => {
    const doc = new Doc();
    writeEntityInsert(doc, "e1", { hp: 1 });
    joinNamespace(doc, "A", "e1");
    joinNamespace(doc, "B", "e1");

    leaveNamespace(doc, "A", "e1");
    expect(membersMap(doc, "A").has("e1")).toBe(false);
    expect(entitiesMap(doc).has("e1")).toBe(true); // still referenced by B
    expect(refsMap(doc).get("e1")?.size).toBe(1);

    leaveNamespace(doc, "B", "e1");
    expect(entitiesMap(doc).has("e1")).toBe(false); // last reference gone → GC'd
    expect(refsMap(doc).has("e1")).toBe(false);
  });

  it("writeInsert == writeEntityInsert + joinNamespace (same logical state)", () => {
    const combined = new Doc();
    writeInsert(combined, "A", "e1", { hp: 5 });

    const split = new Doc();
    writeEntityInsert(split, "e1", { hp: 5 });
    joinNamespace(split, "A", "e1");

    // Compare logical content (raw encoded bytes differ by clientID/clock).
    expect((entitiesMap(combined).get("e1") as YMap<unknown>).toJSON()).toEqual(
      (entitiesMap(split).get("e1") as YMap<unknown>).toJSON(),
    );
    expect((refsMap(combined).get("e1") as YMap<boolean>).toJSON()).toEqual(
      (refsMap(split).get("e1") as YMap<boolean>).toJSON(),
    );
    expect(membersMap(combined, "A").toJSON()).toEqual(membersMap(split, "A").toJSON());
  });
});
