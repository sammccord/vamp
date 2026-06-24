import { query as buildQuery, type QueryBuilder } from "@vamp/ecs";
import { createRoot, getOwner } from "solid-js";
import { describe, expect, it } from "vitest";
import { createQueryRegistry } from "../src/registry.ts";
import { createWorld } from "../src/world.ts";
import { components, del, frame, insert, options, update } from "./fixture.ts";

describe("createQueryRegistry membership", () => {
  it("covers join / value-update / structural-leave / delete", async () => {
    await createRoot(async (dispose) => {
      const world = createWorld(options());
      world.initialize();
      const registry = createQueryRegistry(world, getOwner());
      const handle = registry.acquire((q: QueryBuilder) => q.every(components.faction));

      const push = async (f: ReturnType<typeof frame>) => {
        const { mutations } = await world.withScope(() => world.applyMutations(f.mutations!));
        registry.update(mutations);
      };

      expect(handle.ids()).toEqual([]);

      // insert e1 WITH faction -> joins
      await push(frame(["e1", insert({ id: "e1", hp: 10, tags: [], faction: 1 })]));
      expect(handle.ids()).toContain("e1");

      // insert e2 WITHOUT faction -> not a member
      await push(frame(["e2", insert({ id: "e2", hp: 10, tags: [] })]));
      expect(handle.ids()).not.toContain("e2");

      // update e2 adding faction -> joins (archetype gains the component)
      await push(frame(["e2", update({ faction: 2 })]));
      expect(handle.ids()).toContain("e2");

      // value-only update of e1's faction -> still a member, no membership churn
      const before = handle.ids();
      await push(frame(["e1", update({ faction: 9 })]));
      expect(handle.ids()).toBe(before); // membership signal not re-set
      expect(world.entity("e1")?.faction).toBe(9);

      // structural leave: removing the faction component moves e2 to an archetype
      // that no longer matches — the case `subscribe(Q)` cannot observe.
      const leave = await world.withScope(() => {
        world.put("e2", { faction: undefined }, true);
      });
      registry.update(leave.mutations);
      expect(handle.ids()).not.toContain("e2");

      // delete e1 -> leaves
      await push(frame(["e1", del({ id: "e1" })]));
      expect(handle.ids()).not.toContain("e1");

      dispose();
    });
  });

  it("refcounts shared queries by Query identity", async () => {
    await createRoot(async (dispose) => {
      const world = createWorld(options());
      world.initialize();
      const registry = createQueryRegistry(world, getOwner());

      const built = buildQuery((b: QueryBuilder) => b.every(components.hp));
      const a = registry.acquire(built);
      const b = registry.acquire(built);
      expect(b.ids()).toBe(a.ids()); // shared membership signal

      const { mutations } = await world.withScope(() =>
        world.applyMutations(frame(["x", insert({ id: "x", hp: 5, tags: [] })]).mutations!),
      );
      registry.update(mutations);
      expect(a.ids()).toContain("x");

      a.release();
      b.release();
      dispose();
    });
  });
});
