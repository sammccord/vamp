import type { SchemaDefinition } from "./parse-bop";

export function emitComponents(entity: SchemaDefinition): string {
  const entries = entity.fields
    .map((f, i) => `${f.name}: ${i}`)
    .join(", ");
  return `export const components = { ${entries} } as const satisfies Record<keyof Entity, number>;`;
}
