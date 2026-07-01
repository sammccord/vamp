import { defineCommand } from "citty";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadBebopConfig, loadVampConfig } from "../config/loader";
import { generate } from "../generators/codegen";
import { generateMutationSchema } from "../generators/generate-mutation-schema";

/**
 * Build a watch-mode scheduler that runs `run` on each change, never dropping a
 * change saved while a run is in flight: a mid-run change sets a pending flag
 * that triggers exactly one follow-up after the current run completes.
 *
 * Extracted (and exported) so the pending-rerun semantics can be unit-tested
 * without invoking the real generator (plan 21 §4d / Case E).
 */
export function createWatchScheduler(
  run: () => boolean,
  debounce: (fn: () => void) => void,
  onComplete?: (ok: boolean) => void,
): { onChange: () => void } {
  let isRunning = false;
  let pending = false;

  const runOnce = (): void => {
    isRunning = true;
    const ok = run();
    isRunning = false;
    onComplete?.(ok);
    if (pending) {
      pending = false;
      debounce(runOnce);
    }
  };

  const onChange = (): void => {
    if (isRunning) {
      pending = true; // remember it; don't drop it
      return;
    }
    debounce(runOnce);
  };

  return { onChange };
}

export const generateCommand = defineCommand({
  meta: {
    name: "generate",
    description:
      "Run bebopc build, then emit game.generated.ts with component map, delta types, helpers, and factory",
  },
  args: {
    cwd: {
      type: "string",
      description: "Working directory",
      default: process.cwd(),
    },
    "skip-bebopc": {
      type: "boolean",
      description: "Skip running bebopc build",
      default: false,
    },
    watch: {
      type: "boolean",
      description: "Watch schema files for changes and regenerate on change",
      default: false,
    },
  },
  async run({ args }) {
    const cwd = args.cwd;
    const vampConfig = loadVampConfig(cwd);
    const bebopConfig = loadBebopConfig(cwd, vampConfig.bebopConfig);

    const runGenerate = (): boolean => {
      // Generate the bebop mutation schema (EntityDelta, MutationScope) from the
      // Entity message BEFORE bebopc runs so it gets compiled into bebop.ts.
      console.log("Generating mutation schema...");
      const mutationPath = generateMutationSchema(cwd, vampConfig);
      console.log(`Generated ${mutationPath}`);

      const bebopTsPath = resolve(cwd, bebopConfig.generators?.ts?.outFile ?? "./src/bebop.ts");

      if (!args["skip-bebopc"]) {
        // 1. Verify toolchain present (npx bebopc 404s if not installed).
        try {
          execSync("npx --no-install bebopc --version", { cwd, stdio: "pipe" });
        } catch {
          console.error(
            "bebopc not found. Install it (e.g. `pnpm add -D bebop-tools`) before running `vamp generate`.",
          );
          return false;
        }
        // 2. Run the build, capturing stderr for diagnostics.
        console.log("Running bebopc build...");
        try {
          execSync("npx --no-install bebopc build", { cwd, stdio: "inherit" });
        } catch (err) {
          console.error("bebopc build failed:");
          const e = err as { stderr?: Buffer; stdout?: Buffer };
          if (e.stderr?.length) console.error(e.stderr.toString());
          return false;
        }
        // 3. Validate the output exists before continuing.
        if (!existsSync(bebopTsPath)) {
          console.error(`bebopc build did not produce ${bebopTsPath}`);
          return false;
        }
      }

      console.log("Generating ECS types...");
      const { core, worker, barrel } = generate(cwd, bebopConfig, vampConfig);
      console.log(`Generated ${core}`);
      console.log(`Generated ${worker}`);
      console.log(`Generated ${barrel}`);
      return true;
    };

    if (!args.watch) {
      const ok = runGenerate();
      if (!ok) process.exit(1);
      return;
    }

    const chokidar = await import("chokidar");
    const schemaPaths = [
      resolve(cwd, vampConfig.schemas.entity),
      resolve(cwd, vampConfig.schemas.actions),
      resolve(cwd, vampConfig.schemas.state),
      resolve(cwd, vampConfig.schemas.tags),
    ];

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const debounce = (fn: () => void) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fn, 100);
    };

    const scheduler = createWatchScheduler(runGenerate, debounce, (ok) => {
      if (ok) console.log("Watching for changes...");
    });

    const watcher = chokidar.watch(schemaPaths, { persistent: true });
    watcher.on("change", (path) => {
      console.log(`\nSchema changed: ${path}`);
      scheduler.onChange();
    });

    console.log("Watching for changes...");
    if (!runGenerate()) {
      await watcher.close();
      process.exit(1);
    }
  },
});
