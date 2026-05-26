import type { ParsedSchema, SchemaDefinition, SchemaField } from "./parse-bop";

const SCALAR_TYPES = new Set([
  "bool",
  "byte",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "int64",
  "uint64",
  "float32",
  "float64",
  "string",
  "guid",
  "date",
]);

export function scalarToTs(type: string): string {
  switch (type) {
    case "bool":
      return "boolean";
    case "byte":
    case "uint8":
    case "int16":
    case "uint16":
    case "int32":
    case "uint32":
    case "float32":
    case "float64":
      return "number";
    case "int64":
    case "uint64":
      return "bigint";
    case "string":
    case "guid":
      return "string";
    case "date":
      return "Date";
    default:
      return type;
  }
}

export function isScalar(typeName: string): boolean {
  return SCALAR_TYPES.has(typeName);
}

export function deltaTypeForField(field: SchemaField, schema: ParsedSchema): string {
  if (field.isArray) {
    const itemType = scalarToTs(field.memberTypeName!);
    return `{ set?: ${itemType}[]; add?: ${itemType}[]; remove?: ${itemType}[] }`;
  }

  if (isScalar(field.typeName)) {
    return scalarToTs(field.typeName);
  }

  // Check if there's a <Name>Delta definition
  const deltaName = `${field.typeName}Delta`;
  if (schema.definitions.has(deltaName)) {
    return deltaName;
  }

  return `Partial<${field.typeName}>`;
}

export function emitDelta(entity: SchemaDefinition, schema: ParsedSchema): string {
  const fields = entity.fields
    .map((f) => `  ${f.name}?: ${deltaTypeForField(f, schema)};`)
    .join("\n");
  return `export type EntityDelta = {\n${fields}\n};`;
}
