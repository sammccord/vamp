import { type BaseEntity, clonePlainValue } from "@vampgg/ecs";
import { createStore, produce, reconcile, type Store } from "solid-js/store";

/**
 * A fine-grained reactive mirror of the world's committed entity state, keyed by
 * entity id. Backed by a Solid store: a component reading `state[id].health.points`
 * re-runs only when that path changes, not on every streamed frame.
 */
export interface EntityStore<E extends BaseEntity> {
  readonly state: Store<Record<string, E>>;
  /** Insert or update an entity, diffing against the previous value to keep identity stable. */
  upsert(id: string, entity: E): void;
  remove(id: string): void;
}

export function createEntityStore<E extends BaseEntity>(): EntityStore<E> {
  const [state, setState] = createStore<Record<string, E>>({});

  return {
    state,
    upsert(id, entity) {
      // Reconcile against a fresh structural snapshot, NOT the live ECS entity.
      // The ECS mutates entity objects in place (additive `mergeDelta`), so the
      // store would otherwise alias that same object — reconcile would diff it
      // against itself, detect no change, and never notify (stale UI). Cloning
      // decouples the store's value; reconcile then produces minimal,
      // identity-preserving path updates (rows in `<For>` stay stable).
      setState(id, reconcile(clonePlainValue(entity), { key: "id", merge: false }));
    },
    remove(id) {
      setState(
        produce((draft) => {
          delete draft[id];
        }),
      );
    },
  };
}
