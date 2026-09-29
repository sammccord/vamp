import { defineConfig } from "vite-plus";

export default defineConfig({
  create: {
    defaultTemplate: "@vampgg",
  },
  staged: {
    "*": "vp check --fix",
  },
  // Skip generated sources (bebopc output + @vampgg/cli emit) from both passes:
  // they are rewritten on every codegen run, so formatting/linting them only
  // churns diffs and surfaces warnings the generators own.
  //
  // `.changeset/**` and `**/CHANGELOG.md` are Changeset-tool-owned: `changeset
  // version` rewrites `.changeset/pre.json` and (re)generates CHANGELOGs during
  // the release run in a layout oxfmt does not consider canonical (e.g. it
  // writes `"changesets": [\n  "id"\n]` where oxfmt wants it inlined), which
  // would fail the release's `vp check` fmt gate on files the tool owns.
  fmt: {
    ignorePatterns: [
      "**/bebop.ts",
      "**/*.generated.ts",
      ".changeset/**",
      "**/CHANGELOG.md",
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      ".zed/**",
      ".vite-hooks/**",
      "tools/oxlint/anti-slop/**",
    ],
  },
  lint: {
    // `.opencode/**` holds the verify-vamp harness. Its scenarios import `vitest`
    // and `@vampgg/*` through a `node_modules` symlink that `control-vamp up`
    // creates at run time (see that skill's SKILL.md), so they are unresolvable
    // until the skill bootstraps itself and can never type-check on CI. Running
    // the skill is what validates them.
    // The agent-tooling dot-dirs (`.claude`, `.zed`, ...) and `.vite-hooks`
    // hold editor- and agent-owned config those tools regenerate, not
    // application source, and `tools/oxlint/anti-slop/**` is the vendored
    // plugin itself, so none of them belong in the lint or typecheck passes.
    ignorePatterns: [
      "**/bebop.ts",
      "**/*.generated.ts",
      ".opencode/**",
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      ".zed/**",
      ".vite-hooks/**",
      "tools/oxlint/anti-slop/**",
    ],
    jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
    // Both flag deliberate patterns: `new Array(n)` preallocates fixed-size ring
    // buffers / scratch arrays (Array.from({length}) would create holey arrays),
    // and the `[...map]`/`[...set]` spreads snapshot a collection before it is
    // mutated (entries deleted) during the same — sometimes async — iteration in
    // the stream-teardown sweeps. Removing either reintroduces a real defect.
    rules: {
      "unicorn/no-new-array": "off",
      "unicorn/no-useless-spread": "off",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
});
