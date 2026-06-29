import { createBaseMutator, ECS, type ECSOptions } from "@vamp/ecs";
import { describe, expect, it } from "vitest";
import { Doc, encodeStateAsUpdate, Map as YMap } from "yjs";

import { entitiesMap, membersMap, writeInsert } from "../../../packages/worker/src/entity-doc";
import { type Entity, type EntityDelta, Tags } from "../src/bebop";

/**
 * GLOBAL-ENTITY SCALE BENCHMARK (node-level; no workerd).
 *
 * Question: how many global entities can the system hold before performance is
 * affected — and where does it hard-break?
 *
 * Hypothesis: the hard ceiling is y-durablestream's 1 MB max-frame limit on the
 * initial full-state SyncStep2. The whole shared world is streamed as ONE frame
 * on every connect (and every backpressure `resync`), so N_max ≈ 1 MB / B where
 * B is the per-entity encoded bytes in the shared doc (components + refcount +
 * membership — the model in `entity-doc.ts`). Below the ceiling, connect-seed
 * and compaction are O(N) and stay within budget, so the break dominates.
 *
 * This is node-only (no Durable Object / wrangler): it imports the real shared-
 * doc writer (`entity-doc.ts`), the real example entity shape (`bebop.ts`), and
 * the real ECS, and replicates y-durablestream's frame codec verbatim (its own
 * protocol.test.ts proves the >1MB FrameDecodeError; here we pin the snapshot to
 * that limit). Neither `@vamp/worker` nor `y-durablestream`'s entry can be
 * imported here — both pull in `cloudflare:workers`.
 */

const A = "bench-ns";

// ── y-durablestream frame codec replica (src/protocol.ts) ────────────────────
// 4-byte big-endian length header + 1 MB payload cap. Mirrors the published
// codec so the ceiling proof exercises the real framing math.
const MAX_FRAME_SIZE = 1024 * 1024;

function encodeFrame(message: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + message.byteLength);
  new DataView(frame.buffer).setUint32(0, message.byteLength, false);
  frame.set(message, 4);
  return frame;
}

/** Decode one frame, throwing exactly as y-durablestream's FrameDecoder does. */
function decodeFrameOrThrow(frame: Uint8Array): Uint8Array {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const len = view.getUint32(0, false);
  if (len > MAX_FRAME_SIZE) {
    throw new Error(`Frame payload length ${len} exceeds maximum of ${MAX_FRAME_SIZE} bytes`);
  }
  return frame.slice(4, 4 + len);
}

// ── ECS options (pure half of game.generated.ts; that file pulls @vamp/worker) ─
const components = {
  id: 1,
  root: 2,
  parent: 4,
  children: 5,
  health: 6,
  position: 7,
  velocity: 8,
  mana: 9,
  stamina: 10,
  level: 11,
  xp: 12,
  faction: 13,
} as const;

function makeOptions(): ECSOptions<Entity, EntityDelta> {
  return {
    createId: () => crypto.randomUUID(),
    components: components as unknown as Record<Exclude<keyof Entity, "tags">, number>,
    // Inserts (what seed measures) never call these; minimal correct stubs.
    materializeDelta: (delta, base) => ({ ...base, ...(delta as object) }) as Entity,
    mergeDelta: (entity, delta) => {
      Object.assign(entity as object, delta as object);
    },
    accumulateDelta: (from, to) => {
      Object.assign(to as object, from as object);
      return to;
    },
  };
}

// ── entity factories ─────────────────────────────────────────────────────────

/** Rich entity (mirrors stress.bench.ts makeStressEntity): the realistic case. */
function richEntity(i: number): Entity {
  const tags: Tags[] = [];
  if (i % 7 === 0) tags.push(Tags.PlayerControlled, Tags.Human);
  if (i % 3 === 0) tags.push(Tags.Hostile);
  if (i % 5 === 0) tags.push(Tags.Flying);
  return {
    id: `e-${i.toString(36).padStart(8, "0")}`,
    tags,
    children: [],
    health: { points: 50 + (i % 50), min: 0, max: 100, rate: 1, interval: 0 },
    position: { x: (i * 13) % 512, y: (i * 7) % 512 },
    velocity: { x: (i % 3) - 1, y: (i % 5) - 2 },
    mana: { points: 20, min: 0, max: 50, rate: 1, interval: 0 },
    stamina: { points: 30, min: 0, max: 30, rate: 0, interval: 0 },
    level: 1 + (i % 10),
    xp: i % 100,
    faction: i % 4,
  } as Entity;
}

/** Lean entity: id + position + health only. */
function leanEntity(i: number): Entity {
  return {
    id: `e-${i.toString(36).padStart(8, "0")}`,
    tags: [],
    position: { x: (i * 13) % 512, y: (i * 7) % 512 },
    health: { points: 100, min: 0, max: 100, rate: 0, interval: 0 },
  } as Entity;
}

// ── measurement helpers ──────────────────────────────────────────────────────

/** Build the shared doc with N entities under one namespace, as the DO would. */
function buildDoc(n: number, make: (i: number) => Entity): Doc {
  const doc = new Doc();
  doc.transact(() => {
    for (let i = 0; i < n; i++) {
      const e = make(i);
      writeInsert(doc, A, e.id as string, e as Record<string, unknown>);
    }
  });
  return doc;
}

/** Components only — no refcount/membership index — to isolate the indexing tax. */
function buildComponentsOnly(n: number, make: (i: number) => Entity): Doc {
  const doc = new Doc();
  const entities = entitiesMap(doc);
  doc.transact(() => {
    for (let i = 0; i < n; i++) {
      const e = make(i) as Record<string, unknown>;
      const map = new YMap<unknown>();
      entities.set(e.id as string, map);
      for (const k in e) if (e[k] !== undefined) map.set(k, e[k]);
    }
  });
  return doc;
}

/** Snapshot bytes streamed on connect (≈ the SyncStep2 frame payload). */
function snapshotBytes(doc: Doc): number {
  return encodeStateAsUpdate(doc).byteLength;
}

/** Simulate `_seedFromDoc` + `_addEntityFromDoc`: toJSON + ecs.insert + observe. */
function seedMs(doc: Doc): number {
  const entities = new Map<string, Entity>();
  const options = makeOptions();
  const ecs = new ECS(entities, createBaseMutator(entities, options), {}, options);
  ecs.initialize();

  const parent = entitiesMap(doc);
  const handler = () => {};
  const t0 = performance.now();
  for (const id of membersMap(doc, A).keys()) {
    const map = parent.get(id) as YMap<unknown> | undefined;
    if (!map) continue;
    const raw = map.toJSON() as Entity;
    if (!ecs.hasEntity(id)) ecs.insert(raw);
    map.observe(handler); // per-entity observer attach (the DO does this)
  }
  return performance.now() - t0;
}

/** ms to encode a full snapshot (the per-compaction cost). */
function compactMs(doc: Doc): number {
  const t0 = performance.now();
  encodeStateAsUpdate(doc);
  return performance.now() - t0;
}

interface Row {
  n: number;
  bytes: number;
  perEntity: number;
  seedMs: number;
  compactMs: number;
}

function measure(make: (i: number) => Entity, sizes: number[]): Row[] {
  const rows: Row[] = [];
  for (const n of sizes) {
    const doc = buildDoc(n, make);
    const bytes = snapshotBytes(doc);
    const sm = seedMs(doc);
    const cm = compactMs(doc);
    rows.push({ n, bytes, perEntity: bytes / n, seedMs: sm, compactMs: cm });
    doc.destroy();
  }
  return rows;
}

function report(title: string, rows: Row[]): number {
  const perEntity = rows.reduce((s, r) => s + r.perEntity, 0) / rows.length;
  const nHard = Math.floor(MAX_FRAME_SIZE / perEntity);
  console.log(`\n=== ${title} ===`);
  console.log("      N |  snapshot |  B/entity |  seed ms | compact ms | % of 1MB frame");
  for (const r of rows) {
    const pct = ((r.bytes / MAX_FRAME_SIZE) * 100).toFixed(1);
    console.log(
      `  ${String(r.n).padStart(6)} | ${(r.bytes / 1024).toFixed(1).padStart(7)}KB | ` +
        `${r.perEntity.toFixed(0).padStart(6)} B | ${r.seedMs.toFixed(1).padStart(7)} | ` +
        `${r.compactMs.toFixed(2).padStart(9)} | ${pct.padStart(6)}%`,
    );
  }
  console.log(
    `  → mean B/entity ≈ ${perEntity.toFixed(0)} B  ⇒  HARD ceiling N_max ≈ ${nHard} ` +
      `(1MB frame); KV-snapshot ceiling ≈ ${Math.floor((128 * 1024) / perEntity)} (128KB per-value)`,
  );
  return nHard;
}

// ── the benchmark ────────────────────────────────────────────────────────────

describe("global-entity scale", () => {
  it("measures snapshot/seed/compaction vs N and derives the ceiling", () => {
    const sizes = [100, 250, 500, 1000, 2000, 4000, 8000];
    const richHard = report("RICH entity (stress profile)", measure(richEntity, sizes));
    const leanHard = report("LEAN entity (id + position + health)", measure(leanEntity, sizes));

    // Linearity: per-entity bytes ~constant (≤15% spread) ⇒ snapshot is O(N) and
    // the ceiling is a clean N_max ≈ 1MB/B.
    const rich = measure(richEntity, [500, 4000]);
    const spread = Math.abs(rich[0].perEntity - rich[1].perEntity) / rich[0].perEntity;
    expect(spread).toBeLessThan(0.15);

    // Indexing tax: how much the refcount + membership index costs per entity
    // (the lever to raise the ceiling — e.g. by deriving membership instead of
    // storing it). Compare full shared-doc bytes vs components-only at N=2000.
    const full = snapshotBytes(buildDoc(2000, richEntity)) / 2000;
    const compsOnly = snapshotBytes(buildComponentsOnly(2000, richEntity)) / 2000;
    const taxPct = ((full - compsOnly) / compsOnly) * 100;
    console.log(
      `\n=== Indexing tax (rich, N=2000) ===\n` +
        `  components-only ${compsOnly.toFixed(0)} B/entity (ceiling ${Math.floor(MAX_FRAME_SIZE / compsOnly)})` +
        ` | full +refs+membership ${full.toFixed(0)} B/entity (ceiling ${Math.floor(MAX_FRAME_SIZE / full)})` +
        ` | tax ${taxPct.toFixed(1)}%`,
    );

    // Rich entities are heavier ⇒ lower ceiling than lean; both land in the
    // low-thousands range.
    expect(richHard).toBeGreaterThan(500);
    expect(leanHard).toBeGreaterThan(richHard);
    expect(full).toBeGreaterThan(compsOnly); // the index does cost bytes
  }, 120_000);

  it("PROVES the 1MB frame ceiling: a snapshot just over 1MB fails to decode", () => {
    // Find N where the rich-entity snapshot first exceeds the 1MB frame limit.
    let n = 1000;
    let doc = buildDoc(n, richEntity);
    while (snapshotBytes(doc) < MAX_FRAME_SIZE) {
      doc.destroy();
      n = Math.ceil(n * 1.5);
      doc = buildDoc(n, richEntity);
    }
    const overSnapshot = encodeStateAsUpdate(doc);
    console.log(
      `\n=== Frame ceiling proof ===\n  N=${n} rich entities ⇒ snapshot ${(overSnapshot.byteLength / 1024).toFixed(1)}KB > 1024KB`,
    );

    // The provider frames the full snapshot; the subscriber's decoder rejects it.
    expect(() => decodeFrameOrThrow(encodeFrame(overSnapshot))).toThrow(/exceeds maximum/);

    // An entity-set comfortably below the limit frames + round-trips intact.
    const under = buildDoc(Math.floor(n * 0.6), richEntity);
    const underSnapshot = encodeStateAsUpdate(under);
    expect(underSnapshot.byteLength).toBeLessThan(MAX_FRAME_SIZE);
    const decoded = decodeFrameOrThrow(encodeFrame(underSnapshot));
    expect(decoded.byteLength).toBe(underSnapshot.byteLength);

    doc.destroy();
    under.destroy();
  }, 120_000);
});
