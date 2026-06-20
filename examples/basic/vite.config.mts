import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Booting a local wrangler dev server + durable objects takes a moment.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    server: {
      deps: {
        // @tempojs/* (0.0.12) statically import `BebopJson` from `bebop`, an
        // export dropped in bebop@3.2.3. Native ESM linking rejects the missing
        // named export; inlining lets Vite transform these with lazy bindings
        // (the symbol is only dereferenced in code paths we never hit).
        inline: [/@tempojs\//],
      },
    },
  },
});
