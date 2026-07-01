import { describe, expect, it } from "vite-plus/test";
import { emitComponents } from "../src/generators/emit-components.js";
import { emitDelta } from "../src/generators/emit-delta.js";
import { emitFactory } from "../src/generators/emit-factory.js";
import { emitClasses } from "../src/generators/emit-classes.ts";
import { emitGameContext } from "../src/generators/emit-game-context.ts";
import { emitSystems } from "../src/generators/emit-systems.ts";
import type { SchemaDefinition, ParsedSchema } from "../src/generators/parse-bop.js";

const entityDef: SchemaDefinition = {
  name: "Entity",
  kind: "message",
  fields: [
    { name: "id", typeId: -12, isArray: false, isMap: false, typeName: "guid", constantValue: 1 },
    {
      name: "sk",
      typeId: -12,
      isArray: false,
      isMap: false,
      typeName: "guid",
      constantValue: 2,
    },
    {
      name: "tags",
      typeId: 1,
      isArray: true,
      isMap: false,
      typeName: "array",
      memberTypeName: "Tags",
      constantValue: 3,
    },
    {
      name: "parent",
      typeId: -12,
      isArray: false,
      isMap: false,
      typeName: "guid",
      constantValue: 4,
    },
    {
      name: "children",
      typeId: -14,
      isArray: true,
      isMap: false,
      typeName: "array",
      memberTypeName: "guid",
      constantValue: 5,
    },
    {
      name: "health",
      typeId: 0,
      isArray: false,
      isMap: false,
      typeName: "pool",
      constantValue: 6,
    },
  ],
};

const schema: ParsedSchema = {
  definitions: new Map([
    ["Entity", entityDef],
    [
      "Tags",
      {
        name: "Tags",
        kind: "enum",
        fields: [],
      },
    ],
    [
      "pool",
      {
        name: "pool",
        kind: "message",
        fields: [
          { name: "points", typeId: -5, isArray: false, isMap: false, typeName: "uint32" },
          { name: "min", typeId: -5, isArray: false, isMap: false, typeName: "uint32" },
          { name: "max", typeId: -5, isArray: false, isMap: false, typeName: "uint32" },
        ],
      },
    ],
    [
      "poolDelta",
      {
        name: "poolDelta",
        kind: "message",
        fields: [
          { name: "points", typeId: -6, isArray: false, isMap: false, typeName: "int32" },
          { name: "min", typeId: -6, isArray: false, isMap: false, typeName: "int32" },
          { name: "max", typeId: -6, isArray: false, isMap: false, typeName: "int32" },
        ],
      },
    ],
  ]),
};

describe("emitComponents", () => {
  it("generates a tag-derived component ID map skipping tags field", () => {
    const result = emitComponents(entityDef);
    // Ids derive from the bebop field tag (constantValue), not array position.
    expect(result).toContain("id: 1");
    expect(result).toContain("sk: 2");
    expect(result).toContain("parent: 4");
    expect(result).toContain("children: 5");
    expect(result).toContain("health: 6");
    expect(result).toContain('satisfies Record<keyof Omit<Entity, "tags">, number>');
  });

  it("throws when a field has no bebop tag", () => {
    const noTag: SchemaDefinition = {
      name: "Entity",
      kind: "message",
      fields: [{ name: "id", typeId: -12, isArray: false, isMap: false, typeName: "guid" }],
    };
    expect(() => emitComponents(noTag)).toThrow(/no bebop field tag/);
  });
});

describe("emitDelta", () => {
  it("generates correct delta types for primitives", () => {
    const result = emitDelta(entityDef, schema);
    expect(result).toContain("id?: string;");
    expect(result).toContain("sk?: string;");
    expect(result).toContain("tags?: Tags[];");
    expect(result).toContain("parent?: string;");
  });

  it("generates CRDT-style delta for arrays", () => {
    const result = emitDelta(entityDef, schema);
    expect(result).toContain("children?: { set?: string[]; add?: string[]; remove?: string[] }");
  });

  it("uses delta type when available", () => {
    const result = emitDelta(entityDef, schema);
    expect(result).toContain("health?: poolDelta;");
  });
});

describe("emitFactory", () => {
  it("generates factory function", () => {
    const result = emitFactory();
    expect(result).toContain("createECSOptions");
    expect(result).toContain("ECSOptions<Entity, EntityDelta>");
  });
});

describe("emitTypedClasses", () => {
  it("generates typed DO aliases with given tags type", () => {
    const result = emitClasses("Tags");
    expect(result).toContain("GameECS");
    expect(result).toContain("GameStorage");
    expect(result).toContain("ECSDurableObject");
    expect(result).toContain("ECSStorage<Entity>");
    expect(result).toMatch(/,(\s*)Tags,/);
  });

  it("defaults to number when no tags type given", () => {
    const result = emitClasses();
    expect(result).toMatch(/,(\s*)number,/);
  });

  it("exposes an overridable Env generic defaulting to Cloudflare.Env", () => {
    const result = emitClasses("Tags");
    expect(result).toContain("Env = Cloudflare.Env,");
    // Env is threaded through to ECSDurableObject (not the literal Cloudflare.Env).
    expect(result).toMatch(/EntityDelta,\s*Env\s*>\s*\{\}/);
    expect(result).not.toContain("EntityDelta,\n    Cloudflare.Env");
  });

  it("uses a custom env type when provided", () => {
    const result = emitClasses("Tags", "unknown");
    expect(result).toContain("Env = unknown,");
    expect(result).not.toContain("Cloudflare.Env,");
  });
});

describe("emitGameContext", () => {
  it("exports a GameContext alias over RPCContext for service environments", () => {
    const result = emitGameContext();
    expect(result).toContain("export type GameContext");
    expect(result).toContain(
      "RPCContext<UserSession, Context, UpdateArguments, Actions, Tags, Entity, EntityDelta>",
    );
  });
});

describe("emitSystems", () => {
  const result = emitSystems();

  it("bakes concrete Actions/Tags/Entity/EntityDelta into each generic system alias", () => {
    expect(result).toContain(
      "export type GameEntitySystem<\n  State extends Record<string, unknown> = {},\n  UpdateArguments extends Array<unknown> = [],\n> = EntitySystem<State, UpdateArguments, Actions, Tags, Entity, EntityDelta>;",
    );
    expect(result).toContain(
      "> = ArchetypeSystem<State, UpdateArguments, Actions, Tags, Entity, EntityDelta>;",
    );
    expect(result).toContain(
      "> = Behavior<State, UpdateArguments, Actions, Tags, Entity, EntityDelta>;",
    );
    expect(result).toContain(
      "> = System<State, UpdateArguments, Actions, Tags, Entity, EntityDelta>;",
    );
  });

  it("emits create wrappers that keep State/UpdateArguments open and reuse the alias param types", () => {
    expect(result).toContain("export function createGameEntitySystem<");
    expect(result).toContain('execute: GameEntitySystem<State, UpdateArguments>["execute"],');
    expect(result).toContain("return createEntitySystem(execute, query);");

    expect(result).toContain("export function createGameArchetypeSystem<");
    expect(result).toContain("return createArchetypeSystem(execute, query);");

    expect(result).toContain("export function createGameBehavior<");
    expect(result).toContain('handler: GameBehavior<State, UpdateArguments>["handler"],');
    expect(result).toContain("return createBehavior(tag, handler, query, priority);");
  });
});

describe("jsdoc on public exports", () => {
  // Assert every top-level `export <kw> <name>` in `src` is immediately preceded
  // by a JSDoc block — the line above ends a comment (single- or multi-line).
  const eachExportHasJsdoc = (src: string): void => {
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^export (?:const|type|function|class) (\w+)/.exec(lines[i]!);
      if (!m) continue;
      const prev = lines[i - 1]?.trim() ?? "";
      expect(prev.endsWith("*/"), `export ${m[1]} should be preceded by JSDoc`).toBe(true);
    }
  };

  it("documents the component map, delta type, and delta helpers", () => {
    eachExportHasJsdoc(emitComponents(entityDef));
    eachExportHasJsdoc(emitDelta(entityDef, schema));
  });

  it("documents the factory, durable-object classes, and context alias", () => {
    eachExportHasJsdoc(emitFactory());
    eachExportHasJsdoc(emitClasses("Tags"));
    eachExportHasJsdoc(emitGameContext());
  });

  it("documents every generated system alias and factory", () => {
    const result = emitSystems();
    eachExportHasJsdoc(result);
    // 4 aliases + 3 factories, each with its own block.
    expect((result.match(/\/\*\*/g) ?? []).length).toBe(7);
  });
});
