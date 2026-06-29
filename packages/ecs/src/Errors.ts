/**
 * Thrown when an entity read returns undefined mid-iteration — usually because a
 * system transformed an entity (changing its archetype) while iterating a query
 * result forward. Iterate backwards or wrap the transform in `world.defer(...)`.
 */
export class EntityUndefinedError extends Error {
  constructor() {
    super(`
Seems like you're iterating entities from 0..N and transforming entities.
This may remove the entity from the query results passed to your system.
Try iterating entities backwards:
\`for (let i = entities.length -1; i >= 0; i--) {...}\`
You can also wrap the transformation in \`world.defer(() => {...})\`
`);
  }
}
/** Thrown when operating on an entity that has already been deleted. */
export class EntityDeletedError extends Error {
  constructor(entity: string) {
    super(`Entity ${entity} is deleted`);
  }
}
/** Thrown when referencing an entity id that does not exist in the world. */
export class EntityNotExistError extends Error {
  constructor(entity: string) {
    super(`Entity ${entity} does not exist`);
  }
}
/** Thrown by {@link ECS.update} when called before {@link ECS.initialize}. */
export class WorldNotInitializedError extends Error {
  constructor() {
    super("World not initialized");
  }
}
