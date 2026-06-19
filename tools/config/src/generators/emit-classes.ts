export function emitClasses(tagsType: string = "number"): string {
  return `export class GameECS<
    UserSession extends {} = {},
    Context extends {} = {},
    UpdateArguments extends Array<unknown> = [],
  > extends ECSDurableObject<
    UserSession,
    Context,
    UpdateArguments,
    Actions,
    ${tagsType},
    Entity,
    EntityDelta,
    Cloudflare.Env
  > {}

export class GameStorage extends ECSStorage<Entity> {}`;
}
