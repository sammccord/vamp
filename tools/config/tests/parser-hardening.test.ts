import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  classifyType,
  extractMessageBody,
  parseEntityMessage,
  parseMessage,
} from "../src/generators/parse-bop-source.js";
import { SCALAR_TYPES, scalarToTs } from "../src/generators/emit-delta.js";
import { SOURCE_ONLY_SCALARS, WireBaseType, scrapeSchema } from "../src/generators/parse-bop.js";
import { loadVampConfig } from "../src/config/loader.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// Fixture 1 — inline message in Entity (4.1)
describe("nested/inline message stripping (4.1)", () => {
  it("does not scrape inner inline-message fields as Entity fields", () => {
    const source = `message Entity {
  1 -> guid id;
  7 -> message Inline { 1 -> uint32 a; } inline;
  2 -> guid root;
}`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entity = parseEntityMessage(source);
    // `a` (index 1 from the inline block) must NOT leak in as an Entity field.
    expect(entity.fields.map((f) => f.name)).not.toContain("a");
    expect(entity.fields.map((f) => f.name)).toContain("id");
    expect(entity.fields.map((f) => f.name)).toContain("root");
    // The duplicate index-1 garbage field must be gone.
    const indices = entity.fields.map((f) => f.index);
    expect(indices.filter((i) => i === 1).length).toBe(1);
    expect(warn).toHaveBeenCalled();
  });
});

// Fixture 2 — regex-special component name (4.2)
describe("regex-escaped / validated message names (4.2)", () => {
  it("does not throw a RegExp SyntaxError for a metacharacter name", () => {
    // An invalid identifier is rejected with a clear error (not a RegExp throw).
    expect(() => extractMessageBody("message Foo { 1 -> guid id; }", "Foo(Bar)")).toThrow(
      /Invalid message name/,
    );
  });

  it("word-boundary anchor: requesting Foo does not match FooBar", () => {
    const src = `message FooBar { 1 -> guid id; }`;
    expect(extractMessageBody(src, "Foo")).toBeNull();
    expect(extractMessageBody(src, "FooBar")).not.toBeNull();
  });

  it("a legal name like V2 matches normally", () => {
    const src = `message V2 { 1 -> float64 x; }`;
    expect(parseMessage(src, "V2")!.fields[0].name).toBe("x");
  });
});

// Fixture 3 & 4 — nested map value & array of custom type classification (4.7 / plan 21 4b)
describe("array/map element classification (4.7, plan 21 4b)", () => {
  it("classifies a map value that is a custom type", () => {
    const c = classifyType("map[guid, Position]");
    expect(c.isMap).toBe(true);
    expect(c.keyType).toBe("guid");
    expect(c.valueType).toBe("Position");
    expect(c.valueClassified?.isScalar).toBe(false);
  });

  it("classifies an array of a custom type", () => {
    const c = classifyType("Position[]");
    expect(c.isArray).toBe(true);
    expect(c.memberType).toBe("Position");
    expect(c.memberClassified?.isScalar).toBe(false);
  });

  it("recursively classifies nested map and array values", () => {
    const nestedMap = classifyType("map[guid, map[guid, Pool]]");
    expect(nestedMap.valueClassified?.isMap).toBe(true);

    const mapOfArray = classifyType("map[guid, guid[]]");
    expect(mapOfArray.valueClassified?.isArray).toBe(true);
    expect(mapOfArray.valueClassified?.isScalar).toBe(true);
  });

  it("still parses the example map[guid, MutationRecord]", () => {
    const c = classifyType("map[guid, MutationRecord]");
    expect(c.isMap).toBe(true);
    expect(c.valueType).toBe("MutationRecord");
  });
});

// Fixture 6 — malformed BEBOP_SCHEMA bytes (4.3)
describe("BEBOP_SCHEMA byte validation (4.3)", () => {
  it("throws naming the bad token on a non-numeric byte", () => {
    const content = `export const BEBOP_SCHEMA = new Uint8Array([1, 2, 12x, 4])`;
    expect(() => scrapeSchema(content, "bebop.ts")).toThrow(/12x.*not an integer in 0-255/);
  });

  it("tolerates a trailing comma", () => {
    const content = `export const BEBOP_SCHEMA = new Uint8Array([1, 2, 3,])`;
    const bytes = scrapeSchema(content, "bebop.ts");
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("throws on an out-of-range byte (no silent NaN->0)", () => {
    const content = `export const BEBOP_SCHEMA = new Uint8Array([1, 999, 3])`;
    expect(() => scrapeSchema(content, "bebop.ts")).toThrow(/999.*0-255/);
  });
});

// Fixture 7 — malformed jsonc (4.8)
describe("jsonc parse error surfacing (4.8)", () => {
  it("throws with a parse-error offset for a malformed vamp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "vamp-cfg-"));
    // Missing closing brace / value -> jsonc records an error.
    writeFileSync(join(dir, "vamp.json"), `{ "schemas": { "entity": } }`, "utf-8");
    expect(() => loadVampConfig(dir)).toThrow(/Failed to parse.*vamp\.json/);
  });
});

// Fixture 9 — array delta materialize parity (4.5) is asserted in scaffolding/round-trip
// via emitHelpers; here we assert the generated source IMPORTS the shared applier
// from `@vamp/ecs` (the canonical algebra now lives there, not inlined) and uses
// it from materializeDelta.
describe("materializeDelta array parity (4.5)", () => {
  it("imports and uses the shared applyArrayDelta helper", async () => {
    const { emitHelpers, emitHelperImports } = await import("../src/generators/emit-helpers.js");
    const entity = {
      name: "Entity",
      kind: "message" as const,
      fields: [
        {
          name: "children",
          typeId: 1,
          isArray: true,
          isMap: false,
          typeName: "array",
          memberTypeName: "guid",
          constantValue: 5,
        },
      ],
    };
    const schema = { definitions: new Map([["Entity", entity]]) };
    const out = emitHelpers(entity, schema);
    const imports = emitHelperImports(entity, schema);
    // No longer inlined: the algebra is a runtime import, not a generated function body.
    expect(out).not.toContain("function applyArrayDelta");
    expect(imports).toContain("applyArrayDelta");
    expect(imports).toContain('from "@vamp/ecs"');
    expect(out).toContain("children: applyArrayDelta(base?.children ?? [], delta.children)");
  });
});

// Fixture 10 — component ids tag-derived (4.6)
describe("component ids tag-derived (4.6)", () => {
  it("a field's id is its bebop tag, stable under reorder", async () => {
    const { emitComponents } = await import("../src/generators/emit-components.js");
    const mk = (fields: any[]) => ({ name: "Entity", kind: "message" as const, fields });
    const a = emitComponents(
      mk([
        {
          name: "id",
          typeId: -12,
          isArray: false,
          isMap: false,
          typeName: "guid",
          constantValue: 1,
        },
        {
          name: "health",
          typeId: 0,
          isArray: false,
          isMap: false,
          typeName: "Pool",
          constantValue: 6,
        },
      ]),
    );
    // Reordered field array, same tags -> same ids.
    const b = emitComponents(
      mk([
        {
          name: "health",
          typeId: 0,
          isArray: false,
          isMap: false,
          typeName: "Pool",
          constantValue: 6,
        },
        {
          name: "id",
          typeId: -12,
          isArray: false,
          isMap: false,
          typeName: "guid",
          constantValue: 1,
        },
      ]),
    );
    expect(a).toContain("id: 1");
    expect(a).toContain("health: 6");
    expect(b).toContain("id: 1");
    expect(b).toContain("health: 6");
  });
});

// Fixture 11 — vocabulary drift guard (4.9)
describe("single scalar vocabulary (4.9)", () => {
  it("every WireBaseType name is in SCALAR_TYPES and has a scalarToTs case", () => {
    for (const name of Object.values(WireBaseType)) {
      expect(SCALAR_TYPES.has(name)).toBe(true);
      // scalarToTs must not fall through to the identity default for a scalar.
      const ts = scalarToTs(name);
      expect(["number", "bigint", "boolean", "string", "Date"]).toContain(ts);
    }
  });

  it("source-only scalars (uint8) are recognized", () => {
    for (const name of SOURCE_ONLY_SCALARS) {
      expect(SCALAR_TYPES.has(name)).toBe(true);
    }
  });
});
