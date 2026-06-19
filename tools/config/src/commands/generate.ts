import { defineCommand } from "citty";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { loadBebopConfig, loadVampConfig } from "../config/loader";
import { generate } from "../generators/codegen";
import { generateMutationSchema } from "../generators/generate-mutation-schema";

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

    const runGenerate = () => {
      // Generate the bebop mutation schema (EntityDelta, MutationScope) from the
      // Entity message BEFORE bebopc runs so it gets compiled into bebop.ts.
      console.log("Generating mutation schema...");
      const mutationPath = generateMutationSchema(cwd, vampConfig);
      console.log(`Generated ${mutationPath}`);

      if (!args["skip-bebopc"]) {
        console.log("Running bebopc build...");
        try {
          execSync("npx bebopc build", { cwd, stdio: "inherit" });
        } catch {
          console.error("bebopc build failed");
          return false;
        }
      }

      console.log("Generating ECS types...");
      const outPath = generate(cwd, bebopConfig, vampConfig);
      console.log(`Generated ${outPath}`);
      return true;
    };

    if (!args.watch) {
      runGenerate();
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
    let isRunning = false;

    const debounce = (fn: () => void) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fn, 100);
    };

    const watcher = chokidar.watch(schemaPaths, { persistent: true });
    watcher.on("change", (path) => {
      if (isRunning) return;
      console.log(`\nSchema changed: ${path}`);
      isRunning = true;
      debounce(() => {
        if (runGenerate()) {
          console.log("Watching for changes...");
        }
        isRunning = false;
      });
    });

    console.log("Watching for changes...");
    if (!runGenerate()) {
      await watcher.close();
      process.exit(1);
    }
  },
});
