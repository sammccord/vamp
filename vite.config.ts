import { defineConfig } from "vite-plus";

export default defineConfig({
  create: {
    defaultTemplate: "@vamp",
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
});
