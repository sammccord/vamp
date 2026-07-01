import { type BaseEntity, MutationType } from "@vampgg/ecs";
import {
  batch,
  createComponent,
  createSignal,
  getOwner,
  type JSX,
  onCleanup,
  onMount,
  runWithOwner,
} from "solid-js";
import { GameContext, type GameContextValue } from "./context";
import { createQueryRegistry } from "./registry";
import { createEntityStore } from "./store";
import type { AnyECS, ConnectionStatus, WireBatch } from "./types";

export interface GameProviderProps<E extends BaseEntity, D, C> {
  /** The client read-replica world (see `createWorld`). */
  world: AnyECS<E, D>;
  /** The generated bebop RPC client. Exposed unwrapped via `useClient()`. */
  client: C;
  /**
   * Open the server `observe`-style stream. Codec-agnostic: the consumer decides
   * which method and request to use, e.g. `(c) => c.observe(MutationScope({}))`.
   */
  open: (client: C) => Promise<AsyncGenerator<WireBatch<E, D>, void, unknown>>;
  /** Delay (ms) before reconnecting after the stream ends/errors. Default 1000. */
  reconnectDelay?: number;
  children?: JSX.Element;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Provides a client ECS read-replica fed by the server `observe` stream. Owns:
 * world initialization, the reactive entity store, the per-query membership
 * registry, and the observe loop (start on mount, reconnect on drop, cancel on
 * unmount). Children read state via `createQuery` / `createEntity` and call RPCs
 * via `useClient`.
 */
export function GameProvider<E extends BaseEntity, D, C>(
  props: GameProviderProps<E, D, C>,
): JSX.Element {
  const world = props.world;
  if (!world.initialized) world.initialize();

  const store = createEntityStore<E>();
  const owner = getOwner();
  const registry = createQueryRegistry<E, D>(world, owner);
  const [connection, setConnection] = createSignal<ConnectionStatus>("connecting");

  // Seed the store from any entities already present in the world.
  batch(() => {
    for (const [id, entity] of world.entities) store.upsert(id, entity as E);
  });

  let stream: AsyncGenerator<WireBatch<E, D>, void, unknown> | undefined;
  let stopped = false;

  async function commit(frame: WireBatch<E, D>): Promise<void> {
    // Apply through a scope so writes coalesce into one authoritative commit; the
    // returned map is the coalesced batch reflecting the merged final state.
    const { mutations } = await world.withScope(() => {
      if (frame.mutations) world.applyMutations(frame.mutations);
    });
    // Drive store + membership from the committed batch under the provider owner,
    // in a single Solid batch so dependent effects run once on final state.
    runWithOwner(owner, () => {
      batch(() => {
        for (const [id, record] of mutations) {
          if (record.tag === MutationType.Delete) {
            store.remove(id);
          } else {
            const entity = world.entity(id);
            if (entity) store.upsert(id, entity as E);
          }
        }
        registry.update(mutations);
      });
    });
  }

  async function run(): Promise<void> {
    const reconnectDelay = props.reconnectDelay ?? 1000;
    while (!stopped) {
      try {
        setConnection("connecting");
        stream = await props.open(props.client);
        setConnection("open");
        for await (const frame of stream) {
          if (stopped) break;
          await commit(frame);
        }
      } catch {
        // Transport/decode failure: fall through to reconnect unless stopped.
      }
      stream = undefined;
      if (stopped) return;
      setConnection("closed");
      await delay(reconnectDelay);
    }
  }

  // `onMount` runs client-side only, so SSR renders children without opening a
  // socket. `onCleanup` cancels the stream and stops the loop.
  onMount(() => {
    void run();
  });
  onCleanup(() => {
    stopped = true;
    void stream?.return(undefined);
  });

  const value: GameContextValue<E, D, C> = {
    world,
    client: props.client,
    store,
    registry,
    connection,
  };

  return createComponent(GameContext.Provider, {
    value: value as unknown as GameContextValue<BaseEntity, unknown, unknown>,
    get children() {
      return props.children;
    },
  });
}
