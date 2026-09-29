import {
  type BehaviorRandom,
  cond,
  cooldown,
  type ECS,
  seq,
  task,
  tree,
  weighted,
} from "@vampgg/ecs";
import { Actions, Attack, Condition, type Entity, Tags, Task } from "./bebop";
import {
  components,
  createGameArchetypeSystem,
  createGameBehavior,
  createGameBehaviorTreeSystem,
  createGameEntitySystem,
  type EntityDelta,
  type GameConditions,
  type GameTasks,
} from "./game.core.generated";

/** What the hostile AI reads from the world context: its seeded RNG and frame clock. */
export type AIContext = Record<string, unknown> & { random: BehaviorRandom; frame: number };

/**
 * The concrete ECS world the basic example runs. `UpdateArguments` is `[]`
 * (frames advance on a fixed `DT`), the action union is `Actions`, the tag space
 * is `Tags`, and the entity/delta shapes are the generated `Entity`/`EntityDelta`.
 *
 * Generic over `Context` so the same systems install on whatever context the
 * caller's world carries: the durable object hands `registerGameSystems` an ECS
 * whose context is the worker's `RuntimeContext<...>` (the generated
 * `defineGameECSRuntime` enforces this), while tests can pass a plain context
 * carrying the {@link AIContext} fields.
 */
type World<Context extends AIContext = AIContext> = ECS<
  Context,
  [],
  Actions,
  Tags,
  Entity,
  EntityDelta
>;

// Fixed timestep assumptions for the deterministic stress benchmark. Velocity is
// integrated as an integer per frame because `Vec2Delta` is a signed-int CRDT
// counter (see schema/mutation.bop).
const HEALTH_REGEN = 1; // health points restored per frame for entities with rate > 0
const AI_ATTACK_DAMAGE = 1; // damage of a hostile's regular hit on the nearest player
const AI_HEAVY_DAMAGE = 3; // damage of the occasional heavy hit
const AI_HEAVY_COOLDOWN = 10; // frames before a hostile can land another heavy hit
const AI_AGGRO_RADIUS = 256; // how close the nearest player must be for a hostile to attack

/** Id of the entity holding the tree every hostile's `brain` points at. */
export const HOSTILE_TREE_ID = "tree/hostile";

/**
 * While a player is in aggro range, a hostile usually lands a regular hit and
 * one time in four a heavy hit, which then cools down. A cooling-down heavy
 * branch fails, so the regular hit is picked instead.
 */
const hostileTree = tree(
  seq(
    cond(Condition.PlayerNear, AI_AGGRO_RADIUS),
    weighted(
      [3, task(Task.Attack, AI_ATTACK_DAMAGE)],
      [1, cooldown(AI_HEAVY_COOLDOWN, task(Task.Attack, AI_HEAVY_DAMAGE))],
    ),
  ),
);

/**
 * Register the example's systems and behaviors on the ECS world. Wired into the
 * worker runtime via `defineECSRuntime({ registerSystems })`, so the durable
 * object installs these during bootstrap (before `initialize()`), and the same
 * function is reused by the benchmark harness to drive `update()`/`act()`.
 *
 * The systems intentionally span a complexity gradient so the FPS benchmark can
 * attribute cost:
 *   1. regen      — cheap per-entity arithmetic + one pool delta.
 *   2. movement   — per-entity read of two components + a vector delta.
 *   3. ai         — a behavior tree per hostile: an O(players) nearest-target scan,
 *                   a seeded weighted pick, and an `act` dispatch.
 */
export function registerGameSystems<Context extends AIContext = AIContext>(
  ecs: World<Context>,
): void {
  // ── System 1 (simple): regenerate health toward max for entities with a rate.
  ecs.registerSystem(
    createGameEntitySystem<Context, []>(
      (entities, world) => {
        for (let i = 0; i < entities.length; i++) {
          const id = entities[i];
          const e = world.entity(id);
          const h = e?.health;
          if (!h || !h.rate) continue;
          const points = h.points ?? 0;
          const max = h.max ?? 0;
          if (points >= max) continue;
          const inc = Math.min(HEALTH_REGEN, max - points);
          if (inc !== 0) world.put(id, { health: { points: inc } });
        }
      },
      (q) => q.every(components.health),
    ),
  );

  // ── System 2 (medium): integrate position += velocity each frame.
  ecs.registerSystem(
    createGameEntitySystem<Context, []>(
      (entities, world) => {
        for (let i = 0; i < entities.length; i++) {
          const id = entities[i];
          const e = world.entity(id);
          const v = e?.velocity;
          if (!v) continue;
          const vx = Math.round(v.x ?? 0);
          const vy = Math.round(v.y ?? 0);
          if (vx === 0 && vy === 0) continue;
          world.put(id, { position: { x: vx, y: vy } });
        }
      },
      (q) => q.every(components.position, components.velocity),
    ),
  );

  // ── System 3 (complex): hostile AI. Hostiles carry a `brain` pointing at the
  // shared hostile tree entity; the behavior tree system picks an attack for each
  // and dispatches it as an `Attack` action to the Attack behavior below. The
  // upkeep system advances the frame clock that cooldowns compare against and
  // keeps the tree entity present.
  ecs.registerSystem(
    createGameArchetypeSystem<Context, []>(
      (_archetypes, world) => {
        world.context.frame++;
        if (!world.entity(HOSTILE_TREE_ID)) {
          world.insert({ id: HOSTILE_TREE_ID, behaviorTree: hostileTree });
        }
      },
      (q) => q.every(components.brain),
    ),
  );
  ecs.registerSystem(
    createGameBehaviorTreeSystem<Context, []>({
      ...hostileLeaves<Context>(),
      random: (world) => world.context.random,
      now: (world) => world.context.frame,
      target: (intent) => intent.value.target,
    }),
  );

  // ── Behaviors dispatched via `act(targetId, action)`. The action tag selects
  // the behavior; `act` propagates the same action down to the entity's children,
  // so dispatching `AreaAttack` on a parent cascades to its whole subtree.
  registerBehaviors(ecs);
}

/**
 * The hostile tree's leaves. Players are queried once per frame and shared by
 * every hostile's scan.
 */
function hostileLeaves<Context extends AIContext>(): {
  conditions: GameConditions<Context>;
  tasks: GameTasks<Context>;
} {
  let playersFrame = -1;
  let players: string[] = [];
  const nearestPlayer = (world: World<Context>, hostile: Entity) => {
    if (playersFrame !== world.context.frame) {
      players = world.query((q) => q.someTag(Tags.PlayerControlled).every(components.position));
      playersFrame = world.context.frame;
    }
    const hx = hostile.position?.x ?? 0;
    const hy = hostile.position?.y ?? 0;
    let bestId: string | undefined;
    let bestDistSq = Number.POSITIVE_INFINITY;
    for (const id of players) {
      const pp = world.entity(id)?.position;
      if (!pp) continue;
      const dx = (pp.x ?? 0) - hx;
      const dy = (pp.y ?? 0) - hy;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestId = id;
      }
    }
    return bestId === undefined ? undefined : { id: bestId, distSq: bestDistSq };
  };
  return {
    conditions: {
      [Condition.PlayerNear]: (world, hostile, [radius]) =>
        (nearestPlayer(world, hostile)?.distSq ?? Number.POSITIVE_INFINITY) <= radius * radius,
    },
    tasks: {
      [Task.Attack]: (world, hostile, [damage]) => {
        const target = nearestPlayer(world, hostile)?.id;
        if (!hostile.id || !target) return undefined;
        return Actions.fromAttack(Attack({ source: hostile.id, target, damage }));
      },
    },
  };
}

/**
 * Behaviors keyed by the `Actions` union tag. Kept current per-entity by the ECS
 * behavior cache (`act` only runs behaviors whose query matches the entity's
 * archetype, here: anything with a health pool).
 */
function registerBehaviors<Context extends AIContext>(ecs: World<Context>): void {
  // tag 1 — Attack: subtract damage from the struck entity's health.
  ecs.registerBehavior(
    createGameBehavior<Context, []>(
      1,
      (world, entity, event) => {
        const damage = (event.detail.value as { damage?: number }).damage ?? 0;
        if (!entity.id || damage === 0) return;
        world.put(entity.id, { health: { points: -damage } });
      },
      (q) => q.every(components.health),
    ),
  );

  // tag 2 — TakeDamage: same effect, modelled as a separate event so it can be
  // dispatched independently of an attacker.
  ecs.registerBehavior(
    createGameBehavior<Context, []>(
      2,
      (world, entity, event) => {
        const damage = (event.detail.value as { damage?: number }).damage ?? 0;
        if (!entity.id || damage === 0) return;
        world.put(entity.id, { health: { points: -damage } });
      },
      (q) => q.every(components.health),
    ),
  );

  // tag 3 — Heal: add to the entity's health pool.
  ecs.registerBehavior(
    createGameBehavior<Context, []>(
      3,
      (world, entity, event) => {
        const amount = (event.detail.value as { amount?: number }).amount ?? 0;
        if (!entity.id || amount === 0) return;
        world.put(entity.id, { health: { points: amount } });
      },
      (q) => q.every(components.health),
    ),
  );

  // tag 4 — AreaAttack: damage the entity and (via act's child propagation) every
  // descendant. Drains stamina too, so a single cascade touches two pools.
  ecs.registerBehavior(
    createGameBehavior<Context, []>(
      4,
      (world, entity, event) => {
        const damage = (event.detail.value as { damage?: number }).damage ?? 0;
        if (!entity.id || damage === 0) return;
        const delta: EntityDelta = { health: { points: -damage } };
        if (entity.stamina) delta.stamina = { points: -1 };
        world.put(entity.id, delta);
      },
      (q) => q.every(components.health),
    ),
  );
}
