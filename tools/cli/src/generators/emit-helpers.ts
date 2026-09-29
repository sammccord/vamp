import type { ParsedSchema, SchemaDefinition, SchemaField } from "./parse-bop";
import { isScalar } from "./emit-delta";

/**
 * How a custom component's `<Type>Delta` merges, named by the `@vampgg/ecs`
 * helpers that implement it. `numeric` helpers take `Record<string, number>`.
 */
interface DeltaStrategy {
  apply: string;
  accumulate: string;
  numeric: boolean;
}

const COUNTER: DeltaStrategy = {
  apply: "applyPoolDelta",
  accumulate: "accumulatePoolDelta",
  numeric: true,
};
const REPLACE: DeltaStrategy = {
  apply: "applyReplaceDelta",
  accumulate: "accumulateReplaceDelta",
  numeric: false,
};

/**
 * Delta strategy per component type. Counters add fields together, so types
 * whose values must not be summed (behavior trees, brains) replace instead.
 * Unlisted types with a `<Type>Delta` default to {@link COUNTER}.
 */
const DELTA_STRATEGIES: Readonly<Record<string, DeltaStrategy>> = {
  Pool: COUNTER,
  BehaviorTree: REPLACE,
  Brain: REPLACE,
};

/** The delta strategy for a non-array custom field with a `<Type>Delta`, else undefined. */
function deltaStrategy(field: SchemaField, schema: ParsedSchema): DeltaStrategy | undefined {
  if (field.isArray || isScalar(field.typeName)) return undefined;
  if (!schema.definitions.has(`${field.typeName}Delta`)) return undefined;
  return DELTA_STRATEGIES[field.typeName] ?? COUNTER;
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

/**
 * Import of the canonical delta-algebra appliers from `@vampgg/ecs`, narrowed to
 * exactly the helpers this entity's fields use. The set/add/remove (array),
 * additive (pool) and replace semantics live in `@vampgg/ecs` so `materializeDelta`,
 * `mergeDelta`, and `accumulateDelta` cannot drift; the generated code only
 * dispatches per field. Returns "" when the entity has no array or delta-typed
 * fields (so no unused import is emitted).
 */
export function emitHelperImports(entity: SchemaDefinition, schema: ParsedSchema): string {
  const names: string[] = [];
  if (needsArrayHelper(entity)) names.push("applyArrayDelta", "accumulateArrayDelta");
  for (const strategy of new Set(entity.fields.map((f) => deltaStrategy(f, schema)))) {
    if (strategy) names.push(strategy.apply, strategy.accumulate);
  }
  if (names.length === 0) return "";
  return `import { ${names.join(", ")} } from "@vampgg/ecs";`;
}

export function emitHelpers(entity: SchemaDefinition, schema: ParsedSchema): string {
  return [
    emitMaterializeDelta(entity, schema),
    emitMergeDelta(entity, schema),
    emitAccumulateDelta(entity, schema),
  ]
    .filter(Boolean)
    .join("\n\n");
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
    const strategy = deltaStrategy(f, schema);
    if (strategy) {
      const baseMsg = schema.definitions.get(f.typeName);
      const defaultFields = baseMsg
        ? baseMsg.fields.map((bf) => `${bf.name}: ${defaultForField(bf)}`).join(", ")
        : "";
      const deltaExpr = strategy.numeric
        ? `delta.${f.name} as Record<string, number>`
        : `delta.${f.name}`;
      return `    ${f.name}: delta.${f.name} ? ${strategy.apply}(base?.${f.name} ?? { ${defaultFields} }, ${deltaExpr}) : base?.${f.name} ?? { ${defaultFields} }`;
    }
    if (isScalar(f.typeName)) {
      const defaultVal = f.typeName === "string" || f.typeName === "guid" ? "''" : "0";
      return `    ${f.name}: delta.${f.name} ?? base?.${f.name} ?? ${defaultVal}`;
    }
    return `    ${f.name}: delta.${f.name} ? { ...base?.${f.name}, ...delta.${f.name} } as any : base?.${f.name} as any`;
  });

  return `/**
 * Build a full {@link Entity} from a {@link EntityDelta} and optional \`base\`,
 * honoring array set/add/remove and additive pool semantics.
 */
export function materializeDelta(delta: EntityDelta, base?: Partial<Entity>): Entity {
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
      return `  if (delta.${f.name}) entity.${f.name} = applyArrayDelta(entity.${f.name} ?? [], delta.${f.name});`;
    }
    const strategy = deltaStrategy(f, schema);
    if (strategy?.numeric) {
      return `  if (delta.${f.name}) entity.${f.name} = ${strategy.apply}((entity.${f.name} ?? {}) as Record<string, number>, delta.${f.name} as Record<string, number>) as Entity[${JSON.stringify(f.name)}];`;
    }
    if (strategy) {
      return `  if (delta.${f.name}) entity.${f.name} = ${strategy.apply}(entity.${f.name} ?? {}, delta.${f.name});`;
    }
    if (isScalar(f.typeName)) {
      return `  if (delta.${f.name} !== undefined) entity.${f.name} = delta.${f.name};`;
    }
    return `  if (delta.${f.name}) Object.assign(entity.${f.name} ??= {} as any, delta.${f.name});`;
  });

  return `/**
 * Apply \`delta\` onto \`entity\` in place — same set/add/remove and additive pool
 * rules as {@link materializeDelta}.
 */
export function mergeDelta(entity: Entity, delta: EntityDelta): void {
${cases.join("\n")}
}`;
}

function emitAccumulateDelta(entity: SchemaDefinition, schema: ParsedSchema): string {
  const cases = entity.fields.map((f) => {
    if (f.name === "tags") {
      return `  if (from.tags !== undefined) to.tags = from.tags;`;
    }
    if (f.isArray) {
      return `  if (from.${f.name}) to.${f.name} = accumulateArrayDelta(to.${f.name}, from.${f.name});`;
    }
    const strategy = deltaStrategy(f, schema);
    if (strategy?.numeric) {
      return `  if (from.${f.name}) to.${f.name} = ${strategy.accumulate}(to.${f.name} as Record<string, number> | undefined, from.${f.name} as Record<string, number>) as EntityDelta[${JSON.stringify(f.name)}];`;
    }
    if (strategy) {
      return `  if (from.${f.name}) to.${f.name} = ${strategy.accumulate}(to.${f.name}, from.${f.name});`;
    }
    if (isScalar(f.typeName)) {
      return `  if (from.${f.name} !== undefined) to.${f.name} = from.${f.name};`;
    }
    return `  if (from.${f.name}) to.${f.name} = { ...to.${f.name}, ...from.${f.name} };`;
  });

  return `/**
 * Fold \`from\` into \`to\`, collapsing two {@link EntityDelta}s into one equivalent
 * delta (array/pool deltas combine additively). Returns the mutated \`to\`.
 */
export function accumulateDelta(from: EntityDelta, to: EntityDelta): EntityDelta {
${cases.join("\n")}
  return to;
}`;
}
