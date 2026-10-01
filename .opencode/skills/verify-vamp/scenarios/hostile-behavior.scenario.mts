import { expect, it } from "vitest";
import {
  type MutationRecord,
  MutationScope,
  Tags,
  TickRequest,
} from "../../../../examples/basic/src/bebop";
import { HOSTILE_TREE_ID } from "../../../../examples/basic/src/systems";
import { artifact, collect, connect, makeEntity, newNs, waitFor } from "./harness.mts";

const FRAMES = 20;
const health = { points: 1000, min: 0, max: 1000, rate: 0, interval: 0 };

function healthDeltas(seen: MutationScope[], id: string): number[] {
  return seen
    .flatMap((scope) => [...(scope.mutations ?? [])])
    .flatMap(([key, rec]: [string, MutationRecord]) =>
      key === id && rec.tag === 2 && rec.value.delta.health
        ? [rec.value.delta.health.points ?? 0]
        : [],
    );
}

async function fight(label: string, playerAt: { x: number; y: number }, frames: number) {
  const { channel, client } = connect(newNs(label), "&rng=42");
  const observed = collect(await client.observe(MutationScope({})));

  const pet = makeEntity({ health });
  const player = makeEntity({
    tags: [Tags.PlayerControlled],
    position: playerAt,
    children: [pet.id as string],
    health,
  });
  const hostile = makeEntity({ position: { x: 10, y: 10 }, brain: { tree: HOSTILE_TREE_ID } });
  await client.spawn(pet);
  await client.spawn(player);
  await client.spawn(hostile);
  const result = await client.tick(TickRequest({ steps: frames, dtMs: 16 }));
  return { channel, observed, pet, player, result };
}

it("picks, cools down, and dispatches hostile hits the same way for the same seed", async () => {
  const runs = [];
  for (const label of ["bt-a", "bt-b"]) {
    const { channel, observed, pet, player, result } = await fight(label, { x: 0, y: 0 }, FRAMES);
    expect(result.frames).toBe(FRAMES);
    await waitFor(
      () => (healthDeltas(observed.seen, pet.id as string).length === FRAMES ? true : undefined),
      { label: `a hit per frame on the pet in ${label}` },
    );
    runs.push({
      player: healthDeltas(observed.seen, player.id as string),
      pet: healthDeltas(observed.seen, pet.id as string),
    });
    await observed.stop();
    channel.close();
  }

  const [first, second] = runs;
  expect(new Set(first.player)).toEqual(new Set([-1, -3]));
  const heavy = first.player.flatMap((d, frame) => (d === -3 ? [frame] : []));
  for (let i = 1; i < heavy.length; i++) expect(heavy[i] - heavy[i - 1]).toBeGreaterThanOrEqual(10);
  expect(first.pet).toEqual(first.player);
  expect(second.player).toEqual(first.player);

  artifact("hostile-behavior.json", { rng: 42, frames: FRAMES, runs, heavyFrames: heavy });
});

it("leaves a player outside aggro range alone", async () => {
  const { channel, observed, player, result } = await fight("bt-far", { x: 1000, y: 1000 }, 5);
  await new Promise((r) => setTimeout(r, 300));
  const deltas = healthDeltas(observed.seen, player.id as string);
  expect(deltas).toEqual([]);

  artifact("hostile-out-of-range.json", { frames: result.frames, deltas });
  await observed.stop();
  channel.close();
});
