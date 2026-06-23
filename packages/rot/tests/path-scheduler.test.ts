import { describe, expect, test } from "vitest";
import AStar from "../src/path/astar.ts";
import EventQueue from "../src/eventqueue.ts";
import Action from "../src/scheduler/action.ts";

/* ------------------------------------------------------------------ helpers */

// A small set of fixed maps ('#' wall, '.' floor) for deterministic testing.
function parseMap(rows: string[]) {
  const H = rows.length;
  const W = rows[0]!.length;
  const isFloor = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && rows[y]![x] === ".";
  return { W, H, isFloor };
}

const OPEN = ["..........", "..........", "..........", "..........", ".........."];

const WALLED = [
  "..........",
  ".####.###.",
  ".#......#.",
  ".#.####.#.",
  ".#......#.",
  ".######.#.",
  "..........",
];

const OBSTACLES = [
  "................",
  "..####....####..",
  "..#..........#..",
  "..#..####..#..#.",
  ".....#..#.....#.",
  "..#..#..#..#..#.",
  "..#.....#..####.",
  "..#######.......",
  "................",
];

const DIRS4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIRS8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
// hex direction set (matches DIRS[6] in src/constants.ts)
const DIRS6 = [
  [-1, -1],
  [1, -1],
  [2, 0],
  [1, 1],
  [-1, 1],
  [-2, 0],
];

// BFS shortest length on a unit-cost grid over a given direction set. Returns
// the number of cells on the path (inclusive), or -1 when unreachable.
function bfsLen(
  map: { W: number; H: number; isFloor: (x: number, y: number) => boolean },
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  dirs: number[][],
) {
  const key = (x: number, y: number) => y * map.W + x;
  const dist = new Map<number, number>();
  const queue: [number, number][] = [[fx, fy]];
  dist.set(key(fx, fy), 1);
  while (queue.length) {
    const [x, y] = queue.shift()!;
    const d = dist.get(key(x, y))!;
    if (x === tx && y === ty) return d;
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (!map.isFloor(nx, ny)) continue;
      const k = key(nx, ny);
      if (dist.has(k)) continue;
      dist.set(k, d + 1);
      queue.push([nx, ny]);
    }
  }
  return -1;
}

function runAStar(
  map: { W: number; H: number; isFloor: (x: number, y: number) => boolean },
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  topology: 4 | 6 | 8,
) {
  const passable = (x: number, y: number) => map.isFloor(x, y);
  const astar = new AStar(tx, ty, passable, { topology, width: map.W });
  const path: [number, number][] = [];
  astar.compute(fx, fy, (x: number, y: number) => path.push([x, y]));
  return path;
}

/* -------------------------------------------------------------------- A* */

describe("AStar", () => {
  // Plan 16, Test 1: correctness parity vs. BFS reference (same direction set as
  // the A* topology). BFS gives the true shortest length on unit-cost grids.
  test("topology 4: path length equals BFS shortest length", () => {
    for (const rows of [OPEN, WALLED, OBSTACLES]) {
      const map = parseMap(rows);
      // pick reachable endpoints (top-left-ish to bottom-right-ish floor cells)
      const path = runAStar(map, 0, 0, map.W - 1, map.H - 1, 4);
      const ref = bfsLen(map, 0, 0, map.W - 1, map.H - 1, DIRS4);
      expect(path.length).toBe(ref);
      // contiguous & passable
      for (const [x, y] of path) expect(map.isFloor(x, y)).toBe(true);
    }
  });

  test("topology 8: path length equals diagonal-BFS shortest length", () => {
    for (const rows of [OPEN, WALLED, OBSTACLES]) {
      const map = parseMap(rows);
      const path = runAStar(map, 0, 0, map.W - 1, map.H - 1, 8);
      const ref = bfsLen(map, 0, 0, map.W - 1, map.H - 1, DIRS8);
      expect(path.length).toBe(ref);
      for (const [x, y] of path) expect(map.isFloor(x, y)).toBe(true);
    }
  });

  test("topology 6: path length equals hex-BFS shortest length", () => {
    const map = parseMap(OPEN);
    // (8,4) is hex-reachable from (0,0) (same (x+y) parity class); (9,4) is not.
    const tx = 8;
    const ty = 4;
    const path = runAStar(map, 0, 0, tx, ty, 6);
    const ref = bfsLen(map, 0, 0, tx, ty, DIRS6);
    expect(ref).toBeGreaterThan(0); // sanity: the target is reachable under hex
    expect(path.length).toBe(ref);
    for (const [x, y] of path) expect(map.isFloor(x, y)).toBe(true);
    // reconstruction starts at the FROM cell and walks .prev back to the target.
    expect(path[0]).toEqual([0, 0]); // from
    expect(path[path.length - 1]).toEqual([tx, ty]); // to (target)
  });

  test("path is a contiguous chain of adjacent cells (topology 8)", () => {
    const map = parseMap(OBSTACLES);
    const path = runAStar(map, 0, 0, map.W - 1, map.H - 1, 8);
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i]![0] - path[i - 1]![0]);
      const dy = Math.abs(path[i]![1] - path[i - 1]![1]);
      expect(dx <= 1 && dy <= 1 && dx + dy > 0).toBe(true);
    }
  });

  test("no path emits nothing when target is unreachable", () => {
    // Two isolated floor pockets separated by a solid wall column.
    const rows = ["#.#.#", "#.#.#", "#.#.#"];
    const map = parseMap(rows);
    // from (1,1) on the left pocket to (3,1) on the right pocket — no connection
    const passable = (x: number, y: number) => map.isFloor(x, y);
    const astar = new AStar(3, 1, passable, { topology: 4, width: 5 });
    const path: [number, number][] = [];
    astar.compute(1, 1, (x: number, y: number) => path.push([x, y]));
    expect(bfsLen(map, 1, 1, 3, 1, DIRS4)).toBe(-1); // sanity: truly unreachable
    expect(path.length).toBe(0);
  });

  // Plan 16, Test 2: sub-quadratic scaling. Gated on a generous bound the old
  // O(n^2) code clearly violates and the new O(E log V) clearly passes.
  test("scales sub-quadratically with open-map size", () => {
    const timeOnce = (n: number) => {
      const map = {
        W: n,
        H: n,
        isFloor: () => true,
      };
      const t0 = performance.now();
      runAStar(map, 0, 0, n - 1, n - 1, 8);
      return performance.now() - t0;
    };
    const median = (n: number) => {
      const xs = [timeOnce(n), timeOnce(n), timeOnce(n)].sort((a, b) => a - b);
      return xs[1]!;
    };
    // warm up
    timeOnce(50);
    const t100 = Math.max(median(100), 0.05);
    const t400 = median(400);
    // O(n^2) would be ~16x for a 4x size increase; heap A* is far below that.
    expect(t400 / t100).toBeLessThan(16);
  });

  // Plan 16, Test 5: bad topology throws (no silent NaN).
  test("illegal topology throws instead of producing NaN paths", () => {
    const map = parseMap(OPEN);
    const passable = (x: number, y: number) => map.isFloor(x, y);
    // bypass typing on the @ts-nocheck file by casting
    const astar = new AStar(5, 4, passable, { topology: 5 as any, width: map.W });
    expect(() => astar.compute(0, 0, () => {})).toThrow(/topology/i);
  });

  test("non-square map uses width so cell keys do not collide", () => {
    // wide, short map; a too-small key stride would alias cells across rows.
    const rows = ["................", "................", "................"];
    const map = parseMap(rows);
    const path = runAStar(map, 0, 0, map.W - 1, map.H - 1, 8);
    const ref = bfsLen(map, 0, 0, map.W - 1, map.H - 1, DIRS8);
    expect(path.length).toBe(ref);
  });
});

/* --------------------------------------------------------------- EventQueue */

describe("EventQueue", () => {
  // Plan 16, Test 3: returns events in absolute time order across advances.
  test("returns events in absolute time order across advances", () => {
    const q = new EventQueue<string>();
    q.add("a", 5);
    q.add("b", 2);
    q.add("c", 8);
    expect(q.get()).toBe("b");
    expect(q.getTime()).toBe(2);
    expect(q.get()).toBe("a");
    expect(q.getTime()).toBe(5);
    expect(q.get()).toBe("c");
    expect(q.getTime()).toBe(8);
  });

  test("getTime is monotonic non-decreasing as events drain in order", () => {
    const q = new EventQueue<number>();
    const times = [3, 1, 4, 1, 5, 9, 2, 6, 0, 7];
    times.forEach((t, i) => q.add(i, t));
    let last = -Infinity;
    const drained: number[] = [];
    while (true) {
      const ev = q.get();
      if (ev === null) break;
      expect(q.getTime()).toBeGreaterThanOrEqual(last);
      last = q.getTime();
      drained.push(last);
    }
    // the absolute fire times emerged sorted (in-place shift preserved order)
    expect(drained).toEqual([...times].sort((a, b) => a - b));
  });

  test("shift mutates keys in place without reallocating the heap array", () => {
    const q = new EventQueue<string>();
    q.add("a", 5);
    q.add("b", 2);
    // reach into internals: the heap array reference must stay stable across get()
    const heapBefore = (q as any)._events.heap;
    q.get(); // advances time, triggers shift(-time)
    const heapAfter = (q as any)._events.heap;
    expect(heapAfter).toBe(heapBefore); // same array identity -> no realloc
  });
});

/* ------------------------------------------------------------------- Action */

describe("Action scheduler", () => {
  // Plan 16, Test 4: honors a 0-cost (free) action.
  test("honors a 0-cost (free) action", () => {
    const s = new Action<string>();
    s.add("free", false, 0);
    s.add("normal", false, 1);
    expect(s.next()).toBe("free"); // 0-cost goes first
    expect((s as any).getTime()).toBe(0);
    expect(s.next()).toBe("normal");
    expect((s as any).getTime()).toBe(1);
  });

  test("omitted time still defaults to 1", () => {
    const s = new Action<string>();
    s.add("a", false);
    expect(s.next()).toBe("a");
    expect((s as any).getTime()).toBe(1);
  });

  test("repeated 0-cost action via setDuration(0) stays at cost 0", () => {
    const s = new Action<string>();
    s.add("loop", true, 0);
    expect(s.next()).toBe("loop");
    expect((s as any).getTime()).toBe(0);
    s.setDuration(0);
    // next() re-schedules the repeating current at _duration (0)
    expect(s.next()).toBe("loop");
    expect((s as any).getTime()).toBe(0);
  });
});
