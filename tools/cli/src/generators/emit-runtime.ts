/**
 * Emits the app-typed runtime wrappers exported near the bottom of the generated
 * file. These bake the schema's concrete `Actions`/`Tags`/`Entity`/`EntityDelta`
 * into the worker's generic {@link ECSRuntimeConfiguration}/{@link ECSRuntimeProvider}
 * (leaving `UserSession`/`Context`/`UpdateArguments` open, mirroring `GameECS`/
 * `GameContext`), and provide a `defineGameECSRuntime` wrapper so the worker entry
 * gets call-site type safety on `ecs`, `context`, `registerSystems`, `tickArgs`,
 * and `broadcastTick`.
 *
 * A wrapper *function* is required: a type alias alone cannot constrain the
 * worker's generic `defineECSRuntime`, so the provider's return type would not be
 * inferred at the call site.
 */
export function emitRuntime(): string {
  return `/** App-typed {@link ECSRuntimeConfiguration} — the worker runtime config with this schema's types baked in. */
export type GameECSRuntimeConfiguration<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
> = ECSRuntimeConfiguration<UserSession, Context, UpdateArguments, Actions, Tags, Entity, EntityDelta>;

/** Factory returning a {@link GameECSRuntimeConfiguration}; pass it to {@link defineGameECSRuntime}. */
export type GameECSRuntimeProvider<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
> = () => GameECSRuntimeConfiguration<UserSession, Context, UpdateArguments>;

/**
 * Register the worker's runtime provider with call-site type safety on \`ecs\`,
 * \`context\`, \`registerSystems\`, \`tickArgs\`, and \`broadcastTick\`. Call once from
 * the worker entry.
 */
export function defineGameECSRuntime<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
>(provider: GameECSRuntimeProvider<UserSession, Context, UpdateArguments>): void {
  defineECSRuntime(provider);
}`;
}
