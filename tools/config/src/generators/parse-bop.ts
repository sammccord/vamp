import { readFileSync } from "node:fs";
import { BinarySchema } from "bebop";

// Re-export for codegen consumers
export type { BinarySchema };

// WireBaseType values from bebop binary.ts. This is the canonical wire-level
// scalar vocabulary; `emit-delta.ts` derives its SCALAR_TYPES set from these
// names so the two modules can never silently drift (see the drift-guard test).
export const WireBaseType: Record<number, string> = {
  [-1]: "bool",
  [-2]: "byte",
  [-3]: "uint16",
  [-4]: "int16",
  [-5]: "uint32",
  [-6]: "int32",
  [-7]: "uint64",
  [-8]: "int64",
  [-9]: "float32",
  [-10]: "float64",
  [-11]: "string",
  [-12]: "guid",
  [-13]: "date",
};

/**
 * Scalar type names that only appear in *source* form (never as a distinct
 * wire base type). `uint8` is a bebop alias for `byte`; both are accepted in
 * `.bop` source but compile to the same wire type.
 */
export const SOURCE_ONLY_SCALARS: readonly string[] = ["uint8"];

// WireTypeKind
const WireTypeKind = {
  Struct: 1,
  Message: 2,
  Union: 3,
  Enum: 4,
} as const;

export interface SchemaField {
  name: string;
  typeId: number;
  isArray: boolean;
  isMap: boolean;
  /** For scalars, the scalar type name. For definitions, the definition name. */
  typeName: string;
  /** For arrays, the member type name */
  memberTypeName?: string;
  /** For maps, the key type name */
  keyTypeName?: string;
  /** For maps, the value type name */
  valueTypeName?: string;
  /** Bebop field tag (for messages) */
  constantValue?: number | null;
}

export interface SchemaDefinition {
  name: string;
  kind: "struct" | "message" | "union" | "enum";
  fields: SchemaField[];
  /** For unions: branch info */
  branches?: { discriminator: number; typeName: string }[];
}

export interface ParsedSchema {
  definitions: Map<string, SchemaDefinition>;
}

function resolveTypeName(typeId: number, schema: BinarySchema): string {
  if (typeId < 0) {
    return WireBaseType[typeId] ?? `unknown(${typeId})`;
  }
  return schema.getDefinition(typeId).name;
}

function parseField(name: string, field: any, schema: BinarySchema): SchemaField {
  const props = field.fieldProperties;
  const isArray = props.type === "array";
  const isMap = props.type === "map";

  let typeName: string;
  let memberTypeName: string | undefined;
  let keyTypeName: string | undefined;
  let valueTypeName: string | undefined;

  if (isArray) {
    typeName = "array";
    memberTypeName = resolveTypeName(props.memberTypeId, schema);
  } else if (isMap) {
    typeName = "map";
    keyTypeName = resolveTypeName(props.keyTypeId, schema);
    valueTypeName = resolveTypeName(props.valueTypeId, schema);
  } else {
    typeName = resolveTypeName(field.typeId, schema);
  }

  return {
    name,
    typeId: field.typeId,
    isArray,
    isMap,
    typeName,
    memberTypeName,
    keyTypeName,
    valueTypeName,
    constantValue: field.constantValue,
  };
}

export function parseSchema(bebopSchemaBytes: Uint8Array): ParsedSchema {
  const schema = new BinarySchema(bebopSchemaBytes);
  schema.get();
  const ast = schema.ast;
  const definitions = new Map<string, SchemaDefinition>();

  for (const [name, def] of Object.entries(ast.definitions)) {
    if (def.kind === WireTypeKind.Enum) {
      definitions.set(name, { name, kind: "enum", fields: [] });
      continue;
    }

    if (def.kind === WireTypeKind.Union) {
      const union = def as any;
      const branches = (union.branches as any[]).map((b) => ({
        discriminator: b.discriminator,
        typeName: schema.getDefinition(b.typeId).name,
      }));
      definitions.set(name, { name, kind: "union", fields: [], branches });
      continue;
    }

    const kind = def.kind === WireTypeKind.Struct ? "struct" : "message";
    const fields: SchemaField[] = [];
    const defWithFields = def as any;
    if (defWithFields.fields) {
      for (const [fieldName, field] of Object.entries(defWithFields.fields)) {
        fields.push(parseField(fieldName, field, schema));
      }
    }
    definitions.set(name, { name, kind, fields });
  }

  return { definitions };
}

/**
 * Recover the compiled `BEBOP_SCHEMA` byte array from a generated `bebop.ts`.
 *
 * Every token is validated to be an integer in 0-255; a non-numeric token, a
 * trailing comma, or any format drift throws (naming the bad token) instead of
 * silently coercing `NaN` to `0` and corrupting the binary schema.
 */
export function scrapeSchema(content: string, path: string): Uint8Array {
  const match = content.match(
    /export const BEBOP_SCHEMA\s*=\s*new Uint8Array\s*\(\s*\[\s*([\s\S]*?)\s*\]\s*\)/,
  );
  if (!match) {
    throw new Error(`Could not find BEBOP_SCHEMA in ${path}`);
  }
  const tokens = match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0); // tolerate a trailing comma
  const bytes = tokens.map((s, i) => {
    // `Number` (not `parseInt`) so "12x" yields NaN and trips the guard rather
    // than parseInt's lenient `12`.
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(
        `BEBOP_SCHEMA byte ${i} ('${s}') in ${path} is not an integer in 0-255; the ` +
          `generated schema is corrupt — re-run bebopc build.`,
      );
    }
    return n;
  });
  return new Uint8Array(bytes);
}

export function loadSchemaFromFile(bebopTsPath: string): Uint8Array {
  const content = readFileSync(bebopTsPath, "utf-8");
  return scrapeSchema(content, bebopTsPath);
}

export function loadAndParseSchema(bebopTsPath: string): ParsedSchema {
  return parseSchema(loadSchemaFromFile(bebopTsPath));
}
