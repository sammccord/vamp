import { describe, expect, it } from "vite-plus/test";
import { emitDelta, scalarToTs } from "../src/generators/emit-delta.js";
import { emitHelpers } from "../src/generators/emit-helpers.js";
import { emitMutationSchema, planMutationSchema } from "../src/generators/emit-mutation-bop.js";
import { parseEntityMessage, parseMessage } from "../src/generators/parse-bop-source.js";
import type { ParsedSchema, SchemaDefinition } from "../src/generators/parse-bop.js";

// --- Plan 10 Case A: float64 maps to number, not bigint ---

describe("scalarToTs (1a float64)", () => {
  it("maps float64 (and float32) to number", () => {
    expect(scalarToTs("float64")).toBe("number");
    expect(scalarToTs("float32")).toBe("number");
  });

  it("keeps only 64-bit integers as bigint", () => {
    expect(scalarToTs("int64")).toBe("bigint");
    expect(scalarToTs("uint64")).toBe("bigint");
  });

  it("maps small ints to number", () => {
    for (const t of ["byte", "uint8", "int16", "uint16", "int32", "uint32"]) {
      expect(scalarToTs(t)).toBe("number");
    }
  });
});

/** Build a ParsedSchema fixture for emitDelta/emitHelpers with the given Entity fields. */
function schemaFixture(
  entityFields: SchemaDefinition["fields"],
  extra: Array<[string, SchemaDefinition]> = [],
): { entity: SchemaDefinition; schema: ParsedSchema } {
  const entity: SchemaDefinition = { name: "Entity", kind: "message", fields: entityFields };
  const schema: ParsedSchema = {
    definitions: new Map<string, SchemaDefinition>([
      ["Entity", entity],
      ["Tags", { name: "Tags", kind: "enum", fields: [] }],
      ...extra,
    ]),
  };
  return { entity, schema };
}

describe("emitDelta with a float64 field (Case A)", () => {
  it("emits `mass?: number;` not `bigint`", () => {
    const { entity, schema } = schemaFixture([
      { name: "id", typeId: -12, isArray: false, isMap: false, typeName: "guid", constantValue: 1 },
      {
        name: "mass",
        typeId: -10,
        isArray: false,
        isMap: false,
        typeName: "float64",
        constantValue: 7,
      },
    ]);
    const out = emitDelta(entity, schema);
    expect(out).toContain("mass?: number;");
    expect(out).not.toContain("mass?: bigint;");
  });

  it("materializeDelta defaults the float64 field to 0", () => {
    const { entity, schema } = schemaFixture([
      {
        name: "mass",
        typeId: -10,
        isArray: false,
        isMap: false,
        typeName: "float64",
        constantValue: 7,
      },
    ]);
    const out = emitHelpers(entity, schema);
    expect(out).toContain("mass: delta.mass ?? base?.mass ?? 0");
  });
});

// --- Plan 10 Case B: custom non-pool component WITH user-supplied delta ---

const POSITION_SOURCE = `
message Position {
  1 -> float64 x;
  2 -> float64 y;
  3 -> float64 z;
}
message PositionDelta {
  1 -> int32 x;
  2 -> int32 y;
  3 -> int32 z;
}
message Entity {
  1 -> guid id;
  7 -> Position pos;
}
`;

describe("custom component with user-supplied delta (Case B)", () => {
  it("reuses PositionDelta verbatim, does not re-synthesize", () => {
    const entity = parseEntityMessage(POSITION_SOURCE);
    const out = emitMutationSchema(
      entity,
      "./entity.bop",
      new Set(["PositionDelta"]),
      new Map([["Position", parseMessage(POSITION_SOURCE, "Position")!]]),
    );
    expect(out).toContain("7 -> PositionDelta pos;");
    // Only ONE PositionDelta message block (user's), no synthesized duplicate.
    const occurrences = out.split("message PositionDelta").length - 1;
    expect(occurrences).toBe(0); // not re-emitted by the mutation schema (user supplies it)
  });
});

// --- Plan 10 Case C: custom component WITHOUT a delta -> synthesized ---

describe("custom component without a delta (Case C synthesis)", () => {
  it("synthesizes message PositionDelta with signed-delta fields", () => {
    const entity = parseEntityMessage(POSITION_SOURCE);
    const out = emitMutationSchema(
      entity,
      "./entity.bop",
      new Set(), // no PositionDelta supplied
      new Map([["Position", parseMessage(POSITION_SOURCE, "Position")!]]),
    );
    expect(out).toContain("message PositionDelta {");
    // float64 numeric fields become int32 signed deltas (CRDT counter policy).
    expect(out).toContain("1 -> int32 x;");
    expect(out).toContain("2 -> int32 y;");
    expect(out).toContain("3 -> int32 z;");
    expect(out).toContain("7 -> PositionDelta pos;");
  });
});

// --- Plan 10 Case D: custom component that cannot be resolved -> throws ---

describe("unresolved custom component (Case D loud failure)", () => {
  it("throws naming the field, type, delta, and schema path", () => {
    const source = `message Entity {
  1 -> guid id;
  7 -> Foo foo;
}`;
    const entity = parseEntityMessage(source);
    expect(() =>
      emitMutationSchema(entity, "./entity.bop", new Set(), new Map(), "/proj/schema/entity.bop"),
    ).toThrow(/foo.*Foo.*FooDelta.*\/proj\/schema\/entity\.bop/s);
  });

  it("planMutationSchema also throws for a non-numeric component without a delta", () => {
    const source = `message Stats {
  1 -> string name;
  2 -> uint32 level;
}
message Entity {
  1 -> guid id;
  7 -> Stats stats;
}`;
    const entity = parseEntityMessage(source);
    expect(() =>
      planMutationSchema(
        entity,
        new Set(),
        new Map([["Stats", parseMessage(source, "Stats")!]]),
        "/proj/schema/entity.bop",
      ),
    ).toThrow(/non-numeric/);
  });
});

// --- emit-delta now throws (no Partial fallback) when delta missing in TS schema ---

describe("emitDelta reconciliation (Step 4, no Partial fallback)", () => {
  it("throws when a custom field's <Type>Delta is absent from the compiled schema", () => {
    const { entity, schema } = schemaFixture(
      [
        {
          name: "pos",
          typeId: 5,
          isArray: false,
          isMap: false,
          typeName: "Position",
          constantValue: 7,
        },
      ],
      [["Position", { name: "Position", kind: "message", fields: [] }]],
    );
    expect(() => emitDelta(entity, schema)).toThrow(/No 'PositionDelta' found/);
  });

  it("resolves to the named delta type when present", () => {
    const { entity, schema } = schemaFixture(
      [
        {
          name: "pos",
          typeId: 5,
          isArray: false,
          isMap: false,
          typeName: "Position",
          constantValue: 7,
        },
      ],
      [
        ["Position", { name: "Position", kind: "message", fields: [] }],
        ["PositionDelta", { name: "PositionDelta", kind: "message", fields: [] }],
      ],
    );
    expect(emitDelta(entity, schema)).toContain("pos?: PositionDelta;");
  });
});
