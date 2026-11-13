export function emitClasses(env: string = "Cloudflare.Env"): string {
  return `/**
 * The {@link GameTypes} a durable object for this schema runs with: the
 * schema's {@link GameWorld} plus the per-connection \`UserSession\`.
 */
export type GameServerTypes<
  UserSession extends object = {},
  Context extends object = {},
  UpdateArguments extends Array<unknown> = [],
> = GameWorld<Context, UpdateArguments> & { session: UserSession };

/**
 * App-typed {@link ECSDurableObject}: this schema's \`Actions\`/\`Tags\`/\`Entity\`/
 * \`EntityDelta\` are baked in, leaving \`UserSession\`/\`Context\`/\`UpdateArguments\`/\`Env\`
 * open (\`Env\` defaults to \`${env}\`, configurable via the \`env\` field in vamp.json).
 * Subclass this as your game's durable object.
 */
export class GameECS<
    UserSession extends object = {},
    Context extends object = {},
    UpdateArguments extends Array<unknown> = [],
    Env = ${env},
  > extends ECSDurableObject<GameServerTypes<UserSession, Context, UpdateArguments>, Env> {}

/** App-typed {@link ECSStorage} over this schema's {@link Entity}. */
export class GameStorage extends ECSStorage<Entity> {}`;
}
