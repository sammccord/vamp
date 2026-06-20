/**
 * Emits the `GameContext` type alias exported near the bottom of the generated
 * file. It describes the server-environment context provided to RPC method
 * implementations, i.e. the tuple `[ECS<...>, WebSocket]` that the durable
 * object hands to the tempo router. RPC methods retrieve it via
 * `const [ecs, ws] = ctx.getEnvironment<GameContext>()`.
 */
export function emitGameContext(): string {
  return `export type GameContext<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
> = RPCContext<UserSession, Context, UpdateArguments, Actions, Tags, Entity, EntityDelta>;`;
}
