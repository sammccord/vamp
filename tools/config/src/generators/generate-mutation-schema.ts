import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { FrameworkConfig } from "../config/types";
import { emitMutationSchema } from "./emit-mutation-bop";
import { parseEntityMessage } from "./parse-bop-source";

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

  const mutationPath = resolveMutationPath(cwd, vampConfig);
  const importPath = entityImportPath(entityPath, mutationPath);
  const output = emitMutationSchema(entity, importPath);

  mkdirSync(dirname(mutationPath), { recursive: true });
  writeFileSync(mutationPath, output, "utf-8");
  return mutationPath;
}
