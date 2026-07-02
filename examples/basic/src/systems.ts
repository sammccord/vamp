import type { ECS } from "@vampgg/ecs";
import { type Actions, type Entity, Tags } from "./bebop";
import {
  components,
  createGameArchetypeSystem,
  createGameBehavior,
  createGameEntitySystem,
  type EntityDelta,
} from "./game.core.generated";

/**
 * The concrete ECS world the basic example runs. `UpdateArguments` is `[]`
 * (frames advance on a fixed `DT`), the action union is `Actions`, the tag space
 * is `Tags`, and the entity/delta shapes are the generated `Entity`/`EntityDelta`.
 *
 * Generic over `Context` so the same systems install on whatever context the
 * caller's world carries: the durable object hands `registerGameSystems` an ECS
 * whose context is the worker's `RuntimeContext<...>` (the generated
 * `defineGameECSRuntime` enforces this), while tests can pass a plain context.
 * The systems here never read context, so they accept any.
 */
type World<Context extends Record<string, unknown> = Record<string, unknown>> = ECS<
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
const AI_ATTACK_DAMAGE = 1; // damage a hostile deals to the nearest player per frame
const AI_AGGRO_RADIUS_SQ = 256 * 256; // squared aggro range for the O(hostiles × players) scan

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
 *   3. ai         — once-per-frame O(hostiles × players) nearest-target scan with
 *                   a cross-archetype query and conditional mutation.
 */
export function registerGameSystems<
  Context extends Record<string, unknown> = Record<string, unknown>,
>(ecs: World<Context>): void {
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

  // ── System 3 (complex): each hostile scans every player for the nearest in
  // aggro range and chips its health. Archetype system so the player query runs
  // once per frame; the inner scan is O(hostiles × players).
  ecs.registerSystem(
    createGameArchetypeSystem<Context, []>(
      (archetypes, world) => {
        const players = world.query((q) =>
          q.someTag(Tags.PlayerControlled).every(components.position),
        );
        if (players.length === 0) return;
        for (const arch of archetypes) {
          for (const hostileId of arch.entities) {
            const hostile = world.entity(hostileId);
            const hp = hostile?.position;
            if (!hp) continue;
            const hx = hp.x ?? 0;
            const hy = hp.y ?? 0;
            let bestId: string | undefined;
            let bestDistSq = Number.POSITIVE_INFINITY;
            for (let p = 0; p < players.length; p++) {
              const player = world.entity(players[p]);
              const pp = player?.position;
              if (!pp) continue;
              const dx = (pp.x ?? 0) - hx;
              const dy = (pp.y ?? 0) - hy;
              const distSq = dx * dx + dy * dy;
              if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestId = players[p];
              }
            }
            if (bestId !== undefined && bestDistSq <= AI_AGGRO_RADIUS_SQ) {
              world.put(bestId, { health: { points: -AI_ATTACK_DAMAGE } });
            }
          }
        }
      },
      (q) => q.someTag(Tags.Hostile).every(components.position, components.health),
    ),
  );

  // ── Behaviors dispatched via `act(targetId, action)`. The action tag selects
  // the behavior; `act` propagates the same action down to the entity's children,
  // so dispatching `AreaAttack` on a parent cascades to its whole subtree.
  registerBehaviors(ecs);
}

/**
 * Behaviors keyed by the `Actions` union tag. Kept current per-entity by the ECS
 * behavior cache (`act` only runs behaviors whose query matches the entity's
 * archetype, here: anything with a health pool).
 */
function registerBehaviors<Context extends Record<string, unknown>>(ecs: World<Context>): void {
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
