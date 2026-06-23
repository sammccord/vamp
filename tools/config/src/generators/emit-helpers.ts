import type { ParsedSchema, SchemaDefinition, SchemaField } from "./parse-bop";
import { isScalar } from "./emit-delta";

function hasDeltaDef(field: SchemaField, schema: ParsedSchema): boolean {
  return schema.definitions.has(`${field.typeName}Delta`);
}

/** True when the entity has at least one array field (so the shared array applier is needed). */
function needsArrayHelper(entity: SchemaDefinition): boolean {
  return entity.fields.some((f) => f.isArray);
}

/** Type-correct default literal for a component sub-field (used by materializeDelta). */
function defaultForField(bf: SchemaField): string {
  if (bf.isArray) return "[]";
  if (isScalar(bf.typeName)) {
    if (bf.typeName === "string" || bf.typeName === "guid") return "''";
    if (bf.typeName === "bool") return "false";
    if (bf.typeName === "date") return "new Date(0)";
    return "0"; // numeric scalars (incl. float64 after plan 10)
  }
  return "undefined as any"; // nested custom — no safe literal; leave to base
}

export function emitHelpers(entity: SchemaDefinition, schema: ParsedSchema): string {
  return [
    emitArrayHelper(entity),
    emitPoolHelper(entity, schema),
    emitMaterializeDelta(entity, schema),
    emitMergeDelta(entity, schema),
    emitAccumulateDelta(entity, schema),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Shared array-delta applier so `materializeDelta` and `mergeDelta` agree on
 * set/add/remove semantics (plan 14 §4.5). Only emitted when the entity has an
 * array field.
 */
function emitArrayHelper(entity: SchemaDefinition): string {
  if (!needsArrayHelper(entity)) return "";
  return `function applyArrayDelta<T>(base: T[], d?: { set?: T[]; add?: T[]; remove?: T[] }): T[] {
  if (!d) return base;
  if (d.set) return d.set;
  let out = base.slice();
  if (d.add) for (const x of d.add) if (!out.includes(x)) out.push(x);
  if (d.remove) out = out.filter((x) => !d.remove!.includes(x));
  return out;
}`;
}

function needsPoolHelper(entity: SchemaDefinition, schema: ParsedSchema): boolean {
  return entity.fields.some((f) => !f.isArray && !isScalar(f.typeName) && hasDeltaDef(f, schema));
}

function emitPoolHelper(entity: SchemaDefinition, schema: ParsedSchema): string {
  if (!needsPoolHelper(entity, schema)) return "";
  return `function applyPoolDelta<T>(base: T, delta: Record<string, number>): T {
  const result = { ...base } as Record<string, number>;
  for (const key in delta) {
    if (delta[key] !== undefined) {
      result[key] = (result[key] ?? 0) + delta[key];
    }
  }
  return result as unknown as T;
}`;
}

function emitMaterializeDelta(entity: SchemaDefinition, schema: ParsedSchema): string {
  const assignments = entity.fields.map((f) => {
    if (f.name === "tags") {
      return `    tags: delta.tags ?? base?.tags ?? []`;
    }
    if (f.isArray) {
      // Honor set/add/remove (matches mergeDelta) via the shared applier.
      return `    ${f.name}: applyArrayDelta(base?.${f.name} ?? [], delta.${f.name})`;
    }
    if (!isScalar(f.typeName) && hasDeltaDef(f, schema)) {
      const baseMsg = schema.definitions.get(f.typeName);
      const defaultFields = baseMsg
        ? baseMsg.fields.map((bf) => `${bf.name}: ${defaultForField(bf)}`).join(", ")
        : "";
      return `    ${f.name}: delta.${f.name} ? applyPoolDelta(base?.${f.name} ?? { ${defaultFields} }, delta.${f.name} as Record<string, number>) : base?.${f.name} ?? { ${defaultFields} }`;
    }
    if (isScalar(f.typeName)) {
      const defaultVal = f.typeName === "string" || f.typeName === "guid" ? "''" : "0";
      return `    ${f.name}: delta.${f.name} ?? base?.${f.name} ?? ${defaultVal}`;
    }
    return `    ${f.name}: delta.${f.name} ? { ...base?.${f.name}, ...delta.${f.name} } as any : base?.${f.name} as any`;
  });

  return `export function materializeDelta(delta: EntityDelta, base?: Partial<Entity>): Entity {
  return {
${assignments.join(",\n")},
  } as Entity;
}`;
}

function emitMergeDelta(entity: SchemaDefinition, schema: ParsedSchema): string {
  const cases = entity.fields.map((f) => {
    if (f.name === "tags") {
      return `  if (delta.tags !== undefined) entity.tags = delta.tags;`;
    }
    if (f.isArray) {
      return `  if (delta.${f.name}) {
    if (delta.${f.name}.set) {
      entity.${f.name} = delta.${f.name}.set;
    } else {
      if (!entity.${f.name}) entity.${f.name} = [];
      if (delta.${f.name}.add) {
        for (const item of delta.${f.name}.add) {
          if (!entity.${f.name}.includes(item)) entity.${f.name}.push(item);
        }
      }
      if (delta.${f.name}.remove) {
        entity.${f.name} = entity.${f.name}.filter((item) => !delta.${f.name}!.remove!.includes(item));
      }
    }
  }`;
    }
    if (!isScalar(f.typeName) && hasDeltaDef(f, schema)) {
      return `  if (delta.${f.name}) {
    if (!entity.${f.name}) entity.${f.name} = {} as any;
    const t = entity.${f.name} as Record<string, number>;
    const d = delta.${f.name} as Record<string, number>;
    for (const key in d) {
      if (d[key] !== undefined) t[key] = (t[key] ?? 0) + d[key];
    }
  }`;
    }
    if (isScalar(f.typeName)) {
      return `  if (delta.${f.name} !== undefined) entity.${f.name} = delta.${f.name};`;
    }
    return `  if (delta.${f.name}) Object.assign(entity.${f.name} ??= {} as any, delta.${f.name});`;
  });

  return `export function mergeDelta(entity: Entity, delta: EntityDelta): void {
${cases.join("\n")}
}`;
}

function emitAccumulateDelta(entity: SchemaDefinition, schema: ParsedSchema): string {
  const cases = entity.fields.map((f) => {
    if (f.name === "tags") {
      return `  if (from.tags !== undefined) to.tags = from.tags;`;
    }
    if (f.isArray) {
      return `  if (from.${f.name}) {
    if (from.${f.name}.set) {
      to.${f.name} = from.${f.name};
    } else {
      if (!to.${f.name}) to.${f.name} = {};
      if (from.${f.name}.add) {
        to.${f.name}.add = [...(to.${f.name}.add ?? []), ...from.${f.name}.add];
      }
      if (from.${f.name}.remove) {
        to.${f.name}.remove = [...(to.${f.name}.remove ?? []), ...from.${f.name}.remove];
      }
    }
  }`;
    }
    if (!isScalar(f.typeName) && hasDeltaDef(f, schema)) {
      return `  if (from.${f.name}) {
    if (!to.${f.name}) {
      to.${f.name} = { ...from.${f.name} };
    } else {
      const t = to.${f.name} as Record<string, number>;
      const d = from.${f.name} as Record<string, number>;
      for (const key in d) {
        if (d[key] !== undefined) t[key] = (t[key] ?? 0) + d[key];
      }
    }
  }`;
    }
    if (isScalar(f.typeName)) {
      return `  if (from.${f.name} !== undefined) to.${f.name} = from.${f.name};`;
    }
    return `  if (from.${f.name}) to.${f.name} = { ...to.${f.name}, ...from.${f.name} };`;
  });

  return `export function accumulateDelta(from: EntityDelta, to: EntityDelta): EntityDelta {
${cases.join("\n")}
  return to;
}`;
}
