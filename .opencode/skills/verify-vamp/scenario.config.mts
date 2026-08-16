import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const scenario = process.env.VAMP_SCENARIO;
if (!scenario) throw new Error("VAMP_SCENARIO must point at a scenario file");

export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  test: {
    include: [scenario],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    server: { deps: { inline: [/@tempojs\//] } },
  },
});
