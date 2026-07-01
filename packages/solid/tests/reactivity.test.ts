import type { QueryBuilder } from "@vampgg/ecs";
import { createRoot, getOwner } from "solid-js";
import { describe, expect, it } from "vitest";
import { createQueryRegistry } from "../src/registry.ts";
import { createEntityStore } from "../src/store.ts";
import { createWorld } from "../src/world.ts";
import { components, del, frame, insert, options, update } from "./fixture.ts";
import type { TestEntity } from "./fixture.ts";

/**
 * Validates the store + registry composition that `createQuery` builds on:
 * membership tracking and — crucially for fine-grained `<For>` rendering — that a
 * value-only update keeps the entity's store-node identity stable (so rows don't
 * churn) while its fields update in place. Asserted via direct reads rather than
 * an effect, since a headless root has no render scheduler to flush effects.
 */
describe("createQuery store + registry composition", () => {
  it("tracks membership and updates entity fields in place (reconcile identity)", async () => {
    await createRoot(async (dispose) => {
      const world = createWorld(options());
      world.initialize();
      const store = createEntityStore<TestEntity>();
      const registry = createQueryRegistry(world, getOwner());
      const handle = registry.acquire((q: QueryBuilder) => q.every(components.hp));

      const push = async (f: ReturnType<typeof frame>) => {
        const { mutations } = await world.withScope(() => world.applyMutations(f.mutations!));
        for (const [id, record] of mutations) {
          if (record.tag === 3) store.remove(id);
          else {
            const e = world.entity(id);
            if (e) store.upsert(id, e as TestEntity);
          }
        }
        registry.update(mutations);
      };

      // insert -> joins membership, lands in the store
      await push(frame(["a", insert({ id: "a", hp: 100, tags: [] })]));
      expect(handle.ids()).toEqual(["a"]);
      const ref = store.state["a"]; // the entity's reactive store node
      expect(ref?.hp).toBe(100);

      // value-only update: membership unchanged, store-node identity preserved
      // (no row churn), field updated in place (fine-grained).
      await push(frame(["a", update({ hp: -30 })]));
      expect(handle.ids()).toEqual(["a"]);
      expect(store.state["a"]).toBe(ref);
      expect(store.state["a"]?.hp).toBe(70);

      // second entity joins -> membership grows, existing identity still stable
      await push(frame(["b", insert({ id: "b", hp: 50, tags: [] })]));
      expect([...handle.ids()].sort((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
      expect(store.state["a"]).toBe(ref);

      // delete -> leaves membership and the store
      await push(frame(["a", del({ id: "a" })]));
      expect(handle.ids()).not.toContain("a");
      expect(store.state["a"]).toBeUndefined();

      dispose();
    });
  });
});
