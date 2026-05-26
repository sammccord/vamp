import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { BebopConfig, FrameworkConfig } from "./types";

export function loadBebopConfig(cwd: string, configPath?: string): BebopConfig {
  const resolved = resolve(cwd, configPath ?? "bebop.json");
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf-8");
  } catch {
    throw new Error(`bebop.json not found at ${resolved}`);
  }
  const config = parseJsonc(raw) as BebopConfig;
  if (!config) {
    throw new Error(`Failed to parse ${resolved}`);
  }
  return config;
}

export function loadVampConfig(cwd: string): FrameworkConfig {
  const configPath = resolve(cwd, "vamp.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`vamp.json not found in ${cwd}`);
  }
  const config = parseJsonc(raw) as FrameworkConfig;
  if (!config) {
    throw new Error(`Failed to parse vamp.json in ${cwd}`);
  }
  const { schemas, outFile } = config;
  if (!schemas?.entity || !schemas?.actions || !schemas?.state) {
    throw new Error("vamp.schemas must define entity, actions, and state paths");
  }
  if (!outFile) {
    throw new Error("vamp.outFile is required");
  }
  return config;
}
