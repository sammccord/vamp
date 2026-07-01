import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    vamp: "src/vamp.ts",
  },
  dts: {
    tsgo: true,
  },
  // Auto-generate the exports map, but name the CLI binary `vamp` explicitly.
  // Without this, tsdown derives the bin key from the unscoped package name
  // (`@vampgg/cli` -> `cli`); the object form sets the command name directly.
  exports: {
    bin: { vamp: "src/vamp.ts" },
  },
});
