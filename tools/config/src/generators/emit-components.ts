import type { SchemaDefinition } from "./parse-bop";

export function emitComponents(entity: SchemaDefinition): string {
  const entries: string[] = [];
  for (let i = 0; i < entity.fields.length; i++) {
    if (entity.fields[i].name === "tags") continue;
    entries.push(`${entity.fields[i].name}: ${i}`);
  }
  return `export const components = { ${entries.join(", ")} } as const satisfies Record<keyof Omit<Entity, "tags">, number>;`;
}
