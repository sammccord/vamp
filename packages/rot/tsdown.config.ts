import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: ["src/**/*"],
  dts: {
    tsgo: true,
  },
  exports: true,
  // ...config options
});
