import type { GenericAction } from "../Actions";
import type { ECS } from "../ECS";
import type { Query, QueryBuilder } from "../Query";
import { type ArchetypeSystem, createArchetypeSystem } from "../System";
import type { BaseEntity } from "../types";
import { evaluate } from "./evaluate";
import type { BehaviorCondition, BehaviorRandom, BehaviorTask, BehaviorTree, Brain } from "./types";

export interface BehaviorTreeSystemOptions<
  State extends Record<string, unknown>,
  UpdateArguments extends unknown[],
  Actions extends GenericAction,
  Tags extends number,
  E extends BaseEntity<Tags>,
  D,
  C extends number = number,
  T extends number = number,
> {
  /** The agents to run: entities carrying the `brain` field. */
  query: Query | ((buildQuery: QueryBuilder) => QueryBuilder);
  /** Entity field holding each agent's {@link Brain}. */
  brain: keyof E & string;
  /** Entity field holding the {@link BehaviorTree} on the entity a brain points at. */
  tree: keyof E & string;
  conditions: Readonly<
    Record<C, BehaviorCondition<ECS<State, UpdateArguments, Actions, Tags, E, D>, E>>
  >;
  tasks: Readonly<
    Record<T, BehaviorTask<ECS<State, UpdateArguments, Actions, Tags, E, D>, E, Actions>>
  >;
  /** The world's seeded RNG, so replays make the same choices. */
  random: (world: ECS<State, UpdateArguments, Actions, Tags, E, D>) => BehaviorRandom;
  /** The world's current tick, for cooldowns. */
  now: (world: ECS<State, UpdateArguments, Actions, Tags, E, D>) => number;
  /** Entity an intent is dispatched to via `act`; defaults to the agent. `undefined` drops it. */
  target?: (intent: Actions, agentId: string) => string | undefined;
}

/**
 * Run every agent's behavior tree once per `update()`. Brain changes are `put`
 * straight away; the intents are dispatched through `act` after all systems ran,
 * in agent order, and the surrounding `withScope` waits for them (see
 * `ECS.waitUntil`) so the resulting mutations commit in the same batch.
 */
export function createBehaviorTreeSystem<
  State extends Record<string, unknown>,
  UpdateArguments extends unknown[],
  Actions extends GenericAction,
  Tags extends number,
  E extends BaseEntity<Tags>,
  D,
  C extends number = number,
  T extends number = number,
>(
  options: BehaviorTreeSystemOptions<State, UpdateArguments, Actions, Tags, E, D, C, T>,
): ArchetypeSystem<State, UpdateArguments, Actions, Tags, E, D> {
  const { brain: brainField, tree: treeField, conditions, tasks } = options;
  const target = options.target ?? ((_intent: Actions, agentId: string) => agentId);
  return createArchetypeSystem<State, UpdateArguments, void, Actions, Tags, E, D>(
    (archetypes, world, ..._args) => {
      const random = options.random(world);
      const now = options.now(world);
      const dispatch: [string, Actions][] = [];
      for (const archetype of archetypes) {
        for (const id of archetype.entities) {
          const agent = world.entity(id);
          const brain = agent?.[brainField] as Brain | undefined;
          if (!agent || !brain?.tree) continue;
          const tree = world.entity(brain.tree)?.[treeField] as BehaviorTree | undefined;
          if (!tree) continue;
          const result = evaluate(tree, brain, {
            world,
            entity: agent,
            conditions,
            tasks,
            random,
            now,
          });
          if (Object.keys(result.brain).length > 0) {
            world.put(id, { [brainField]: result.brain } as D);
          }
          for (const intent of result.intents) {
            const to = target(intent, id);
            if (to !== undefined) dispatch.push([to, intent]);
          }
        }
      }
      if (dispatch.length === 0) return;
      world.defer(() =>
        world.waitUntil(
          (async () => {
            for (const [to, intent] of dispatch) await world.act(to, intent);
          })(),
        ),
      );
    },
    options.query,
  );
}
