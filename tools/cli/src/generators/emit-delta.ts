import type { ParsedSchema, SchemaDefinition, SchemaField } from "./parse-bop";
import { SOURCE_ONLY_SCALARS, WireBaseType } from "./parse-bop";

/**
 * Canonical scalar vocabulary, derived from the single source of truth
 * (`WireBaseType` in parse-bop.ts) plus the source-only aliases. Deriving it
 * here — rather than re-declaring a parallel list — guarantees the parser and
 * the emitter agree on what counts as a scalar. A drift-guard test asserts
 * every `WireBaseType` name also has a `scalarToTs` case.
 */
export const SCALAR_TYPES: ReadonlySet<string> = new Set([
  ...Object.values(WireBaseType),
  ...SOURCE_ONLY_SCALARS,
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
    // bebop emits float64 as `number` (DataView.getFloat64); only 64-bit ints are bigint.
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

  // A `<Type>Delta` must exist for every custom component — either user-supplied
  // or synthesized by the mutation-schema step (see emit-mutation-bop.ts). Never
  // fall back to `Partial<Type>`, which would silently diverge from the bebop
  // wire type. If it is missing, the mutation-schema/bebopc step did not run or
  // failed; fail loudly rather than emit a contradictory TS type.
  const deltaName = `${field.typeName}Delta`;
  if (schema.definitions.has(deltaName)) {
    return deltaName;
  }
  throw new Error(
    `No '${deltaName}' found in the compiled schema for Entity field '${field.name}'. ` +
      `The mutation schema generation step should have produced it; re-run 'vamp generate'.`,
  );
}

export function emitDelta(entity: SchemaDefinition, schema: ParsedSchema): string {
  const fields = entity.fields
    .map((f) => {
      if (f.name === "tags") return "  tags?: Tags[];";
      return `  ${f.name}?: ${deltaTypeForField(f, schema)};`;
    })
    .join("\n");
  return `/**
 * Partial, CRDT-style mutation over an {@link Entity}: scalars are
 * last-writer-wins, array fields carry \`set\`/\`add\`/\`remove\`, and pool/vector
 * fields use additive \`*Delta\` counters. Apply with {@link materializeDelta} or
 * {@link mergeDelta}; combine with {@link accumulateDelta}.
 */
export type EntityDelta = {\n${fields}\n};`;
}
