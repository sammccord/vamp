import type { BaseEntity } from "@vampgg/ecs";
import { type Accessor, createContext, useContext } from "solid-js";
import type { QueryRegistry } from "./registry";
import type { EntityStore } from "./store";
import type { AnyECS, ConnectionStatus } from "./types";

export interface GameContextValue<E extends BaseEntity, D, C> {
  readonly world: AnyECS<E, D>;
  readonly client: C;
  readonly store: EntityStore<E>;
  readonly registry: QueryRegistry<E, D>;
  readonly connection: Accessor<ConnectionStatus>;
}

/**
 * One runtime slot serves every `<GameProvider<E, D, C>>`, so the stored value's
 * type parameters are erased here and recovered by {@link useGame}.
 */
export const GameContext = createContext<unknown>();

/**
 * Read the game context. Throws when called outside a {@link GameProvider}. The
 * type parameters let call sites recover their concrete entity/delta/client types.
 * Solid 2's default-less `useContext` throws `ContextNotFoundError` on missing
 * provider; we rebrand it to name the provider a game developer forgot.
 */
export function useGame<
  E extends BaseEntity = BaseEntity,
  D = unknown,
  C = unknown,
>(): GameContextValue<E, D, C> {
  try {
    // SAFETY: `useContext` throws when no provider is mounted (caught below), and
    // `GameProvider` is the only writer of `GameContext`, so a returned value is
    // the `GameContextValue<E, D, C>` a `<GameProvider<E, D, C>>` stored.
    return useContext(GameContext) as GameContextValue<E, D, C>;
  } catch {
    throw new Error("[@vampgg/solid] hooks must be called within a <GameProvider>.");
  }
}
