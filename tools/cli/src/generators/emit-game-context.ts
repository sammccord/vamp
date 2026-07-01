/**
 * Emits the `GameContext` type alias exported near the bottom of the generated
 * file. It describes the server-environment context provided to RPC method
 * implementations, i.e. the tuple `[ECS<...>, WebSocket]` that the durable
 * object hands to the tempo router. RPC methods retrieve it via
 * `const [ecs, ws] = ctx.getEnvironment<GameContext>()`.
 */
export function emitGameContext(): string {
  return `/**
 * Server environment handed to RPC methods, app-typed for this schema. Retrieve
 * it inside a method with \`const [ecs, ws] = ctx.getEnvironment<GameContext>()\` —
 * the \`[ECS, WebSocket]\` tuple carrying the live world.
 */
export type GameContext<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
> = RPCContext<UserSession, Context, UpdateArguments, Actions, Tags, Entity, EntityDelta>;`;
}
