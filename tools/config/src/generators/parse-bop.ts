import { readFileSync } from "node:fs";
import { BinarySchema } from "bebop";

// Re-export for codegen consumers
export type { BinarySchema };

// WireBaseType values from bebop binary.ts
const WireBaseType: Record<number, string> = {
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

  if (isArray) {
    typeName = "array";
    memberTypeName = resolveTypeName(props.memberTypeId, schema);
  } else if (isMap) {
    typeName = "map";
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

export function loadSchemaFromFile(bebopTsPath: string): Uint8Array {
  const content = readFileSync(bebopTsPath, "utf-8");
  // Extract the BEBOP_SCHEMA array from the generated TS file
  const match = content.match(
    /export const BEBOP_SCHEMA\s*=\s*new Uint8Array\s*\(\s*\[\s*([\s\S]*?)\s*\]\s*\)/,
  );
  if (!match) {
    throw new Error(`Could not find BEBOP_SCHEMA in ${bebopTsPath}`);
  }
  const bytes = match[1].split(",").map((s) => parseInt(s.trim(), 10));
  return new Uint8Array(bytes);
}

export function loadAndParseSchema(bebopTsPath: string): ParsedSchema {
  return parseSchema(loadSchemaFromFile(bebopTsPath));
}
