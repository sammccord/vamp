import { defineConfig } from "vite-plus";

export default defineConfig({
  create: {
    defaultTemplate: "@vamp",
  },
  staged: {
    "*": "vp check --fix",
  },
  // Skip generated sources (bebopc output + @vamp/config emit) from both passes:
  // they are rewritten on every codegen run, so formatting/linting them only
  // churns diffs and surfaces warnings the generators own.
  fmt: { ignorePatterns: ["**/bebop.ts", "**/*.generated.ts"] },
  lint: {
    ignorePatterns: ["**/bebop.ts", "**/*.generated.ts"],
    options: { typeAware: true, typeCheck: true },
  },
});
