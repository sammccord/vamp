/**
 * Comprehensive test suite for the ECS (Entity Component System) implementation.
 *
 * This test suite covers all public API methods and provides a safety net for refactoring.
 */
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { ECS, type ECSOptions } from "../src/index.ts";
import { MutationType, type MutationRecord } from "../src/index.ts";
import { query } from "../src/Query.ts";
import type { QueryBuilder } from "../src/Query.ts";
import {
  createArchetypeSystem,
  createBehavior,
  createEntitySystem,
  createEventSystem,
  createLifecycleSystem,
} from "../src/System.ts";

// Simple test entity type with flat primitive fields
type Entity = {
  id?: string;
  root?: string;
  parent?: string;
  children?: string[];
  tags?: number[];
  health?: number;
  level?: number;
  name?: string;
  xp?: number;
  mana?: number;
  replicated?: boolean;
  deleted?: boolean;
  userId?: string;
};

// Simple delta type mirrors the entity shape
type EntityDelta = Partial<Entity>;

// Component IDs
const components = {
  id: 1,
  root: 2,
  parent: 3,
  children: 4,
  xp: 5,
  level: 6,
  health: 7,
  mana: 8,
  name: 9,
  replicated: 10,
  deleted: 11,
  userId: 12,
} as const satisfies Record<keyof Omit<Required<Entity>, "tags">, number>;

// Handle bebop-style array delta { set?, add?, remove? }
function applyArrayDelta(current: string[] | undefined, delta: any): string[] {
  if (delta.set) return [...delta.set];
  let result = current ? [...current] : [];
  if (delta.add) result = [...result, ...delta.add];
  if (delta.remove) result = result.filter((x) => !delta.remove.includes(x));
  return result;
}

// materializeDelta: copy all defined fields from delta onto base
function materializeDelta(delta: EntityDelta, base: Partial<Entity> = {}): Entity {
  const result = { ...base } as Record<string, unknown>;
  for (const key in delta) {
    const dv = (delta as Record<string, unknown>)[key];
    if (dv === undefined) continue;
    if (
      dv !== null &&
      typeof dv === "object" &&
      !Array.isArray(dv) &&
      ("set" in (dv as object) || "add" in (dv as object) || "remove" in (dv as object))
    ) {
      result[key] = applyArrayDelta(result[key] as string[] | undefined, dv);
    } else {
      result[key] = dv;
    }
  }
  return result as Entity;
}

// mergeDelta: add numeric deltas, overwrite strings/booleans, merge arrays
function mergeDelta(entity: Entity, delta: EntityDelta): void {
  const e = entity as Record<string, unknown>;
  for (const key in delta) {
    const dv = (delta as Record<string, unknown>)[key];
    if (dv === undefined) continue;
    const ev = e[key];
    if (typeof dv === "number" && typeof ev === "number") {
      e[key] = (ev as number) + dv;
    } else if (
      dv !== null &&
      typeof dv === "object" &&
      !Array.isArray(dv) &&
      ("set" in (dv as object) || "add" in (dv as object) || "remove" in (dv as object))
    ) {
      // bebop array delta
      e[key] = applyArrayDelta(ev as string[] | undefined, dv);
    } else {
      e[key] = dv;
    }
  }
}

// accumulateDelta: accumulate two deltas together
function accumulateDelta(from: EntityDelta, to: EntityDelta): EntityDelta {
  const result = { ...(from as Record<string, unknown>) };
  for (const key in to) {
    const tv = (to as Record<string, unknown>)[key];
    if (tv === undefined) continue;
    const fv = result[key];
    if (typeof tv === "number" && typeof fv === "number") {
      result[key] = fv + tv;
    } else if (
      tv !== null &&
      typeof tv === "object" &&
      !Array.isArray(tv) &&
      ("set" in (tv as object) || "add" in (tv as object) || "remove" in (tv as object))
    ) {
      // Accumulate array deltas: apply `to` delta on top of result
      // For simplicity, last-write wins for set; union add/remove
      const prevDelta = fv as any;
      const nextDelta = tv as any;
      if (nextDelta.set) {
        result[key] = { set: nextDelta.set };
      } else {
        const combinedAdd = [...(prevDelta?.add || []), ...(nextDelta.add || [])];
        const combinedRemove = [...(prevDelta?.remove || []), ...(nextDelta.remove || [])];
        const prevSet = prevDelta?.set;
        if (prevSet) {
          result[key] = { set: applyArrayDelta(prevSet, nextDelta) };
        } else {
          result[key] = {
            ...(combinedAdd.length ? { add: combinedAdd } : {}),
            ...(combinedRemove.length ? { remove: combinedRemove } : {}),
          };
        }
      }
    } else {
      result[key] = tv;
    }
  }
  return result as EntityDelta;
}

// Helper functions mirroring @vaporware/bebop/lib/entities
function buildSingleEntityCollection(
  entityMap: Map<string, Entity>,
  id: string,
): Map<string, Entity> {
  const entityCollection = new Map<string, Entity>();
  const entities: string[] = [id];
  let entityIndex = 0;
  while (entityIndex < entities.length) {
    const entity = entityMap.get(entities[entityIndex++]);
    if (!entity) continue;
    if (entity.children) {
      entities.push(...entity.children);
    }
    entityCollection.set(entity.id!, entity);
  }
  return entityCollection;
}

function resolveEntityRoot(entities: Map<string, Entity>, entityId: string): string | undefined {
  let entity = entities.get(entityId);
  if (!entity?.id) return;
  if (entity.root) return entity.root;
  if (!entity.parent) return entity.id;
  while (entity?.parent) {
    const _entity = entities.get(entity.parent);
    if (_entity) entity = _entity;
    else break;
  }
  return entity.id;
}

function validAncestry(entities: Map<string, Entity>, ownerId: string, entity?: Entity): boolean {
  if (!entity) return false;
  if (entity.parent === ownerId) return true;
  if (entity.parent !== undefined)
    return validAncestry(entities, ownerId, entities.get(entity.parent));
  return false;
}

type TestContext = {
  frame: number;
  deltaTime: number;
};

type TestAction = { tag: number; value: any };

// Helper function to create a test ECS instance
function createTestECS() {
  const entities = new Map<string, Entity>();
  let idCounter = 0;

  const mutate = (id: string, record: MutationRecord<Entity, EntityDelta>) => {
    switch (record.tag) {
      case MutationType.Insert:
        entities.set(id, record.value.entity);
        return;
      case MutationType.Update: {
        const entity = entities.get(id);
        if (!entity) entities.set(id, materializeDelta(record.value.delta, { id }));
        else mergeDelta(entity, record.value.delta);
        return;
      }
      case MutationType.Delete:
        entities.delete(id);
    }
  };

  const options: ECSOptions<Entity, EntityDelta> = {
    createId: () => `entity_${idCounter++}`,
    components: components as unknown as Record<keyof Entity, number>,
    materializeDelta,
    mergeDelta,
    accumulateDelta,
  };

  const context: TestContext = {
    frame: 0,
    deltaTime: 16.67,
  };

  return new ECS<TestContext, [number], TestAction, number, Entity, EntityDelta>(
    entities as unknown as Map<string, Entity>,
    mutate,
    context,
    options,
  );
}

describe("ECS", () => {
  let ecs: ECS<TestContext, [number], TestAction, number, Entity, EntityDelta>;

  beforeEach(() => {
    ecs = createTestECS();
  });

  describe("Initialization", () => {
    test("should create ECS instance", () => {
      expect(ecs).toBeDefined();
      expect(ecs.initialized).toBe(false);
    });

    test("should initialize ECS", () => {
      ecs.initialize();
      expect(ecs.initialized).toBe(true);
    });

    test("should not re-initialize if already initialized", () => {
      ecs.initialize();
      expect(ecs.initialized).toBe(true);
      ecs.initialize(); // Should be safe to call again
      expect(ecs.initialized).toBe(true);
    });

    test("should provide access to context", () => {
      expect(ecs.context).toBeDefined();
      expect(ecs.context.frame).toBe(0);
    });

    test("should allow context updates", () => {
      ecs.context.frame = 10;
      ecs.context.deltaTime = 20;
      expect(ecs.context.frame).toBe(10);
      expect(ecs.context.deltaTime).toBe(20);
    });
  });

  describe("Entity Management", () => {
    test("should create entity with generated ID", () => {
      const entityId = ecs.createEntity();
      expect(entityId).toBeDefined();
      expect(typeof entityId).toBe("string");
      expect(ecs.hasEntity(entityId)).toBe(true);
    });

    test("should create entity with custom ID", () => {
      const customId = "custom-entity";
      const entityId = ecs.createEntity(undefined, customId);
      expect(entityId).toBe(customId);
      expect(ecs.hasEntity(customId)).toBe(true);
    });

    test("should delete entity", () => {
      const entityId = ecs.createEntity();
      expect(ecs.hasEntity(entityId)).toBe(true);

      ecs.deleteEntity(entityId);
      expect(ecs.hasEntity(entityId)).toBe(false);
    });

    test("should handle operations on deleted entity gracefully", () => {
      const entityId = ecs.createEntity();
      ecs.deleteEntity(entityId);

      // These operations should not throw, but should be no-ops
      ecs.addComponent(entityId, "health");
      ecs.removeComponent(entityId, "health");
    });

    test("should retrieve entity data", () => {
      const entity: Entity = {
        id: "test-entity",
        health: 100,
        name: "Test Entity",
      };

      ecs.insert(entity);
      const retrieved = ecs.entity("test-entity");

      expect(retrieved).toBeDefined();
      expect(retrieved!.health).toBe(100);
      expect(retrieved!.name).toBe("Test Entity");
    });

    test("should return undefined for non-existent entity", () => {
      const entity = ecs.entity("non-existent");
      expect(entity).toBeUndefined();
    });

    test("should provide access to entities map", () => {
      const entity: Entity = { id: "test", name: "Test" };
      ecs.insert(entity);

      expect(ecs.entities).toBeDefined();
      expect(ecs.entities.size).toBeGreaterThan(0);
    });
  });

  describe("Entity CRUD Operations", () => {
    test("should insert new entity", () => {
      const entity: Entity = {
        id: "player1",
        health: 100,
        name: "Player One",
      };

      const inserted = ecs.insert(entity);
      expect(inserted.id).toBe("player1");
      expect(ecs.entity("player1")).toBeDefined();
    });

    test("should insert entity without ID", () => {
      const entity: Entity = {
        health: 50,
        name: "Anonymous",
      };

      const inserted = ecs.insert(entity);
      expect(inserted.id).toBeDefined();
      expect(ecs.entity(inserted.id!)).toBeDefined();
    });

    test("should update existing entity with put", () => {
      const entity: Entity = { id: "test", health: 100 };
      ecs.insert(entity);

      // Note: numeric values in delta are ADDED to existing values (delta behavior)
      const updated = ecs.put("test", { health: -20, name: "Updated" });
      expect(updated.health).toBe(100); // Returns old values

      const current = ecs.entity("test");
      expect(current!.health).toBe(80); // 100 + (-20) = 80
      expect(current!.name).toBe("Updated");
    });

    test("should insert if entity doesn't exist in put", () => {
      // put() requires the entity to exist; if not, it inserts with materialized delta
      // But the entity needs an id to be tracked in the ECS
      ecs.put(undefined, { id: "new", health: 60 });

      expect(ecs.entity("new")).toBeDefined();
      expect(ecs.entity("new")!.health).toBe(60);
    });

    test("should upsert entity based on filter", () => {
      // Insert initial entity
      ecs.insert({ id: "player1", health: 100, replicated: true });

      // Upsert should find and update existing
      const updated = ecs.upsert(
        { health: 75, level: 5 },
        (entity: Entity | undefined) => entity?.replicated === true,
      );

      expect(updated.health).toBe(75);
      expect(updated.level).toBe(5);
    });

    test("should insert new entity when upsert filter finds no match", () => {
      // Upsert with no matching entity should insert
      const inserted = ecs.upsert(
        { health: 50, name: "New Entity" },
        (entity: Entity | undefined) => entity?.replicated === true, // No entity has replicated=true
      );

      expect(inserted.health).toBe(50);
      expect(inserted.name).toBe("New Entity");
      expect(inserted.id).toBeDefined();
    });

    test("should delete entity and return its data", () => {
      const entity: Entity = { id: "delete-me", name: "ToDelete" };
      ecs.insert(entity);

      const deleted = ecs.delete(entity);
      expect(deleted).toBeDefined();
      expect(deleted!.name).toBe("ToDelete");
      expect(ecs.hasEntity("delete-me")).toBe(false);
    });
  });

  describe("Component Management", () => {
    let entityId: string;

    beforeEach(() => {
      entityId = ecs.createEntity();
    });

    test("should add component to entity", () => {
      ecs.addComponent(entityId, "health");
      expect(ecs.hasComponent(entityId, "health")).toBe(true);
    });

    test("should remove component from entity", () => {
      ecs.addComponent(entityId, "health");
      expect(ecs.hasComponent(entityId, "health")).toBe(true);

      ecs.removeComponent(entityId, "health");
      expect(ecs.hasComponent(entityId, "health")).toBe(false);
    });

    test("should check component existence", () => {
      expect(ecs.hasComponent(entityId, "health")).toBe(false);

      ecs.addComponent(entityId, "health");
      expect(ecs.hasComponent(entityId, "health")).toBe(true);
    });

    test("should handle undefined component gracefully", () => {
      // This should not throw or cause issues
      ecs.addComponent(entityId, "nonexistent" as any);
      ecs.removeComponent(entityId, "nonexistent" as any);
    });
  });

  describe("Query System", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("should query entities by components", () => {
      const entity1 = ecs.createEntity();
      const entity2 = ecs.createEntity();
      const entity3 = ecs.createEntity();

      ecs.addComponent(entity1, "health");
      ecs.addComponent(entity1, "level");

      ecs.addComponent(entity2, "health");
      ecs.addComponent(entity2, "name");

      ecs.addComponent(entity3, "name");

      const results = ecs.query((q: QueryBuilder) => q.every(components.health)); // health component
      expect(results).toContain(entity1);
      expect(results).toContain(entity2);
      expect(results).not.toContain(entity3);
    });

    test("should query with multiple component requirements", () => {
      const entity1 = ecs.createEntity();
      const entity2 = ecs.createEntity();

      ecs.addComponent(entity1, "health");
      ecs.addComponent(entity1, "level");

      ecs.addComponent(entity2, "health");

      const results = ecs.query((q: QueryBuilder) => q.every(components.health, components.level)); // health and level
      expect(results).toContain(entity1);
      expect(results).not.toContain(entity2);
    });

    test("should query with 'some' component requirements", () => {
      const entity1 = ecs.createEntity();
      const entity2 = ecs.createEntity();
      const entity3 = ecs.createEntity();

      ecs.addComponent(entity1, "health");
      ecs.addComponent(entity2, "level");
      ecs.addComponent(entity3, "name");

      const results = ecs.query((q: QueryBuilder) => q.some(components.health, components.level)); // health or level
      expect(results).toContain(entity1);
      expect(results).toContain(entity2);
      expect(results).not.toContain(entity3);
    });

    test("should accept pre-built query", () => {
      const entity1 = ecs.createEntity();
      ecs.addComponent(entity1, "health");

      const prebuiltQuery = query((q: QueryBuilder) => q.every(components.health));
      const results = ecs.query(prebuiltQuery);

      expect(results).toContain(entity1);
    });
  });

  describe("System Registration and Execution", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("should register and unregister entity system", () => {
      const system = createEntitySystem<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        (_entities, _world, _deltaTime) => {
          // Systems no longer return values
        },
        (q: QueryBuilder) => q.every(components.health), // health component
      );

      const unregister = ecs.registerSystem(system);
      expect(ecs.systems).toContain(system);

      unregister();
      expect(ecs.systems).not.toContain(system);
    });

    test("should execute entity systems during update", () => {
      const results: string[] = [];
      const system = createEntitySystem<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        (entities, _world, _deltaTime) => {
          results.push(`processed-${entities.length}`);
        },
        (q: QueryBuilder) => q.every(components.health), // health component
      );

      ecs.registerSystem(system);

      // Create entities with health component
      const entity1 = ecs.createEntity();
      const entity2 = ecs.createEntity();
      ecs.addComponent(entity1, "health");
      ecs.addComponent(entity2, "health");

      ecs.update(16.67);

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("processed-2");
    });

    test("should execute archetype systems during update", () => {
      let archetypeCount = 0;
      const system = createArchetypeSystem<
        TestContext,
        [number],
        void,
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        (archetypes, _world, _deltaTime) => {
          archetypeCount = archetypes.size;
        },
        (q: QueryBuilder) => q.every(components.health), // health component
      );

      ecs.registerSystem(system);

      const entity = ecs.createEntity();
      ecs.addComponent(entity, "health");

      ecs.update(16.67);

      expect(archetypeCount).toBeGreaterThan(0);
    });

    test("should throw error if update called before initialization", () => {
      const uninitializedECS = createTestECS();
      expect(() => uninitializedECS.update(16.67)).toThrow();
    });
  });

  describe("Event Systems", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("should register and execute event system", () => {
      const events: string[][] = [];
      const eventSystem = createEventSystem(
        (entities) => {
          events.push([...entities]);
        },
        (q: QueryBuilder) => q.every(components.health), // health component
      );

      const unsubscribe = ecs.subscribe(eventSystem);

      const entity = ecs.createEntity();
      ecs.addComponent(entity, "health");

      expect(events).toHaveLength(1);
      expect(events[0]).toContain(entity);

      unsubscribe();
    });

    test("should emit events for existing entities when requested", () => {
      const entity = ecs.createEntity();
      ecs.addComponent(entity, "health");

      const events: string[][] = [];
      const eventSystem = createEventSystem(
        (entities) => {
          events.push([...entities]);
        },
        (q: QueryBuilder) => q.every(components.health),
      );

      ecs.subscribe(eventSystem, true); // emit for existing

      expect(events).toHaveLength(1);
      expect(events[0]).toContain(entity);
    });

    test("should execute event systems manually", () => {
      const entity = ecs.createEntity();
      ecs.addComponent(entity, "health");

      let executed = false;
      const eventSystem = createEventSystem(
        () => {
          executed = true;
        },
        (q: QueryBuilder) => q.every(components.health),
      );

      ecs.subscribe(eventSystem);
      executed = false; // Reset after subscription

      ecs.executeEventSystems(entity);
      expect(executed).toBe(true);
    });
  });

  describe("Lifecycle Systems", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("should register onCreate lifecycle system", () => {
      const createdEntities: string[] = [];
      const lifecycleSystem = createLifecycleSystem(
        (entity) => {
          createdEntities.push(entity);
        },
        (q: QueryBuilder) => q.every(components.health), // health component
      );

      const unregister = ecs.onCreate(lifecycleSystem);

      // Insert an entity with health component - should trigger onCreate
      ecs.insert({ id: "test-entity", health: 100 });

      expect(createdEntities).toContain("test-entity");

      unregister();
    });

    test("should register onDelete lifecycle system", () => {
      const deletedEntities: string[] = [];
      const lifecycleSystem = createLifecycleSystem(
        (entity) => {
          deletedEntities.push(entity);
        },
        (q: QueryBuilder) => q.every(components.health), // health component
      );

      const unregister = ecs.onDelete(lifecycleSystem);

      const entity = ecs.insert({ id: "test-delete", health: 100 });
      ecs.delete(entity);

      expect(deletedEntities).toContain("test-delete");

      unregister();
    });
  });

  describe("Archetype Operations", () => {
    test("should prefabricate archetype", () => {
      const archetype = ecs.prefabricate([components.health, components.level]); // health, level
      expect(archetype).toBeDefined();
      expect(archetype.hasComponent(components.health)).toBe(true);
      expect(archetype.hasComponent(components.level)).toBe(true);
    });

    test("should create entity with prefabricated archetype", () => {
      const archetype = ecs.prefabricate([components.health, components.name]); // health, name
      const entity = ecs.createEntity(archetype);

      expect(ecs.hasComponent(entity, "health")).toBe(true);
      expect(ecs.hasComponent(entity, "name")).toBe(true);
    });

    test("should transform entity to prefabricated archetype", () => {
      const entity = ecs.createEntity();
      ecs.addComponent(entity, "health");
      ecs.addComponent(entity, "level");
      ecs.addComponent(entity, "name");

      const newArchetype = ecs.prefabricate([components.health]); // health only
      ecs.transformEntity(entity, newArchetype);

      expect(ecs.hasComponent(entity, "health")).toBe(true);
      expect(ecs.hasComponent(entity, "level")).toBe(false);
      expect(ecs.hasComponent(entity, "name")).toBe(false);
    });
  });

  describe("Deferred Actions", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("should defer action execution", () => {
      let executed = false;
      ecs.defer(() => {
        executed = true;
      });

      expect(executed).toBe(false);

      ecs.update(16.67);

      expect(executed).toBe(true);
    });

    test("should execute multiple deferred actions", () => {
      const results: number[] = [];
      ecs.defer(() => results.push(1));
      ecs.defer(() => results.push(2));
      ecs.defer(() => results.push(3));

      ecs.update(16.67);

      expect(results).toEqual([1, 2, 3]);
    });
  });

  describe("Entity Hierarchy", () => {
    test("should build entity collection from hierarchy", () => {
      ecs.insert({ id: "parent", name: "Parent" });
      ecs.insert({ id: "child1", name: "Child1" });
      ecs.insert({ id: "child2", name: "Child2" });

      ecs.parent("parent", "child1");
      ecs.parent("parent", "child2");

      const collection = buildSingleEntityCollection(ecs.entities, "parent");

      expect(collection.size).toBe(3);
      expect(collection.has("parent")).toBe(true);
      expect(collection.has("child1")).toBe(true);
      expect(collection.has("child2")).toBe(true);
    });

    test("should establish parent-child relationship", () => {
      ecs.insert({ id: "parent" });
      ecs.insert({ id: "child" });

      ecs.parent("parent", "child");

      const parentEntity = ecs.entity("parent");
      expect(parentEntity!.children).toContain("child");
    });

    test("should remove parent-child relationship", () => {
      ecs.insert({ id: "parent" });
      ecs.insert({ id: "child" });

      ecs.parent("parent", "child");
      ecs.unparent("parent", "child");

      const parentEntity = ecs.entity("parent");
      expect(parentEntity!.children).not.toContain("child");
    });

    test("should resolve entity root", () => {
      ecs.insert({ id: "root" });
      ecs.insert({ id: "middle", parent: "root" });
      ecs.insert({ id: "child", parent: "middle" });

      expect(resolveEntityRoot(ecs.entities, "child")).toBe("root");
      expect(resolveEntityRoot(ecs.entities, "middle")).toBe("root");
      expect(resolveEntityRoot(ecs.entities, "root")).toBe("root");
    });

    test("should validate ancestry", () => {
      ecs.insert({ id: "player" });
      ecs.insert({ id: "unit", parent: "player" });
      ecs.insert({ id: "weapon", parent: "unit" });

      expect(validAncestry(ecs.entities, "player", ecs.entity("unit"))).toBe(true);
      expect(validAncestry(ecs.entities, "player", ecs.entity("weapon"))).toBe(true);
      expect(validAncestry(ecs.entities, "other", ecs.entity("unit"))).toBe(false);
    });
  });

  describe("Additional API Coverage", () => {
    test("should execute systems during update", () => {
      ecs.initialize();

      let executed = false;
      const system = createEntitySystem<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        () => {
          executed = true;
        },
        (q: QueryBuilder) => q.every(components.health),
      );

      ecs.registerSystem(system);
      const entity = ecs.createEntity();
      ecs.addComponent(entity, "health");

      ecs.update(16.67);
      expect(executed).toBe(true);
    });

    test("should provide access to deleted entities set", () => {
      const entity = ecs.createEntity();
      ecs.deleteEntity(entity);
      expect(ecs.deletedEntities.has(entity)).toBe(true);
    });

    test("should handle entity creation with prefab and system execution control", () => {
      ecs.initialize();
      const archetype = ecs.prefabricate([components.health, components.name]); // health, name
      ecs.createEntity(archetype, "custom-prefab-entity", false);

      expect(ecs.hasEntity("custom-prefab-entity")).toBe(true);
      expect(ecs.hasComponent("custom-prefab-entity", "health")).toBe(true);
      expect(ecs.hasComponent("custom-prefab-entity", "name")).toBe(true);
    });
  });

  describe("Behavior System", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("should register behavior for event type", () => {
      const eventTag = 100;
      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {
          // Behavior handler
        },
        (q: QueryBuilder) => q.every(components.health), // health component
        10, // priority
      );

      ecs.registerBehavior(behavior);

      expect(ecs.behaviors.has(eventTag)).toBe(true);
      expect(ecs.behaviors.get(eventTag)).toContain(behavior);
    });

    test("should register multiple behaviors for same event type", () => {
      const eventTag = 101;
      const behavior1 = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {},
        (q: QueryBuilder) => q.every(components.health),
        10,
      );
      const behavior2 = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {},
        (q: QueryBuilder) => q.every(components.level), // level
        5,
      );

      ecs.registerBehavior(behavior1);
      ecs.registerBehavior(behavior2);

      const behaviors = ecs.behaviors.get(eventTag);
      expect(behaviors).toHaveLength(2);
      expect(behaviors).toContain(behavior1);
      expect(behaviors).toContain(behavior2);
    });

    test("should sort behaviors by priority (higher first)", () => {
      const eventTag = 102;
      const lowPriority = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {},
        (q: QueryBuilder) => q.every(components.health),
        1,
      );
      const highPriority = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {},
        (q: QueryBuilder) => q.every(components.health),
        100,
      );
      const mediumPriority = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {},
        (q: QueryBuilder) => q.every(components.health),
        50,
      );

      ecs.registerBehavior(lowPriority);
      ecs.registerBehavior(highPriority);
      ecs.registerBehavior(mediumPriority);

      const behaviors = ecs.behaviors.get(eventTag);
      expect(behaviors![0]).toBe(highPriority);
      expect(behaviors![1]).toBe(mediumPriority);
      expect(behaviors![2]).toBe(lowPriority);
    });

    test("should rebuild behavior cache for entity", () => {
      const eventTag = 103;
      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {},
        (q: QueryBuilder) => q.every(components.health), // health component
        10,
      );

      ecs.registerBehavior(behavior);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });

      ecs.rebuildBehaviorCache(inserted.id!);

      const cache = ecs.entityBehaviorCache.get(inserted.id!);
      expect(cache).toBeDefined();
      expect(cache!.has(eventTag)).toBe(true);
      expect(cache!.get(eventTag)).toContain(behavior);
    });

    test("should rebuild cache only for matching entities", () => {
      const eventTag = 104;
      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {},
        (q: QueryBuilder) => q.every(components.health, components.level), // health and level
        10,
      );

      ecs.registerBehavior(behavior);

      const entity1 = ecs.insert({
        id: "entity1",
        health: 100,
        level: 5,
      });

      const entity2 = ecs.insert({
        id: "entity2",
        health: 100,
      });

      ecs.rebuildBehaviorCache(entity1.id!);
      ecs.rebuildBehaviorCache(entity2.id!);

      const cache1 = ecs.entityBehaviorCache.get(entity1.id!);
      const cache2 = ecs.entityBehaviorCache.get(entity2.id!);

      expect(cache1!.has(eventTag)).toBe(true);
      expect(cache2!.has(eventTag)).toBe(false);
    });

    test("should emit event to specific entity", async () => {
      const eventTag = 105;
      let executed = false;
      let receivedEntity: Entity | undefined;

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, entity, _event) => {
          executed = true;
          receivedEntity = entity;
        },
        (q: QueryBuilder) => q.every(components.health), // health component
        10,
      );

      ecs.registerBehavior(behavior);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });
      ecs.rebuildBehaviorCache(inserted.id!);

      await ecs.act(inserted.id!, { tag: eventTag, value: "test-data" });

      expect(executed).toBe(true);
      expect(receivedEntity?.id).toBe(inserted.id);
    });

    test("should not emit to entities without matching components", async () => {
      const eventTag = 106;
      let executed = false;

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {
          executed = true;
        },
        (q: QueryBuilder) => q.every(components.health, components.level), // health and level
        10,
      );

      ecs.registerBehavior(behavior);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });
      ecs.rebuildBehaviorCache(inserted.id!);

      await ecs.act(inserted.id!, { tag: eventTag, value: "test-data" });

      expect(executed).toBe(false);
    });

    test("should execute behaviors in priority order", async () => {
      const eventTag = 107;
      const executionOrder: number[] = [];

      const behavior1 = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {
          executionOrder.push(1);
        },
        (q: QueryBuilder) => q.every(components.health),
        1,
      );
      const behavior2 = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {
          executionOrder.push(2);
        },
        (q: QueryBuilder) => q.every(components.health),
        100,
      );
      const behavior3 = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {
          executionOrder.push(3);
        },
        (q: QueryBuilder) => q.every(components.health),
        50,
      );

      ecs.registerBehavior(behavior1);
      ecs.registerBehavior(behavior2);
      ecs.registerBehavior(behavior3);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });
      ecs.rebuildBehaviorCache(inserted.id!);

      await ecs.act(inserted.id!, { tag: eventTag, value: "test" });

      expect(executionOrder).toEqual([2, 3, 1]); // Priority: 100, 50, 1
    });

    test("should stop execution when event.preventDefault is called", async () => {
      const eventTag = 108;
      const executionOrder: number[] = [];

      const behavior1 = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (world, entity, event) => {
          executionOrder.push(1);
          event.preventDefault();
        },
        (q: QueryBuilder) => q.every(components.health),
        100,
      );
      const behavior2 = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {
          executionOrder.push(2);
        },
        (q: QueryBuilder) => q.every(components.health),
        50,
      );

      ecs.registerBehavior(behavior1);
      ecs.registerBehavior(behavior2);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });
      ecs.rebuildBehaviorCache(inserted.id!);

      await ecs.act(inserted.id!, { tag: eventTag, value: "test" });

      expect(executionOrder).toEqual([1]); // Only first behavior executes
    });

    test("should access event data in behavior handler", async () => {
      const eventTag = 109;
      let _receivedData: any;

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, event) => {
          _receivedData = event.detail;
        },
        (q: QueryBuilder) => q.every(components.health),
        10,
      );

      ecs.registerBehavior(behavior);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });
      ecs.rebuildBehaviorCache(inserted.id!);

      const eventData = { tag: eventTag, value: { message: "hello", count: 42 } };
      await ecs.act(inserted.id!, eventData);

      expect(_receivedData).toEqual(eventData);
    });
  });

  describe("Event Propagation", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("should emit to subtree (entity and all children)", async () => {
      const eventTag = 200;
      const executed: string[] = [];

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, entity, _event) => {
          executed.push(entity.id!);
        },
        (q: QueryBuilder) => q.every(components.health), // health component
        10,
      );

      ecs.registerBehavior(behavior);

      // Create hierarchy: parent -> child1 -> grandchild
      //                           -> child2
      ecs.insert({ id: "parent", health: 100 });
      ecs.insert({ id: "child1", health: 100 });
      ecs.insert({ id: "child2", health: 100 });
      ecs.insert({ id: "grandchild", health: 100 });

      ecs.parent("parent", "child1");
      ecs.parent("parent", "child2");
      ecs.parent("child1", "grandchild");

      ecs.rebuildBehaviorCache("parent");
      ecs.rebuildBehaviorCache("child1");
      ecs.rebuildBehaviorCache("child2");
      ecs.rebuildBehaviorCache("grandchild");

      await ecs.actToSubtree("parent", { tag: eventTag, value: "cascade" });

      expect(executed).toContain("parent");
      expect(executed).toContain("child1");
      expect(executed).toContain("child2");
      expect(executed).toContain("grandchild");
      expect(executed).toHaveLength(4);
    });

    test("should not emit to subtree if entity has no children", async () => {
      const eventTag = 201;
      const executed: string[] = [];

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, entity, _event) => {
          executed.push(entity.id!);
        },
        (q: QueryBuilder) => q.every(components.health),
        10,
      );

      ecs.registerBehavior(behavior);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });
      ecs.rebuildBehaviorCache(inserted.id!);

      await ecs.actToSubtree(inserted.id!, { tag: eventTag, value: "test" });

      expect(executed).toEqual([inserted.id!]);
    });

    test("should emit with bubbling (from entity up to ancestors)", async () => {
      const eventTag = 202;
      const executed: string[] = [];

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, entity, _event) => {
          executed.push(entity.id!);
        },
        (q: QueryBuilder) => q.every(components.health),
        10,
      );

      ecs.registerBehavior(behavior);

      // Create hierarchy: grandparent -> parent -> child
      ecs.insert({ id: "grandparent", health: 100 });
      ecs.insert({ id: "parent", health: 100, parent: "grandparent" });
      ecs.insert({ id: "child", health: 100, parent: "parent" });

      ecs.rebuildBehaviorCache("grandparent");
      ecs.rebuildBehaviorCache("parent");
      ecs.rebuildBehaviorCache("child");

      await ecs.actWithBubbling("child", { tag: eventTag, value: "bubble-up" });

      expect(executed).toEqual(["child", "parent", "grandparent"]);
    });

    test("should stop bubbling when event.preventDefault is called", async () => {
      const eventTag = 203;
      const executed: string[] = [];

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, entity, event) => {
          executed.push(entity.id!);
          if (entity.id === "parent") {
            event.preventDefault();
          }
        },
        (q: QueryBuilder) => q.every(components.health),
        10,
      );

      ecs.registerBehavior(behavior);

      ecs.insert({ id: "grandparent", health: 100 });
      ecs.insert({ id: "parent", health: 100, parent: "grandparent" });
      ecs.insert({ id: "child", health: 100, parent: "parent" });

      ecs.rebuildBehaviorCache("grandparent");
      ecs.rebuildBehaviorCache("parent");
      ecs.rebuildBehaviorCache("child");

      await ecs.actWithBubbling("child", { tag: eventTag, value: "bubble-up" });

      expect(executed).toEqual(["child", "parent"]); // Stops at parent
    });

    test("should handle bubbling for entity without parent", async () => {
      const eventTag = 204;
      const executed: string[] = [];

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, entity, _event) => {
          executed.push(entity.id!);
        },
        (q: QueryBuilder) => q.every(components.health),
        10,
      );

      ecs.registerBehavior(behavior);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });
      ecs.rebuildBehaviorCache(inserted.id!);

      await ecs.actWithBubbling(inserted.id!, { tag: eventTag, value: "test" });

      expect(executed).toEqual([inserted.id!]);
    });

    test("should emit batch to multiple entities", async () => {
      const eventTag = 205;
      const executed: string[] = [];

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, entity, _event) => {
          executed.push(entity.id!);
        },
        (q: QueryBuilder) => q.every(components.health),
        10,
      );

      ecs.registerBehavior(behavior);

      const entity1 = ecs.insert({ id: "entity1", health: 100 });
      const entity2 = ecs.insert({ id: "entity2", health: 100 });
      const entity3 = ecs.insert({ id: "entity3", health: 100 });

      ecs.rebuildBehaviorCache(entity1.id!);
      ecs.rebuildBehaviorCache(entity2.id!);
      ecs.rebuildBehaviorCache(entity3.id!);

      await ecs.actBatch([entity1.id!, entity2.id!, entity3.id!], {
        tag: eventTag,
        value: "batch",
      });

      expect(executed).toHaveLength(3);
      expect(executed).toContain(entity1.id!);
      expect(executed).toContain(entity2.id!);
      expect(executed).toContain(entity3.id!);
    });

    test("should handle async behavior handlers", async () => {
      const eventTag = 206;
      const executionOrder: number[] = [];

      const behavior1 = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        async (_world, _entity, _event) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionOrder.push(1);
        },
        (q: QueryBuilder) => q.every(components.health),
        100,
      );
      const behavior2 = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {
          executionOrder.push(2);
        },
        (q: QueryBuilder) => q.every(components.health),
        50,
      );

      ecs.registerBehavior(behavior1);
      ecs.registerBehavior(behavior2);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });
      ecs.rebuildBehaviorCache(inserted.id!);

      await ecs.act(inserted.id!, { tag: eventTag, value: "test" });

      expect(executionOrder).toEqual([1, 2]); // Async handlers are awaited
    });
  });

  describe("Performance Optimizations", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("should defer cache rebuilding until update cycle", () => {
      const eventTag = 300;
      let rebuildCount = 0;

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {},
        (q: QueryBuilder) => q.every(components.health, components.level), // health and level
        10,
      );

      ecs.registerBehavior(behavior);

      const inserted = ecs.insert({ id: "test-entity", health: 100 });

      // Spy on rebuildBehaviorCache by checking cache presence
      const originalRebuild = ecs.rebuildBehaviorCache.bind(ecs);
      ecs.rebuildBehaviorCache = (entityId: string) => {
        rebuildCount++;
        originalRebuild(entityId);
      };

      // Add multiple components - should defer rebuilding
      ecs.addComponent(inserted.id!, "level");
      ecs.addComponent(inserted.id!, "name");
      ecs.addComponent(inserted.id!, "mana");

      // Cache rebuilds should be deferred (not executed yet)
      expect(rebuildCount).toBe(0);

      // Trigger update to flush deferred rebuilds
      ecs.update(16.67);

      // Now cache should be rebuilt (only once despite 3 component additions)
      expect(rebuildCount).toBe(1);
    });

    test("should reuse archetype-level behavior cache for entities with same components", () => {
      const eventTag = 301;
      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {},
        (q: QueryBuilder) => q.every(components.health, components.level), // health and level
        10,
      );

      ecs.registerBehavior(behavior);

      // Create multiple entities with same archetype
      const entity1 = ecs.insert({ id: "entity1", health: 100, level: 1 });
      const entity2 = ecs.insert({ id: "entity2", health: 100, level: 2 });
      const entity3 = ecs.insert({ id: "entity3", health: 100, level: 3 });

      // Rebuild caches for all entities
      ecs.rebuildBehaviorCache(entity1.id!);
      ecs.rebuildBehaviorCache(entity2.id!);
      ecs.rebuildBehaviorCache(entity3.id!);

      // All three entities should reference the same archetype cache
      const cache1 = ecs.entityBehaviorCache.get(entity1.id!);
      const cache2 = ecs.entityBehaviorCache.get(entity2.id!);
      const cache3 = ecs.entityBehaviorCache.get(entity3.id!);

      // They should all reference the exact same cache object (not just equal, but identical)
      expect(cache1).toBe(cache2);
      expect(cache2).toBe(cache3);
    });

    test("should stop emitToSubtree propagation when preventDefault is called", async () => {
      const eventTag = 302;
      const executed: string[] = [];

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, entity, event) => {
          executed.push(entity.id!);
          if (entity.id === "child1") {
            event.preventDefault(); // Stop at child1
          }
        },
        (q: QueryBuilder) => q.every(components.health),
        10,
      );

      ecs.registerBehavior(behavior);

      // Create hierarchy: parent -> child1 -> grandchild1
      //                           -> child2 -> grandchild2
      ecs.insert({ id: "parent", health: 100 });
      ecs.insert({ id: "child1", health: 100 });
      ecs.insert({ id: "child2", health: 100 });
      ecs.insert({ id: "grandchild1", health: 100 });
      ecs.insert({ id: "grandchild2", health: 100 });

      ecs.parent("parent", "child1");
      ecs.parent("parent", "child2");
      ecs.parent("child1", "grandchild1");
      ecs.parent("child2", "grandchild2");

      ecs.rebuildBehaviorCache("parent");
      ecs.rebuildBehaviorCache("child1");
      ecs.rebuildBehaviorCache("child2");
      ecs.rebuildBehaviorCache("grandchild1");
      ecs.rebuildBehaviorCache("grandchild2");

      const stopped = await ecs.actToSubtree("parent", { tag: eventTag, value: "test" });

      // Should have stopped at child1
      expect(stopped).toBe(true);
      expect(executed).toContain("parent");
      expect(executed).toContain("child1");
      // Should NOT have reached grandchild1 or any other children after preventDefault
      expect(executed).not.toContain("grandchild1");
    });

    test("should batch component changes within a single update cycle", () => {
      const eventTag = 303;
      let _executionCount = 0;

      const behavior = createBehavior<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        eventTag,
        (_world, _entity, _event) => {
          _executionCount++;
        },
        (q: QueryBuilder) => q.every(components.health, components.level, components.name), // health, level, name
        10,
      );

      ecs.registerBehavior(behavior);

      const system = createEntitySystem<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        (entities, world) => {
          // System that modifies entities during update
          for (const entityId of entities) {
            const entity = world.entity(entityId);
            if (entity && !entity.level) {
              world.addComponent(entityId, "level");
            }
            if (entity && !entity.name) {
              world.addComponent(entityId, "name");
            }
          }
        },
        (q: QueryBuilder) => q.every(components.health), // health
      );

      ecs.registerSystem(system);

      // Create entity with just health
      const inserted = ecs.insert({ id: "test-entity", health: 100 });

      // Run update - system will add level and name
      ecs.update(16.67);

      // Cache should be rebuilt only once at the end of update
      ecs.rebuildBehaviorCache(inserted.id!);

      // Entity should now have all components and match the behavior query
      const cache = ecs.entityBehaviorCache.get(inserted.id!);
      expect(cache?.has(eventTag)).toBe(true);
    });
  });

  describe("Edge Cases and Error Handling", () => {
    test("should handle entity operations with undefined ID gracefully", () => {
      const result = ecs.delete({ name: "No ID" } as Entity);
      expect(result).toBeUndefined();
    });

    test("should handle empty query results", () => {
      ecs.initialize();
      const results = ecs.query((q: QueryBuilder) => q.every(999)); // Non-existent component
      expect(results).toEqual([]);
    });

    test("should handle component operations on non-existent entity", () => {
      // addComponent and removeComponent don't throw - they're no-ops
      ecs.addComponent("non-existent", "health");
      ecs.removeComponent("non-existent", "health");

      // executeEventSystems should throw
      expect(() => ecs.executeEventSystems("non-existent")).toThrow();
    });

    test("should handle system registration before initialization", () => {
      const uninitializedECS = createTestECS();
      const system = createEntitySystem<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        () => {
          // System logic
        },
        (q: QueryBuilder) => q.every(components.health),
      );

      // Should not throw
      uninitializedECS.registerSystem(system);
      expect(uninitializedECS.systems).toContain(system);
    });

    test("should handle duplicate parent-child relationships", () => {
      ecs.insert({ id: "parent" });
      ecs.insert({ id: "child" });

      ecs.parent("parent", "child");
      ecs.parent("parent", "child");

      const parentEntity = ecs.entity("parent");
      expect(parentEntity!.children?.filter((c: string) => c === "child")).toHaveLength(1);
    });

    test("should handle unparent non-existent relationship", () => {
      ecs.insert({ id: "parent" });

      // Should not throw
      ecs.unparent("parent", "non-existent-child");
    });
  });

  describe("Mutation Scope", () => {
    test("should create a mutation scope with generated ID", () => {
      ecs.initialize();

      const scope = ecs.createScope();
      expect(scope.mutations.size).toBe(0);
    });

    test("should track insert mutations within scope", async () => {
      ecs.initialize();

      const { mutations } = await ecs.withScope(async () => {
        ecs.insert({ id: "new-entity", health: 100 });
      });

      expect(mutations.size).toBe(1);
      const mutation = mutations.get("new-entity");
      expect(mutation).toBeDefined();
      expect(mutation?.tag).toBe(MutationType.Insert);
      expect((mutation!.value as any).entity.health).toBe(100);
    });

    test("should track update mutations within scope", async () => {
      ecs.initialize();
      ecs.insert({ id: "existing-entity", health: 100 });

      const { mutations } = await ecs.withScope(async () => {
        ecs.put("existing-entity", { health: 50 });
      });

      expect(mutations.size).toBe(1);
      const mutation = mutations.get("existing-entity")!;
      expect(mutation.tag).toBe(MutationType.Update);
      expect((mutation.value as any).delta.health).toBe(50);
    });

    test("should track delete mutations within scope", async () => {
      ecs.initialize();
      ecs.insert({ id: "to-delete", name: "goodbye" });

      const { mutations } = await ecs.withScope(async () => {
        const entity = ecs.entity("to-delete");
        if (entity) ecs.delete(entity);
      });

      expect(mutations.size).toBe(1);
      const mutation = mutations.get("to-delete");
      expect(mutation?.tag).toBe(MutationType.Delete);
    });

    test("should coalesce insert + update = insert", async () => {
      ecs.initialize();

      const { mutations } = await ecs.withScope(async () => {
        ecs.insert({ id: "coalesce-test", health: 100 });
        // Numeric deltas are ADDED to existing values
        ecs.put("coalesce-test", { health: -25 }); // 100 + (-25) = 75
        ecs.put("coalesce-test", { name: "updated" });
      });

      expect(mutations.size).toBe(1);
      const mutation = mutations.get("coalesce-test");
      expect(mutation!.tag).toBe(MutationType.Insert);
      expect((mutation!.value as any).entity.health).toBe(75); // 100 + (-25) = 75
      expect((mutation!.value as any).entity.name).toBe("updated");
    });

    test("should coalesce insert + delete = net zero (no mutations)", async () => {
      ecs.initialize();

      const { mutations } = await ecs.withScope(async () => {
        ecs.insert({ id: "temp-entity", health: 100 });
        const entity = ecs.entity("temp-entity");
        if (entity) ecs.delete(entity);
      });

      expect(mutations.size).toBe(0);
    });

    test("should coalesce update + delete = delete", async () => {
      ecs.initialize();
      ecs.insert({ id: "update-delete", health: 100 });

      const { mutations } = await ecs.withScope(async () => {
        ecs.put("update-delete", { health: 50 });
        const entity = ecs.entity("update-delete");
        if (entity) ecs.delete(entity);
      });

      expect(mutations.size).toBe(1);
      const mutation = mutations.get("update-delete");
      expect(mutation?.tag).toBe(MutationType.Delete);
    });

    test("should track multiple entity mutations in single scope", async () => {
      ecs.initialize();

      const { mutations } = await ecs.withScope(async () => {
        ecs.insert({ id: "entity-1", health: 100 });
        ecs.insert({ id: "entity-2", health: 200 });
        ecs.insert({ id: "entity-3", health: 300 });
      });

      expect(mutations.size).toBe(3);
      const entityIds = [...mutations.keys()].sort((a, b) => a.localeCompare(b));
      expect(entityIds).toEqual(["entity-1", "entity-2", "entity-3"]);
    });

    test("should return result from withScope callback", async () => {
      ecs.initialize();

      const { result, mutations } = await ecs.withScope(async () => {
        ecs.insert({ id: "result-test", health: 100 });
        return { success: true, count: 42 };
      });

      expect(result).toEqual({ success: true, count: 42 });
      expect(mutations.size).toBe(1);
    });

    test("should support nested scopes", async () => {
      ecs.initialize();

      const { result: outerResult, mutations: outerMutations } = await ecs.withScope(async () => {
        ecs.insert({ id: "outer-entity", health: 100 });

        const { mutations: innerMutations } = await ecs.withScope(async () => {
          ecs.insert({ id: "inner-entity", health: 200 });
        });

        expect(innerMutations.size).toBe(1);
        expect(innerMutations.get("inner-entity")).toBeDefined();

        return { nested: true };
      });

      // Outer scope should only track outer entity (inner was in separate scope)
      expect(outerMutations.size).toBe(1);
      expect(outerMutations.get("outer-entity")).toBeDefined();
      expect(outerResult).toEqual({ nested: true });
    });

    test("should not track mutations outside of scope", async () => {
      ecs.initialize();

      // Insert outside of scope
      ecs.insert({ id: "outside-scope", health: 100 });

      const { mutations } = await ecs.withScope(async () => {
        ecs.insert({ id: "inside-scope", health: 200 });
      });

      expect(mutations.size).toBe(1);
      expect(mutations.get("inside-scope")).toBeDefined();
    });

    test("should clear scope after withScope completes", async () => {
      ecs.initialize();

      await ecs.withScope(async () => {
        ecs.insert({ id: "scoped-entity", health: 100 });
      });

      // Create a new scope - it should be empty
      const scope = ecs.createScope();
      expect(scope.mutations.size).toBe(0);
    });

    test("should handle async operations within scope", async () => {
      ecs.initialize();

      const { mutations } = await ecs.withScope(async () => {
        ecs.insert({ id: "async-1", health: 100 });

        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));

        ecs.insert({ id: "async-2", health: 200 });

        await new Promise((resolve) => setTimeout(resolve, 10));

        // Numeric deltas are ADDED to existing values
        ecs.put("async-1", { health: -50 }); // 100 + (-50) = 50
      });

      expect(mutations.size).toBe(2);
      const entity1 = mutations.get("async-1");
      const entity2 = mutations.get("async-2");

      expect(entity1!.tag).toBe(MutationType.Insert);
      expect((entity1!.value as any).entity.health).toBe(50); // 100 + (-50) = 50
      expect(entity2!.tag).toBe(MutationType.Insert);
      expect((entity2!.value as any).entity.health).toBe(200);
    });

    test("should capture final entity state at scope completion", async () => {
      ecs.initialize();

      const { mutations } = await ecs.withScope(async () => {
        ecs.insert({ id: "final-state", health: 100, name: "initial" });
        // Numeric deltas are ADDED to existing values
        ecs.put("final-state", { health: -25 }); // 100 + (-25) = 75
        ecs.put("final-state", { name: "updated" });
        ecs.put("final-state", { health: -25 }); // 75 + (-25) = 50
      });

      expect(mutations.size).toBe(1);
      const mutation = mutations.get("final-state")!;
      expect((mutation.value as any).entity.health).toBe(50); // 100 + (-25) + (-25) = 50
      expect((mutation.value as any).entity.name).toBe("updated");
    });
  });

  describe("Tags", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("should add and check tag on entity", () => {
      const entity = ecs.createEntity();
      expect(ecs.hasTag(entity, 1)).toBe(false);

      ecs.addTag(entity, 1);
      expect(ecs.hasTag(entity, 1)).toBe(true);
      expect(ecs.getTags(entity)).toContain(1);
    });

    test("should remove tag from entity", () => {
      const entity = ecs.createEntity();
      ecs.addTag(entity, 1);
      expect(ecs.hasTag(entity, 1)).toBe(true);

      ecs.removeTag(entity, 1);
      expect(ecs.hasTag(entity, 1)).toBe(false);
    });

    test("should seed tags from entity.tags on insert", () => {
      const entity = ecs.insert({ health: 100, tags: [1, 2] });
      expect(ecs.hasTag(entity.id!, 1)).toBe(true);
      expect(ecs.hasTag(entity.id!, 2)).toBe(true);
      expect(ecs.hasTag(entity.id!, 3)).toBe(false);
    });

    test("should filter entities by tag presence in query", () => {
      const e1 = ecs.createEntity();
      const e2 = ecs.createEntity();
      ecs.addTag(e1, 1);
      ecs.addTag(e2, 2);
      ecs.addTag(e2, 3);

      const results = ecs.query((q: QueryBuilder) => q.everyTag(1));
      expect(results).toContain(e1);
      expect(results).not.toContain(e2);

      const someResults = ecs.query((q: QueryBuilder) => q.someTag(2, 3));
      expect(someResults).toContain(e2);
      expect(someResults).not.toContain(e1);
    });

    test("should query by notTag and noneTag", () => {
      const e1 = ecs.createEntity();
      const e2 = ecs.createEntity();
      ecs.addTag(e1, 1);

      const no1 = ecs.query((q: QueryBuilder) => q.notTag(1));
      expect(no1).toContain(e2);
      expect(no1).not.toContain(e1);

      const noAll = ecs.query((q: QueryBuilder) => q.noneTag(1));
      expect(noAll).toContain(e2);
      expect(noAll).not.toContain(e1);
    });

    test("should query combining components and tags", () => {
      const e1 = ecs.createEntity();
      ecs.addComponent(e1, "health");
      ecs.addTag(e1, 1);

      const e2 = ecs.createEntity();
      ecs.addComponent(e2, "health");
      // no tag

      const e3 = ecs.createEntity();
      ecs.addTag(e3, 1);
      // no health component

      const results = ecs.query((q: QueryBuilder) => q.every(components.health).everyTag(1));
      expect(results).toContain(e1);
      expect(results).not.toContain(e2);
      expect(results).not.toContain(e3);
    });

    test("should run entity system filtered by tags", () => {
      const processed: string[] = [];
      const system = createEntitySystem<
        TestContext,
        [number],
        TestAction,
        number,
        Entity,
        EntityDelta
      >(
        (entities) => {
          processed.push(...entities);
        },
        (q: QueryBuilder) => q.everyTag(1),
      );

      ecs.registerSystem(system);

      const e1 = ecs.createEntity();
      const e2 = ecs.createEntity();
      ecs.addTag(e1, 1);
      // e2 has no tag 1

      ecs.update(16.67);

      expect(processed).toContain(e1);
      expect(processed).not.toContain(e2);
    });

    test("should reconcile tags via put", () => {
      const entity = ecs.insert({ health: 100, tags: [1, 2] });
      expect(ecs.hasTag(entity.id!, 1)).toBe(true);

      // Replace tags with [3]
      ecs.put(entity.id!, { tags: [3] } as unknown as EntityDelta);
      expect(ecs.hasTag(entity.id!, 1)).toBe(false);
      expect(ecs.hasTag(entity.id!, 3)).toBe(true);
    });
  });

  describe("Tags - extended coverage", () => {
    beforeEach(() => {
      ecs.initialize();
    });

    test("getTags returns empty array for entity with no tags", () => {
      const e = ecs.createEntity();
      expect(ecs.getTags(e)).toEqual([]);
    });

    test("getTags and hasTag are defensive on non-existent entity", () => {
      expect(ecs.getTags("non-existent")).toEqual([]);
      expect(ecs.hasTag("non-existent", 1)).toBe(false);
    });

    test("getTags returns all assigned tags", () => {
      const e = ecs.createEntity();
      ecs.addTag(e, 1);
      ecs.addTag(e, 2);
      ecs.addTag(e, 3);
      const tags = ecs.getTags(e);
      expect(tags).toHaveLength(3);
      expect(tags).toContain(1);
      expect(tags).toContain(2);
      expect(tags).toContain(3);
    });

    test("addTag is idempotent", () => {
      const e = ecs.createEntity();
      ecs.addTag(e, 1);
      ecs.addTag(e, 1);
      expect(ecs.getTags(e)).toEqual([1]);
    });

    test("removeTag of absent tag is a no-op", () => {
      const e = ecs.createEntity();
      ecs.addTag(e, 1);
      ecs.removeTag(e, 2);
      expect(ecs.hasTag(e, 1)).toBe(true);
      expect(ecs.getTags(e)).toEqual([1]);
    });

    test("everyTag with multiple tags requires all (AND semantics)", () => {
      const e1 = ecs.createEntity();
      const e2 = ecs.createEntity();
      ecs.addTag(e1, 1);
      ecs.addTag(e1, 2);
      ecs.addTag(e2, 1);

      const results = ecs.query((q: QueryBuilder) => q.everyTag(1, 2));
      expect(results).toContain(e1);
      expect(results).not.toContain(e2);
    });

    test("preserves tags across component add and remove", () => {
      const e = ecs.createEntity();
      ecs.addTag(e, 1);
      ecs.addComponent(e, "health");
      ecs.removeComponent(e, "health");
      expect(ecs.hasTag(e, 1)).toBe(true);
      expect(ecs.getTags(e)).toEqual([1]);
    });

    test("preserves components across tag add and remove", () => {
      const e = ecs.createEntity();
      ecs.addComponent(e, "health");
      ecs.addTag(e, 1);
      ecs.removeTag(e, 1);
      expect(ecs.hasComponent(e, "health")).toBe(true);
    });

    test("prefabricate with tags seeds entity via createEntity", () => {
      const arch = ecs.prefabricate([components.health], [1, 2]);
      const e = ecs.createEntity(arch);
      expect(ecs.hasComponent(e, "health")).toBe(true);
      expect(ecs.hasTag(e, 1)).toBe(true);
      expect(ecs.hasTag(e, 2)).toBe(true);
    });

    test("put with object delta { set: [...] } replaces tags", () => {
      const entity = ecs.insert({ health: 100, tags: [1, 2] });
      expect(ecs.hasTag(entity.id!, 1)).toBe(true);
      expect(ecs.hasTag(entity.id!, 2)).toBe(true);

      ecs.put(entity.id!, { tags: { set: [3] } } as unknown as EntityDelta);
      expect(ecs.hasTag(entity.id!, 1)).toBe(false);
      expect(ecs.hasTag(entity.id!, 2)).toBe(false);
      expect(ecs.hasTag(entity.id!, 3)).toBe(true);
    });

    test("put with object delta { add, remove } reconciles incrementally", () => {
      const entity = ecs.insert({ health: 100, tags: [1, 2] });
      expect(ecs.hasTag(entity.id!, 1)).toBe(true);
      expect(ecs.hasTag(entity.id!, 2)).toBe(true);

      ecs.put(entity.id!, {
        tags: { add: [3], remove: [1] } as { add: number[]; remove: number[] },
      } as unknown as EntityDelta);
      expect(ecs.hasTag(entity.id!, 3)).toBe(true);
      expect(ecs.hasTag(entity.id!, 1)).toBe(false);
      expect(ecs.hasTag(entity.id!, 2)).toBe(true);
    });

    test("put with empty tags array clears all tags", () => {
      const entity = ecs.insert({ health: 100, tags: [1, 2, 3] });
      expect(ecs.getTags(entity.id!)).toHaveLength(3);

      ecs.put(entity.id!, { tags: [] } as unknown as EntityDelta);
      expect(ecs.getTags(entity.id!)).toEqual([]);
    });

    test("same components and tags share one archetype", () => {
      const arch1 = ecs.prefabricate([components.health], [1]);
      const arch2 = ecs.prefabricate([components.health], [1]);
      expect(arch1).toBe(arch2);
    });

    test("event system with everyTag query fires when tag is added", () => {
      const fired: string[] = [];
      const eventSystem = createEventSystem(
        (entities) => {
          fired.push(...entities);
        },
        (q: QueryBuilder) => q.everyTag(1),
      );

      ecs.subscribe(eventSystem);

      const e = ecs.createEntity();
      ecs.addTag(e, 1);
      expect(fired).toContain(e);
    });
  });
});
