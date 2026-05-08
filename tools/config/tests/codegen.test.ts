import { describe, expect, it } from "vite-plus/test";
import { emitComponents } from "../src/generators/emit-components.js";
import { emitDelta } from "../src/generators/emit-delta.js";
import { emitFactory } from "../src/generators/emit-factory.js";
import { emitClasses } from "../src/generators/emit-classes.ts";
import type { SchemaDefinition, ParsedSchema } from "../src/generators/parse-bop.js";

const entityDef: SchemaDefinition = {
  name: "Entity",
  kind: "message",
  fields: [
    { name: "id", typeId: -12, isArray: false, isMap: false, typeName: "guid" },
    { name: "root", typeId: -12, isArray: false, isMap: false, typeName: "guid" },
    { name: "parent", typeId: -12, isArray: false, isMap: false, typeName: "guid" },
    {
      name: "children",
      typeId: -14,
      isArray: true,
      isMap: false,
      typeName: "array",
      memberTypeName: "guid",
    },
    { name: "health", typeId: 0, isArray: false, isMap: false, typeName: "pool" },
  ],
};

const schema: ParsedSchema = {
  definitions: new Map([
    ["Entity", entityDef],
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
  it("generates component ID map", () => {
    const result = emitComponents(entityDef);
    expect(result).toContain("id: 0");
    expect(result).toContain("root: 1");
    expect(result).toContain("parent: 2");
    expect(result).toContain("children: 3");
    expect(result).toContain("health: 4");
    expect(result).toContain("satisfies Record<keyof Entity, number>");
  });
});

describe("emitDelta", () => {
  it("generates correct delta types for primitives", () => {
    const result = emitDelta(entityDef, schema);
    expect(result).toContain("id?: string;");
    expect(result).toContain("root?: string;");
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
  it("generates typed DO aliases", () => {
    const result = emitClasses();
    expect(result).toContain("GameECS");
    expect(result).toContain("GameStorage");
    expect(result).toContain("ECSDurableObject");
    expect(result).toContain("ECSStorage<Entity>");
  });
});
