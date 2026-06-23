import { defineConfig } from "vite-plus";

// Dedicated config for the mitata full-stack benchmark. Kept separate from
// vite.config.mts so `vp test` (which only globs tests/**/*.test.ts) never boots
// wrangler dev or runs the long benchmark; run it explicitly via `pnpm bench`.
export default defineConfig({
  test: {
    include: ["tests/**/*.bench.ts"],
    // Booting wrangler dev + populating worlds + running every mitata trial.
    testTimeout: 600_000,
    hookTimeout: 180_000,
    // Single process, no isolation: one wrangler dev server, one steady JIT for
    // mitata's measurement loops.
    pool: "forks",
    fileParallelism: false,
    isolate: false,
    // Let mitata's live ASCII report stream straight to the terminal.
    disableConsoleIntercept: true,
    server: {
      deps: {
        // Same @tempojs ESM-interop workaround as vite.config.mts.
        inline: [/@tempojs\//],
      },
    },
  },
});
