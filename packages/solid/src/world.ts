import { type BaseEntity, createBaseMutator, ECS, type ECSOptions } from "@vampgg/ecs";
import type { AnyECS } from "./types";

/**
 * Build a client-side read-replica ECS wired with the standard base mutator
 * (Insert → set, Update → additive `mergeDelta`, Delete → remove). Pass the same
 * `ECSOptions` your game generates server-side (e.g. `createECSOptions(createId)`
 * from the generated game module) so client and server share delta semantics.
 *
 * The returned world is NOT `update()`-ticked: it is a pure replica fed by the
 * server `observe` stream via {@link GameProvider}.
 */
export function createWorld<E extends BaseEntity, D>(
  options: ECSOptions<E, D>,
  context: Record<string, unknown> = {},
): AnyECS<E, D> {
  const entities = new Map<string, E>();

  // Client replica: an Update may be the first frame we see for an entity, so
  // materialize-and-insert on a missing target instead of no-op'ing.
  const mutate = createBaseMutator(entities, options, { materializeOnMissingUpdate: true });

  return new ECS(entities, mutate, context, options);
}
