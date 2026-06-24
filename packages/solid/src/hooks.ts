import type { BaseEntity } from "@vamp/ecs";
import { type Accessor, createMemo, onCleanup } from "solid-js";
import { useGame } from "./context";
import type { QueryInput } from "./registry";
import type { AnyECS, ConnectionStatus, EventSystemArg, LifecycleSystemArg } from "./types";

/** The client ECS read-replica. */
export function useWorld<E extends BaseEntity = BaseEntity, D = unknown>(): AnyECS<E, D> {
  return useGame<E, D>().world;
}

/** The generated bebop RPC client. Call methods directly: `useClient().spawn(e)`. */
export function useClient<C = unknown>(): C {
  return useGame<BaseEntity, unknown, C>().client;
}

/** Reactive connection status of the observe stream. */
export function useConnection(): Accessor<ConnectionStatus> {
  return useGame().connection;
}

/**
 * The reactive "Query signal": a fine-grained accessor of the entities matching
 * `input`. The returned array changes identity only when membership changes; each
 * entity is a reactive store node, so `<For each={items()}>{(e) => <span>{e.x}</span>}</For>`
 * re-renders rows on membership change and updates fields in place on value change.
 */
export function createQuery<E extends BaseEntity = BaseEntity>(input: QueryInput): Accessor<E[]> {
  const game = useGame<E, unknown>();
  const handle = game.registry.acquire(input);
  onCleanup(() => handle.release());

  return createMemo<E[]>(() => {
    const result: E[] = [];
    for (const id of handle.ids()) {
      const entity = game.store.state[id];
      if (entity !== undefined) result.push(entity as E);
    }
    return result;
  });
}

/** Reactive accessor of a single entity by id (static or reactive). */
export function createEntity<E extends BaseEntity = BaseEntity>(
  id: string | Accessor<string>,
): Accessor<E | undefined> {
  const game = useGame<E, unknown>();
  const read = typeof id === "function" ? id : () => id;
  return createMemo(() => game.store.state[read()] as E | undefined);
}

/**
 * Register an ECS `EventSystem` (from `createEventSystem`) for the provider's
 * lifetime. Fires on archetype changes as the stream applies — useful for
 * app-level reactions. Auto-unregistered on cleanup.
 */
export function createSubscription(system: EventSystemArg): void {
  const world = useWorld();
  const unsubscribe = world.subscribe(system);
  onCleanup(() => unsubscribe());
}

/** Register an `onCreate` lifecycle system for the provider's lifetime. */
export function createOnCreate(system: LifecycleSystemArg): void {
  const world = useWorld();
  const unsubscribe = world.onCreate(system);
  onCleanup(() => unsubscribe());
}

/** Register an `onDelete` lifecycle system for the provider's lifetime. */
export function createOnDelete(system: LifecycleSystemArg): void {
  const world = useWorld();
  const unsubscribe = world.onDelete(system);
  onCleanup(() => unsubscribe());
}
