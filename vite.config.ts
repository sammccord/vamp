import { defineConfig } from "vite-plus";

export default defineConfig({
  create: {
    defaultTemplate: "@vamp",
  },
  staged: {
    "*": "vp check --fix",
  },
  // Skip generated sources (bebopc output + @vamp/cli emit) from both passes:
  // they are rewritten on every codegen run, so formatting/linting them only
  // churns diffs and surfaces warnings the generators own.
  fmt: { ignorePatterns: ["**/bebop.ts", "**/*.generated.ts"] },
  lint: {
    ignorePatterns: ["**/bebop.ts", "**/*.generated.ts"],
    // Both flag deliberate patterns: `new Array(n)` preallocates fixed-size ring
    // buffers / scratch arrays (Array.from({length}) would create holey arrays),
    // and the `[...map]`/`[...set]` spreads snapshot a collection before it is
    // mutated (entries deleted) during the same — sometimes async — iteration in
    // the stream-teardown sweeps. Removing either reintroduces a real defect.
    rules: {
      "unicorn/no-new-array": "off",
      "unicorn/no-useless-spread": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
});
