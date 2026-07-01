export function emitFactory(): string {
  return `/**
 * {@link ECSOptions} for this schema — wires the {@link components} map and the
 * delta algebra ({@link materializeDelta}/{@link mergeDelta}/{@link accumulateDelta})
 * into an ECS world. \`createId\` mints new entity ids.
 */
export function createECSOptions(createId: () => string): ECSOptions<Entity, EntityDelta> {
  return { createId, components, materializeDelta, mergeDelta, accumulateDelta };
}`;
}
