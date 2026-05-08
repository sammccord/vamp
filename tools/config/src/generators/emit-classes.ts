export function emitClasses(): string {
  return `export class GameECS<
    UserSession extends {} = {},
    Context extends {} = {},
    UpdateArguments extends Array<unknown> = [],
  > extends ECSDurableObject<UserSession, Context, UpdateArguments, Actions, Entity, EntityDelta> {};

export class GameStorage extends ECSStorage<Entity> {}`;
}
