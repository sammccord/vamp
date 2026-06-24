import type { Archetype } from "./Archetype";
import type { Query } from "./Query";
import { MutationType } from "./types";

/**
 * A query whose matching entity-id set is kept current as mutations commit. The
 * `members` set is owned by the tracker and mutated in place by `update`.
 */
export interface TrackedQuery {
  readonly query: Query;
  readonly members: Set<string>;
}

/**
 * The minimal slice of an ECS world the membership tracker reads: the
 * entity → archetype index and a snapshot `query`. `ECS` satisfies this
 * structurally, so any world (or a test double) can be passed directly.
 */
export interface QueryMembershipWorld {
  readonly entityArchetype: ReadonlyMap<string, Archetype>;
  query(q: Query): Iterable<string>;
}

export interface QueryMembershipTracker {
  /**
   * Start tracking `query`, seeding its member set from the world's current
   * matches. Idempotent per `Query` reference — re-tracking returns the existing
   * {@link TrackedQuery}.
   */
  track(query: Query): TrackedQuery;
  /** Stop tracking `query` and drop its member set. */
  untrack(query: Query): void;
  /**
   * Apply a committed mutation batch: re-test ONLY the ids it touched against
   * every tracked query (via the O(1), non-mutating `query.tryAdd(archetype,
   * false)`) and update membership in place. Returns the tracked queries whose
   * membership actually changed, so a host can notify exactly those.
   *
   * This closes the gap a `subscribe(Q)` event system cannot: it also fires when
   * an entity transitions OUT of `Q` (its new archetype isn't in `Q`'s set, so
   * no event system keyed on `Q` would ever see it).
   */
  update(batch: ReadonlyMap<string, { readonly tag: MutationType }>): TrackedQuery[];
}

/**
 * Framework-agnostic per-query membership tracking, driven by committed mutation
 * batches rather than ECS event systems. UI bindings (Solid, React, Vue, …) wrap
 * this with their own reactivity; the diff logic lives here once.
 */
export function createQueryMembershipTracker(world: QueryMembershipWorld): QueryMembershipTracker {
  const tracked = new Map<Query, TrackedQuery>();

  function track(query: Query): TrackedQuery {
    let entry = tracked.get(query);
    if (!entry) {
      const members = new Set<string>();
      for (const id of world.query(query)) members.add(id);
      entry = { query, members };
      tracked.set(query, entry);
    }
    return entry;
  }

  function untrack(query: Query): void {
    tracked.delete(query);
  }

  function update(batch: ReadonlyMap<string, { readonly tag: MutationType }>): TrackedQuery[] {
    if (tracked.size === 0) return [];
    const changed: TrackedQuery[] = [];
    for (const entry of tracked.values()) {
      let didChange = false;
      for (const [id, record] of batch) {
        let member: boolean;
        if (record.tag === MutationType.Delete) {
          member = false;
        } else {
          const archetype = world.entityArchetype.get(id);
          member = archetype !== undefined && entry.query.tryAdd(archetype, false);
        }
        if (member) {
          if (!entry.members.has(id)) {
            entry.members.add(id);
            didChange = true;
          }
        } else if (entry.members.delete(id)) {
          didChange = true;
        }
      }
      if (didChange) changed.push(entry);
    }
    return changed;
  }

  return { track, untrack, update };
}
