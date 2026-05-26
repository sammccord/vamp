#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { generateCommand } from "./commands/generate";
import { initCommand } from "./commands/init";

const main = defineCommand({
  meta: {
    name: "vamp-config",
    description: "ECS code generator for @vamp",
  },
  subCommands: {
    generate: generateCommand,
    init: initCommand,
  },
});

runMain(main);
