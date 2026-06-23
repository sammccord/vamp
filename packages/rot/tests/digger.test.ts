import { describe, expect, test } from "vitest";
import Digger from "../src/map/digger.ts";
import RNG from "../src/rng.ts";

describe("Digger", () => {
  // Plan 09, Test 1: structural regression (headline assertions).
  test("produces a connected dungeon near the dug target", () => {
    RNG.setSeed(12345);
    const W = 80;
    const H = 40;
    let dugCount = 0;
    const digger = new Digger(W, H, { dugPercentage: 0.2 });
    digger.create((_x: number, _y: number, contents: number) => {
      if (contents === 0) dugCount++; // 0 = floor in this port's convention
    });

    const rooms = (digger as any).getRooms();
    const corridors = (digger as any).getCorridors();

    expect(rooms.length).toBeGreaterThan(1); // was 1 (only the first room)
    expect(corridors.length).toBeGreaterThan(0); // was 0

    const area = (W - 2) * (H - 2);
    const fraction = dugCount / area;
    // near the 0.2 target — generous band to absorb seed/feature variance
    expect(fraction).toBeGreaterThan(0.1); // was ~0.01
    expect(fraction).toBeLessThan(0.6);
  });

  // Plan 09, Test 2: multiple seeds (no degenerate output).
  test("is non-degenerate across multiple seeds", () => {
    for (const seed of [1, 2, 42, 1000, 99999]) {
      RNG.setSeed(seed);
      const digger = new Digger(60, 30, { dugPercentage: 0.2 });
      let dug = 0;
      digger.create((_x: number, _y: number, c: number) => {
        if (c === 0) dug++;
      });
      expect((digger as any).getRooms().length).toBeGreaterThan(1);
      expect(dug).toBeGreaterThan((60 - 2) * (30 - 2) * 0.1);
    }
  });

  // Plan 09, Test 4 (optional, stronger): connectivity via flood fill over the
  // returned map proves corridors actually connect the rooms.
  test("all room centers are reachable from the first room (connectivity)", () => {
    RNG.setSeed(777);
    const W = 60;
    const H = 30;
    const grid: number[][] = Array.from({ length: W }, () => Array.from({ length: H }, () => 1));
    const digger = new Digger(W, H, { dugPercentage: 0.2 });
    digger.create((x: number, y: number, c: number) => {
      grid[x]![y] = c;
    });

    const rooms = (digger as any).getRooms();
    expect(rooms.length).toBeGreaterThan(1);

    const centerOf = (r: any) => r.getCenter() as [number, number];

    // BFS flood fill over floor cells (0) from the first room's center.
    const [sx, sy] = centerOf(rooms[0]);
    const seen = new Set<number>();
    const key = (x: number, y: number) => y * W + x;
    const queue: [number, number][] = [[sx, sy]];
    seen.add(key(sx, sy));
    while (queue.length) {
      const [x, y] = queue.shift()!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (grid[nx]![ny] !== 0) continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }

    for (const room of rooms) {
      const [cx, cy] = centerOf(room);
      expect(seen.has(key(cx, cy))).toBe(true);
    }
  });
});
