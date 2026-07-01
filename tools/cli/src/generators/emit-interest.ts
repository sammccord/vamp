/**
 * Emits the app-typed interest-managed broadcast wrapper exported near the bottom
 * of the generated file. It binds the schema's concrete `Entity`/`EntityDelta`/
 * `MutationScope` into the worker's generic `createInterestBroadcast` and supplies
 * the two app-specific defaults a developer would otherwise hand-write: the bebop
 * `encodeBatch` codec (which the worker package cannot import — it is per-app
 * codegen), and a first-key `resolveViewer` (the convention where the client
 * passes its viewer entity id as the first key of the observe request scope's
 * `mutations` map). The interest policy (`canSee`) is left to the app; with no
 * args every observer sees every mutation (global broadcast).
 *
 * A wrapper *function* (not a type alias) is required so the bound defaults exist
 * at runtime and `UserSession`/`Context`/`UpdateArguments` stay open at the call
 * site, mirroring `defineGameECSRuntime`/`GameContext`.
 */
export function emitInterest(): string {
  return `/**
 * Interest-managed mutation broadcast bound to this schema. Supplies the bebop
 * \`encodeBatch\` codec and a first-key \`resolveViewer\` default; pass \`canSee\` to
 * scope what each observer sees, or omit \`config\` for a global broadcast.
 */
export function createGameInterestBroadcast<
  UserSession extends {} = {},
  Context extends Record<string, unknown> = {},
  UpdateArguments extends Array<unknown> = [],
>(
  config: Partial<
    InterestBroadcastConfig<
      GameContext<UserSession, Context, UpdateArguments>[0],
      MutationScope,
      Entity,
      EntityDelta
    >
  > = {},
) {
  return createInterestBroadcast<
    GameContext<UserSession, Context, UpdateArguments>[0],
    MutationScope,
    MutationScope,
    Entity,
    EntityDelta
  >({
    encodeBatch: (batch: MutationBatch<Entity, EntityDelta>): Uint8Array =>
      new Uint8Array(
        MutationScope.encode(
          MutationScope({ mutations: batch as unknown as Map<string, MutationRecord> }),
        ),
      ),
    resolveViewer: (record: MutationScope): string | undefined => {
      if (!record.mutations) return undefined;
      for (const key of record.mutations.keys()) return key;
      return undefined;
    },
    ...config,
  });
}`;
}
