export function emitFactory(): string {
  return `export function createECSOptions(createId: () => string): ECSOptions<Entity, EntityDelta> {
  return { createId, components, materializeDelta, mergeDelta, accumulateDelta };
}`;
}
