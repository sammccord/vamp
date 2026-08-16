import { expect, it } from "vitest";
import {
  Actions,
  AreaAttack,
  Attack,
  Heal,
  type MutationRecord,
  MutationScope,
} from "../../../../examples/basic/src/bebop";
import { artifact, collect, connect, makeEntity, newNs, waitFor } from "./harness.mts";

/** The example streams pool changes as signed deltas, not absolute values. */
function healthDelta(seen: MutationScope[], id: string): number | undefined {
  const record = seen
    .flatMap((scope) => [...(scope.mutations ?? [])])
    .find(([key, rec]: [string, MutationRecord]) => key === id && rec.tag === 2)?.[1];
  return record?.tag === 2 ? record.value.delta.health?.points : undefined;
}

it("applies Attack and Heal to the targeted entity and streams the health delta", async () => {
  const { channel, client } = connect(newNs("combat"));
  const observed = collect(await client.observe(MutationScope({})));

  const target = makeEntity();
  await client.spawn(target);

  const attack = Actions.fromAttack(Attack({ source: target.id, target: target.id, damage: 30 }));
  const echoed = await client.act(attack);
  expect(echoed.tag).toBe(1);

  const damage = await waitFor(() => healthDelta(observed.seen, target.id as string), {
    label: "health delta from Attack",
  });
  expect(damage).toBe(-30);

  await client.act(Actions.fromHeal(Heal({ source: target.id, target: target.id, amount: 12 })));
  const healed = await waitFor(
    () => {
      const deltas = observed.seen
        .flatMap((scope) => [...(scope.mutations ?? [])])
        .filter(([key, rec]: [string, MutationRecord]) => key === target.id && rec.tag === 2)
        .map(([, rec]: [string, MutationRecord]) =>
          rec.tag === 2 ? rec.value.delta.health?.points : undefined,
        );
      return deltas.includes(12) ? deltas : undefined;
    },
    { label: "health delta from Heal" },
  );

  artifact("combat-actions.json", { target: target.id, deltas: healed });

  await observed.stop();
  channel.close();
});

it("cascades AreaAttack from a parent to its children", async () => {
  const { channel, client } = connect(newNs("aoe"));
  const observed = collect(await client.observe(MutationScope({})));

  const child = makeEntity({ stamina: { points: 10, min: 0, max: 10, rate: 0, interval: 0 } });
  await client.spawn(child);
  const parent = makeEntity({ children: [child.id as string] });
  await client.spawn(parent);

  await client.act(
    Actions.fromAreaAttack(
      AreaAttack({ source: parent.id, target: parent.id, damage: 5, radius: 1 }),
    ),
  );

  const parentHit = await waitFor(() => healthDelta(observed.seen, parent.id as string), {
    label: "parent health delta",
  });
  const childHit = await waitFor(() => healthDelta(observed.seen, child.id as string), {
    label: "child health delta from the cascade",
  });

  expect(parentHit).toBe(-5);
  expect(childHit).toBe(-5);

  artifact("combat-area-attack.json", {
    parent: { id: parent.id, healthDelta: parentHit },
    child: { id: child.id, healthDelta: childHit },
  });

  await observed.stop();
  channel.close();
});
