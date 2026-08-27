import tsdownConfig from "./tsdown.config.ts";

import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: tsdownConfig,
  // `solid-js` lists its `node` export condition ahead of `development`, so a
  // plain node test run silently loads the SSR build: writes commit synchronously,
  // `flush()` becomes a no-op, and the dev-only owned-write diagnostics never fire.
  // The suite would pass for the wrong reason. Vitest resolves the node
  // environment through the SSR graph, so the override has to live under `ssr`.
  // `tests/build-conditions.test.ts` fails if this stops taking effect.
  ssr: { resolve: { conditions: ["browser", "development"] } },
});
