export function emitClasses(tagsType: string = "number", env: string = "Cloudflare.Env"): string {
  return `/**
 * App-typed {@link ECSDurableObject}: this schema's \`Actions\`/\`Tags\`/\`Entity\`/
 * \`EntityDelta\` are baked in, leaving \`UserSession\`/\`Context\`/\`UpdateArguments\`/\`Env\`
 * open (\`Env\` defaults to \`${env}\`, configurable via the \`env\` field in vamp.json).
 * Subclass this as your game's durable object.
 */
export class GameECS<
    UserSession extends {} = {},
    Context extends {} = {},
    UpdateArguments extends Array<unknown> = [],
    Env = ${env},
  > extends ECSDurableObject<
    UserSession,
    Context,
    UpdateArguments,
    Actions,
    ${tagsType},
    Entity,
    EntityDelta,
    Env
  > {}

/** App-typed {@link ECSStorage} over this schema's {@link Entity}. */
export class GameStorage extends ECSStorage<Entity> {}`;
}
