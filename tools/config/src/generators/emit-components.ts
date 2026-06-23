import type { SchemaDefinition } from "./parse-bop";

/**
 * Emit the component-id map. Ids are derived from the bebop field tag
 * (`constantValue`), NOT the array position, so they are stable across field
 * reorder/insert/remove and align with the wire format. This is a deliberate,
 * breaking change from the previous positional scheme — see plan 14 §4.6.
 */
export function emitComponents(entity: SchemaDefinition): string {
  const entries: string[] = [];
  for (const f of entity.fields) {
    if (f.name === "tags") continue;
    const tag = f.constantValue;
    if (tag == null) {
      throw new Error(
        `Entity field '${f.name}' has no bebop field tag; cannot derive a stable component id.`,
      );
    }
    entries.push(`${f.name}: ${tag}`);
  }
  return `export const components = { ${entries.join(", ")} } as const satisfies Record<keyof Omit<Entity, "tags">, number>;`;
}
