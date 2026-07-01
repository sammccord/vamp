#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { generateCommand } from "./commands/generate";
import { initCommand } from "./commands/init";

const main = defineCommand({
  meta: {
    name: "vamp",
    description: "ECS code generator for @vampgg",
  },
  subCommands: {
    generate: generateCommand,
    init: initCommand,
  },
});

runMain(main).catch((err) => {
  console.error(err);
  process.exit(1);
});
