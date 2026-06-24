import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: ["src/index.ts", "src/interest.ts"],
  dts: {
    tsgo: true,
  },
  exports: true,
  deps: {
    neverBundle: ["cloudflare:workers"],
  },
});
