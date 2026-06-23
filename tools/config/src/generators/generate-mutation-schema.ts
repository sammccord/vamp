import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { FrameworkConfig } from "../config/types";
import { emitMutationSchema } from "./emit-mutation-bop";
import { collectMessageNames, parseEntityMessage, parseMessage } from "./parse-bop-source";
import type { SourceMessage } from "./parse-bop-source";
import { collectReachableSource } from "./resolve-imports";

/** Default mutation schema path: a `mutation.bop` sibling of the entity schema. */
export function resolveMutationPath(cwd: string, vampConfig: FrameworkConfig): string {
  if (vampConfig.schemas.mutation) {
    return resolve(cwd, vampConfig.schemas.mutation);
  }
  const entityPath = resolve(cwd, vampConfig.schemas.entity);
  return resolve(dirname(entityPath), "mutation.bop");
}

/** Compute the bebop import path from the mutation file to the entity file. */
function entityImportPath(entityPath: string, mutationPath: string): string {
  const rel = relative(dirname(mutationPath), entityPath);
  const normalized = rel.split("\\").join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

/**
 * From the reachable schema source, collect:
 *  - `userDeltas`: every `<Type>Delta` message name already declared.
 *  - `components`: every custom-component message referenced by Entity, parsed
 *    so a missing `<Type>Delta` can be synthesized.
 */
export function collectSchemaContext(
  entity: SourceMessage,
  reachableSource: string,
): { userDeltas: Set<string>; components: Map<string, SourceMessage> } {
  const declared = collectMessageNames(reachableSource);
  const userDeltas = new Set<string>([...declared].filter((n) => n.endsWith("Delta")));

  const components = new Map<string, SourceMessage>();
  for (const field of entity.fields) {
    if (field.name === "tags" || field.isArray || field.isMap || field.isScalar) continue;
    if (components.has(field.typeName)) continue;
    if (!declared.has(field.typeName)) continue;
    const parsed = parseMessage(reachableSource, field.typeName);
    if (parsed) components.set(field.typeName, parsed);
  }
  return { userDeltas, components };
}

/**
 * Parse the user's entity schema and (re)generate the bebop mutation schema
 * (EntityDelta, MutationType, MutationRecord, MutationScope) next to it.
 *
 * IMPORTANT: this must run BEFORE `bebopc build` so the generated schema is
 * picked up and compiled into serializable types.
 *
 * @returns the absolute path of the written mutation schema.
 */
export function generateMutationSchema(cwd: string, vampConfig: FrameworkConfig): string {
  const entityPath = resolve(cwd, vampConfig.schemas.entity);
  const source = readFileSync(entityPath, "utf-8");
  const entity = parseEntityMessage(source);

  // Read the entity source plus every reachable imported .bop so we can see
  // component messages (e.g. Pool) and user-supplied <Type>Delta (e.g. PoolDelta).
  const reachableSource = collectReachableSource(entityPath);
  const { userDeltas, components } = collectSchemaContext(entity, reachableSource);

  const mutationPath = resolveMutationPath(cwd, vampConfig);
  const importPath = entityImportPath(entityPath, mutationPath);
  // emitMutationSchema validates/synthesizes deltas and THROWS before we write
  // anything if a custom component's delta can be neither found nor synthesized.
  const output = emitMutationSchema(entity, importPath, userDeltas, components, entityPath);

  mkdirSync(dirname(mutationPath), { recursive: true });
  writeFileSync(mutationPath, output, "utf-8");
  return mutationPath;
}
