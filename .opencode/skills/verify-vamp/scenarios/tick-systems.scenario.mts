import { expect, it } from "vitest";
import {
  type MutationRecord,
  MutationScope,
  Tags,
  TickRequest,
} from "../../../../examples/basic/src/bebop";
import { HOSTILE_TREE_ID } from "../../../../examples/basic/src/systems";
import { artifact, collect, connect, makeEntity, newNs, waitFor } from "./harness.mts";

function deltasFor(seen: MutationScope[], id: string) {
  return seen
    .flatMap((scope) => [...(scope.mutations ?? [])])
    .filter(([key, rec]: [string, MutationRecord]) => key === id && rec.tag === 2)
    .map(([, rec]: [string, MutationRecord]) => (rec.tag === 2 ? rec.value.delta : undefined));
}

it("regenerates health and integrates velocity when the world ticks", async () => {
  const { channel, client } = connect(newNs("tick"));
  const observed = collect(await client.observe(MutationScope({})));

  const wounded = makeEntity({
    health: { points: 50, min: 0, max: 100, rate: 1, interval: 0 },
  });
  const mover = makeEntity({ position: { x: 0, y: 0 }, velocity: { x: 3, y: -2 } });
  await client.spawn(wounded);
  await client.spawn(mover);

  const result = await client.tick(TickRequest({ steps: 1, dtMs: 16 }));
  expect(result.frames).toBe(1);

  const regen = await waitFor(
    () => deltasFor(observed.seen, wounded.id as string).find((d) => d?.health?.points === 1),
    { label: "regen delta on the wounded entity" },
  );
  const moved = await waitFor(
    () => deltasFor(observed.seen, mover.id as string).find((d) => d?.position),
    { label: "position delta on the moving entity" },
  );

  expect(regen.health?.points).toBe(1);
  expect(moved.position).toEqual({ x: 3, y: -2 });

  artifact("tick-systems.json", { tick: { frames: result.frames }, regen, moved });

  await observed.stop();
  channel.close();
});

it("lets a hostile chip the nearest player when it ticks inside aggro range", async () => {
  const { channel, client } = connect(newNs("aggro"));
  const observed = collect(await client.observe(MutationScope({})));

  const player = makeEntity({ tags: [Tags.PlayerControlled], position: { x: 0, y: 0 } });
  const hostile = makeEntity({
    tags: [Tags.Hostile],
    position: { x: 10, y: 10 },
    brain: { tree: HOSTILE_TREE_ID },
  });
  await client.spawn(player);
  await client.spawn(hostile);

  await client.tick(TickRequest({ steps: 1, dtMs: 16 }));

  const chip = await waitFor(
    () => deltasFor(observed.seen, player.id as string).find((d) => d?.health?.points),
    { label: "aggro damage on the player" },
  );
  expect([-1, -3]).toContain(chip.health?.points);

  artifact("tick-aggro.json", { player: player.id, hostile: hostile.id, delta: chip });

  await observed.stop();
  channel.close();
});
