import { expect, it } from "vitest";
import { MutationScope } from "../../../../examples/basic/src/bebop";
import { artifact, collect, connect, makeEntity, newNs, waitFor } from "./harness.mts";

it("opens a lobby socket, spawns a player, and streams the insert to observers", async () => {
  const ns = newNs("join");
  const { channel, client } = connect(ns);

  await channel.waitForOpen();
  expect(channel.ws.readyState).toBe(WebSocket.OPEN);

  const observed = collect(await client.observe(MutationScope({})));

  const entity = makeEntity();
  const spawned = await client.spawn(entity);
  expect(spawned.id).toBe(entity.id);
  expect(spawned.health?.points).toBe(100);

  const insert = await waitFor(
    () =>
      observed.seen
        .flatMap((scope) => [...(scope.mutations ?? [])])
        .find(([key]) => key === entity.id)?.[1],
    { label: "insert mutation for the spawned player" },
  );
  expect(insert.tag).toBe(1);

  artifact("join-lobby.json", {
    ns,
    spawned: { id: spawned.id, health: spawned.health, faction: spawned.faction },
    mutations: observed.seen.map((scope) => [...(scope.mutations ?? [])]),
  });

  await observed.stop();
  channel.close();
});

it("seeds each lobby's world context from the connect query string", async () => {
  const suffix = newNs("ctx");
  const a = connect(`${suffix}-a`, "&faction=7");
  const b = connect(`${suffix}-b`, "&faction=9");

  const spawnedA = await a.client.spawn(makeEntity());
  const spawnedB = await b.client.spawn(makeEntity());

  expect(spawnedA.faction).toBe(7);
  expect(spawnedB.faction).toBe(9);

  artifact("join-lobby-context.json", {
    a: { ns: `${suffix}-a`, faction: spawnedA.faction },
    b: { ns: `${suffix}-b`, faction: spawnedB.faction },
  });

  a.channel.close();
  b.channel.close();
});
