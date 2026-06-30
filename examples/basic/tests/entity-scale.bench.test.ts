import { createBaseMutator, ECS, type ECSOptions } from "@vamp/ecs";
import { nanoid } from "nanoid";
import { describe, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate, Map as YMap } from "yjs";

import {
  addRef,
  entitiesMap,
  membersMap,
  writeEntityInsert,
  writeInsert,
} from "../../../packages/worker/src/entity-doc";
import { type Entity, type EntityDelta, Tags } from "../src/bebop";

/**
 * ENTITY-SCALE BENCHMARK (node-level; no workerd).
 *
 * Question: how many entities fit in ONE shard before sync/seed/compaction cost
 * bites — and how does the D1b `root`-keyed sharding model change the GLOBAL cap?
 *
 * Model (post-D1b): each `root` is its own provider DO / `Y.Doc` holding ONLY
 * that shard's entity DATA — the cross-namespace refcount/membership index is
 * gone (a shard's entity-set IS its membership). So the per-entity bytes that set
 * a shard's cap are components-only, and a snapshot streams chunked (post-B2), so
 * the binding limit is DO memory, not the 1 MB frame. A single shard therefore
 * caps at ~the old global figure, but the GLOBAL store is now
 * `Σ shards` — add provider DOs to reach millions; a lobby's working set is the
 * union of the shards it subscribes to.
 *
 * This is node-only (no Durable Object / wrangler): it imports the real shard-doc
 * writers (`entity-doc.ts`), the real example entity shape (`bebop.ts`), and the
 * real ECS, and replicates y-durablestream's frame codec verbatim (its own
 * protocol.test.ts proves the >1MB FrameDecodeError; here we pin the snapshot to
 * that limit). Neither `@vamp/worker` nor `y-durablestream`'s entry can be
 * imported here — both pull in `cloudflare:workers`.
 */

const A = "bench-ns";

// ── y-durablestream frame codec replica (src/protocol.ts) ────────────────────
// 4-byte big-endian length header + configurable payload cap. Mirrors the
// published codec so the ceiling proof exercises the real framing math.
// Can't import the real symbols (package entry pulls in `cloudflare:workers`).
const DEFAULT_FRAME_CAP = 1024 * 1024; // y-durablestream DEFAULT_MAX_FRAME_SIZE
const VAMP_FRAME_CAP = 8 * 1024 * 1024; // what vamp configures (ecs.ts maxFrameSize)

function encodeFrame(message: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + message.byteLength);
  new DataView(frame.buffer).setUint32(0, message.byteLength, false);
  frame.set(message, 4);
  return frame;
}

/** Decode one frame, throwing exactly as y-durablestream's FrameDecoder does. */
function decodeFrameOrThrow(frame: Uint8Array, cap = DEFAULT_FRAME_CAP): Uint8Array {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const len = view.getUint32(0, false);
  if (len > cap) {
    throw new Error(`Frame payload length ${len} exceeds maximum of ${cap} bytes`);
  }
  return frame.slice(4, 4 + len);
}

// ── y-durablestream message layer replica (Phase B2, src/protocol.ts) ─────────
// Splits one message into ≤cap frames with an 8-byte [total][index] part header
// and reassembles by concatenation — the byte-level chunking that lifts the
// single-frame ceiling. Mirrored locally (can't import the real symbols here).
const PART_HEADER = 8;

function encodeMessageLocal(message: Uint8Array, chunkCap: number): Uint8Array[] {
  const maxChunk = Math.max(1, chunkCap - 4 - PART_HEADER); // 4 = frame length header
  const total = Math.max(1, Math.ceil(message.byteLength / maxChunk));
  const frames: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const chunk = message.subarray(i * maxChunk, (i + 1) * maxChunk);
    const payload = new Uint8Array(PART_HEADER + chunk.byteLength);
    const v = new DataView(payload.buffer);
    v.setUint32(0, total, false);
    v.setUint32(4, i, false);
    payload.set(chunk, PART_HEADER);
    frames.push(encodeFrame(payload));
  }
  return frames;
}

/** Reassemble frames into the original message, enforcing the per-frame cap. */
function reassembleMessageLocal(frames: Uint8Array[], cap: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of frames) {
    const payload = decodeFrameOrThrow(f, cap); // each frame must be within cap
    const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    parts[v.getUint32(4, false)] = payload.subarray(PART_HEADER);
  }
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
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
    id: nanoid(16), // production id scheme (see examples/basic/src/index.ts)
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
    id: nanoid(16),
    tags: [],
    position: { x: (i * 13) % 512, y: (i * 7) % 512 },
    health: { points: 100, min: 0, max: 100, rate: 0, interval: 0 },
  } as Entity;
}

// ── measurement helpers ──────────────────────────────────────────────────────

/**
 * Build ONE shard doc with N entities, exactly as a D1b provider holds it:
 * entity DATA only (no refcount/membership index), via the real `writeEntityInsert`.
 */
function buildDoc(n: number, make: (i: number) => Entity): Doc {
  const doc = new Doc();
  doc.transact(() => {
    for (let i = 0; i < n; i++) {
      const e = make(i);
      writeEntityInsert(doc, e.id as string, e as Record<string, unknown>);
    }
  });
  return doc;
}

/**
 * Pre-D1b layout for an apples-to-apples delta: the flat shared doc with the
 * cross-namespace refcount + membership index (`writeInsert`). Used to quantify
 * the per-entity bytes the sharded entity-data-only model SAVES by dropping it.
 */
function buildWithIndex(n: number, make: (i: number) => Entity): Doc {
  const doc = new Doc();
  doc.transact(() => {
    for (let i = 0; i < n; i++) {
      const e = make(i);
      writeInsert(doc, A, e.id as string, e as Record<string, unknown>);
    }
  });
  return doc;
}

/** Snapshot bytes streamed on connect (≈ the SyncStep2 frame payload). */
function snapshotBytes(doc: Doc): number {
  return encodeStateAsUpdate(doc).byteLength;
}

/**
 * Pre-Phase-A layout for an apples-to-apples delta: 36-char `crypto.randomUUID`
 * ids AND the id stored as a redundant component (id encoded 4×). Mirrors the
 * old `writeInsert`.
 */
function buildOldScheme(n: number, make: (i: number) => Entity): Doc {
  const doc = new Doc();
  const entities = entitiesMap(doc);
  doc.transact(() => {
    for (let i = 0; i < n; i++) {
      const e = make(i) as Record<string, unknown>;
      e.id = crypto.randomUUID(); // 36-char uuid
      const map = new YMap<unknown>();
      entities.set(e.id as string, map);
      for (const k in e) if (e[k] !== undefined) map.set(k, e[k]); // INCLUDING id
      addRef(doc, A, e.id as string);
      membersMap(doc, A).set(e.id as string, true);
    }
  });
  return doc;
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
  // The shard's entity-set IS its membership in the D1b model — seed from it.
  for (const id of parent.keys()) {
    const map = parent.get(id) as YMap<unknown> | undefined;
    if (!map) continue;
    const raw = map.toJSON() as Entity;
    if (!raw.id) (raw as Record<string, unknown>).id = id; // id is not stored as a component
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

function report(title: string, rows: Row[]): { def: number; vamp: number } {
  const perEntity = rows.reduce((s, r) => s + r.perEntity, 0) / rows.length;
  const nDefault = Math.floor(DEFAULT_FRAME_CAP / perEntity);
  const nVamp = Math.floor(VAMP_FRAME_CAP / perEntity);
  console.log(`\n=== ${title} ===`);
  console.log("      N |  snapshot |  B/entity |  seed ms | compact ms | % of 1MB frame");
  for (const r of rows) {
    const pct = ((r.bytes / DEFAULT_FRAME_CAP) * 100).toFixed(1);
    console.log(
      `  ${String(r.n).padStart(6)} | ${(r.bytes / 1024).toFixed(1).padStart(7)}KB | ` +
        `${r.perEntity.toFixed(0).padStart(6)} B | ${r.seedMs.toFixed(1).padStart(7)} | ` +
        `${r.compactMs.toFixed(2).padStart(9)} | ${pct.padStart(6)}%`,
    );
  }
  // Post-B2 the frame cap no longer bounds size (snapshot is chunked + reassembled),
  // so the bound is DO memory. Conservative: ~64 MB usable for the encoded doc
  // (the rest of the 128 MB isolate holds the ECS working store + observers).
  const memBound = Math.floor((64 * 1024 * 1024) / perEntity);
  console.log(
    `  → mean B/entity ≈ ${perEntity.toFixed(0)} B  ⇒  pre-B2 N_max ≈ ${nDefault} @1MB / ${nVamp} @8MB frame; ` +
      `post-B2 (chunked) bound ≈ ${memBound} (≈64MB DO memory); KV-snapshot ceiling ≈ ${Math.floor((128 * 1024) / perEntity)} (128KB)`,
  );
  return { def: nDefault, vamp: nVamp };
}

// ── the benchmark ────────────────────────────────────────────────────────────

describe("entity scale (per-shard cap + sharded global)", () => {
  it("measures snapshot/seed/compaction vs N and derives the per-shard cap", () => {
    const sizes = [100, 250, 500, 1000, 2000, 4000, 8000];
    const richHard = report("RICH entity (stress profile)", measure(richEntity, sizes));
    const leanHard = report("LEAN entity (id + position + health)", measure(leanEntity, sizes));

    // Linearity: per-entity bytes ~constant (≤15% spread) ⇒ snapshot is O(N) and
    // the per-shard cap is a clean N_max ≈ cap/B.
    const rich = measure(richEntity, [500, 4000]);
    const spread = Math.abs(rich[0].perEntity - rich[1].perEntity) / rich[0].perEntity;
    expect(spread).toBeLessThan(0.15);

    // Sharding savings: dropping the cross-namespace refcount + membership index
    // (the D1b sharded shard stores entity DATA only) shrinks per-entity bytes,
    // raising the per-shard cap. Compare the old indexed flat doc vs a D1b shard.
    const sharded = snapshotBytes(buildDoc(2000, richEntity)) / 2000;
    const withIndex = snapshotBytes(buildWithIndex(2000, richEntity)) / 2000;
    const savingsPct = ((withIndex - sharded) / withIndex) * 100;
    console.log(
      `\n=== Sharding savings (rich, N=2000) ===\n` +
        `  D1b shard (entity-data only) ${sharded.toFixed(0)} B/entity (per-shard cap ${Math.floor(DEFAULT_FRAME_CAP / sharded)})` +
        ` | old flat doc +refs+membership ${withIndex.toFixed(0)} B/entity (cap ${Math.floor(DEFAULT_FRAME_CAP / withIndex)})` +
        ` | saved ${savingsPct.toFixed(1)}%`,
    );

    // Sharded global cap: the per-shard figure × the number of provider DOs. The
    // store is distributed, so "millions" is a matter of how many roots exist; a
    // lobby's working set is only the union of the shards it subscribes to.
    const perShardMem = Math.floor((64 * 1024 * 1024) / sharded);
    console.log(
      `\n=== Sharded global cap ===\n` +
        `  per-shard ≈ ${perShardMem} rich (64MB DO mem) ⇒ ` +
        `1k shards ≈ ${(perShardMem * 1000).toLocaleString()} | ` +
        `100k shards ≈ ${(perShardMem * 100_000).toLocaleString()} entities (add provider DOs to scale)`,
    );

    // Rich entities are heavier ⇒ lower per-shard cap than lean; both land in the
    // low-thousands at the 1MB default, ~8× higher at vamp's 8MB cap.
    expect(richHard.def).toBeGreaterThan(500);
    expect(leanHard.def).toBeGreaterThan(richHard.def);
    expect(richHard.vamp).toBeGreaterThan(richHard.def * 7); // 8MB ≈ 8× the cap
    expect(withIndex).toBeGreaterThan(sharded); // dropping the index saves bytes
  }, 120_000);

  it("quantifies Phase A id-diet savings (uuid+component → nanoid16, no component)", () => {
    for (const [label, make] of [
      ["RICH", richEntity],
      ["LEAN", leanEntity],
    ] as const) {
      const N = 1500;
      const oldB = snapshotBytes(buildOldScheme(N, make)) / N;
      const newB = snapshotBytes(buildDoc(N, make)) / N; // current scheme
      const oldCeil = Math.floor(DEFAULT_FRAME_CAP / oldB);
      const newCeil = Math.floor(DEFAULT_FRAME_CAP / newB);
      const gain = ((newCeil - oldCeil) / oldCeil) * 100;
      console.log(
        `\n=== Phase A delta · ${label} ===\n` +
          `  old (uuid + id component): ${oldB.toFixed(0)} B/entity → ceiling ${oldCeil}\n` +
          `  new (nanoid16, no component): ${newB.toFixed(0)} B/entity → ceiling ${newCeil}\n` +
          `  ⇒ +${gain.toFixed(0)}% entities`,
      );
      expect(newB).toBeLessThan(oldB); // the id diet must shrink B
    }
  }, 120_000);

  it("PROVES B1 + B2: >1MB rejected unchunked; B2 chunks a >8MB snapshot and reassembles intact", () => {
    // (B1) A snapshot just over the 1MB default is rejected by a default decoder
    // but accepted by vamp's 8MB cap — the quick multiplier.
    let n = 1000;
    let doc = buildDoc(n, richEntity);
    while (snapshotBytes(doc) < DEFAULT_FRAME_CAP) {
      doc.destroy();
      n = Math.ceil(n * 1.5);
      doc = buildDoc(n, richEntity);
    }
    const over1mb = encodeStateAsUpdate(doc);
    expect(() => decodeFrameOrThrow(encodeFrame(over1mb))).toThrow(/exceeds maximum/);
    expect(decodeFrameOrThrow(encodeFrame(over1mb), VAMP_FRAME_CAP).byteLength).toBe(
      over1mb.byteLength,
    );
    doc.destroy();

    // (B2) Grow a snapshot past 8 MB — beyond ANY single-frame cap — then chunk
    // it at the provider's 1 MB default and reassemble through a 1 MB decoder.
    let m = 8000;
    let big = buildDoc(m, richEntity);
    while (snapshotBytes(big) < 8 * 1024 * 1024) {
      big.destroy();
      m = Math.ceil(m * 1.4);
      big = buildDoc(m, richEntity);
    }
    const snapshot = encodeStateAsUpdate(big);
    const CHUNK = DEFAULT_FRAME_CAP; // provider frameChunkSize default (1 MB)

    const frames = encodeMessageLocal(snapshot, CHUNK);
    expect(frames.length).toBeGreaterThan(8); // many sub-cap frames
    for (const f of frames) expect(f.byteLength).toBeLessThanOrEqual(CHUNK);

    // Reassemble through a 1 MB-capped decoder (would reject the whole snapshot
    // as one frame) and apply — a fresh replica matches the source entity count.
    const reassembled = reassembleMessageLocal(frames, CHUNK);
    expect(reassembled.byteLength).toBe(snapshot.byteLength);
    const replica = new Doc();
    applyUpdate(replica, reassembled);
    expect(entitiesMap(replica).size).toBe(entitiesMap(big).size);

    console.log(
      `\n=== B2 chunked-sync proof ===\n  ${m} rich entities ⇒ ${(snapshot.byteLength / 1024 / 1024).toFixed(1)}MB snapshot ` +
        `→ ${frames.length} × ≤1MB frames → reassembled intact (${entitiesMap(replica).size} entities) ` +
        `through a 1MB-capped decoder`,
    );
    big.destroy();
    replica.destroy();
  }, 180_000);

  // Phase C / S2 spike: per-entity-authored updates (one transaction per entity)
  // are the price of interest-filtered partial sync. Quantify the overhead vs the
  // current batched flow (one transaction per flush), in the tick worst case —
  // updating K of a lobby's entities each frame.
  it("Spike: per-entity vs batched update authoring overhead", () => {
    const captureUpdates = (
      doc: Doc,
      fn: () => void,
    ): { count: number; bytes: number; ms: number } => {
      const updates: Uint8Array[] = [];
      const onUpdate = (u: Uint8Array) => updates.push(u);
      doc.on("update", onUpdate);
      const t0 = performance.now();
      fn();
      const ms = performance.now() - t0;
      doc.off("update", onUpdate);
      return { count: updates.length, bytes: updates.reduce((s, u) => s + u.byteLength, 0), ms };
    };

    console.log("\n=== Per-entity vs batched authoring (tick: update K entities) ===");
    console.log(
      "      K | batched: 1 upd, bytes, ms | per-entity: K upd, bytes, ms | bytes× | frames×",
    );
    for (const K of [10, 100, 1000]) {
      const doc = buildDoc(K, richEntity);
      const ids = [...entitiesMap(doc).keys()];
      const at = (id: string) => entitiesMap(doc).get(id) as YMap<unknown>;

      // Batched: one transaction touching one field on each of K entities → 1 update.
      const batched = captureUpdates(doc, () => {
        doc.transact(() => {
          for (let i = 0; i < ids.length; i++) at(ids[i]).set("xp", i + 1);
        });
      });

      // Per-entity: K transactions, each touching one entity → K updates (each
      // a standalone, interest-filterable frame).
      const per = captureUpdates(doc, () => {
        for (let i = 0; i < ids.length; i++) {
          doc.transact(() => at(ids[i]).set("xp", i + 1000));
        }
      });

      console.log(
        `  ${String(K).padStart(5)} | ${String(batched.count).padStart(3)} upd ${batched.bytes.toString().padStart(7)}B ${batched.ms.toFixed(2).padStart(6)}ms` +
          ` | ${String(per.count).padStart(4)} upd ${per.bytes.toString().padStart(8)}B ${per.ms.toFixed(2).padStart(7)}ms` +
          ` | ${(per.bytes / batched.bytes).toFixed(1)}× | ${per.count}×`,
      );

      // Per-entity emits exactly K updates (one per entity) vs 1 batched.
      expect(per.count).toBe(K);
      expect(batched.count).toBe(1);
      doc.destroy();
    }
  }, 120_000);

  // The current (post-B2) cap is DO memory: the subscriber holds the in-memory
  // Y.Doc (decoded structs) + the ECS working store (JS entity objects) + a
  // per-entity Y.Map observer. Measure that real footprint per entity (node
  // heap; workerd will differ but this is far closer than encoded bytes) and
  // derive the cap against a 100 MB working budget of the 128 MB isolate.
  it("Memory footprint per entity → DO-memory cap", () => {
    const BUDGET = 100 * 1024 * 1024; // usable heap within the 128 MB isolate
    const gc = (globalThis as { gc?: () => void }).gc;
    const N = 50000;

    // Single-shot, gc-bracketed: baseline AFTER gc, then build the full
    // subscriber footprint (doc + ECS world + per-entity observers) retained,
    // gc again, and diff. Looping/measuring repeatedly cross-contaminates the
    // heap, so we measure exactly once.
    if (gc) {
      gc();
      gc();
    }
    const before = process.memoryUsage().heapUsed;

    const doc = buildDoc(N, richEntity);
    const store = new Map<string, Entity>();
    const options = makeOptions();
    const ecs = new ECS(store, createBaseMutator(store, options), {}, options);
    ecs.initialize();
    const parent = entitiesMap(doc);
    const observers: Array<() => void> = [];
    for (const id of parent.keys()) {
      const map = parent.get(id) as YMap<unknown>;
      const raw = map.toJSON() as Entity;
      (raw as Record<string, unknown>).id = id;
      if (!ecs.hasEntity(id)) ecs.insert(raw);
      const h = () => {};
      map.observe(h);
      observers.push(() => map.unobserve(h));
    }

    if (gc) {
      gc();
      gc();
    }
    const after = process.memoryUsage().heapUsed;
    const perEntity = (after - before) / N;

    console.log("\n=== In-memory footprint (doc + ECS world + observers) ===");
    if (!gc) console.log("  ⚠ no --expose-gc: heap delta is unreliable, treat as rough");
    console.log(
      `  N=${N} rich · heap +${((after - before) / 1024 / 1024).toFixed(1)}MB · ` +
        `${perEntity.toFixed(0)} B/entity (in-memory) vs ${(snapshotBytes(doc) / N).toFixed(0)} B/entity (encoded)`,
    );
    console.log(
      `  ⇒ DO-memory cap ≈ ${Math.floor(BUDGET / Math.max(1, perEntity))} rich entities @100MB working budget`,
    );

    // Keep the footprint alive until measured, then release.
    for (const off of observers) off();
    void ecs;
    void store;
    doc.destroy();
    expect(perEntity).toBeGreaterThan(0);
  }, 120_000);
});
