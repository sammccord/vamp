import type { BaseEntity } from "@vamp/ecs";
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

export const GameContext = createContext<GameContextValue<BaseEntity, unknown, unknown>>();

/**
 * Read the game context. Throws when called outside a {@link GameProvider}. The
 * type parameters let call sites recover their concrete entity/delta/client types.
 */
export function useGame<
  E extends BaseEntity = BaseEntity,
  D = unknown,
  C = unknown,
>(): GameContextValue<E, D, C> {
  const ctx = useContext(GameContext);
  if (!ctx) {
    throw new Error("[@vamp/solid] hooks must be called within a <GameProvider>.");
  }
  return ctx as unknown as GameContextValue<E, D, C>;
}
