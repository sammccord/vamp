export function emitClasses(tagsType: string = "number"): string {
  return `/**
 * App-typed {@link ECSDurableObject}: this schema's \`Actions\`/\`Tags\`/\`Entity\`/
 * \`EntityDelta\` are baked in, leaving \`UserSession\`/\`Context\`/\`UpdateArguments\`
 * open. Subclass this as your game's durable object.
 */
export class GameECS<
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

/** App-typed {@link ECSStorage} over this schema's {@link Entity}. */
export class GameStorage extends ECSStorage<Entity> {}`;
}
