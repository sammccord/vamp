import tsdownConfig from "./tsdown.config.ts";

import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: tsdownConfig,
});
