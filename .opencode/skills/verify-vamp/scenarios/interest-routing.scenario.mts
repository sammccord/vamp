import { expect, it } from "vitest";
import { Entity, MutationScope, type RpcClient } from "../../../../examples/basic/src/bebop";
import { artifact, collect, connect, makeEntity, newNs, waitFor } from "./harness.mts";

/**
 * Observe as a specific viewer. The example resolves the viewer entity from the
 * first key of the request scope's `mutations` map, so a one-entry scope keyed by
 * the viewer id is what selects an interest-filtered stream over a see-all one.
 */
function observeAs(client: RpcClient, viewerId: string) {
  return client.observe(
    MutationScope({
      mutations: new Map([[viewerId, { tag: 1, value: { entity: Entity({ id: viewerId }) } }]]),
    }),
  );
}

const keys = (seen: MutationScope[]) =>
  new Set(seen.flatMap((scope) => [...(scope.mutations?.keys() ?? [])]));

it("delivers every mutation in a lobby to all see-all observers", async () => {
  const ns = newNs("shared");
  const a = connect(ns);
  const b = connect(ns);

  const seenA = collect(await a.client.observe(MutationScope({})));
  const seenB = collect(await b.client.observe(MutationScope({})));

  const entity = makeEntity();
  await a.client.spawn(entity);

  await waitFor(() => (keys(seenA.seen).has(entity.id as string) ? true : undefined), {
    label: "spawn visible to the spawning client",
  });
  await waitFor(() => (keys(seenB.seen).has(entity.id as string) ? true : undefined), {
    label: "spawn visible to the second client",
  });

  artifact("interest-shared-lobby.json", { ns, entity: entity.id });

  await seenA.stop();
  await seenB.stop();
  a.channel.close();
  b.channel.close();
});

it("routes only interest-relevant mutations to each viewer, with no cross-zone leakage", async () => {
  const ns = newNs("aoi");
  const actor = connect(ns);

  const viewerA = makeEntity({ position: { x: 0, y: 0 } });
  const viewerB = makeEntity({ position: { x: 1000, y: 1000 } });
  await actor.client.spawn(viewerA);
  await actor.client.spawn(viewerB);

  const a = connect(ns);
  const b = connect(ns);
  const seenA = collect(await observeAs(a.client, viewerA.id as string));
  const seenB = collect(await observeAs(b.client, viewerB.id as string));

  await new Promise((r) => setTimeout(r, 200));

  const nearA = makeEntity({ position: { x: 10, y: 10 } });
  const nearB = makeEntity({ position: { x: 1010, y: 1010 } });
  await actor.client.spawn(nearA);
  await actor.client.spawn(nearB);

  await waitFor(() => (keys(seenA.seen).has(nearA.id as string) ? true : undefined), {
    label: "nearA routed to viewer A",
  });
  await waitFor(() => (keys(seenB.seen).has(nearB.id as string) ? true : undefined), {
    label: "nearB routed to viewer B",
  });
  await new Promise((r) => setTimeout(r, 300));

  expect(keys(seenA.seen).has(nearB.id as string)).toBe(false);
  expect(keys(seenB.seen).has(nearA.id as string)).toBe(false);

  artifact("interest-aoi.json", {
    ns,
    viewerA: { id: viewerA.id, delivered: [...keys(seenA.seen)] },
    viewerB: { id: viewerB.id, delivered: [...keys(seenB.seen)] },
    nearA: nearA.id,
    nearB: nearB.id,
  });

  await seenA.stop();
  await seenB.stop();
  a.channel.close();
  b.channel.close();
  actor.channel.close();
});
