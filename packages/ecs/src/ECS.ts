import { TypedFastBitSet } from "typedfastbitset";
import {
  type Archetype,
  createArchetype,
  transformArchetype,
  transformArchetypeTag,
  traverseArchetypeGraph,
} from "./Archetype";
import {
  EntityDeletedError,
  EntityNotExistError,
  EntityUndefinedError,
  WorldNotInitializedError,
} from "./Errors";
import { CustomAction } from "./Actions";
import { clonePlainValue } from "./clone";
import { type AccumulateDeltaFn, type MergeDeltaFn, MutationScope } from "./MutationScope";
import type { Query, QueryBuilder } from "./Query";
import { query } from "./Query";
import {
  type Behavior,
  type EventSystem,
  type LifecycleSystem,
  type System,
  SystemType,
} from "./System";
import type { ArrayDelta } from "./delta";
import {
  type BaseEntity,
  type EntityMutator,
  MutationRecord,
  MutationType,
  type WorldTypes,
} from "./types";

/** A tags delta: a replacement tag list, or the ArrayDelta set/add/remove form. */
type TagsDelta<Tags extends number> = Tags[] | ArrayDelta<Tags>;

/** Parse the `tags` field read off an opaque delta record into a {@link TagsDelta}. */
function isTagsDelta<Tags extends number>(value: unknown): value is TagsDelta<Tags> {
  return Array.isArray(value) || Object(value) === value;
}

/** Remove `item` from `list` if present. Idempotent, so a second unsubscribe is a no-op. */
function removeItem<T>(list: T[], item: T): void {
  const index = list.indexOf(item);
  if (index !== -1) list.splice(index, 1);
}

/** The world each registered query belongs to; a query's archetype set is per world. */
const queryOwners = new WeakMap<Query, object>();

export type EntityCallback = (entity: string, archetype: Archetype) => Promise<void>;

// Shared frozen empty array for behavior-cache misses. Iterating it with
// `for...of` is a no-op and allocates nothing, replacing the `|| []` idiom that
// allocated a throwaway empty array on every miss (the common case) in
// `act`/`actWithBubbling` (proposal 15 §4e).
const EMPTY_BEHAVIORS: readonly never[] = Object.freeze([]);

export interface ECSOptions<E extends BaseEntity, D> {
  createId: () => string;
  // Keyed by component name → component id. A plain string map so dynamic-key
  // reads (e.g. iterating a delta's keys in `upsert`) are sound without casts;
  // the generated options object still supplies one entry per real component.
  components: Record<string, number>;
  materializeDelta: (delta: D, base?: Partial<E>) => E;
  mergeDelta: MergeDeltaFn<E, D>;
  accumulateDelta: AccumulateDeltaFn<D>;
}

export type StateWithScope<C extends object, E extends BaseEntity, D> = C & {
  scope?: MutationScope<E, D>;
};

/** A coalesced set of mutations keyed by entity id (same shape the flush handler gets). */
export type MutationBatch<E extends BaseEntity, D> = Map<string, MutationRecord<E, D>>;

/**
 * Commits a coalesced batch to the authoritative store. `scope` is the scope
 * being committed, or `undefined` for a mutation made outside any scope (which
 * commits on its own as a one-entry batch).
 */
export type FlushHandler<E, D> = (
  mutations: Map<string, MutationRecord<E, D>>,
  scope: MutationScope<E, D> | undefined,
) => void;

/**
 * A remote observer of committed mutations (interest-managed broadcast). The game
 * supplies `interested` (its subjective area-of-interest policy) and `deliver`
 * (push the filtered batch to a transport, e.g. a framed `ws.send`). Both are
 * called by {@link ECS.routeMutations} after a scope commits.
 *
 * This is the per-observer routing mechanism that sits beside `setFlushHandler`:
 * the flush handler is the single authoritative write, mutation observers are the
 * many filtered readers. Both consume the same coalesced `Map<id, MutationRecord>`.
 */
export interface MutationObserver<W extends WorldTypes = WorldTypes> {
  /**
   * Is this single committed mutation relevant to this observer? Called once per
   * (observer × mutation) per routed flush. Close over the observer's
   * per-connection interest state (its viewer entity id, last-known position,
   * room…). Keep it cheap; back it with the game's own spatial index for O(1)
   * when scaling.
   *
   * For DELETE mutations the entity is already gone from the world, so read its
   * last state from `mutation.value.entity`, NOT from `world.entity(id)`.
   *
   * MUST be read-only: routing runs in the commit tail, so neither `interested`
   * nor `deliver` may mutate the world.
   */
  interested(
    entityId: string,
    mutation: MutationRecord<W["entity"], W["delta"]>,
    world: ECS<W>,
  ): boolean;

  /** Deliver the non-empty interested subset. Called at most once per routed flush. */
  deliver(batch: MutationBatch<W["entity"], W["delta"]>): void;
}

/**
 * The core Entity-Component-System world.
 *
 * The generic parameters are a deliberate, stable part of the public API and are
 * NOT reducible to plain strings: entities are addressed by string id internally,
 * but consumers parametrize the world with their own `State`, `UpdateArguments`,
 * `Actions`, `Tags`, entity (`E`) and delta (`D`) types so that systems,
 * behaviors, queries and mutations are statically type-checked against the
 * consumer's domain model. Treat this signature as locked; downstream packages
 * depend on it.
 *
 * @typeParam State - Per-world context object (carries the active mutation scope).
 * @typeParam UpdateArguments - Extra arguments threaded into every `update()` call.
 * @typeParam Actions - The action union dispatched via `act`/`actWithBubbling`.
 * @typeParam Tags - Numeric tag id space for tag archetypes.
 * @typeParam E - The consumer's entity shape (must extend {@link BaseEntity}).
 * @typeParam D - The delta shape used by `put`/`upsert` and mutation coalescing.
 */
export class ECS<W extends WorldTypes = WorldTypes> {
  protected readonly rootArchetype: Archetype = createArchetype(
    "root",
    new TypedFastBitSet(),
    new TypedFastBitSet(),
  );
  // Per-ECS id -> Archetype index. Lets transformArchetype/transformArchetypeTag
  // resolve a novel archetype with an O(1) Map lookup instead of an O(n)
  // traverseArchetypeGraph rescan (proposal 15). Owned per-instance so multiple
  // ECS worlds in one isolate never cross-contaminate. Seeded with the root
  // archetype so the very first transform off the root resolves consistently.
  private readonly _archetypeIndex = new Map<string, Archetype>([
    [this.rootArchetype.id, this.rootArchetype],
  ]);
  private readonly _archetypeOf = new Map<string, Archetype>();
  private readonly _deletedEntities = new Set<string>();
  private readonly _systems: System<W>[] = [];
  private readonly _subscriptions: EventSystem[] = [];
  private readonly _behaviors = new Map<number, Behavior<W>[]>();
  private readonly _entityBehaviorCache = new Map<string, Map<number, Behavior<W>[]>>();
  // Cache behaviors at the archetype level to avoid redundant query evaluation
  private readonly archetypeBehaviorCache = new Map<Archetype, Map<number, Behavior<W>[]>>();
  // Defer cache rebuilding until end of update cycle
  private readonly _deferredCacheRebuilds = new Set<string>();
  // Cache `upsert`/`query(q => q.every(...))` shapes by their sorted component-id
  // key so repeated upserts of the same shape reuse one Query instead of
  // building a fresh QueryBuilder and re-traversing the whole archetype graph
  // each call (proposal 15 §4d). Cached queries are kept current by
  // `_tryAddArchetypeToQueries` as new archetypes appear.
  private readonly _queryCache = new Map<string, Query>();
  // Per-entity-system scratch buffer, refilled in place each frame instead of
  // spreading `[...arch.entities]` into a fresh array per archetype per frame
  // (proposal 15 §4b). The buffer is TRANSIENT: it is valid only for the single
  // `system.execute(...)` call it is passed to and is reused on the next call,
  // so a system MUST NOT retain it past the call. `query()` never returns this
  // buffer (it owns a fresh array), so the no-escape invariant from proposal 07
  // is preserved. Keyed by system so each per-entity system gets its own.
  private readonly _systemScratch = new WeakMap<System<W>, string[]>();
  private readonly _handleCreate: LifecycleSystem[] = [];
  private readonly _handleDelete: LifecycleSystem[] = [];
  private readonly _deferred: (() => void)[] = [];

  /** Each live entity's current archetype. */
  get entityArchetype(): ReadonlyMap<string, Archetype> {
    return this._archetypeOf;
  }

  /** Registered per-update systems, in run order. */
  get systems(): ReadonlyArray<System<W>> {
    return this._systems;
  }

  /** Registered behaviors keyed by action tag, highest priority first. */
  get behaviors(): ReadonlyMap<number, ReadonlyArray<Behavior<W>>> {
    return this._behaviors;
  }

  private _initialized = false;
  public get initialized() {
    return this._initialized;
  }

  private _scopeOpenCallbacks = new Set<(scope: MutationScope<W["entity"], W["delta"]>) => void>();
  private _flushHandler: FlushHandler<W["entity"], W["delta"]> | null = null;
  // Interest-managed broadcast registry. Per-world (per DO): not a module global,
  // so colocated worlds never cross-feed. Holds the remote observers that
  // `routeMutations` fans committed batches out to.
  private readonly _observers = new Set<MutationObserver<W>>();

  /**
   * Register a mutation observer for interest-managed broadcast. Returns an
   * unsubscribe function. Per-world (per DO). See {@link MutationObserver}.
   */
  observeMutations(observer: MutationObserver<W>): () => void {
    this._observers.add(observer);
    return () => {
      this._observers.delete(observer);
    };
  }

  /** Number of registered mutation observers (e.g. to gate work when zero). */
  get observerCount(): number {
    return this._observers.size;
  }

  /**
   * Route a committed batch to every interested observer. Builds a per-observer
   * subset via `interested` and calls `deliver` only when the subset is non-empty
   * (so an uninterested observer pays no send). O(observers × mutations) predicate
   * evaluations; zero cost when no observers are registered.
   *
   * Called automatically on every outermost-scope commit (see {@link withScope}),
   * after the authoritative flush, so observers never see uncommitted state.
   * Also public as an escape hatch for apps that route only certain scopes.
   */
  routeMutations(mutations: MutationBatch<W["entity"], W["delta"]>): void {
    const observers = this._observers;
    if (observers.size === 0 || mutations.size === 0) return;
    for (const observer of observers) {
      const interested: string[] = [];
      for (const [id, mutation] of mutations) {
        if (observer.interested(id, mutation, this)) interested.push(id);
      }
      if (interested.length === 0) continue;
      // An observer that wants everything gets the batch itself, so observers
      // can share work keyed on it (e.g. encode once per commit, not per socket).
      if (interested.length === mutations.size) {
        observer.deliver(mutations);
        continue;
      }
      const batch: MutationBatch<W["entity"], W["delta"]> = new Map();
      for (const id of interested) batch.set(id, mutations.get(id)!);
      observer.deliver(batch);
    }
  }

  /**
   * Build insert-mutations for every entity matching `predicate`. Use for the
   * initial interest-filtered snapshot an `observe` RPC yields first, and for
   * re-sync frames when a viewer's interest set changes.
   */
  snapshotMutations(
    predicate: (id: string, entity: W["entity"]) => boolean,
  ): MutationBatch<W["entity"], W["delta"]> {
    const batch: MutationBatch<W["entity"], W["delta"]> = new Map();
    for (const [id, entity] of this._entities) {
      if (predicate(id, entity))
        batch.set(id, MutationRecord.fromInsert<W["entity"], W["delta"]>({ entity }));
    }
    return batch;
  }

  /**
   * Ingest a coalesced batch of mutations into this world — the inverse of
   * {@link snapshotMutations}/{@link routeMutations}. Each record is dispatched
   * through the public, archetype-aware ops so queries/systems stay consistent:
   * Insert replaces any existing entity (so a re-sync snapshot is authoritative),
   * Update applies its delta via `put` (running the configured additive
   * `mergeDelta`), Delete removes the entity.
   *
   * This is the consumer-side counterpart to the producer/broadcast pair: a
   * remote replica (e.g. a UI client draining an `observe` stream, or a DO
   * rehydrating from persisted batches) applies what the server snapshotted and
   * routed. Call inside {@link withScope} to coalesce the batch into one commit
   * and capture the committed result. Does not itself open a scope, so it
   * composes inside an existing one.
   */
  applyMutations(mutations: MutationBatch<W["entity"], W["delta"]>): void {
    for (const [id, record] of mutations) {
      switch (record.tag) {
        case MutationType.Insert:
          if (this.hasEntity(id)) this.replace(id, record.value.entity);
          else this.insert({ ...record.value.entity, id });
          break;
        case MutationType.Update:
          this.put(id, record.value.delta);
          break;
        case MutationType.Delete:
          this.delete(id);
          break;
      }
    }
  }

  /**
   * Register a callback invoked when a mutation scope is opened (before the scope function runs).
   * Returns an unsubscribe function.
   */
  onScopeOpen(cb: (scope: MutationScope<W["entity"], W["delta"]>) => void): () => void {
    this._scopeOpenCallbacks.add(cb);
    return () => this._scopeOpenCallbacks.delete(cb);
  }

  /**
   * Set a handler that replaces the default per-mutation flush loop.
   * The handler receives all coalesced mutations from the scope and is responsible for
   * applying them (to entities, Yjs, etc.). Pass `null` to restore default behavior.
   */
  setFlushHandler(handler: FlushHandler<W["entity"], W["delta"]> | null): void {
    this._flushHandler = handler;
  }

  // Upper bound on the recently-deleted id ring. `deletedEntities` exists only
  // to power the EntityDeletedError vs EntityNotExistError diagnostic; recent
  // ids still report "deleted", older ones degrade to "does not exist". Bounding
  // it prevents unbounded growth under per-frame spawn/despawn churn.
  private static readonly DELETED_RING_CAP = 1024;

  public readonly context: StateWithScope<W["state"], W["entity"], W["delta"]>;
  protected readonly _entities: Map<string, W["entity"]>;
  protected readonly _baseMutate: EntityMutator<W["entity"], W["delta"]>;
  protected readonly _mutate: EntityMutator<W["entity"], W["delta"]>;
  protected readonly options: ECSOptions<W["entity"], W["delta"]>;

  constructor(
    entities: Map<string, W["entity"]>,
    mutate: EntityMutator<W["entity"], W["delta"]>,
    context: W["state"],
    options: ECSOptions<W["entity"], W["delta"]>,
  ) {
    this._entities = entities;
    this._baseMutate = mutate;
    this._mutate = this._wrapMutator(mutate);
    this.options = options;
    this.context = context;
  }

  private _wrapMutator(
    baseMutate: EntityMutator<W["entity"], W["delta"]>,
  ): EntityMutator<W["entity"], W["delta"]> {
    return (id: string, mutation: MutationRecord<W["entity"], W["delta"]>) => {
      if (this.initialized) {
        const scope = this.context.scope;
        if (scope === undefined && this._flushHandler) {
          // No scope open: commit this mutation on its own, through the same
          // flush + broadcast path a scope commit takes.
          const batch: MutationBatch<W["entity"], W["delta"]> = new Map([[id, mutation]]);
          this._flushHandler(batch, undefined);
          this.routeMutations(batch);
          return;
        }

        if (scope) {
          switch (mutation.tag) {
            case MutationType.Insert:
              scope.insert(id, mutation.value.entity);
              break;
            case MutationType.Update:
              scope.update(id, mutation.value.delta);
              break;
            case MutationType.Delete:
              scope.delete(id, mutation.value.entity);
              break;
          }

          // Defer base mutator call until scope completes
          return;
        }
      }

      // No scope active - call base mutator immediately
      baseMutate(id, mutation);
    };
  }

  /**
   * Read an entity by id, or `undefined` if it does not exist. Inside an open
   * mutation scope this returns the scope's shadow copy — so reads observe
   * staged, not-yet-committed writes — and `undefined` if it was deleted in the
   * scope.
   */
  public entity(id: string): W["entity"] | undefined {
    const scope = this.context.scope;
    if (scope === undefined) return this._entities.get(id);
    return this._scopedEntity(scope, id) ?? undefined;
  }

  /**
   * `id` as `scope` sees it: its shadow if it has one, `null` if deleted in the
   * scope chain, else the parent's view (or the store) with this scope's pending
   * delta applied. That merged copy is cached as the shadow, so later updates in
   * the scope merge into it too.
   */
  private _scopedEntity(
    scope: MutationScope<W["entity"], W["delta"]>,
    id: string,
  ): W["entity"] | undefined | null {
    const shadow = scope.getShadowEntity(id);
    if (shadow !== undefined) return shadow;
    const base = scope.parent ? this._scopedEntity(scope.parent, id) : this._entities.get(id);
    if (!base) return base;
    const pending = scope.mutations.get(id);
    if (pending?.tag !== MutationType.Update) return base;
    const merged = clonePlainValue(base);
    this.options.mergeDelta(merged, pending.value.delta);
    scope.shadowEntities.set(id, merged);
    return merged;
  }

  /** Live `Map<id, entity>` of all committed entities. Treat as read-only. */
  public get entities() {
    return this._entities;
  }

  /**
   * Find the first entity matching `filter` among those carrying every component
   * present in `delta`, then apply `delta` to it via {@link put}; if none match,
   * {@link insert} a new entity materialized from `delta`. Repeated calls with the
   * same component shape reuse a cached query.
   */
  public upsert(
    delta: W["delta"],
    filter: (e: W["entity"] | undefined, i: number, obj: string[]) => boolean,
  ): W["entity"] {
    const components: number[] = [];
    for (const component in delta) {
      if (delta[component] === undefined) continue;
      // Skip keys that aren't real components (e.g. `tags`, or a stray delta key);
      // pushing an `undefined` id here would corrupt the query/cache key downstream.
      if (!(component in this.options.components)) continue;
      components.push(this.options.components[component]);
    }
    // Before initialization, novel archetypes are not propagated to any query
    // (initialize() does the full sweep), so a cached query could be stale.
    // Fall back to a fresh full traversal in that rare path to preserve the old
    // "always see all archetypes" behavior.
    let matched: string[];
    if (this.initialized) {
      // Reuse a cached Query keyed by the sorted component-id list so repeated
      // upserts of the same shape don't rebuild a QueryBuilder + matcher chain
      // each call. The cached query's `archetypes` set is kept current by
      // `_tryAddArchetypeToQueries`, so we read it directly instead of
      // re-traversing the whole archetype graph.
      const key = components
        .slice()
        .sort((a, b) => a - b)
        .join(",");
      let q = this._queryCache.get(key);
      if (q === undefined) {
        q = query((b) => b.every(...components));
        // Seed the freshly-cached query with every archetype that already
        // exists; subsequent novel archetypes are propagated via
        // _tryAddArchetypeToQueries.
        traverseArchetypeGraph(this.rootArchetype, (archetype) => {
          q!.tryAdd(archetype);
        });
        this._queryCache.set(key, q);
      }
      // Build the matched-id array (same membership/order as `query(q)`) so the
      // caller's `filter` still receives the full (e, i, obj) signature.
      matched = this._collectQueryEntities(q);
    } else {
      matched = this.query((q) => q.every(...components));
    }

    const entity = matched.find((e, i, obj) => filter(this.entity(e), i, obj));
    if (entity === undefined) return this.insert(this.options.materializeDelta(delta));
    return this.put(entity, delta);
  }

  /**
   * Collect every entity id from the archetypes a (kept-current) Query already
   * matches, in the same reverse-archetype order `query()` uses. Used by
   * `upsert` to avoid re-traversing the whole archetype graph per call.
   */
  private _collectQueryEntities(q: Query): string[] {
    // Match query()'s iteration order exactly: collect archetypes forward, then
    // emit entities in reverse-archetype order. Preserves `find()` first-match
    // semantics for upsert callers.
    const archetypes: Archetype[] = [];
    let total = 0;
    for (const arch of q.archetypes) {
      archetypes.push(arch);
      total += arch.entities.size;
    }
    const entities = new Array<string>(total);
    let i = 0;
    for (let a = archetypes.length - 1; a >= 0; a--) {
      for (const entity of archetypes[a].entities) entities[i++] = entity;
    }
    return entities;
  }

  /**
   * Insert a new entity. If `entity.id` is unset a fresh id is generated and a
   * copy is committed (the caller's object is never mutated); the committed entity
   * is returned. The insert mutation is recorded before create/event systems fire
   * so observers never see a torn read.
   */
  public insert(entity: W["entity"]): W["entity"] {
    if (entity.id && this._archetypeOf.has(entity.id)) return this.replace(entity.id, entity);
    // An empty id (e.g. a materialized delta's default) means "generate one".
    const id = this._createEntity(undefined, entity.id || undefined, false);
    // Work on a copy when we had to generate an id, so we never mutate the
    // caller's object. The caller gets the id via the returned `committed`.
    const committed: W["entity"] = entity.id ? entity : { ...entity, id };
    // Record the insert mutation FIRST so observers (event/lifecycle systems
    // fired below) never see a state where the archetype already has the
    // component but the entity's data has not yet been committed — a torn read.
    this._mutate(id, MutationRecord.fromInsert<W["entity"], W["delta"]>({ entity: committed }));
    for (const component in committed) {
      if (component === "tags") continue;
      if (committed[component] === undefined) continue;
      this._addComponent(id, component, false);
    }
    if (committed.tags) {
      for (const tag of committed.tags) {
        this._addTag(id, tag);
      }
    }
    this._notify(id);
    this._runCreateSystems(id);
    return committed;
  }

  /**
   * Overwrite an existing entity with a full snapshot, keeping its id. Components
   * absent from `entity` are removed and present ones added, so archetype
   * membership follows the snapshot. Unlike delete + insert, no delete/create
   * lifecycle systems fire. Falls back to {@link insert} for an unknown id.
   */
  public replace(id: string, entity: W["entity"]): W["entity"] {
    if (!this.hasEntity(id)) return this.insert({ ...entity, id });
    const committed: W["entity"] = entity.id === id ? entity : { ...entity, id };
    this._mutate(id, MutationRecord.fromInsert<W["entity"], W["delta"]>({ entity: committed }));
    for (const name in this.options.components) {
      // SAFETY: `options.components` is keyed by entity field names.
      if (committed[name as keyof W["entity"]] === undefined)
        this._removeComponent(id, name, false);
      else this._addComponent(id, name, false);
    }
    this._reconcileTags(id, committed.tags ?? []);
    this._notify(id);
    return committed;
  }

  /**
   * Patch the entity `id` with `delta` and return it as it is after the change.
   * An unknown or missing id inserts a new entity materialized from `delta`.
   * Keys whose value is `undefined` are ignored; use {@link removeComponents}
   * to remove a component.
   */
  public put(id: string | undefined, delta: W["delta"]): W["entity"] {
    if (!id) return this.insert(this.options.materializeDelta(delta));
    const entity = this.entity(id);
    if (!entity || entity.id !== id) {
      // SAFETY: BaseEntity carries `id?: string`, so `{ id }` is a valid Partial<W["entity"]>.
      return this.insert(this.options.materializeDelta(delta, { id } as Partial<W["entity"]>));
    }
    let added = false;
    for (const component in delta) {
      if (component === "tags" || delta[component] === undefined) continue;
      // SAFETY: delta keys are entity field names (the delta record `W["delta"]` mirrors
      // `W["entity"]` field by field), so each non-"tags" delta key is a key of `W["entity"]`.
      if (entity[component as keyof W["entity"]] === undefined) {
        this._addComponent(id, component, false);
        added = true;
      }
    }
    // SAFETY: `delta` is the consumer's delta record (`W["delta"]`), an object keyed by
    // field name; this reads its optional `tags` field, the one delta key handled
    // outside the component loop above. `isTagsDelta` parses it before use.
    const tagsDelta = (delta as { tags?: unknown }).tags;
    const retagged = isTagsDelta<W["tags"]>(tagsDelta) && this._reconcileTags(id, tagsDelta);

    this._mutate(id, MutationRecord.fromUpdate<W["entity"], W["delta"]>({ delta }));
    if (added || retagged) this._notify(id);
    return this.entity(id) ?? entity;
  }

  /**
   * Remove components (fields) from the entity `id` and return it as it is
   * after the change. Recorded as a full snapshot, since a delta cannot carry a
   * removal over the wire.
   */
  public removeComponents(
    id: string,
    ...components: Array<keyof W["entity"] & string>
  ): W["entity"] | undefined {
    const entity = this.entity(id);
    if (!entity) return undefined;
    const next: W["entity"] = { ...entity };
    let changed = false;
    for (const component of components) {
      if (component === "id" || next[component] === undefined) continue;
      delete next[component];
      changed = true;
    }
    return changed ? this.replace(id, next) : entity;
  }

  /**
   * Delete the entity `id`, recording a delete mutation. Returns its last
   * state, or `undefined` if it does not exist.
   */
  public delete(id: string): W["entity"] | undefined {
    const entity = this.entity(id);
    if (entity === undefined) return undefined;
    this._mutate(id, MutationRecord.fromDelete<W["entity"], W["delta"]>({ entity }));
    this._deleteEntity(id);
    return entity;
  }

  /**
   * Return the ids of every entity matching the query — either a {@link Query} or
   * a builder callback, e.g. `query((q) => q.every(A, B).someTag(T))`. The result
   * is a fresh array owned by the caller (never a recycled/pooled buffer).
   *
   * Cost note: every call re-walks the full archetype graph and allocates the
   * result array. For a query evaluated every frame, register a system
   * ({@link registerSystem}) or a membership tracker
   * ({@link createQueryMembershipTracker}) instead — both maintain their match
   * set incrementally as archetypes appear.
   */
  public query(_query: Query | ((builder: QueryBuilder) => QueryBuilder)): string[] {
    const q = _query instanceof Function ? query(_query) : _query;
    const archetypes: Archetype[] = [];
    traverseArchetypeGraph(this.rootArchetype, (archetype) => {
      if (q.tryAdd(archetype, false)) archetypes.push(archetype);
    });

    // Pre-calculate total entity count to avoid array growth
    let totalEntities = 0;
    for (let a = 0; a < archetypes.length; a++) {
      totalEntities += archetypes[a].entities.size;
    }

    // Private array returned to the caller. Must NOT be a pooled/shared buffer:
    // callers may retain the result, so it cannot be recycled underfoot.
    const entities = new Array<string>(totalEntities);
    let entityIndex = 0;

    // reverse iterating in case a system adds/removes component resulting in new archetype that matches query for the system
    for (let a = archetypes.length - 1; a >= 0; a--) {
      const arch = archetypes[a];
      // Direct iteration over Set is faster than spreading
      for (const entity of arch.entities) {
        entities[entityIndex++] = entity;
      }
    }
    return entities;
  }

  /**
   * Register an event {@link System} that runs whenever a matching entity
   * changes. Pass `emit:true` to also run it once immediately over current
   * matches. Returns an unsubscribe function.
   */
  public subscribe(system: EventSystem, emit = false): () => void {
    this._claimQuery(system.query);
    this._subscriptions.push(system);

    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        system.query.tryAdd(archetype);
        return true;
      });
    }

    if (emit) {
      this._executeEventSystem(system);
    }

    return () => removeItem(this._subscriptions, system);
  }

  /** Register a lifecycle system run when a matching entity is created. Returns an unsubscribe function. */
  public onCreate(system: LifecycleSystem) {
    this._claimQuery(system.query);
    this._handleCreate.push(system);
    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        system.query.tryAdd(archetype);
        return true;
      });
    }
    return () => removeItem(this._handleCreate, system);
  }

  /** Register a lifecycle system run when a matching entity is deleted. Returns an unsubscribe function. */
  public onDelete(system: LifecycleSystem) {
    this._claimQuery(system.query);
    this._handleDelete.push(system);
    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        system.query.tryAdd(archetype);
        return true;
      });
    }
    return () => removeItem(this._handleDelete, system);
  }

  /** Bind `query` to this world; its archetype set cannot be shared across worlds. */
  private _claimQuery(query: Query): void {
    const owner = queryOwners.get(query);
    if (owner !== undefined && owner !== this) {
      throw new Error(
        "This query is already registered with another ECS world. A query collects one world's archetypes; build a separate system or query per world.",
      );
    }
    queryOwners.set(query, this);
  }

  /**
   * Notify every event system whose query matches `archetype` that `entity`
   * changed. Each system receives only the changed id, so a change costs
   * O(subscribers), not O(matching entities).
   */
  private _executeEventSystems(archetype: Archetype, entity: string) {
    const systems = this._subscriptions;
    for (let s = 0, sl = systems.length; s < sl; s++) {
      const system = systems[s];
      // A fresh array per call: execute() may re-enter this path synchronously.
      if (system.query.archetypes.has(archetype)) system.execute([entity]);
    }
  }

  /** Run `sys` once over every entity it currently matches. */
  private _executeEventSystem(sys: EventSystem) {
    const entities: string[] = [];
    for (const arch of sys.query.archetypes)
      for (const entity of arch.entities) entities.push(entity);
    sys.execute(entities);
  }

  /**
   * Run and clear the deferred queue. Actions deferred while it runs wait for
   * the next update. Every action runs once even if an earlier one throws; the
   * first error is rethrown after the queue drains.
   */
  private _executeDeferred() {
    if (this._deferred.length === 0) return;
    const actions = this._deferred.splice(0);
    let failure: { error: unknown } | undefined;
    for (const action of actions) {
      try {
        action();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  private _executeDeferredCacheRebuilds() {
    if (this._deferredCacheRebuilds.size === 0) return;
    for (const entityId of this._deferredCacheRebuilds) {
      this._rebuildBehaviorCache(entityId);
    }
    this._deferredCacheRebuilds.clear();
  }

  private _tryAddArchetypeToQueries(archetype: Archetype) {
    // Iterate every registered query collection in place: no intermediate
    // arrays (the old `[...a, ...b, ...Array.from(...).flat()]` allocated four
    // throwaway arrays on every novel archetype, a hot gameplay path).
    const {
      _systems: systems,
      _subscriptions: subscriptions,
      _handleCreate: handleCreate,
      _handleDelete: handleDelete,
    } = this;
    for (let i = 0, l = systems.length; i < l; i++) systems[i].query.tryAdd(archetype);
    for (let i = 0, l = subscriptions.length; i < l; i++) subscriptions[i].query.tryAdd(archetype);
    for (let i = 0, l = handleCreate.length; i < l; i++) handleCreate[i].query.tryAdd(archetype);
    for (let i = 0, l = handleDelete.length; i < l; i++) handleDelete[i].query.tryAdd(archetype);
    for (const list of this._behaviors.values())
      for (let i = 0, l = list.length; i < l; i++) list[i].query.tryAdd(archetype);
    // Keep cached upsert/query shapes current as new archetypes appear; without
    // this a cached query would silently miss entities in archetypes created
    // after the cache entry (a correctness regression, proposal 15 §6).
    for (const q of this._queryCache.values()) q.tryAdd(archetype);
  }

  private _assertEntity(entity: string) {
    if (!this._archetypeOf.has(entity)) {
      if (entity === undefined) {
        throw new EntityUndefinedError();
      } else if (this._deletedEntities.has(entity)) {
        throw new EntityDeletedError(entity);
      }
      throw new EntityNotExistError(entity);
    }
  }

  /** Remember `id`'s archetype before the active scope first moves it. */
  private _recordArchetype(id: string): void {
    const scope = this.context.scope;
    if (scope && !scope.archetypeUndo.has(id)) {
      scope.archetypeUndo.set(id, this._archetypeOf.get(id) ?? null);
    }
  }

  /** Put every entity an aborted scope moved back where it was. */
  private _rollbackArchetypes(scope: MutationScope<W["entity"], W["delta"]>): void {
    for (const [id, prev] of scope.archetypeUndo) {
      const current = this._archetypeOf.get(id);
      if (current === (prev ?? undefined)) continue;
      current?.entities.delete(id);
      if (prev) {
        prev.entities.add(id);
        this._archetypeOf.set(id, prev);
        this._deletedEntities.delete(id);
        this._deferredCacheRebuilds.add(id);
      } else {
        this._archetypeOf.delete(id);
        this._entityBehaviorCache.delete(id);
        this._deferredCacheRebuilds.delete(id);
      }
    }
  }

  private _transformEntityForComponent(
    current: Archetype,
    entity: string,
    componentId: number,
  ): Archetype {
    this._recordArchetype(entity);
    current.entities.delete(entity);

    const adjacent = current.adjacent.get(componentId);
    if (adjacent !== undefined) {
      current = adjacent;
    } else {
      current = transformArchetype(current, componentId, this._archetypeIndex);
      if (this.initialized) {
        this._tryAddArchetypeToQueries(current);
      }
    }

    current.entities.add(entity);
    this._archetypeOf.set(entity, current);
    return current;
  }

  private _transformEntityForTag(current: Archetype, entity: string, tagId: number): Archetype {
    this._recordArchetype(entity);
    current.entities.delete(entity);

    const tagAdjacent = current.tagAdjacent.get(tagId);
    if (tagAdjacent !== undefined) {
      current = tagAdjacent;
    } else {
      current = transformArchetypeTag(current, tagId, this._archetypeIndex);
      if (this.initialized) {
        this._tryAddArchetypeToQueries(current);
      }
    }

    current.entities.add(entity);
    this._archetypeOf.set(entity, current);
    return current;
  }

  /** Move `id` to the archetype for its new tag set; returns whether it moved. */
  private _reconcileTags(id: string, tagsDelta: TagsDelta<W["tags"]>): boolean {
    const archetype = this._archetypeOf.get(id);
    if (!archetype) return false;
    // SAFETY: an archetype's tag bits are only ever set from `W["tags"]` values
    // (addTag/removeTag/_reconcileTags all take `W["tags"]`), so every set bit is a `W["tags"]`.
    const currentTags = archetype.tagMask.array() as W["tags"][];
    let targetTags: W["tags"][];

    if (Array.isArray(tagsDelta)) {
      targetTags = tagsDelta;
    } else {
      const d = tagsDelta;
      if (d.set !== undefined) {
        targetTags = d.set;
      } else {
        // Apply additions first, then removals, against a working copy of the
        // current tags. `remove` must filter the post-`add` array (not the
        // original `currentTags` snapshot) so a combined { add, remove } delta
        // composes correctly; otherwise the added tags are silently dropped.
        targetTags = [...currentTags];
        if (d.add)
          for (const t of d.add) {
            if (!targetTags.includes(t)) targetTags.push(t);
          }
        if (d.remove) targetTags = targetTags.filter((t) => !d.remove!.includes(t));
      }
    }

    for (const tag of currentTags) {
      if (!targetTags.includes(tag)) this._removeTag(id, tag);
    }
    for (const tag of targetTags) {
      if (!currentTags.includes(tag)) this._addTag(id, tag);
    }
    return this._archetypeOf.get(id) !== archetype;
  }

  /**
   * Provide a known combination of `componentIds` constituting an archetype.
   * The component ids can be of your choosing, but be carefull not to use the same id for different components.
   * You should either create all `componentIds` using `createComponentId` first and use the created component ids in the prefacbricate,
   * Or make all of you prefabricates before creating new component ids using `createComponentId`
   */
  prefabricate(components: number[], tags: number[] = []): Archetype {
    let archetype = this.rootArchetype;

    for (let i = 0, l = components.length; i < l; i++) {
      const componentId = components[i];

      const adjacent = archetype.adjacent.get(componentId);
      if (adjacent !== undefined) {
        archetype = adjacent;
      } else {
        archetype = transformArchetype(archetype, componentId, this._archetypeIndex);
        if (this.initialized) {
          this._tryAddArchetypeToQueries(archetype);
        }
      }
    }

    for (let i = 0, l = tags.length; i < l; i++) {
      const tagId = tags[i];

      const tagAdjacent = archetype.tagAdjacent.get(tagId);
      if (tagAdjacent !== undefined) {
        archetype = tagAdjacent;
      } else {
        archetype = transformArchetypeTag(archetype, tagId, this._archetypeIndex);
        if (this.initialized) {
          this._tryAddArchetypeToQueries(archetype);
        }
      }
    }

    return archetype;
  }

  /**
   * Registers a system to be executed for each update cycle.
   * Use the `createEntitySystem` or `createArchetypeSystem` helpers to create the system.
   * A system may not be executed if it's `Query` does not match any `Archetype`s.
   */
  registerSystem(system: System<W>) {
    this._claimQuery(system.query);
    this._systems.push(system);

    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        system.query.tryAdd(archetype);
        return true;
      });
    }

    return () => removeItem(this._systems, system);
  }

  // Register a behavior (system) for a specific event type
  /**
   * Register an event-driven {@link Behavior}, keyed by its action tag and run by
   * {@link act}. Use the `createBehavior` helper to build one. Registering after
   * {@link initialize} invalidates the behavior caches so the new behavior is
   * picked up by already-seen archetypes. Returns an unsubscribe function.
   */
  registerBehavior(behavior: Behavior<W>): () => void {
    this._claimQuery(behavior.query);
    if (!this._behaviors.has(behavior.tag)) {
      this._behaviors.set(behavior.tag, []);
    }

    const behaviors = this._behaviors.get(behavior.tag)!;
    behaviors.push(behavior);

    // Sort by priority (higher first)
    behaviors.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        behavior.query.tryAdd(archetype);
        return true;
      });
      // A new behavior invalidates every derived behavior cache. Clear the
      // shared archetype cache and rebuild per-entity caches so the new behavior
      // is picked up by act()/actWithBubbling without a manual rebuild call.
      // registerBehavior is a setup/feature-load operation, not a per-frame one,
      // so the O(entities) rebuild here is acceptable.
      this.archetypeBehaviorCache.clear();
      this.rebuildAllBehaviorCaches();
    }
    return () => this._unregisterBehavior(behavior);
  }

  private _unregisterBehavior(behavior: Behavior<W>): void {
    const list = this._behaviors.get(behavior.tag);
    if (!list || list.indexOf(behavior) === -1) return;
    removeItem(list, behavior);
    if (list.length === 0) this._behaviors.delete(behavior.tag);
    if (this.initialized) {
      this.archetypeBehaviorCache.clear();
      this.rebuildAllBehaviorCaches();
    }
  }

  private rebuildAllBehaviorCaches(): void {
    for (const entityId of this.entities.keys()) {
      this._rebuildBehaviorCache(entityId);
    }
  }

  // Rebuild behavior cache for a specific entity - O(a * b * q) where a = archetypes, b = behaviors, q = query complexity
  // Now uses archetype-level caching, so each archetype is only evaluated once
  private _rebuildBehaviorCache(entityId: string): void {
    // Keyed on archetype membership, not the committed store, so an entity
    // inserted in the open scope gets its behaviors immediately.
    const entityArchetype = this._archetypeOf.get(entityId);
    if (!entityArchetype) return;

    // Check if we've already computed behaviors for this archetype
    let cache = this.archetypeBehaviorCache.get(entityArchetype);

    if (!cache) {
      // Compute once per archetype, not once per entity
      cache = new Map<number, Behavior<W>[]>();

      // For each event type
      for (const [eventType, behaviors] of this._behaviors) {
        const applicable: Behavior<W>[] = [];

        // Check each behavior
        for (const behavior of behaviors) {
          // Does archetype have all required components?
          const hasAllComponents = behavior.query.tryAdd(entityArchetype, false);

          if (hasAllComponents) {
            applicable.push(behavior);
          }
        }

        if (applicable.length > 0) {
          cache.set(eventType, applicable);
        }
      }

      // Cache at archetype level for reuse
      this.archetypeBehaviorCache.set(entityArchetype, cache);
    }

    // Just reference the archetype cache
    this._entityBehaviorCache.set(entityId, cache);
  }

  /**
   * Initialize the world, must be done before the first update.
   * Subsequent calls to initialize will be voided.
   */
  initialize() {
    if (this.initialized) return;
    this._initialized = true;

    traverseArchetypeGraph(this.rootArchetype, (arch) => this._tryAddArchetypeToQueries(arch));
    // Rebuild cache for all entities
    this.rebuildAllBehaviorCaches();
  }

  /**
   * Update the world, executing all registered systems with queries matching 1 or more `Archetype`.
   * Typically you want to call `update` on each animation frame (`window.requestAnimationFrame`).
   * @throws {WorldNotInitializedError} if `initialized` has not been called
   */
  update(...args: W["args"]) {
    if (!this.initialized) throw new WorldNotInitializedError();
    const systems = this._systems;
    for (let s = 0, sl = systems.length; s < sl; s++) {
      const system = systems[s];
      const archetypes = system.query.archetypes;
      if (system.type === SystemType.Archetype) {
        system.execute(archetypes, this, ...args);
      }
      if (system.type === SystemType.Entity) {
        // Snapshot every match before executing, so an entity the system moves
        // into another matching archetype is not processed twice. The scratch
        // buffer is reused per system and valid only for this execute call.
        let buf = this._systemScratch.get(system);
        if (buf === undefined) {
          buf = [];
          this._systemScratch.set(system, buf);
        }
        let i = 0;
        for (const arch of archetypes) for (const entity of arch.entities) buf[i++] = entity;
        buf.length = i;
        if (i > 0) system.execute(buf, this, ...args);
      }
    }

    // Flush deferred cache rebuilds before executing deferred actions
    this._executeDeferredCacheRebuilds();
    this._executeDeferred();
  }

  /** Dispatch the same `action` to every id in `entityIds` concurrently (see {@link act}). */
  async actBatch<Ac extends W["actions"]>(entityIds: string[], action: Ac): Promise<void> {
    await Promise.all(entityIds.map((id) => this.act(id, action)));
  }

  /**
   * Return an entity's behavior cache, materializing it first if a deferred
   * rebuild is pending. Mutators only enqueue rebuilds (drained by `update()`),
   * so a reactive caller that dispatches via `act`/`actWithBubbling` outside an
   * update tick would otherwise read a stale or absent cache. Rebuilding here
   * and clearing the pending flag keeps those reads correct and avoids a
   * redundant rebuild at the next `update()`.
   */
  private _ensureBehaviorCache(entityId: string): Map<number, Behavior<W>[]> | undefined {
    if (this._deferredCacheRebuilds.has(entityId)) {
      this._rebuildBehaviorCache(entityId);
      this._deferredCacheRebuilds.delete(entityId);
    }
    return this._entityBehaviorCache.get(entityId);
  }

  /** The behaviors `act(id, ...)` would run for an action with `tag`, in run order. */
  behaviorsFor(id: string, tag: W["actions"]["tag"]): ReadonlyArray<Behavior<W>> {
    return this._ensureBehaviorCache(id)?.get(tag) ?? EMPTY_BEHAVIORS;
  }

  /**
   * Dispatch `payload` to the entity's matching behaviors, then propagate the
   * same action down to its children (recursive), so acting on a parent cascades
   * to its whole subtree. Resolves `false` if the entity does not exist.
   */
  async act<Ac extends W["actions"]>(
    entityId: string,
    payload: Ac,
    action?: CustomAction<Ac>,
  ): Promise<boolean> {
    const entity = this.entity(entityId);
    if (!entity) return false;

    // Reuse action object to avoid creating many CustomActions
    const ac = action ?? new CustomAction(payload);

    // Act on current entity
    const entityCache = this._ensureBehaviorCache(entityId);
    const applicableBehaviors = entityCache?.get(payload.tag) ?? EMPTY_BEHAVIORS;

    for (const behavior of applicableBehaviors) {
      if (ac.defaultPrevented) return true; // Early termination
      await behavior.handler(this, entity, ac);
    }

    if (ac.defaultPrevented) return true;

    if (!entity.children) return false;

    // Pass action down to avoid creating new ones
    for (const childId of entity.children) {
      const stopped = await this.act(childId, payload, ac);
      if (stopped) return true; // Stop propagation if any child stopped it
    }

    return false;
  }

  // Act on entity and propagate up the hierarchy
  async actWithBubbling<Ac extends W["actions"]>(entityId: string, action: Ac): Promise<void> {
    let currentId: string | undefined = entityId;

    const ac = new CustomAction(action);

    while (currentId !== undefined) {
      const entity = this.entity(currentId);
      if (!entity) break;

      // Execute behaviors for current entity
      const entityCache = this._ensureBehaviorCache(currentId);
      const applicableBehaviors = entityCache?.get(action.tag) ?? EMPTY_BEHAVIORS;

      for (const behavior of applicableBehaviors) {
        if (ac.defaultPrevented) break;
        await behavior.handler(this, entity, ac);
      }

      // Stop if propagation stopped
      if (ac.defaultPrevented) break;

      // Move to parent
      currentId = entity.parent;
    }
  }

  /**
   * Defer execution of an action until the end of the update cycle (after all systems has been executed)
   * For best performance you try to defer a batched action instead of many small actions, or avoid defering if possbile
   */
  defer(action: () => void) {
    this._deferred.push(action);
  }

  /**
   * Hold the active {@link withScope} open until `work` settles, so async work a
   * synchronous system starts during `update()` (such as dispatching `act`)
   * commits in that scope's batch instead of landing after it closed. A
   * rejection aborts the scope. Outside a scope nothing waits for `work`.
   */
  waitUntil(work: Promise<unknown>): void {
    this.context.scope?.pending.push(work);
  }

  /**
   * Create a new mutation scope for tracking entity changes.
   * Mutations recorded in a scope can be coalesced and flushed together.
   */
  createScope(): MutationScope<W["entity"], W["delta"]> {
    return new MutationScope<W["entity"], W["delta"]>(
      this.options.mergeDelta,
      this.options.accumulateDelta,
    );
  }

  /**
   * Execute a function within a mutation scope.
   * All entity mutations (insert/put/delete) within the function are tracked
   * and deferred until scope completion. Entity reads within the scope see
   * pending mutations via shadow entities.
   * Returns the result and coalesced mutations after execution.
   *
   * A scope opened while another is active becomes its child: on success it
   * merges into the parent, which commits. This covers both deliberate nesting
   * and two async scopes that overlap in time (concurrent RPCs). The world has
   * a single active-scope slot, so overlapping scopes cannot be isolated: they
   * join into one commit, and the parent waits for every child to settle before
   * committing. A child that throws discards its own writes, including any the
   * parent made while the child held the slot.
   */
  async withScope<T>(fn: () => T | Promise<T>): Promise<{
    result: T;
    mutations: Map<string, MutationRecord<W["entity"], W["delta"]>>;
  }> {
    const scope = this.createScope();
    const parent = this.context.scope;
    let settle: (() => void) | undefined;
    if (parent) {
      scope.parent = parent;
      scope.initializeFromParent(parent);
      parent.children.push(new Promise<void>((resolve) => (settle = resolve)));
    }

    let succeeded = false;
    try {
      this.context.scope = scope;
      for (const cb of this._scopeOpenCallbacks) {
        cb(scope);
      }
      const result = await fn();
      while (scope.pending.length > 0) await Promise.all(scope.pending.splice(0));
      succeeded = true;
      return { result, mutations: scope.mutations };
    } finally {
      // Children hold the slot until they settle; restoring it before then
      // would leave it pointing at a finished scope.
      while (scope.children.length > 0) await Promise.all(scope.children.splice(0));
      this.context.scope = parent;

      try {
        // Transactional commit: only on success. An aborted scope leaves no trace.
        if (!succeeded) {
          this._rollbackArchetypes(scope);
        } else {
          if (parent) {
            for (const [id, prev] of scope.archetypeUndo) {
              if (!parent.archetypeUndo.has(id)) parent.archetypeUndo.set(id, prev);
            }
            // Merge up; the outermost scope owns the commit and the broadcast.
            for (const [id, mutation] of scope.mutations) {
              parent.applyMutation(id, mutation);
            }
          } else {
            if (this._flushHandler) {
              this._flushHandler(scope.mutations, scope);
            } else {
              for (const [id, mutation] of scope.mutations) {
                this._baseMutate(id, mutation);
              }
            }
            // Broadcast after the authoritative write so observers never see
            // uncommitted state.
            this.routeMutations(scope.mutations);
          }
        }
      } finally {
        settle?.();
      }
    }
  }

  /**
   * Check if the entity exists in the world
   */
  hasEntity(entity: string): boolean {
    // Also check scope's shadow state
    if (this.context.scope) {
      const shadow = this.context.scope.getShadowEntity(entity);
      if (shadow === null) return false; // Deleted in scope
      if (shadow !== undefined) return true; // Exists in scope
    }
    return this._archetypeOf.has(entity);
  }

  /**
   * Create an entity.
   * An entity is just an Id.
   * Previously deleted entity id's will be reused
   * Optionally supply a prefacbricated archetype
   */
  private _createEntity(
    prefabricate: Archetype = this.rootArchetype,
    id?: string,
    executeSystems = true,
  ): string {
    let entity: string;
    if (id !== undefined) {
      entity = id;
    } else {
      entity = this.options.createId();
    }

    const archetype = prefabricate;
    this._recordArchetype(entity);
    archetype.entities.add(entity);
    this._archetypeOf.set(entity, archetype);

    if (executeSystems) {
      this._executeEventSystems(archetype, entity);
      this._runCreateSystems(entity);
    }
    return entity;
  }

  private _runCreateSystems(entity: string) {
    for (let i = 0; i < this._handleCreate.length; i++) {
      const system = this._handleCreate[i];
      const archetypes = system.query.archetypes;
      const archetype = this._archetypeOf.get(entity);
      if (archetype && archetypes.has(archetype)) system.execute(entity);
    }
  }

  /**
   * Delete an entity, removing it from its current archetype (loosing all of its components).
   * @throws {EntityUndefinedError | EntityDeletedError | EntityNotExistError}
   */
  private _deleteEntity(entity: string) {
    this._assertEntity(entity);

    const archetype = this._archetypeOf.get(entity);
    if (!archetype) return;
    this._recordArchetype(entity);
    archetype.entities.delete(entity);
    // much faster than delete operator, but achieves the same (ish)
    // an alternative is to leave it be, and use archetype.entitySet.has(entity) as a check for entity being deleted, but that too is a little slower.
    this._archetypeOf.delete(entity);
    // Evict per-entity state BEFORE firing delete handlers so a recycled id
    // cannot inherit a stale behavior cache and handlers cannot resurrect one.
    this._entityBehaviorCache.delete(entity);
    this._deferredCacheRebuilds.delete(entity);
    // Record as recently-deleted, bounded to a small ring (see DELETED_RING_CAP).
    this._deletedEntities.add(entity);
    if (this._deletedEntities.size > ECS.DELETED_RING_CAP) {
      // Set iterates in insertion order; drop the oldest id.
      this._deletedEntities.delete(this._deletedEntities.values().next().value!);
    }
    this._executeEventSystems(archetype, entity);
    this._runDeleteSystems(entity, archetype);
  }

  private _runDeleteSystems(entity: string, archetype: Archetype) {
    for (let i = 0; i < this._handleDelete.length; i++) {
      const system = this._handleDelete[i];
      const archetypes = system.query.archetypes;
      if (archetype && archetypes.has(archetype)) system.execute(entity);
    }
  }

  /**
   * Check if the entity has a componentId
   */
  hasComponent(entity: string, _component: Exclude<keyof W["entity"], "tags">): boolean {
    // SAFETY: component names are string keys of `W["entity"]` (schema-generated field
    // names), so `_component` is a string and indexes the string-keyed
    // `options.components` map.
    const component = this.options.components[_component as string];
    const entityArchetype = this._archetypeOf.get(entity);

    if (!entityArchetype) return false;

    return entityArchetype && entityArchetype.mask.has(component);
  }

  private _addComponent(entity: string, name: string, executeSystems: boolean) {
    const archetype = this._archetypeOf.get(entity);
    const component = this.options.components[name];
    // if there's a difference between client entities and server entities
    if (component === undefined) return;

    if (archetype && !archetype?.mask.has(component)) {
      const next = this._transformEntityForComponent(archetype, entity, component);
      // Defer cache rebuilding to batch multiple component changes
      this._deferredCacheRebuilds.add(entity);
      if (executeSystems) this._executeEventSystems(next, entity);
    }
  }

  private _removeComponent(entity: string, name: string, executeSystems: boolean) {
    const archetype = this._archetypeOf.get(entity);
    const component = this.options.components[name];

    if (component === undefined) return;

    if (archetype && archetype.mask.has(component)) {
      const next = this._transformEntityForComponent(archetype, entity, component);
      // Defer cache rebuilding to batch multiple component changes
      this._deferredCacheRebuilds.add(entity);
      if (executeSystems) this._executeEventSystems(next, entity);
    }
  }

  /**
   * Check if the entity has a tag
   */
  hasTag(entity: string, tag: W["tags"]): boolean {
    const entityArchetype = this._archetypeOf.get(entity);
    if (!entityArchetype) return false;
    return entityArchetype.tagMask.has(tag);
  }

  /**
   * All tags currently assigned to the entity
   */
  getTags(entity: string): W["tags"][] {
    const entityArchetype = this._archetypeOf.get(entity);
    if (!entityArchetype) return [];
    // SAFETY: an archetype's tag ids are only ever set from `W["tags"]` values
    // (addTag/removeTag/_reconcileTags all take `W["tags"]`), so each id is a `W["tags"]`.
    return entityArchetype.tagIds() as W["tags"][];
  }

  /** Move `entity` to the archetype with `tag`; archetype only, no data. */
  private _addTag(entity: string, tag: W["tags"]): void {
    const archetype = this._archetypeOf.get(entity);
    if (!archetype || archetype.tagMask.has(tag)) return;
    this._transformEntityForTag(archetype, entity, tag);
    this._deferredCacheRebuilds.add(entity);
  }

  /** Move `entity` to the archetype without `tag`; archetype only, no data. */
  private _removeTag(entity: string, tag: W["tags"]): void {
    const archetype = this._archetypeOf.get(entity);
    if (!archetype || !archetype.tagMask.has(tag)) return;
    this._transformEntityForTag(archetype, entity, tag);
    this._deferredCacheRebuilds.add(entity);
  }

  /** Add `tag` to the entity's `tags` and return the entity after the change. */
  addTag(id: string, tag: W["tags"]): W["entity"] | undefined {
    if (!this.hasEntity(id)) return undefined;
    const tags = this.getTags(id);
    if (tags.includes(tag)) return this.entity(id);
    // SAFETY: `{ tags }` is a replacement tag list, the form of `W["delta"]`'s `tags` field.
    return this.put(id, { tags: [...tags, tag] } as W["delta"]);
  }

  /** Remove `tag` from the entity's `tags` and return the entity after the change. */
  removeTag(id: string, tag: W["tags"]): W["entity"] | undefined {
    if (!this.hasEntity(id)) return undefined;
    const tags = this.getTags(id);
    if (!tags.includes(tag)) return this.entity(id);
    // SAFETY: `{ tags }` is a replacement tag list, the form of `W["delta"]`'s `tags` field.
    return this.put(id, { tags: tags.filter((t) => t !== tag) } as W["delta"]);
  }

  private _notify(id: string) {
    this._assertEntity(id);
    const archetype = this._archetypeOf.get(id);
    if (archetype) this._executeEventSystems(archetype, id);
  }

  /**
   * Make `childId` a child of `id`: adds it to the parent's `children` and sets
   * the child's `parent`, detaching it from any previous parent first. Returns
   * the parent after the change.
   */
  public parent(id: string, childId: string): W["entity"] | undefined {
    const parent = this.entity(id);
    const child = this.entity(childId);
    if (!parent || !child) return undefined;
    if (child.parent !== undefined && child.parent !== id) this.unparent(child.parent, childId);
    if (child.parent !== id) {
      // SAFETY: `{ parent }` sets the scalar `parent` field, the form `W["delta"]` takes.
      this.put(childId, { parent: id } as W["delta"]);
    }
    if (parent.children?.includes(childId)) return this.entity(id);
    // SAFETY: an ArrayDelta `{ add }`, the form of `W["delta"]`'s `children` field.
    return this.put(id, { children: { add: [childId] } } as W["delta"]);
  }

  /**
   * Detach `childId` from `id`: removes it from the parent's `children` and
   * clears the child's `parent` if it points at `id`. Returns the parent after
   * the change.
   */
  public unparent(id: string, childId: string): W["entity"] | undefined {
    const parent = this.entity(id);
    if (!parent) return undefined;
    if (this.entity(childId)?.parent === id) this.removeComponents(childId, "parent");
    if (!parent.children?.includes(childId)) return parent;
    // SAFETY: an ArrayDelta `{ remove }`, the form of `W["delta"]`'s `children` field.
    return this.put(id, { children: { remove: [childId] } } as W["delta"]);
  }
}
