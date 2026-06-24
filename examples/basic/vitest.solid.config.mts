import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vite-plus";

// `game.generated` (imported for the pure `createECSOptions`/`components`/delta
// functions) also imports `@vamp/worker` to define Durable Object classes, and
// the real `@vamp/worker` imports the CF-runtime-only `cloudflare:workers` virtual
// module. Intercept the `@vamp/worker` import (made by the vite-transformed
// generated module) and resolve it to a stub so the client graph loads under
// vite/jsdom. The real worker runs in the separate `wrangler dev` process.
const workerStub = fileURLToPath(new URL("./tests/support/worker-stub.ts", import.meta.url));

// Dedicated config for the @vamp/solid end-to-end suite. Kept separate from
// vite.config.mts so the default `vp test` (node, rpc.test.ts) is unaffected:
// these tests need a DOM (jsdom), the Solid JSX transform (vite-plugin-solid),
// and a polyfilled global WebSocket (setupFiles). Run via `pnpm test:e2e`.
export default defineConfig({
  plugins: [
    {
      name: "stub-vamp-worker",
      enforce: "pre",
      resolveId(source: string) {
        if (source === "@vamp/worker") return workerStub;
        return null;
      },
    },
    solid(),
  ],
  test: {
    include: ["tests/**/*.solid.test.tsx"],
    environment: "jsdom",
    setupFiles: ["./tests/support/solid-setup.ts"],
    // Booting a local wrangler dev server + durable objects takes a moment.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    server: {
      deps: {
        // @tempojs/* (0.0.12) statically import `BebopJson` from `bebop`, dropped
        // in bebop@3.2.3 — inline so Vite transforms with lazy bindings. @vamp/solid
        // is inlined so its solid-js import dedupes to the one instance.
        inline: [/@tempojs\//, "@vamp/solid"],
      },
    },
  },
});
