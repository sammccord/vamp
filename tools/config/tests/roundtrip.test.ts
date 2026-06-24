import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { generate } from "../src/generators/codegen.js";
import { generateMutationSchema } from "../src/generators/generate-mutation-schema.js";
import { loadBebopConfig, loadVampConfig } from "../src/config/loader.js";

// Anchor resolution at tools/config, which depends on bebop, bebop-tools, and typescript.
const TOOLS_CONFIG = resolve(__dirname, "..");
const require = createRequire(join(TOOLS_CONFIG, "noop.js"));

/** Resolve the bebopc CLI entrypoint from the installed bebop-tools package. */
function bebopcEntry(): string {
  // bebop-tools' main is dist/index.js, which is also its bin.
  return require.resolve("bebop-tools");
}

/** Resolve the bebop runtime package dir (for copying into the scratch node_modules). */
function bebopRuntimeDir(): string {
  // `bebop/package.json` is blocked by the exports map; derive the dir from the
  // resolved main entry (.../node_modules/bebop/dist/index.js -> .../bebop).
  const main = require.resolve("bebop"); // -> <pkg>/dist/index.js
  return dirname(dirname(main));
}

/** Minimal ambient stubs for the @vamp/* symbols the generated file references. */
const ECS_STUB = `
export interface ECSOptions<E, D> {
  createId: () => string;
  components: Record<string, number>;
  materializeDelta: (delta: D, base?: Partial<E>) => E;
  mergeDelta: (entity: E, delta: D) => void;
  accumulateDelta: (from: D, to: D) => D;
}
export type MutationBatch<E, D> = Map<string, unknown>;
type ArrayDelta<T> = { set?: T[]; add?: T[]; remove?: T[] };
export function applyArrayDelta<T>(base: T[], d?: ArrayDelta<T>): T[];
export function applyPoolDelta<T>(base: T, delta: Record<string, number>): T;
export function accumulateArrayDelta<T>(to: ArrayDelta<T> | undefined, from: ArrayDelta<T>): ArrayDelta<T>;
export function accumulatePoolDelta(to: Record<string, number> | undefined, from: Record<string, number>): Record<string, number>;
`;

const WORKER_STUB = `
export class ECSDurableObject<
  UserSession extends {} = {},
  Context extends {} = {},
  UpdateArguments extends Array<unknown> = [],
  Actions = unknown,
  Tags extends number = number,
  Entity = unknown,
  EntityDelta = unknown,
  Env = unknown,
> {}
export class ECSStorage<E = unknown> {}
export type RPCContext<
  UserSession extends {},
  Context extends Record<string, unknown>,
  UpdateArguments extends Array<unknown>,
  Actions,
  Tags extends number = number,
  Entity = unknown,
  EntityDelta = unknown,
> = [unknown, unknown];
export interface ECSRuntimeConfiguration<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
  Actions = unknown,
  Tags extends number = number,
  Entity = unknown,
  EntityDelta = unknown,
> {}
export function defineECSRuntime<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
  Actions = unknown,
  Tags extends number = number,
  Entity = unknown,
  EntityDelta = unknown,
>(
  provider: () => ECSRuntimeConfiguration<
    UserSession,
    Context,
    UpdateArguments,
    Actions,
    Tags,
    Entity,
    EntityDelta
  >,
): void;
`;

/** Minimal stub for the `@vamp/worker/interest` subpath the generated wrapper imports. */
const WORKER_INTEREST_STUB = `
import type { MutationBatch } from "@vamp/ecs";
export interface InterestBroadcastConfig<W, Req, E = unknown, D = unknown> {
  encodeBatch: (batch: MutationBatch<E, D>) => Uint8Array;
  canSee?: (world: W, viewerId: string | undefined, targetId: string, target: E) => boolean;
  resolveViewer?: (record: Req) => string | undefined;
}
export interface InterestBroadcast<W, Req, Yield> {
  observe: (record: Req, context: unknown) => AsyncGenerator<Yield, void, undefined>;
  onConnectionClose: (ws: unknown) => void;
  rehydrateConnection: (world: W, ws: unknown) => void;
}
export function createInterestBroadcast<W, Req, Yield = never, E = unknown, D = unknown>(
  config: InterestBroadcastConfig<W, Req, E, D>,
): InterestBroadcast<W, Req, Yield>;
`;

const CF_STUB = `declare namespace Cloudflare { interface Env {} }`;

interface ScratchFiles {
  entity: string;
  pool?: string;
}

/**
 * Scaffold a scratch project, run the full pipeline
 * (generateMutationSchema -> bebopc build -> generate), then `tsc --noEmit`
 * the emitted game.generated.ts together with the compiled bebop.ts against
 * minimal @vamp/* stubs. Returns nothing; throws on any failure.
 */
function roundtrip(files: ScratchFiles): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "vamp-rt-"));
  const schemaDir = join(dir, "schema");
  const srcDir = join(dir, "src");
  mkdirSync(schemaDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });

  // Schema files.
  writeFileSync(join(schemaDir, "entity.bop"), files.entity, "utf-8");
  writeFileSync(
    join(schemaDir, "pool.bop"),
    files.pool ??
      `message Pool {
  1 -> uint32 points;
  2 -> int32 rate;
}
message PoolDelta {
  1 -> int32 points;
  2 -> int32 rate;
}
`,
    "utf-8",
  );
  writeFileSync(join(schemaDir, "tags.bop"), `enum Tags { Human = 1; Hostile = 2; }`, "utf-8");
  writeFileSync(
    join(schemaDir, "actions.bop"),
    `union Actions {
  1 -> message Noop { 1 -> guid who; }
}`,
    "utf-8",
  );
  writeFileSync(join(schemaDir, "state.bop"), `message State { 1 -> string ns; }`, "utf-8");

  // Configs.
  writeFileSync(
    join(dir, "bebop.json"),
    JSON.stringify({
      include: ["schema/**/*.bop"],
      generators: { ts: { outFile: "./src/bebop.ts" } },
    }),
    "utf-8",
  );
  writeFileSync(
    join(dir, "vamp.json"),
    JSON.stringify({
      schemas: {
        entity: "schema/entity.bop",
        actions: "schema/actions.bop",
        state: "schema/state.bop",
        tags: "schema/tags.bop",
      },
      outFile: "./src/game.generated.ts",
    }),
    "utf-8",
  );

  // node_modules: stubs for @vamp/ecs, @vamp/worker, and the real bebop runtime.
  const nm = join(dir, "node_modules");
  const mkPkg = (name: string, dts: string) => {
    const d = join(nm, ...name.split("/"));
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ name, version: "0.0.0", types: "index.d.ts", main: "index.js" }),
      "utf-8",
    );
    writeFileSync(join(d, "index.d.ts"), dts, "utf-8");
    writeFileSync(join(d, "index.js"), "", "utf-8");
  };
  mkPkg("@vamp/ecs", ECS_STUB);
  // @vamp/worker exposes both the root and the `./interest` subpath the generated
  // file imports, so give it an explicit exports map (nodenext subpath resolution).
  const workerDir = join(nm, "@vamp", "worker");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(
    join(workerDir, "package.json"),
    JSON.stringify({
      name: "@vamp/worker",
      version: "0.0.0",
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./interest": { types: "./interest.d.ts", default: "./interest.js" },
      },
    }),
    "utf-8",
  );
  writeFileSync(join(workerDir, "index.d.ts"), WORKER_STUB, "utf-8");
  writeFileSync(join(workerDir, "index.js"), "", "utf-8");
  writeFileSync(join(workerDir, "interest.d.ts"), WORKER_INTEREST_STUB, "utf-8");
  writeFileSync(join(workerDir, "interest.js"), "", "utf-8");
  // Copy the real bebop runtime so the generated bebop.ts type-resolves.
  cpSync(bebopRuntimeDir(), join(nm, "bebop"), { recursive: true });

  // 1. Mutation schema.
  const vampConfig = loadVampConfig(dir);
  const bebopConfig = loadBebopConfig(dir);
  generateMutationSchema(dir, vampConfig);

  // 2. bebopc build (writes src/bebop.ts).
  execFileSync(process.execPath, [bebopcEntry(), "build"], { cwd: dir, stdio: "pipe" });

  // 3. Emit game.generated.ts.
  generate(dir, bebopConfig, vampConfig);

  // 4. tsc --noEmit over the emitted output.
  writeFileSync(join(srcDir, "cloudflare.d.ts"), CF_STUB, "utf-8");
  const tsconfig = {
    compilerOptions: {
      target: "es2024",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
      lib: ["es2024"],
    },
    include: ["src/**/*.ts"],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig), "utf-8");

  const tscBin = require.resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tscBin, "--noEmit", "-p", join(dir, "tsconfig.json")], {
    cwd: dir,
    stdio: "pipe",
  });

  return { dir };
}

describe("generate -> tsc --noEmit round-trip gate", () => {
  it("float64 field + synthesized custom delta compiles clean (Cases A/C)", () => {
    const entity = `import "./pool.bop"
import "./tags.bop"

message Position {
  1 -> float64 x;
  2 -> float64 y;
}

message Entity {
  1 -> guid id;
  2 -> guid root;
  3 -> Tags[] tags;
  4 -> guid parent;
  5 -> guid[] children;
  6 -> Pool health;
  7 -> float64 mass;
  8 -> Position pos;
}
`;
    expect(() => roundtrip({ entity })).not.toThrow();
  });

  it("custom component with user-supplied delta compiles clean (Case B)", () => {
    // bebop requires contiguous field indices from 1.
    const entity = `import "./pool.bop"
import "./tags.bop"

message Entity {
  1 -> guid id;
  2 -> guid root;
  3 -> Tags[] tags;
  4 -> Pool health;
}
`;
    expect(() => roundtrip({ entity })).not.toThrow();
  });

  it("throws before emitting when a custom component delta cannot be resolved (Case D)", () => {
    // `Foo` has no FooDelta and no resolvable Foo message -> generateMutationSchema throws.
    const entity = `import "./pool.bop"
import "./tags.bop"

message Entity {
  1 -> guid id;
  2 -> Foo foo;
}
`;
    expect(() => roundtrip({ entity })).toThrow(/FooDelta/);
  });
});
