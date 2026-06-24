export { type GameContextValue, useGame } from "./context";
export {
  createEntity,
  createOnCreate,
  createOnDelete,
  createQuery,
  createSubscription,
  useClient,
  useConnection,
  useWorld,
} from "./hooks";
export { GameProvider, type GameProviderProps } from "./provider";
export {
  createQueryRegistry,
  type QueryHandle,
  type QueryInput,
  type QueryRegistry,
} from "./registry";
export { createEntityStore, type EntityStore } from "./store";
export type {
  AnyECS,
  ConnectionStatus,
  EventSystemArg,
  LifecycleSystemArg,
  WireBatch,
} from "./types";
export { createWorld } from "./world";
