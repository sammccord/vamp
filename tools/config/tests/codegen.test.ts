import { describe, expect, it } from "vite-plus/test";
import { emitComponents } from "../src/generators/emit-components.js";
import { emitDelta } from "../src/generators/emit-delta.js";
import { emitFactory } from "../src/generators/emit-factory.js";
import { emitClasses } from "../src/generators/emit-classes.ts";
import { emitGameContext } from "../src/generators/emit-game-context.ts";
import type { SchemaDefinition, ParsedSchema } from "../src/generators/parse-bop.js";

const entityDef: SchemaDefinition = {
  name: "Entity",
  kind: "message",
  fields: [
    { name: "id", typeId: -12, isArray: false, isMap: false, typeName: "guid", constantValue: 1 },
    {
      name: "root",
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
    expect(result).toContain("root: 2");
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
    expect(result).toContain("root?: string;");
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
