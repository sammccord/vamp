import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import tsdownConfig from "./tsdown.config.ts";

// DO lifecycle tests (`tests/**/*.do.test.ts`) import the Durable Object, which
// imports the workerd-only `cloudflare:workers` virtual module. Alias it to a
// stub base class so the DO loads + runs under the plain-Node test runner. This
// affects only `vp test`/`vp dev`; the published build uses `tsdown.config.ts`
// (`neverBundle: ["cloudflare:workers"]`), so the real module stays external.
const cfWorkersStub = fileURLToPath(
  new URL("./tests/support/cloudflare-workers-stub.ts", import.meta.url),
);

export default defineConfig({
  pack: tsdownConfig,
  plugins: [
    {
      name: "stub-cloudflare-workers",
      enforce: "pre",
      resolveId(source: string) {
        if (source === "cloudflare:workers") return cfWorkersStub;
        return null;
      },
    },
  ],
});
