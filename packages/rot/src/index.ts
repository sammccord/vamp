/**
 * Curated public surface of `@vampgg/rot`. Import from here (`@vampgg/rot`) or
 * from a concrete-module subpath (`@vampgg/rot/path/astar`) for tighter
 * tree-shaking. Abstract base classes (`fov/fov`, `path/path`,
 * `scheduler/scheduler`, `map/map`, `map/dungeon`, `noise/noise`) and internal
 * support code (`MinHeap`, `util`) are intentionally not published as
 * subpaths — their public types are re-exported below.
 */

// RNG: shared singleton (rot.js-style) + the class for isolated instances.
export { default as RNG, RNG as RNGClass } from "./rng";

export { default as Engine } from "./engine";
export { default as EventQueue } from "./eventqueue";
export { default as Lighting } from "./lighting";
export { default as StringGenerator } from "./stringgenerator";

export { DEFAULT_HEIGHT, DEFAULT_WIDTH, DIRS, KEYS } from "./constants";

// Function-namespace modules (rot.js `ROT.Color` / `ROT.Text` style).
export * as Color from "./color";
export * as Text from "./text";

// Schedulers (concrete).
export { default as ActionScheduler } from "./scheduler/action";
export { default as SimpleScheduler } from "./scheduler/simple";
export { default as SpeedScheduler } from "./scheduler/speed";

// FOV algorithms (concrete) + the base-class callback/option types.
export { default as DiscreteShadowcasting } from "./fov/discrete-shadowcasting";
export { default as PreciseShadowcasting } from "./fov/precise-shadowcasting";
export { default as RecursiveShadowcasting } from "./fov/recursive-shadowcasting";
export type { LightPassesCallback, Options as FOVOptions, VisibilityCallback } from "./fov/fov";

// Pathfinding (concrete) + the base-class callback/option types.
export { default as AStar } from "./path/astar";
export { default as Dijkstra } from "./path/dijkstra";
export type { ComputeCallback, Options as PathOptions, PassableCallback } from "./path/path";

// Map generators (concrete) + the feature types dungeon generators expose.
export { default as Arena } from "./map/arena";
export { default as Cellular } from "./map/cellular";
export { default as Digger } from "./map/digger";
export { default as DividedMaze } from "./map/dividedmaze";
export { default as EllerMaze } from "./map/ellermaze";
export { default as IceyMaze } from "./map/iceymaze";
export { default as Rogue } from "./map/rogue";
export { default as Uniform } from "./map/uniform";
export { Corridor, Room } from "./map/features";

// Noise.
export { default as SimplexNoise } from "./noise/simplex";
