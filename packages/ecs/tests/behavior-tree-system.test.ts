import { RNGClass } from "@vampgg/rot";
import { describe, expect, test } from "vite-plus/test";
import type { CustomAction } from "../src/Actions.ts";
import {
  accumulateReplaceDelta,
  applyReplaceDelta,
  type Brain,
  type BehaviorTree,
  cond,
  cooldown,
  createBehavior,
  createBehaviorTreeSystem,
  ECS,
  type MutationBatch,
  MutationType,
  type MutationRecord,
  type MutationScope,
  type QueryBuilder,
  seq,
  task,
  tree,
  weighted,
} from "../src/index.ts";

type Entity = {
  id?: string;
  children?: string[];
  hp?: number;
  brain?: Brain;
  behaviorTree?: BehaviorTree;
};
type Delta = { hp?: number; brain?: Brain; behaviorTree?: BehaviorTree };
type Action = { tag: 1; value: { target: string; damage: number } };

type State = { scope?: MutationScope<Entity, Delta> };
type World = ECS<State, [], Action, number, Entity, Delta>;

const components = { id: 1, children: 2, hp: 3, brain: 4, behaviorTree: 5 };
const Condition = { Hurt: 1 } as const;
const Task = { Attack: 1, Rest: 2 } as const;

function merge(entity: Entity, delta: Delta): void {
  if (delta.hp !== undefined) entity.hp = (entity.hp ?? 0) + delta.hp;
  if (delta.brain) entity.brain = applyReplaceDelta(entity.brain ?? {}, delta.brain);
  if (delta.behaviorTree) entity.behaviorTree = delta.behaviorTree;
}

function world(seed: number) {
  const entities = new Map<string, Entity>();
  const mutate = (id: string, record: MutationRecord<Entity, Delta>) => {
    if (record.tag === MutationType.Insert) entities.set(id, record.value.entity);
    else if (record.tag === MutationType.Update) merge(entities.get(id)!, record.value.delta);
  };
  let tick = 0;
  const random = new RNGClass().setSeed(seed);
  const ecs: World = new ECS<State, [], Action, number, Entity, Delta>(
    entities,
    mutate,
    {},
    {
      createId: () => crypto.randomUUID(),
      components,
      materializeDelta: (delta: Delta, base?: Partial<Entity>) => ({ ...base, ...delta }),
      mergeDelta: merge,
      accumulateDelta: (from: Delta, to: Delta) => {
        if (from.hp !== undefined) to.hp = (to.hp ?? 0) + from.hp;
        if (from.brain) to.brain = accumulateReplaceDelta(to.brain, from.brain);
        return to;
      },
    },
  );
  // Mirrors the worker's DO: writes that miss the scope are dropped, not applied.
  ecs.setFlushHandler((mutations: MutationBatch<Entity, Delta>) => {
    for (const [id, record] of mutations) mutate(id, record);
  });
  ecs.registerBehavior(
    createBehavior<State, [], Action, number, Entity, Delta>(
      1,
      async (w: World, entity: Entity, event: CustomAction<Action>) => {
        await Promise.resolve();
        w.put(entity.id!, { hp: -event.detail.value.damage });
      },
      (q: QueryBuilder) => q.every(components.hp),
    ),
  );
  ecs.registerSystem(
    createBehaviorTreeSystem<State, [], Action, number, Entity, Delta>({
      query: (q: QueryBuilder) => q.every(components.brain),
      brain: "brain",
      tree: "behaviorTree",
      conditions: { [Condition.Hurt]: (_w: World, e: Entity) => (e.hp ?? 0) < 10 },
      tasks: {
        [Task.Attack]: (_w: World, _e: Entity, args: readonly number[]) => ({
          tag: 1,
          value: { target: "player", damage: args[0] },
        }),
        [Task.Rest]: () => [],
      },
      random: () => random,
      now: () => tick,
      target: (intent: Action) => intent.value.target,
    }),
  );
  ecs.initialize();
  const step = async () => {
    const { mutations } = await ecs.withScope(() => ecs.update());
    tick++;
    return mutations;
  };
  return { ecs, entities, step };
}

async function spawn(w: ReturnType<typeof world>, root: Parameters<typeof tree>[0]) {
  await w.ecs.withScope(() => {
    w.ecs.insert({ id: "hostile-tree", behaviorTree: tree(root) });
    w.ecs.insert({ id: "player", hp: 20, children: ["pet"] });
    w.ecs.insert({ id: "pet", hp: 20 });
    w.ecs.insert({ id: "mob", hp: 5, brain: { tree: "hostile-tree" } });
  });
}

describe("createBehaviorTreeSystem", () => {
  test("dispatched intents commit in the tick's scope, children included", async () => {
    const w = world(1);
    await spawn(w, seq(cond(Condition.Hurt), task(Task.Attack, 3)));
    const mutations = await w.step();
    expect(new Set(mutations.keys())).toEqual(new Set(["mob", "pet", "player"]));
    expect(w.entities.get("player")?.hp).toBe(17);
    expect(w.entities.get("pet")?.hp).toBe(17);
    expect(w.entities.get("mob")?.brain).toEqual({ tree: "hostile-tree", last: 2 });
  });

  test("cooldown state lives on the brain and gates later ticks", async () => {
    const w = world(1);
    await spawn(w, seq(cooldown(3), task(Task.Attack, 1)));
    for (let i = 0; i < 7; i++) await w.step();
    expect(w.entities.get("player")?.hp).toBe(17);
    expect(w.entities.get("mob")?.brain?.readyAt).toEqual([0, 9, 0]);
  });

  test("the same seed replays the same damage", async () => {
    const run = async (seed: number) => {
      const w = world(seed);
      await spawn(w, weighted([1, task(Task.Attack, 1)], [1, task(Task.Attack, 2)]));
      const hp: number[] = [];
      for (let i = 0; i < 20; i++) {
        await w.step();
        hp.push(w.entities.get("player")!.hp!);
      }
      return hp;
    };
    expect(await run(7)).toEqual(await run(7));
    expect(await run(7)).not.toEqual(await run(8));
  });
});
