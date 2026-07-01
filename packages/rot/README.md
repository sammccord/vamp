# @vampgg/rot

A TypeScript roguelike toolkit providing low-level utilities for game development: procedural map generation, field-of-view, pathfinding, turn scheduling, lighting, noise, color manipulation, text formatting, and more.

Each module is a focused, standalone utility. Import only what you need via subpath exports.

## Development

```bash
vp install        # install dependencies
vp test           # run tests
vp run build      # build the library (outputs to dist/)
```

## Import Pattern

All modules are available as subpath exports from the `@vampgg/rot` package:

```ts
import { RNG } from "@vampgg/rot/rng";
import { Digger } from "@vampgg/rot/map/digger";
import { PreciseShadowcasting } from "@vampgg/rot/fov/precise-shadowcasting";
```

`@vampgg/rot` has no root export — always import from the specific subpath.

---

## Core Patterns

### RNG Singleton

All probabilistic modules share a single `RNG` instance from `@vampgg/rot/rng`. Seed it once at startup to make the entire generation pipeline deterministic:

```ts
import { RNG } from "@vampgg/rot/rng";
RNG.setSeed(12345);
```

After seeding, all map generators, noise, string generators, and color randomization produce identical results across runs.

### Callback-Driven Output

Map generators, FOV, pathfinding, and lighting all deliver results via callbacks rather than returning data structures:

```ts
// Map generator
digger.create((x, y, contents) => {
  /* 0=floor, 1=wall, 2=door */
});

// FOV
fov.compute(x, y, radius, (x, y, r, visibility) => {
  /* mark visible */
});

// Pathfinding
astar.compute(fromX, fromY, (x, y) => {
  /* step along path */
});

// Lighting
lighting.compute((x, y, color) => {
  /* apply color to cell */
});
```

### Topology

Many systems support a `topology` option controlling the grid shape:

| Value | Grid type              | Directions          |
| ----- | ---------------------- | ------------------- |
| `4`   | Square, cardinal only  | N/E/S/W             |
| `8`   | Square, all directions | N/NE/E/SE/S/SW/W/NW |
| `6`   | Hexagonal              | 6 hex directions    |

FOV, pathfinding, map generators (`Cellular`), and `DIRS` constants all accept this option.

### Options Pattern

All configurable classes accept a `Partial<Options>` merged with sensible defaults. All options are optional:

```ts
const digger = new Digger(80, 25, {
  roomWidth: [4, 10],
  dugPercentage: 0.3,
});
```

---

## Modules

### `@vampgg/rot/rng` — Seedable RNG

Seedable pseudorandom number generator (Alea algorithm). Exported as a singleton.

```ts
import { RNG } from "@vampgg/rot/rng";

RNG.setSeed(42);
RNG.getUniform(); // float in [0, 1)
RNG.getUniformInt(1, 6); // integer in [1, 6]
RNG.getNormal(0, 1); // normal distribution
RNG.getItem(["a", "b", "c"]); // random element
RNG.shuffle([1, 2, 3, 4]); // shuffled copy
RNG.getWeightedValue({ sword: 10, axe: 5, bow: 3 }); // weighted pick

const state = RNG.getState(); // serialize state
RNG.setState(state); // restore state
const rng2 = RNG.clone(); // independent copy
```

---

### `@vampgg/rot/color` — Color Manipulation

Works with the `Color` type: `[R, G, B]` (0–255 each).

```ts
import * as Color from "@vampgg/rot/color";

const red = Color.fromString("red"); // [255, 0, 0]
const hex = Color.fromString("#ff8800");
const sum = Color.add(red, [0, 128, 0]); // add component-wise
const blended = Color.interpolate(red, [0, 0, 255], 0.5); // lerp RGB
const smooth = Color.interpolateHSL(red, [0, 0, 255], 0.5); // lerp HSL
const jittered = Color.randomize(red, 20); // random ± perturbation

Color.toRGB(blended); // 'rgb(127, 0, 127)'
Color.toHex(blended); // '#7f007f'
```

---

### `@vampgg/rot/constants` — Shared Constants

```ts
import { DEFAULT_WIDTH, DEFAULT_HEIGHT, DIRS, KEYS } from "@vampgg/rot/constants";

// Direction vectors
DIRS[4]; // [[0,-1],[1,0],[0,1],[-1,0]]       — cardinal
DIRS[8]; // 8-directional including diagonals
DIRS[6]; // hex directions

// Key codes for keyboard input handling
KEYS.VK_UP; // 38
KEYS.VK_ESCAPE; // 27
```

---

### `@vampgg/rot/util` — Math & String Utilities

```ts
import { mod, clamp, capitalize, format } from "@vampgg/rot/util";

mod(-1, 4); // 3  (always-positive modulo)
clamp(1.5, 0, 1); // 1
capitalize("hello"); // 'Hello'
format("Hello %s!", "world"); // 'Hello world!'
```

---

### `@vampgg/rot/noise/simplex` — Simplex Noise

2D simplex noise for terrain, cave thresholds, and procedural variation. Returns values in approximately `[-1, 1]`.

```ts
import { Simplex } from "@vampgg/rot/noise/simplex";

const noise = new Simplex(); // uses global RNG for permutation table
const value = noise.get(x * 0.1, y * 0.1);
// value > 0.2 → floor, else → wall
```

---

## Map Generation — `@vampgg/rot/map/*`

All generators share the `create(callback)` interface where `callback(x, y, contents)` is called per cell with `contents`: `0` = floor, `1` = wall, `2` = door.

### `@vampgg/rot/map/arena` — Open Room

A single rectangular room with walls on the border. Useful for testing.

```ts
import { Arena } from "@vampgg/rot/map/arena";
new Arena(40, 20).create((x, y, wall) => {
  /* ... */
});
```

### `@vampgg/rot/map/cellular` — Cellular Automaton (Caves)

Conway's Game of Life variant. Call `create()` multiple times to evolve. Use `connect()` to guarantee full connectivity.

```ts
import { Cellular } from "@vampgg/rot/map/cellular";

const map = new Cellular(80, 40, { topology: 8 });
map.randomize(0.5); // 50% random fill
for (let i = 0; i < 4; i++) map.create(); // evolve 4 generations
map.connect((x, y, wall) => {
  /* final map */
}, 0); // connect floors
```

### `@vampgg/rot/map/digger` — Organic Dungeon

Grows a dungeon outward from a center room by iteratively adding rooms and corridors. Stops when `dugPercentage` of the area is open.

```ts
import { Digger } from "@vampgg/rot/map/digger";

const dungeon = new Digger(80, 25, {
  roomWidth: [4, 10],
  roomHeight: [4, 8],
  corridorLength: [2, 6],
  dugPercentage: 0.25,
});
dungeon.create((x, y, wall) => {
  /* ... */
});
dungeon.getRooms(); // Room[]
dungeon.getCorridors(); // Corridor[]
```

### `@vampgg/rot/map/uniform` — Uniform Density Dungeon

Places rooms independently then connects them with I/L/S-shaped corridors.

```ts
import { Uniform } from "@vampgg/rot/map/uniform";

const result = new Uniform(80, 25, { roomDugPercentage: 0.15 }).create(cb);
// returns null on timeout, 'this' on success
```

### `@vampgg/rot/map/rogue` — Classic Rogue Dungeon

Divides the map into a grid of cells, places one room per cell, then connects them.

```ts
import { Rogue } from "@vampgg/rot/map/rogue";
new Rogue(80, 25, { cellWidth: 3, cellHeight: 3 }).create(cb);
```

### Mazes

Three maze algorithms, all producing perfect mazes (no loops, fully connected):

```ts
import { DividedMaze } from "@vampgg/rot/map/dividedmaze"; // recursive division
import { EllerMaze } from "@vampgg/rot/map/ellermaze"; // Eller's row-by-row algorithm
import { IceyMaze } from "@vampgg/rot/map/iceymaze"; // random walk; regularity=0–N

new DividedMaze(40, 20).create(cb);
new IceyMaze(40, 20, 3).create(cb); // regularity 3 = straighter corridors
```

### `@vampgg/rot/map/features` — Rooms & Corridors

Low-level building blocks used internally by dungeon generators. Useful when implementing custom generators.

```ts
import { Room, Corridor } from "@vampgg/rot/map/features";

const room = Room.createRandom(80, 25, { roomWidth: [4, 8] });
room.create((x, y, contents) => {
  /* ... */
});
room.getCenter(); // [cx, cy]
room.getDoors(cb); // iterate door positions
room.addDoors(isWallCb); // auto-detect and add doors
```

---

## Field of View — `@vampgg/rot/fov/*`

All FOV algorithms take a `lightPassesCallback(x, y): boolean` at construction time and compute via `compute(x, y, radius, visibilityCallback)`.

### `@vampgg/rot/fov/recursive-shadowcasting` — (Recommended)

Best general-purpose FOV for standard square-grid roguelikes. Supports full 360°, 180° (facing + flanks), and 90° (narrow cone) variants.

```ts
import { RecursiveShadowcasting } from "@vampgg/rot/fov/recursive-shadowcasting";

const fov = new RecursiveShadowcasting((x, y) => map[x][y] === 0);

fov.compute(playerX, playerY, 8, (x, y, r, visibility) => {
  if (visibility > 0) markVisible(x, y);
});

// Directional variants:
fov.compute180(x, y, 8, dir, cb); // dir is index into DIRS[8]
fov.compute90(x, y, 8, dir, cb);
```

### `@vampgg/rot/fov/precise-shadowcasting`

Higher-precision shadowcasting using fractional arcs. The visibility callback receives values in `[0, 1]` for partial occlusion.

```ts
import { PreciseShadowcasting } from "@vampgg/rot/fov/precise-shadowcasting";

const fov = new PreciseShadowcasting((x, y) => isTransparent(x, y));
fov.compute(x, y, 10, (x, y, r, visibility) => {
  applyFog(x, y, 1 - visibility); // partial visibility supported
});
```

### `@vampgg/rot/fov/discrete-shadowcasting`

Simpler, older algorithm. Integer-degree precision. Prefer `RecursiveShadowcasting` unless compatibility is required.

---

## `@vampgg/rot/lighting` — Multi-Source Lighting

Computes light contributions from multiple sources using FOV form factors. Supports optional radiosity-like light bouncing via multiple passes.

```ts
import { Lighting } from "@vampgg/rot/lighting";
import { PreciseShadowcasting } from "@vampgg/rot/fov/precise-shadowcasting";

const fov = new PreciseShadowcasting((x, y) => isTransparent(x, y));
const lighting = new Lighting((x, y) => (map[x][y] === 0 ? 0.3 : 0), {
  range: 12,
  passes: 2, // 1 = direct only, >1 = bounced light
  emissionThreshold: 100,
});
lighting.setFOV(fov);

lighting.setLight(torchX, torchY, [255, 200, 100]); // add a light source
lighting.setLight(torchX, torchY, null); // remove a light source
lighting.clearLights();
lighting.reset(); // call when map topology changes

lighting.compute((x, y, color) => {
  applyLight(x, y, color); // color is [R, G, B]
});
```

---

## Pathfinding — `@vampgg/rot/path/*`

All pathfinders are constructed with a target (`toX, toY`) and a `passableCallback(x, y): boolean`, then compute paths from a given start.

### `@vampgg/rot/path/astar` — A\*

Single-pair shortest path. Use when computing one path per query.

```ts
import { AStar } from "@vampgg/rot/path/astar";

const astar = new AStar(targetX, targetY, (x, y) => isPassable(x, y), { topology: 8 });
astar.compute(fromX, fromY, (x, y) => path.push([x, y]));
```

### `@vampgg/rot/path/dijkstra` — Dijkstra

Builds a BFS tree from the target. Efficient when computing paths from many different start points to the same target (the tree is cached and extended lazily).

```ts
import { Dijkstra } from "@vampgg/rot/path/dijkstra";

const dijkstra = new Dijkstra(targetX, targetY, (x, y) => isPassable(x, y));
// Compute from multiple start points cheaply:
dijkstra.compute(x1, y1, cb1);
dijkstra.compute(x2, y2, cb2);
```

---

## Turn Scheduling — `@vampgg/rot/scheduler/*` + `@vampgg/rot/engine`

### `@vampgg/rot/scheduler/simple` — Round-Robin

All actors take turns in equal rotation. Classic roguelike scheduling.

```ts
import { Simple } from "@vampgg/rot/scheduler/simple";

const scheduler = new Simple<Actor>();
scheduler.add(player, true); // true = repeating
scheduler.add(monster, true);
const next = scheduler.next(); // next actor
```

### `@vampgg/rot/scheduler/speed` — Speed-Based

Actors must implement `getSpeed(): number`. Faster actors act more frequently.

```ts
import { Speed } from "@vampgg/rot/scheduler/speed";

// Actor must have getSpeed()
class Monster {
  getSpeed() {
    return 100;
  }
  async act() {}
}

const scheduler = new Speed<Monster>();
scheduler.add(fastMonster, true);
```

### `@vampgg/rot/scheduler/action` — Action Duration

Each actor declares its action cost during its turn via `scheduler.setDuration(n)`.

```ts
import { Action } from "@vampgg/rot/scheduler/action";

const scheduler = new Action<Actor>();
scheduler.add(player, true, 1);

// Inside actor.act():
scheduler.setDuration(isRunning ? 0.5 : 1);
```

### `@vampgg/rot/engine` — Game Loop

Drives actors through a scheduler. Supports asynchronous actors (return a Promise from `act()` to pause the loop, e.g. while waiting for player input).

```ts
import { Engine } from "@vampgg/rot/engine";

class Player {
  async act() {
    return new Promise<void>((resolve) => {
      waitForKeypress(() => {
        handleInput();
        resolve();
      });
    });
  }
}

const engine = new Engine(scheduler);
engine.start(); // begins calling scheduler.next() and actor.act()
engine.lock(); // pause
engine.unlock(); // resume
```

---

## `@vampgg/rot/eventqueue` — Time-Based Event Queue

Schedules events at relative time offsets. Useful for implementing timers, cooldowns, and non-uniform-speed simulations directly.

```ts
import { EventQueue } from "@vampgg/rot/eventqueue";

const queue = new EventQueue<string>();
queue.add("heal", 10); // schedule 'heal' 10 time units from now
queue.add("spawn", 25);

const event = queue.get(); // returns 'heal', advances time to 10
queue.getTime(); // 10
queue.remove("spawn"); // cancel
```

---

## `@vampgg/rot/stringgenerator` — Markov Name/Text Generator

Learns from a training corpus and generates statistically similar strings. Character-level (default) or word-level.

```ts
import { StringGenerator } from "@vampgg/rot/stringgenerator";

const gen = new StringGenerator({ order: 3, words: false });
["Aragorn", "Legolas", "Gimli", "Boromir"].forEach((n) => gen.observe(n));

gen.generate(); // e.g. 'Aramir', 'Legorn'

// Word-level generation:
const wordGen = new StringGenerator({ order: 2, words: true });
sentences.forEach((s) => wordGen.observe(s));
wordGen.generate();
```

---

## `@vampgg/rot/text` — Color-Markup Text & Word Wrap

Tokenizes strings containing color markup (`%c{name}` for foreground, `%b{name}` for background) with word-wrap support. Used by display/rendering layers.

```ts
import { tokenize, measure, TYPE_TEXT, TYPE_NEWLINE, TYPE_FG, TYPE_BG } from "@vampgg/rot/text";

const tokens = tokenize("%c{red}Hello %c{}world", 40);
// tokens: [TYPE_FG(red), TYPE_TEXT('Hello '), TYPE_FG(reset), TYPE_TEXT('world')]

const { width, height } = measure("%c{red}Some text", 40);
```

Color names are compatible with `@vampgg/rot/color`'s `fromString`.

---

## `@vampgg/rot/MinHeap` — Min-Heap Priority Queue

A generic min-heap used internally by `EventQueue`. Useful directly when you need an efficient priority queue.

```ts
import { MinHeap } from "@vampgg/rot/MinHeap";

const heap = new MinHeap<string>();
heap.push("low priority task", 10);
heap.push("urgent task", 1);
heap.pop(); // { key: 1, timestamp: ..., value: 'urgent task' }
heap.len();
heap.remove("low priority task");
heap.shift(5); // advance all keys by 5
```
