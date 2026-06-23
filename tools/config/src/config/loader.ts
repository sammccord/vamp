import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { BebopConfig, FrameworkConfig } from "./types";

/** Parse jsonc, throwing a clear error (with offsets) on any syntax error. */
function parseJsoncStrict<T>(raw: string, resolved: string): T {
  const errors: ParseError[] = [];
  const config = parseJsonc(raw, errors, { allowTrailingComma: true }) as T;
  if (errors.length) {
    throw new Error(
      `Failed to parse ${resolved}: ${errors
        .map((e) => `${printParseErrorCode(e.error)}@${e.offset}`)
        .join(", ")}`,
    );
  }
  if (!config) {
    throw new Error(`Failed to parse ${resolved}: empty document`);
  }
  return config;
}

export function loadBebopConfig(cwd: string, configPath?: string): BebopConfig {
  const resolved = resolve(cwd, configPath ?? "bebop.json");
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf-8");
  } catch {
    throw new Error(`bebop.json not found at ${resolved}`);
  }
  return parseJsoncStrict<BebopConfig>(raw, resolved);
}

export function loadVampConfig(cwd: string): FrameworkConfig {
  const configPath = resolve(cwd, "vamp.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`vamp.json not found in ${cwd}`);
  }
  const config = parseJsoncStrict<FrameworkConfig>(raw, configPath);
  const { schemas, outFile } = config;
  if (!schemas?.entity || !schemas?.actions || !schemas?.state || !schemas?.tags) {
    throw new Error("vamp.schemas must define entity, actions, state, and tags paths");
  }
  if (!outFile) {
    throw new Error("vamp.outFile is required");
  }
  return config;
}
