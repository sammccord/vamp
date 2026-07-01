import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { emitHelpers } from "../src/generators/emit-helpers.js";
import { classifyType } from "../src/generators/parse-bop-source.js";
import { resolvePoolImport } from "../src/commands/init.js";
import { createWatchScheduler } from "../src/commands/generate.js";
import type { SchemaDefinition } from "../src/generators/parse-bop.js";

// --- Case A: type-aware defaults in materializeDelta (4a) ---

describe("type-aware composite defaults (Case A, 4a)", () => {
  it("defaults string='' / bool=false / numeric=0 for a Stats component", () => {
    const stats: SchemaDefinition = {
      name: "Stats",
      kind: "message",
      fields: [
        { name: "name", typeId: -11, isArray: false, isMap: false, typeName: "string" },
        { name: "level", typeId: -5, isArray: false, isMap: false, typeName: "uint32" },
        { name: "active", typeId: -1, isArray: false, isMap: false, typeName: "bool" },
      ],
    };
    const entity: SchemaDefinition = {
      name: "Entity",
      kind: "message",
      fields: [
        {
          name: "stats",
          typeId: 0,
          isArray: false,
          isMap: false,
          typeName: "Stats",
          constantValue: 7,
        },
      ],
    };
    const schema = {
      definitions: new Map<string, SchemaDefinition>([
        ["Entity", entity],
        ["Stats", stats],
        ["StatsDelta", { name: "StatsDelta", kind: "message", fields: [] }],
      ]),
    };
    const out = emitHelpers(entity, schema);
    expect(out).toContain("name: ''");
    expect(out).toContain("level: 0");
    expect(out).toContain("active: false");
    expect(out).not.toContain("name: 0");
  });

  it("keeps the all-numeric Pool default unchanged", () => {
    const pool: SchemaDefinition = {
      name: "Pool",
      kind: "message",
      fields: [
        { name: "points", typeId: -5, isArray: false, isMap: false, typeName: "uint32" },
        { name: "min", typeId: -5, isArray: false, isMap: false, typeName: "uint32" },
        { name: "max", typeId: -5, isArray: false, isMap: false, typeName: "uint32" },
        { name: "rate", typeId: -6, isArray: false, isMap: false, typeName: "int32" },
        { name: "interval", typeId: -5, isArray: false, isMap: false, typeName: "uint32" },
      ],
    };
    const entity: SchemaDefinition = {
      name: "Entity",
      kind: "message",
      fields: [
        {
          name: "health",
          typeId: 0,
          isArray: false,
          isMap: false,
          typeName: "Pool",
          constantValue: 6,
        },
      ],
    };
    const schema = {
      definitions: new Map<string, SchemaDefinition>([
        ["Entity", entity],
        ["Pool", pool],
        ["PoolDelta", { name: "PoolDelta", kind: "message", fields: [] }],
      ]),
    };
    const out = emitHelpers(entity, schema);
    expect(out).toContain("points: 0, min: 0, max: 0, rate: 0, interval: 0");
  });
});

// --- Case B: nested map/array value classification (4b) ---

describe("recursive value classification (Case B, 4b)", () => {
  it("classifies map[guid, Pool] value as custom", () => {
    const c = classifyType("map[guid, Pool]");
    expect(c.valueClassified?.isScalar).toBe(false);
    expect(c.valueClassified?.isArray).toBe(false);
    expect(c.valueClassified?.isMap).toBe(false);
  });

  it("classifies map[guid, guid[]] value as scalar array", () => {
    const c = classifyType("map[guid, guid[]]");
    expect(c.valueClassified?.isArray).toBe(true);
    expect(c.valueClassified?.isScalar).toBe(true);
  });

  it("classifies map[guid, map[guid, Pool]] value as map", () => {
    const c = classifyType("map[guid, map[guid, Pool]]");
    expect(c.valueClassified?.isMap).toBe(true);
  });
});

// --- Case C/D (resolution half): resolvePoolImport across layouts (4c) ---

/** Lay down a fake @vampgg/utils package with a schema/pool.bop at the given node_modules root. */
function fakeUtils(nmRoot: string): void {
  const pkgDir = join(nmRoot, "@vampgg", "utils");
  mkdirSync(join(pkgDir, "schema"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@vampgg/utils", version: "0.0.0", files: ["schema"] }),
    "utf-8",
  );
  writeFileSync(
    join(pkgDir, "schema", "pool.bop"),
    "message Pool { 1 -> uint32 points; }",
    "utf-8",
  );
}

describe("pool.bop import resolution (Case C/D, 4c)", () => {
  it("resolves in a hoisted node_modules layout", () => {
    const proj = mkdtempSync(join(tmpdir(), "vamp-hoist-"));
    const schemaDir = join(proj, "schema");
    mkdirSync(schemaDir, { recursive: true });
    fakeUtils(join(proj, "node_modules"));

    const importPath = resolvePoolImport(proj, schemaDir);
    expect(importPath).toContain("pool.bop");
    expect(importPath).not.toContain("__POOL_IMPORT__");
    // The resolved path should point at a real file relative to the schema dir.
    const abs = join(schemaDir, importPath);
    expect(readFileSync(abs, "utf-8")).toContain("message Pool");
  });

  it("resolves through a pnpm-style symlinked layout", () => {
    const proj = mkdtempSync(join(tmpdir(), "vamp-pnpm-"));
    const schemaDir = join(proj, "schema");
    mkdirSync(schemaDir, { recursive: true });

    // Real package under .pnpm, symlinked into node_modules/@vampgg/utils.
    const pnpmRoot = join(proj, "node_modules", ".pnpm", "@vampgg+utils@0.0.0", "node_modules");
    fakeUtils(pnpmRoot);
    mkdirSync(join(proj, "node_modules", "@vampgg"), { recursive: true });
    try {
      symlinkSync(
        join(pnpmRoot, "@vampgg", "utils"),
        join(proj, "node_modules", "@vampgg", "utils"),
        "dir",
      );
    } catch {
      // Some CI filesystems disallow symlinks; skip gracefully.
      return;
    }

    const importPath = resolvePoolImport(proj, schemaDir);
    expect(importPath).toContain("pool.bop");
    const abs = join(schemaDir, importPath);
    expect(readFileSync(abs, "utf-8")).toContain("message Pool");
  });

  it("falls back to a literal path with a warning when unresolved", () => {
    const proj = mkdtempSync(join(tmpdir(), "vamp-noutils-"));
    const schemaDir = join(proj, "schema");
    mkdirSync(schemaDir, { recursive: true });
    // Force resolution failure deterministically — relying on the temp dir being
    // unable to resolve @vampgg/utils is environment-dependent (an ancestor
    // node_modules may still resolve it).
    const importPath = resolvePoolImport(proj, schemaDir, () => null);
    expect(importPath).toBe("../node_modules/@vampgg/utils/schema/pool.bop");
  });
});

// --- Case E: watch mode defers (does not drop) a change saved during a run (4d) ---

describe("watch scheduler pending-rerun (Case E, 4d)", () => {
  it("re-runs exactly once when a change arrives mid-run", () => {
    let runs = 0;
    // Manual debounce queue so we control flush ordering deterministically.
    const queue: Array<() => void> = [];
    const debounce = (fn: () => void) => {
      queue.length = 0; // mimic the real debounce: latest wins
      queue.push(fn);
    };
    const flush = () => {
      const fns = queue.splice(0);
      for (const fn of fns) fn();
    };

    let injectMidRun: (() => void) | null = null;
    const run = (): boolean => {
      runs++;
      // On the FIRST run only, simulate a save arriving while we're in flight.
      if (injectMidRun) {
        const inject = injectMidRun;
        injectMidRun = null;
        inject();
      }
      return true;
    };

    const { onChange } = createWatchScheduler(run, debounce);

    // Arrange: while run #1 executes, fire another change.
    injectMidRun = () => onChange();

    // First change -> schedules runOnce.
    onChange();
    flush(); // runs once; mid-run change sets pending -> schedules a follow-up
    expect(runs).toBe(1);

    // The deferred follow-up is queued; flush it.
    flush();
    expect(runs).toBe(2);

    // No further runs are scheduled (exactly one follow-up, not N).
    flush();
    expect(runs).toBe(2);
  });

  it("does not re-run when no change arrives mid-run", () => {
    let runs = 0;
    const queue: Array<() => void> = [];
    const debounce = (fn: () => void) => {
      queue.length = 0;
      queue.push(fn);
    };
    const flush = () => queue.splice(0).forEach((fn) => fn());
    const { onChange } = createWatchScheduler(() => {
      runs++;
      return true;
    }, debounce);

    onChange();
    flush();
    expect(runs).toBe(1);
    flush();
    expect(runs).toBe(1);
  });
});
