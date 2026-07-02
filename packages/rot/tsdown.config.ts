import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  // Curated public entry points: the root barrel plus concrete modules.
  // Abstract bases (fov/fov, path/path, scheduler/scheduler, map/map,
  // map/dungeon, noise/noise) and internals (MinHeap, util, map/features) are
  // bundled as needed but not published as subpaths — their public types are
  // re-exported from the barrel.
  entry: [
    "src/index.ts",
    "src/rng.ts",
    "src/engine.ts",
    "src/eventqueue.ts",
    "src/constants.ts",
    "src/color.ts",
    "src/text.ts",
    "src/lighting.ts",
    "src/stringgenerator.ts",
    "src/scheduler/action.ts",
    "src/scheduler/simple.ts",
    "src/scheduler/speed.ts",
    "src/fov/discrete-shadowcasting.ts",
    "src/fov/precise-shadowcasting.ts",
    "src/fov/recursive-shadowcasting.ts",
    "src/path/astar.ts",
    "src/path/dijkstra.ts",
    "src/map/arena.ts",
    "src/map/cellular.ts",
    "src/map/digger.ts",
    "src/map/dividedmaze.ts",
    "src/map/ellermaze.ts",
    "src/map/iceymaze.ts",
    "src/map/rogue.ts",
    "src/map/uniform.ts",
    "src/noise/simplex.ts",
  ],
  dts: {
    tsgo: true,
  },
  exports: true,
});
