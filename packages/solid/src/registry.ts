import {
  type BaseEntity,
  createQueryMembershipTracker,
  type MutationRecord,
  type Query,
  type QueryMembershipTracker,
  query as buildQuery,
  type QueryBuilder,
  type TrackedQuery,
} from "@vampgg/ecs";
import { type Accessor, createSignal, type Owner, runWithOwner, type Setter } from "solid-js";
import type { AnyECS } from "./types";

export type QueryInput = Query | ((builder: QueryBuilder) => QueryBuilder);

interface Entry {
  tracked: TrackedQuery;
  ids: Accessor<string[]>;
  setIds: Setter<string[]>;
  refs: number;
}

export interface QueryHandle {
  readonly ids: Accessor<string[]>;
  release(): void;
}

/**
 * The Solid binding over the framework-agnostic membership tracker
 * (`createQueryMembershipTracker` in `@vampgg/ecs`). The tracker owns the
 * id-set diffing; this layer adds only Solid concerns: one shared signal +
 * reference count per distinct `Query`, owned at the provider scope so it
 * persists across the components that share a query and is disposed with them.
 */
export interface QueryRegistry<E extends BaseEntity, D> {
  acquire(input: QueryInput): QueryHandle;
  update(batch: ReadonlyMap<string, MutationRecord<E, D>>): void;
}

export function createQueryRegistry<E extends BaseEntity, D>(
  world: AnyECS<E, D>,
  owner: Owner | null,
): QueryRegistry<E, D> {
  const tracker: QueryMembershipTracker = createQueryMembershipTracker(world);
  const entries = new Map<Query, Entry>();

  function acquire(input: QueryInput): QueryHandle {
    const q = typeof input === "function" ? buildQuery(input) : input;
    let entry = entries.get(q);
    if (!entry) {
      // `track` seeds the member set from the world's current matches.
      const tracked = tracker.track(q);
      const [ids, setIds] = runWithOwner(owner, () =>
        createSignal<string[]>([...tracked.members]),
      )!;
      entry = { tracked, ids, setIds, refs: 0 };
      entries.set(q, entry);
    }
    entry.refs += 1;
    const current = entry;
    return {
      ids: current.ids,
      release() {
        current.refs -= 1;
        if (current.refs <= 0) {
          entries.delete(q);
          tracker.untrack(q);
        }
      },
    };
  }

  function update(batch: ReadonlyMap<string, MutationRecord<E, D>>): void {
    // The tracker mutates each affected member set in place and returns only the
    // queries that actually changed, so we push exactly those new id snapshots.
    for (const tracked of tracker.update(batch)) {
      entries.get(tracked.query)?.setIds([...tracked.members]);
    }
  }

  return { acquire, update };
}
