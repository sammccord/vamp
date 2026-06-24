import type { Entity } from "./bebop";
import { createGameInterestBroadcast, type GameContext } from "./game.generated";

/**
 * Interest-managed broadcast policy for the basic example.
 *
 * All the plumbing — per-connection subscription persistence, generator-free
 * framed delivery, hibernation rehydration, teardown — lives in
 * `@vamp/worker/interest` and is bound to this app's generated types by the
 * codegen `createGameInterestBroadcast` wrapper (which also supplies the default
 * bebop codec and first-key viewer resolution). All a developer writes here is
 * the subjective interest policy `canSee`; with no policy at all every observer
 * would see every mutation (global broadcast).
 *
 * This module is intentionally free of the `@TempoServiceRegistry.register`
 * decorator (kept in `rpc.service.ts`) so the worker entry can import the
 * lifecycle hooks below without the service-registration side effect.
 */

/**
 * The runtime-configurable world context for this example. It is derived per
 * Durable Object at bootstrap from the handler's request (see `resolveContext`
 * in `index.ts`) and survives hibernation via the persisted seed. `faction` is
 * applied as the default faction for entities spawned into this world.
 */
export type GameWorldContext = { faction: number; seededAt: number };

/** The example's ECS context tuple, typed with the world context above. */
export type WorldContext = GameContext<{}, GameWorldContext>;
/** The example's ECS world type (the first element of the context tuple). */
export type GameWorld = WorldContext[0];

/**
 * Area-of-interest radius for the example's subjective interest policy
 * (`canSee`). Entities within this distance of a viewer's position are relevant
 * to that observer; everything else is filtered out before it is ever sent.
 */
const AOI_RADIUS = 100;
const AOI_RADIUS_SQ = AOI_RADIUS * AOI_RADIUS;

/**
 * The subjective area-of-interest policy. Is `target` relevant to the connection
 * viewing around `viewerId`? A missing viewer (global observer) or an entity
 * without a position (a system/global entity) is always visible; otherwise the
 * target must be within `AOI_RADIUS` of the viewer. Swap this body for room id /
 * faction / line-of-sight as a game requires — the library owns the routing
 * mechanism, this function is the injected policy.
 */
function canSee(
  world: GameWorld,
  viewerId: string | undefined,
  targetId: string,
  target: Entity,
): boolean {
  if (!viewerId || targetId === viewerId) return true;
  const viewer = world.entity(viewerId);
  if (!viewer?.position || !target.position) return true;
  const dx = (target.position.x ?? 0) - (viewer.position.x ?? 0);
  const dy = (target.position.y ?? 0) - (viewer.position.y ?? 0);
  return dx * dx + dy * dy <= AOI_RADIUS_SQ;
}

const broadcast = createGameInterestBroadcast<{}, GameWorldContext>({ canSee });

/**
 * `observe` — delegate target for the RPC `observe` method.
 * `onConnectionClose` / `rehydrateConnection` — wired into `defineGameECSRuntime`.
 */
export const { observe, onConnectionClose, rehydrateConnection } = broadcast;
