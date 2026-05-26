import { defineCommand } from "citty";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { entityTemplate } from "../templates/entity.bop";
import { actionsTemplate } from "../templates/actions.bop";
import { stateTemplate } from "../templates/state.bop";

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

    // Write template .bop files (skip if they exist)
    const files = [
      { path: "schema/entity.bop", content: entityTemplate },
      { path: "schema/actions.bop", content: actionsTemplate },
      { path: "schema/state.bop", content: stateTemplate },
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
        },
        outFile: "./src/ecs.generated.ts",
      };
      writeFileSync(vampConfigPath, JSON.stringify(vampConfig, null, 2) + "\n", "utf-8");
      console.log("Created vamp.json");
    }
  },
});
