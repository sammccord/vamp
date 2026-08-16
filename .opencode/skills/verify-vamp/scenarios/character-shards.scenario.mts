import { expect, it } from "vitest";
import { MutationScope } from "../../../../examples/basic/src/bebop";
import { artifact, BASE_URL, collect, connect, makeEntity, newNs, waitFor } from "./harness.mts";

const keys = (seen: MutationScope[]) =>
  new Set(seen.flatMap((scope) => [...(scope.mutations?.keys() ?? [])]));

it("propagates live edits between lobbies sharing a character shard, and keeps private shards private", async () => {
  const suffix = newNs("xshard");
  const shared = `character/${suffix}`;

  const a = connect(`${suffix}-a`);
  const b = connect(`${suffix}-b`);
  const seenA = collect(await a.client.observe(MutationScope({})));
  const seenB = collect(await b.client.observe(MutationScope({})));

  await a.client.spawn(makeEntity({ sk: shared }));
  await b.client.spawn(makeEntity({ sk: shared }));
  await new Promise((r) => setTimeout(r, 800));

  const privateToA = makeEntity();
  await a.client.spawn(privateToA);

  const liveFromA = makeEntity({ sk: shared });
  await a.client.spawn(liveFromA);
  await waitFor(() => (keys(seenB.seen).has(liveFromA.id as string) ? true : undefined), {
    label: "A's shared-shard edit reaching B",
    timeout: 8000,
  });

  const liveFromB = makeEntity({ sk: shared });
  await b.client.spawn(liveFromB);
  await waitFor(() => (keys(seenA.seen).has(liveFromB.id as string) ? true : undefined), {
    label: "B's shared-shard edit reaching A",
    timeout: 8000,
  });

  await new Promise((r) => setTimeout(r, 400));
  expect(keys(seenB.seen).has(privateToA.id as string)).toBe(false);

  artifact("character-shards-live.json", {
    shard: shared,
    liveFromA: liveFromA.id,
    liveFromB: liveFromB.id,
    privateToA: privateToA.id,
    deliveredToB: [...keys(seenB.seen)],
  });

  await seenA.stop();
  await seenB.stop();
  a.channel.close();
  b.channel.close();
});

it("serves a character's entities over GET /v1/characters/:id without spinning up a lobby", async () => {
  const id = newNs("hero");
  const { channel, client } = connect(newNs("author"));
  const entity = makeEntity({ sk: `character/${id}` });
  await client.spawn(entity);

  const body = await waitFor(
    async () => {
      const res = await fetch(`${BASE_URL}/v1/characters/${id}`);
      const json = (await res.json()) as Array<{ id?: string }>;
      return json.some((e) => e.id === entity.id) ? json : undefined;
    },
    { label: "character entity readable over HTTP" },
  );

  expect(body.some((e) => e.id === entity.id)).toBe(true);
  artifact("character-shards-http.json", { character: id, entities: body });

  channel.close();
});
