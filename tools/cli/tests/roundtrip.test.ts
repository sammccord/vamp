import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { generate, type GeneratedPaths } from "../src/generators/codegen.js";
import { generateMutationSchema } from "../src/generators/generate-mutation-schema.js";
import { loadBebopConfig, loadVampConfig } from "../src/config/loader.js";

// Anchor resolution at tools/cli, which depends on bebop, bebop-tools, and typescript.
const TOOLS_CLI = resolve(__dirname, "..");
const require = createRequire(join(TOOLS_CLI, "noop.js"));

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

/** Minimal ambient stubs for the @vampgg/* symbols the generated file references. */
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
export type BehaviorTreeSystemOptions<State, UpdateArguments extends unknown[], Actions, Tags extends number, E, D, C extends number = number, T extends number = number> = {
  query: Query | ((b: QueryBuilder) => QueryBuilder);
  brain: keyof E & string;
  tree: keyof E & string;
  conditions: Readonly<Record<C, (world: unknown, entity: E, args: readonly number[]) => boolean>>;
  tasks: Readonly<Record<T, (world: unknown, entity: E, args: readonly number[]) => Actions | Actions[] | undefined>>;
  random: (world: unknown) => { getUniform(): number; getWeightedValue(data: Record<number, number>): string | number | undefined };
  now: (world: unknown) => number;
  target?: (intent: Actions, agentId: string) => string | undefined;
};
export function createBehaviorTreeSystem<State, UpdateArguments extends unknown[], Actions, Tags extends number, E, D, C extends number = number, T extends number = number>(
  options: BehaviorTreeSystemOptions<State, UpdateArguments, Actions, Tags, E, D, C, T>,
): ArchetypeSystem<State, UpdateArguments, Actions, Tags, E, D>;
export function applyReplaceDelta<T extends object>(base: T, delta: Partial<T>): T;
export function accumulateReplaceDelta<D extends object>(to: D | undefined, from: D): D;

export type Query = { __query: true };
export type QueryBuilder = { __builder: true; every(...components: number[]): QueryBuilder };
export type EntitySystem<State, UpdateArguments extends unknown[], Actions, Tags extends number = number, E = unknown, D = unknown> = {
  type: 0;
  query: Query;
  execute(entities: Array<string>, world: { __state: State; __ua: UpdateArguments; __actions: Actions; __tags: Tags; __e: E; __d: D }, ...args: UpdateArguments): void;
};
export type ArchetypeSystem<State, UpdateArguments extends unknown[], Actions, Tags extends number = number, E = unknown, D = unknown> = {
  type: 1;
  query: Query;
  execute(archetypes: Set<unknown>, world: { __state: State; __ua: UpdateArguments; __actions: Actions; __tags: Tags; __e: E; __d: D }, ...args: UpdateArguments): void;
};
export type Behavior<State, UpdateArguments extends unknown[], Actions, Tags extends number = number, E = unknown, D = unknown> = {
  type: 4;
  query: Query;
  tag: number;
  handler: (world: { __state: State; __ua: UpdateArguments; __actions: Actions; __tags: Tags; __e: E; __d: D }, entity: E, event: unknown) => void | Promise<void>;
  priority: number | undefined;
};
export type System<State, UpdateArguments extends unknown[], Actions, Tags extends number = number, E = unknown, D = unknown> =
  | EntitySystem<State, UpdateArguments, Actions, Tags, E, D>
  | ArchetypeSystem<State, UpdateArguments, Actions, Tags, E, D>
  | Behavior<State, UpdateArguments, Actions, Tags, E, D>;
export function createEntitySystem<State, UpdateArguments extends unknown[], Actions, Tags extends number = number, E = unknown, D = unknown>(
  execute: EntitySystem<State, UpdateArguments, Actions, Tags, E, D>["execute"],
  query: Query | ((b: QueryBuilder) => QueryBuilder),
): EntitySystem<State, UpdateArguments, Actions, Tags, E, D>;
export function createArchetypeSystem<State, UpdateArguments extends unknown[], ReturnArguments, Actions, Tags extends number = number, E = unknown, D = unknown>(
  execute: (archetypes: Set<unknown>, world: { __state: State; __ua: UpdateArguments; __actions: Actions; __tags: Tags; __e: E; __d: D }, ...args: UpdateArguments) => ReturnArguments,
  query: Query | ((b: QueryBuilder) => QueryBuilder),
): ArchetypeSystem<State, UpdateArguments, Actions, Tags, E, D>;
export function createBehavior<State, UpdateArguments extends unknown[], Actions, Tags extends number = number, E = unknown, D = unknown>(
  tag: number,
  handler: Behavior<State, UpdateArguments, Actions, Tags, E, D>["handler"],
  query: Query | ((b: QueryBuilder) => QueryBuilder),
  priority?: number,
): Behavior<State, UpdateArguments, Actions, Tags, E, D>;
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

/** Minimal stub for the `@vampgg/worker/interest` subpath the generated wrapper imports. */
const WORKER_INTEREST_STUB = `
import type { MutationBatch } from "@vampgg/ecs";
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

const BEHAVIOR_BOP = resolve(TOOLS_CLI, "../../packages/utils/schema/behavior.bop");

const BEHAVIOR_ENTITY = `import "./pool.bop"
import "./behavior.bop"
import "./tags.bop"

enum Condition { Near = 1; }
enum Task { Attack = 1; Wander = 2; }

message Entity {
  1 -> guid id;
  2 -> guid sk;
  3 -> Tags[] tags;
  4 -> Pool health;
  5 -> Brain brain;
  6 -> BehaviorTree behaviorTree;
}
`;

const CF_STUB = `declare namespace Cloudflare { interface Env {} }`;

interface ScratchFiles {
  entity: string;
  pool?: string;
  /** Extra `src/` files type-checked with the generated output, keyed by file name. */
  src?: Record<string, string>;
}

/**
 * Scaffold a scratch project, run the full pipeline
 * (generateMutationSchema -> bebopc build -> generate), then `tsc --noEmit`
 * the emitted game.generated.ts together with the compiled bebop.ts against
 * minimal @vampgg/* stubs. Returns the scratch dir + emitted file paths; throws
 * on any failure.
 */
function roundtrip(files: ScratchFiles): { dir: string; paths: GeneratedPaths } {
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
  cpSync(BEHAVIOR_BOP, join(schemaDir, "behavior.bop"));
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

  // node_modules: stubs for @vampgg/ecs, @vampgg/worker, and the real bebop runtime.
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
  mkPkg("@vampgg/ecs", ECS_STUB);
  // @vampgg/worker exposes both the root and the `./interest` subpath the generated
  // file imports, so give it an explicit exports map (nodenext subpath resolution).
  const workerDir = join(nm, "@vampgg", "worker");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(
    join(workerDir, "package.json"),
    JSON.stringify({
      name: "@vampgg/worker",
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

  // 3. Emit the split game.generated.ts (barrel), game.core.generated.ts, and
  //    game.worker.generated.ts.
  const paths = generate(dir, bebopConfig, vampConfig);

  // 4. tsc --noEmit over the emitted output.
  writeFileSync(join(srcDir, "cloudflare.d.ts"), CF_STUB, "utf-8");
  for (const [name, content] of Object.entries(files.src ?? {})) {
    writeFileSync(join(srcDir, name), content, "utf-8");
  }
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

  return { dir, paths };
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
  2 -> guid sk;
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
  2 -> guid sk;
  3 -> Tags[] tags;
  4 -> Pool health;
}
`;
    expect(() => roundtrip({ entity })).not.toThrow();
  });

  it("behavior tree and brain fields merge by replace, not by counter", () => {
    const { paths } = roundtrip({ entity: BEHAVIOR_ENTITY });
    const core = readFileSync(paths.core, "utf-8");
    expect(core).toContain(
      'import { applyArrayDelta, accumulateArrayDelta, applyPoolDelta, accumulatePoolDelta, applyReplaceDelta, accumulateReplaceDelta } from "@vampgg/ecs";',
    );
    expect(core).toContain("entity.brain = applyReplaceDelta(entity.brain ?? {}, delta.brain);");
    expect(core).toContain(
      "to.behaviorTree = accumulateReplaceDelta(to.behaviorTree, from.behaviorTree);",
    );
    expect(core).toContain("entity.health = applyPoolDelta(");
  });

  it("types createGameBehaviorTreeSystem leaves against the Condition/Task enums", () => {
    const usage = `import { Actions, Condition, Task } from "./bebop.js";
import { createGameBehaviorTreeSystem, type GameTasks } from "./game.core.generated.js";

const random = { getUniform: () => 0, getWeightedValue: () => undefined };
const tasks: GameTasks = {
  [Task.Attack]: (_world, entity) => Actions.fromNoop({ who: entity.id }),
  [Task.Wander]: () => undefined,
};
createGameBehaviorTreeSystem({
  conditions: { [Condition.Near]: (_world, _entity, args) => args[0] > 0 },
  tasks,
  random: () => random,
  now: () => 0,
});
createGameBehaviorTreeSystem({
  conditions: { [Condition.Near]: () => true },
  // @ts-expect-error every Task needs an implementation
  tasks: { [Task.Attack]: () => undefined },
  random: () => random,
  now: () => 0,
});
`;
    const { paths } = roundtrip({ entity: BEHAVIOR_ENTITY, src: { "usage.ts": usage } });
    const core = readFileSync(paths.core, "utf-8");
    expect(core).toContain(
      'import type { Entity, Actions, Tags, PoolDelta, BrainDelta, BehaviorTreeDelta, Condition, Task } from "./bebop.js";',
    );
    expect(core).toContain('brain: "brain",');
    expect(core).toContain("query: (q) => q.every(components.brain),");
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

  it("splits output so the core file is free of @vampgg/worker and the barrel re-exports both", () => {
    const entity = `import "./pool.bop"
import "./tags.bop"

message Entity {
  1 -> guid id;
  2 -> guid sk;
  3 -> Tags[] tags;
  4 -> Pool health;
}
`;
    const { paths } = roundtrip({ entity });

    const core = readFileSync(paths.core, "utf-8");
    const worker = readFileSync(paths.worker, "utf-8");
    const barrel = readFileSync(paths.barrel, "utf-8");

    // The pure core file must NOT reach for the worker package (that is the whole
    // point of the split — non-Worker consumers import it without `cloudflare:`).
    expect(core).not.toContain("@vampgg/worker");
    expect(core).toContain("export function createECSOptions");
    expect(core).toContain("export const components");

    // The worker file carries the DO/runtime and imports EntityDelta from core.
    expect(worker).toContain("@vampgg/worker");
    expect(worker).toContain("export class GameECS");
    expect(worker).toContain('from "./game.core.generated.js"');

    // The barrel re-exports both part-files (backward-compatible `./game.generated`).
    expect(barrel).toContain('export * from "./game.core.generated.js"');
    expect(barrel).toContain('export * from "./game.worker.generated.js"');
  });
});
