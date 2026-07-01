import { defineCommand } from "citty";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  POOL_IMPORT_FALLBACK,
  POOL_IMPORT_PLACEHOLDER,
  entityTemplate,
} from "../templates/entity.bop";
import { actionsTemplate } from "../templates/actions.bop";
import { stateTemplate } from "../templates/state.bop";
import { tagsTemplate } from "../templates/tags.bop";
import { resolveBebopImport } from "../generators/resolve-imports";

/**
 * Resolve a bebop import path (relative to `schemaDir`) for
 * `@vamp/utils/schema/pool.bop` using Node module resolution, so the scaffolded
 * import is correct under hoisted or pnpm `node_modules` layouts. Falls back to
 * a literal path (with a warning) when resolution fails.
 *
 * `resolve` is injectable so the fallback branch can be tested deterministically
 * (Node resolution from a temp dir is environment-dependent — it may still find
 * a `@vamp/utils` in an ancestor `node_modules`).
 */
export function resolvePoolImport(
  cwd: string,
  schemaDir: string,
  resolveImport: (specifier: string, fromDir: string) => string | null = resolveBebopImport,
): string {
  const resolved = resolveImport("@vamp/utils/schema/pool.bop", cwd);
  if (!resolved) {
    console.warn(
      "Warning: could not resolve '@vamp/utils/schema/pool.bop'. Scaffolding a literal " +
        "import path that may not resolve under your node_modules layout — fix the import " +
        "in schema/entity.bop if `bebopc build` fails.",
    );
    return POOL_IMPORT_FALLBACK;
  }
  const rel = relative(schemaDir, resolved).split("\\").join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Scaffold schema/ dir, template .bop files, and create bebop.json + vamp.json",
  },
  args: {
    cwd: {
      type: "string",
      description: "Working directory",
      default: process.cwd(),
    },
  },
  run({ args }) {
    const cwd = args.cwd;
    const schemaDir = resolve(cwd, "schema");

    // Create schema directory
    mkdirSync(schemaDir, { recursive: true });
    console.log("Created schema/");

    // Resolve the pool.bop import path for the actual node_modules layout.
    const poolImport = resolvePoolImport(cwd, schemaDir);
    const entityContent = entityTemplate.replace(POOL_IMPORT_PLACEHOLDER, poolImport);

    // Write template .bop files (skip if they exist)
    const files = [
      { path: "schema/entity.bop", content: entityContent },
      { path: "schema/actions.bop", content: actionsTemplate },
      { path: "schema/state.bop", content: stateTemplate },
      { path: "schema/tags.bop", content: tagsTemplate },
    ];

    for (const file of files) {
      const fullPath = resolve(cwd, file.path);
      if (existsSync(fullPath)) {
        console.log(`Skipping ${file.path} (already exists)`);
      } else {
        writeFileSync(fullPath, file.content, "utf-8");
        console.log(`Created ${file.path}`);
      }
    }

    // Create bebop.json (pure bebopc config, no vamp keys)
    const bebopConfigPath = resolve(cwd, "bebop.json");
    if (existsSync(bebopConfigPath)) {
      console.log("Skipping bebop.json (already exists)");
    } else {
      const bebopConfig = {
        include: ["schema/**/*.bop"],
        generators: { ts: { outFile: "./src/bebop.ts" } },
      };
      writeFileSync(bebopConfigPath, JSON.stringify(bebopConfig, null, 2) + "\n", "utf-8");
      console.log("Created bebop.json");
    }

    // Create vamp.json
    const vampConfigPath = resolve(cwd, "vamp.json");
    if (existsSync(vampConfigPath)) {
      console.log("Skipping vamp.json (already exists)");
    } else {
      const vampConfig = {
        schemas: {
          entity: "schema/entity.bop",
          actions: "schema/actions.bop",
          state: "schema/state.bop",
          tags: "schema/tags.bop",
        },
        outFile: "./src/game.generated.ts",
      };
      writeFileSync(vampConfigPath, JSON.stringify(vampConfig, null, 2) + "\n", "utf-8");
      console.log("Created vamp.json");
    }
  },
});
