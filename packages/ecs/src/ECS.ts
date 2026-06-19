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
import { CustomAction, type GenericAction } from "./Actions";
import { type AccumulateDeltaFn, type MergeDeltaFn, MutationScope } from "./MutationScope";
import type { Query, QueryBuilder } from "./Query";
import { query } from "./Query";
import type { Behavior, EventSystem, LifecycleSystem, System } from "./System";
import { type BaseEntity, type EntityMutator, MutationRecord, MutationType } from "./types";

export type EntityCallback = (entity: string, archetype: Archetype) => Promise<unknown>;

export interface ECSOptions<E extends BaseEntity, D> {
  createId: () => string;
  components: Record<Exclude<keyof E, "tags">, number>;
  materializeDelta: (delta: D, base?: Partial<E>) => E;
  mergeDelta: MergeDeltaFn<E, D>;
  accumulateDelta: AccumulateDeltaFn<D>;
}

export type StateWithScope<C extends Record<string, unknown>, E extends BaseEntity, D> = C & {
  scope?: MutationScope<E, D>;
};

// TODO refactor this to just be strings its fine
export class ECS<
  State extends Record<string, unknown>,
  UpdateArguments extends Array<unknown>,
  Actions extends GenericAction,
  Tags extends number = number,
  E extends BaseEntity<Tags> = BaseEntity<Tags>,
  D = unknown,
> {
  protected readonly rootArchetype: Archetype = createArchetype(
    "root",
    new TypedFastBitSet(),
    new TypedFastBitSet(),
  );
  readonly entityArchetype: Map<string, Archetype> = new Map();
  readonly deletedEntities = new Set<string>();
  readonly systems: System<State, UpdateArguments, Actions, Tags, E, D>[] = [];
  readonly subscriptions: EventSystem[] = [];
  readonly behaviors = new Map<number, Behavior<State, UpdateArguments, Actions, Tags, E, D>[]>();
  readonly entityBehaviorCache = new Map<
    string,
    Map<number, Behavior<State, UpdateArguments, Actions, Tags, E, D>[]>
  >();
  // Cache behaviors at the archetype level to avoid redundant query evaluation
  private readonly archetypeBehaviorCache = new Map<
    Archetype,
    Map<number, Behavior<State, UpdateArguments, Actions, Tags, E, D>[]>
  >();
  // Defer cache rebuilding until end of update cycle
  private readonly _deferredCacheRebuilds = new Set<string>();
  readonly handleCreate: LifecycleSystem[] = [];
  readonly handleDelete: LifecycleSystem[] = [];
  readonly deferred: (() => void)[] = [];

  private _initialized = false;
  public get initialized() {
    return this._initialized;
  }

  private _scopeOpenCallbacks = new Set<(scope: MutationScope<E, D>) => void>();
  private _flushHandler: ((mutations: Map<string, MutationRecord<E, D>>) => void) | null = null;

  /**
   * Register a callback invoked when a mutation scope is opened (before the scope function runs).
   * Returns an unsubscribe function.
   */
  onScopeOpen(cb: (scope: MutationScope<E, D>) => void): () => void {
    this._scopeOpenCallbacks.add(cb);
    return () => this._scopeOpenCallbacks.delete(cb);
  }

  /**
   * Set a handler that replaces the default per-mutation flush loop.
   * The handler receives all coalesced mutations from the scope and is responsible for
   * applying them (to entities, Yjs, etc.). Pass `null` to restore default behavior.
   */
  setFlushHandler(handler: ((mutations: Map<string, MutationRecord<E, D>>) => void) | null): void {
    this._flushHandler = handler;
  }

  // Array pool for entity collections to reduce GC pressure
  readonly _arrayPool: string[][] = [];

  private _getPooledArray(size: number): string[] {
    const pooled = this._arrayPool.pop();
    if (pooled) {
      pooled.length = size; // Reset array to required size
      return pooled;
    }
    return Array.from<string>({ length: size });
  }

  private _returnPooledArray(array: string[]): void {
    if (array.length < 1000) {
      // Only pool reasonably sized arrays
      array.length = 0; // Clear the array
      this._arrayPool.push(array);
    }
  }

  public readonly context: StateWithScope<State, E, D>;
  protected readonly _entities: Map<string, E>;
  protected readonly _baseMutate: EntityMutator<E, D>;
  protected readonly _mutate: EntityMutator<E, D>;
  protected readonly options: ECSOptions<E, D>;

  constructor(
    entities: Map<string, E>,
    mutate: EntityMutator<E, D>,
    context: State,
    options: ECSOptions<E, D>,
  ) {
    this._entities = entities;
    this._baseMutate = mutate;
    this._mutate = this._wrapMutator(mutate);
    this.options = options;
    this.context = context;
  }

  private _wrapMutator(baseMutate: EntityMutator<E, D>): EntityMutator<E, D> {
    return (id: string, mutation: MutationRecord<E, D>) => {
      if (this.initialized) {
        // If there's a flush handler, we should always have a scope to flush.
        const scope = this.context.scope || this._flushHandler ? this.createScope() : undefined;

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

  public entity(id: string): E | undefined {
    // Check scope's shadow entities first
    if (this.context.scope) {
      const shadow = this.context.scope.getShadowEntity(id);
      if (shadow === null) return undefined; // Deleted in scope
      if (shadow !== undefined) return shadow; // Found in scope
      // Fall through to real entities if not in scope
    }
    return this._entities.get(id);
  }

  public get entities() {
    return this._entities;
  }

  public upsert(
    delta: D,
    filter: (e: E | undefined, i: number, obj: string[]) => boolean,
    mutate = false,
  ): E {
    const components: number[] = [];
    for (const component in delta as object) {
      if ((delta as Record<string, unknown>)[component] === undefined) continue;
      //@ts-expect-error indexing component options by dynamic key
      components.push(this.options.components[component]);
    }
    const entity = this.query((q) => q.every(...components)).find((e, i, obj) =>
      filter(this.entity(e), i, obj),
    );
    if (entity === undefined) return this.insert(this.options.materializeDelta(delta));
    return this.put(entity, delta, mutate);
  }

  public insert(entity: E): E {
    const id = this.createEntity(undefined, entity.id, false);
    // assign generated id to entity
    if (!entity.id) entity.id = id;
    for (const component in entity) {
      if (component === "tags") continue;
      if (entity[component as keyof E] === undefined) continue;
      this.addComponent(id, component as unknown as Exclude<keyof E, "tags">, false);
    }
    if (entity.tags) {
      for (const tag of entity.tags) {
        this.addTag(id, tag, false);
      }
    }
    this._mutate(id, MutationRecord.fromInsert<E, D>({ entity }));
    this.executeEventSystems(id);
    this._handleCreate(id);
    return entity;
  }

  public put(id: string | undefined, delta: D, mutating = false): E {
    if (!id) return this.insert(this.options.materializeDelta(delta));
    const entity = this.entity(id);
    // entity does not exist, insert
    if (!entity || entity.id !== id) return this.insert(this.options.materializeDelta(delta));
    // patch the existing entity
    let executing = false;
    const base: Record<string, unknown> = {};

    for (const component in delta as object) {
      if (component === "tags") continue;
      const deltaValue = (delta as Record<string, unknown>)[component];
      const entityValue = (entity as Record<string, unknown>)[component];

      // are we changing the component structure into another archetype?
      if (mutating && deltaValue === undefined) {
        base[component] = undefined;
        this.removeComponent(id, component as Exclude<keyof E, "tags">, false);
        executing = true;
      } else {
        // TODO maybe _.clone() this to prevent accidental mutation of object components
        base[component] = entityValue;
        // If value was previously undefined, add component and execute systems
        if (entityValue === undefined) {
          this.addComponent(id, component as Exclude<keyof E, "tags">, false);
          executing = true;
        }
      }
    }

    const rawDelta = delta as Record<string, unknown>;
    if (rawDelta.tags !== undefined) {
      this._reconcileTags(id, rawDelta.tags);
    }

    this._mutate(id, MutationRecord.fromUpdate<E, D>({ delta }));
    if (executing) this.executeEventSystems(id);

    return base as E;
  }

  public delete(entity: E) {
    const id = entity.id;
    if (id === undefined) {
      console.warn("no id provided for deletion");
      return;
    }
    const e = this.entity(id);
    if (e === undefined) {
      console.warn("no valid entity provided for deletion");
      return;
    }
    this._mutate(id, MutationRecord.fromDelete<E, D>({ entity: e }));
    this.deleteEntity(id);

    return e;
  }

  public query(_query: Query | ((builder: QueryBuilder) => QueryBuilder)): string[] {
    const q = typeof _query === "function" ? query(_query) : _query;
    const archetypes: Archetype[] = [];
    traverseArchetypeGraph(this.rootArchetype, (archetype) => {
      if (q.tryAdd(archetype, false)) archetypes.push(archetype);
    });

    // Pre-calculate total entity count to avoid array growth
    let totalEntities = 0;
    for (let a = 0; a < archetypes.length; a++) {
      totalEntities += archetypes[a].entities.size;
    }

    // Use pooled array with exact size needed
    const entities = this._getPooledArray(totalEntities);
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

  public subscribe(system: EventSystem, emit = false): () => void {
    this.subscriptions.push(system);

    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        system.query.tryAdd(archetype);
        return true;
      });
    }

    if (emit) {
      this._executeEventSystem(system);
    }

    return () =>
      this.subscriptions.splice(
        this.subscriptions.findIndex((s) => s === system),
        1,
      )[0];
  }

  public onCreate(system: LifecycleSystem) {
    this.handleCreate.push(system);
    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        system.query.tryAdd(archetype);
        return true;
      });
    }
    return () =>
      this.handleCreate.splice(
        this.handleCreate.findIndex((s) => s === system),
        1,
      )[0];
  }

  public onDelete(system: LifecycleSystem) {
    this.handleDelete.push(system);
    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        system.query.tryAdd(archetype);
        return true;
      });
    }
    return () =>
      this.handleDelete.splice(
        this.handleDelete.findIndex((s) => s === system),
        1,
      )[0];
  }

  private _executeEventSystems(archetype: Archetype) {
    const systems = this.subscriptions;
    for (let s = 0, sl = systems.length; s < sl; s++) {
      const system = systems[s];
      if (system.query.archetypes.has(archetype)) this._executeEventSystem(system);
    }
  }

  private _executeEventSystem(sys: EventSystem) {
    const archetypes = sys.query.archetypes;

    // Pre-calculate total entity count
    let totalEntities = 0;
    for (const arch of archetypes) {
      totalEntities += arch.entities.size;
    }

    // Use pooled array with exact size needed
    const entities = this._getPooledArray(totalEntities);
    let entityIndex = 0;

    // Direct iteration over Set is faster than spreading
    for (const arch of archetypes) {
      for (const entity of arch.entities) {
        entities[entityIndex++] = entity;
      }
    }
    sys.execute(entities);

    // Return array to pool for reuse
    this._returnPooledArray(entities);
  }

  private _executeDeferred() {
    if (this.deferred.length === 0) return;
    for (let i = 0; i < this.deferred.length; i++) {
      this.deferred[i]();
    }
    this.deferred.length = 0;
  }

  private _executeDeferredCacheRebuilds() {
    if (this._deferredCacheRebuilds.size === 0) return;
    for (const entityId of this._deferredCacheRebuilds) {
      this.rebuildBehaviorCache(entityId);
    }
    this._deferredCacheRebuilds.clear();
  }

  private _tryAddArchetypeToQueries(archetype: Archetype) {
    const systems = [
      ...this.systems,
      ...this.subscriptions,
      ...this.handleCreate,
      ...this.handleDelete,
      ...Array.from(this.behaviors.values()).flat(),
    ] as System<State, UpdateArguments, Actions, Tags, E, D>[];

    for (let i = 0, l = systems.length; i < l; i++) {
      systems[i].query.tryAdd(archetype);
    }
  }

  private _assertEntity(entity: string) {
    if (!this.entityArchetype.has(entity)) {
      if (entity === undefined) {
        throw new EntityUndefinedError();
      } else if (this.deletedEntities.has(entity)) {
        throw new EntityDeletedError(entity);
      }
      throw new EntityNotExistError(entity);
    }
  }

  private _transformEntityForComponent(
    current: Archetype,
    entity: string,
    componentId: number,
  ): Archetype {
    current.entities.delete(entity);

    const adjacent = current.adjacent.get(componentId);
    if (adjacent !== undefined) {
      current = adjacent;
    } else {
      current = transformArchetype(current, componentId);
      if (this.initialized) {
        this._tryAddArchetypeToQueries(current);
      }
    }

    current.entities.add(entity);
    this.entityArchetype.set(entity, current);
    return current;
  }

  private _transformEntityForTag(current: Archetype, entity: string, tagId: number): Archetype {
    current.entities.delete(entity);

    const tagAdjacent = current.tagAdjacent.get(tagId);
    if (tagAdjacent !== undefined) {
      current = tagAdjacent;
    } else {
      current = transformArchetypeTag(current, tagId);
      if (this.initialized) {
        this._tryAddArchetypeToQueries(current);
      }
    }

    current.entities.add(entity);
    this.entityArchetype.set(entity, current);
    return current;
  }

  private _reconcileTags(id: string, tagsDelta: unknown): void {
    const archetype = this.entityArchetype.get(id);
    if (!archetype) return;
    const currentTags = archetype.tagMask.array();
    let targetTags: number[];

    if (typeof tagsDelta === "object" && tagsDelta !== null && !Array.isArray(tagsDelta)) {
      const d = tagsDelta as { set?: number[]; add?: number[]; remove?: number[] };
      if (d.set !== undefined) {
        targetTags = d.set;
      } else {
        targetTags = [...currentTags];
        if (d.add)
          for (const t of d.add) {
            if (!targetTags.includes(t)) targetTags.push(t);
          }
        if (d.remove) targetTags = currentTags.filter((t) => !d.remove!.includes(t));
      }
    } else if (Array.isArray(tagsDelta)) {
      targetTags = tagsDelta;
    } else {
      return;
    }

    for (const tag of currentTags) {
      if (!targetTags.includes(tag)) this.removeTag(id, tag as Tags, false);
    }
    for (const tag of targetTags) {
      if (!currentTags.includes(tag)) this.addTag(id, tag as Tags, false);
    }
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
        archetype = transformArchetype(archetype, componentId);
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
        archetype = transformArchetypeTag(archetype, tagId);
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
  registerSystem(system: System<State, UpdateArguments, Actions, Tags, E, D>) {
    this.systems.push(system);

    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        system.query.tryAdd(archetype);
        return true;
      });
    }

    return () =>
      this.systems.splice(
        this.systems.findIndex((s) => s === system),
        1,
      )[0];
  }

  // Register a behavior (system) for a specific event type
  registerBehavior(behavior: Behavior<State, UpdateArguments, Actions, Tags, E, D>): void {
    if (!this.behaviors.has(behavior.tag)) {
      this.behaviors.set(behavior.tag, []);
    }

    const behaviors = this.behaviors.get(behavior.tag)!;
    behaviors.push(behavior);

    // Sort by priority (higher first)
    behaviors.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    if (this.initialized) {
      traverseArchetypeGraph(this.rootArchetype, (archetype) => {
        behavior.query.tryAdd(archetype);
        return true;
      });
    }
  }

  private rebuildAllBehaviorCaches(): void {
    for (const entityId of this.entities.keys()) {
      this.rebuildBehaviorCache(entityId);
    }
  }

  // Rebuild behavior cache for a specific entity - O(a * b * q) where a = archetypes, b = behaviors, q = query complexity
  // Now uses archetype-level caching, so each archetype is only evaluated once
  rebuildBehaviorCache(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;

    const entityArchetype = this.entityArchetype.get(entityId)!;

    // Check if we've already computed behaviors for this archetype
    let cache = this.archetypeBehaviorCache.get(entityArchetype);

    if (!cache) {
      // Compute once per archetype, not once per entity
      cache = new Map<number, Behavior<State, UpdateArguments, Actions, Tags, E, D>[]>();

      // For each event type
      for (const [eventType, behaviors] of this.behaviors) {
        const applicable: Behavior<State, UpdateArguments, Actions, Tags, E, D>[] = [];

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
    this.entityBehaviorCache.set(entityId, cache);
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
  update(...args: UpdateArguments) {
    if (!this.initialized) throw new WorldNotInitializedError();
    const systems = this.systems;
    for (let s = 0, sl = systems.length; s < sl; s++) {
      const system = systems[s];
      const archetypes = system.query.archetypes;
      if (system.type === 1) {
        system.execute(archetypes, this, ...args);
      }
      if (system.type === 0) {
        // reverse iterating in case a system adds/removes component resulting in new archetype that matches query for the system
        for (const arch of archetypes) {
          system.execute([...arch.entities], this, ...args);
        }
      }
    }

    // Flush deferred cache rebuilds before executing deferred actions
    this._executeDeferredCacheRebuilds();
    this._executeDeferred();
  }

  // Add batch capabilities
  async actBatch<Ac extends Actions>(entityIds: string[], action: Ac): Promise<void> {
    await Promise.all(entityIds.map((id) => this.act(id, action)));
  }

  // Act on entity and propagate down to all children (recursive)
  async act<Ac extends Actions>(
    entityId: string,
    payload: Ac,
    action?: CustomAction<Ac>,
  ): Promise<boolean> {
    const entity = this.entity(entityId);
    if (!entity) return false;

    // Reuse action object to avoid creating many CustomActions
    const ac = action ?? new CustomAction(payload);

    // Act on current entity
    const entityCache = this.entityBehaviorCache.get(entityId);
    const applicableBehaviors = entityCache?.get(payload.tag) || [];

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

  public actToSubtree<Ac extends Actions>(entityId: string, payload: Ac): Promise<boolean> {
    return this.act(entityId, payload);
  }

  // Act on entity and propagate up the hierarchy
  async actWithBubbling<Ac extends Actions>(entityId: string, action: Ac): Promise<void> {
    let currentId: string | undefined = entityId;

    const ac = new CustomAction(action);

    while (currentId !== undefined) {
      const entity = this.entity(currentId);
      if (!entity) break;

      // Execute behaviors for current entity
      const entityCache = this.entityBehaviorCache.get(currentId);
      const applicableBehaviors = entityCache?.get(action.tag) || [];

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
    this.deferred.push(action);
  }

  /**
   * Create a new mutation scope for tracking entity changes.
   * Mutations recorded in a scope can be coalesced and flushed together.
   */
  createScope(): MutationScope<E, D> {
    return new MutationScope<E, D>(this.options.mergeDelta, this.options.accumulateDelta);
  }

  /**
   * Execute a function within a mutation scope.
   * All entity mutations (insert/put/delete) within the function are tracked
   * and deferred until scope completion. Entity reads within the scope see
   * pending mutations via shadow entities.
   * Returns the result and coalesced mutations after execution.
   * Supports nested scopes - inner scopes inherit parent's shadow state.
   */
  async withScope<T>(fn: () => T | Promise<T>): Promise<{
    result: T;
    mutations: Map<string, MutationRecord<E, D>>;
  }> {
    const scope = this.createScope();
    const previousScope = this.context.scope;

    // Inherit shadow state from parent scope for nested scope support
    if (previousScope) {
      scope.initializeFromParent(previousScope);
    }

    try {
      this.context.scope = scope;
      // Invoke scope-open callbacks (e.g., drain remote changes into scope)
      for (const cb of this._scopeOpenCallbacks) {
        cb(scope);
      }
      const result = await fn();
      return { result, mutations: scope.mutations };
    } finally {
      this.context.scope = previousScope!;

      if (this._flushHandler) {
        // Custom flush handler (e.g., batch all mutations in a single transaction)
        this._flushHandler(scope.mutations);
      } else {
        // Default: flush coalesced mutations using base mutator (bypasses wrapper)
        for (const [id, mutation] of scope.mutations) {
          this._baseMutate(id, mutation);
        }
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
    return this.entityArchetype.has(entity);
  }

  /**
   * Create an entity.
   * An entity is just an Id.
   * Previously deleted entity id's will be reused
   * Optionally supply a prefacbricated archetype
   */
  createEntity(
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

    const archetype = prefabricate as Archetype;
    archetype.entities.add(entity);
    this.entityArchetype.set(entity, archetype);

    if (executeSystems) {
      this._executeEventSystems(archetype);
      this._handleCreate(entity);
    }
    return entity;
  }

  protected _handleCreate(entity: string) {
    for (let i = 0; i < this.handleCreate.length; i++) {
      const system = this.handleCreate[i];
      const archetypes = system.query.archetypes;
      const archetype = this.entityArchetype.get(entity);
      if (archetype && archetypes.has(archetype)) system.execute(entity);
    }
  }

  /**
   * Delete an entity, removing it from its current archetype (loosing all of its components).
   * @throws {EntityUndefinedError | EntityDeletedError | EntityNotExistError}
   */
  deleteEntity(entity: string) {
    this._assertEntity(entity);

    const archetype = this.entityArchetype.get(entity);
    if (!archetype) return;
    archetype.entities.delete(entity);
    // much faster than delete operator, but achieves the same (ish)
    // an alternative is to leave it be, and use archetype.entitySet.has(entity) as a check for entity being deleted, but that too is a little slower.
    this.entityArchetype.delete(entity);
    this.deletedEntities.add(entity);
    this._executeEventSystems(archetype);
    this._handleDelete(entity, archetype);
  }

  private _handleDelete(entity: string, archetype: Archetype) {
    for (let i = 0; i < this.handleDelete.length; i++) {
      const system = this.handleDelete[i];
      const archetypes = system.query.archetypes;
      if (archetype && archetypes.has(archetype)) system.execute(entity);
    }
  }

  /**
   * Transform the entity to that of a prefabricated archetype.
   * Any components added to the entity that does not exist in the prefabricate will be removed.
   * This is a sligthly faster operation than adding/subtracting components
   * @throws {EntityUndefinedError | EntityDeletedError | EntityNotExistError}
   */
  transformEntity(entity: string, prefabricate: Archetype) {
    this._assertEntity(entity);

    if (this.entityArchetype.get(entity) === prefabricate) return;

    // Transform resets all components on the entity to that of the prefab..
    this.entityArchetype.get(entity)?.entities.delete(entity);
    const archetype = prefabricate as Archetype;
    archetype.entities.add(entity);
    this.entityArchetype.set(entity, archetype);
    this._executeEventSystems(archetype);
  }

  /**
   * Check if the entity has a componentId
   */
  hasComponent(entity: string, _component: Exclude<keyof E, "tags">): boolean {
    const component = this.options.components[_component];
    const entityArchetype = this.entityArchetype.get(entity);

    if (!entityArchetype) return false;

    return entityArchetype && entityArchetype.mask.has(component);
  }

  /**
   * Adds the componentId to the entity.
   * The entity will be moved to a different archetype
   * @throws {EntityUndefinedError | EntityDeletedError | EntityNotExistError}
   */
  addComponent(entity: string, _component: Exclude<keyof E, "tags">, executeSystems = true) {
    const archetype = this.entityArchetype.get(entity);
    const component = this.options.components[_component];
    // if there's a difference between client entities and server entities
    if (component === undefined) return;

    if (archetype && !archetype?.mask.has(component)) {
      const next = this._transformEntityForComponent(archetype, entity, component);
      // Defer cache rebuilding to batch multiple component changes
      this._deferredCacheRebuilds.add(entity);
      if (executeSystems) this._executeEventSystems(next);
    }
  }

  /**
   * Removes the componentId from the entity.
   * The entity will be moved to a different archetype
   * @throws {EntityUndefinedError | EntityDeletedError | EntityNotExistError}
   */
  removeComponent(entity: string, _component: Exclude<keyof E, "tags">, executeSystems = true) {
    const archetype = this.entityArchetype.get(entity);
    const component = this.options.components[_component];

    if (component === undefined) return;

    if (archetype && archetype.mask.has(component)) {
      const next = this._transformEntityForComponent(archetype, entity, component);
      // Defer cache rebuilding to batch multiple component changes
      this._deferredCacheRebuilds.add(entity);
      if (executeSystems) this._executeEventSystems(next);
    }
  }

  /**
   * Check if the entity has a tag
   */
  hasTag(entity: string, tag: Tags): boolean {
    const entityArchetype = this.entityArchetype.get(entity);
    if (!entityArchetype) return false;
    return entityArchetype.tagMask.has(tag as number);
  }

  /**
   * All tags currently assigned to the entity
   */
  getTags(entity: string): Tags[] {
    const entityArchetype = this.entityArchetype.get(entity);
    if (!entityArchetype) return [];
    return entityArchetype.tagIds() as Tags[];
  }

  /**
   * Adds a tag to the entity.
   * The entity will be moved to a different archetype in the tag graph
   */
  addTag(entity: string, tag: Tags, executeSystems = true) {
    const archetype = this.entityArchetype.get(entity);
    if (!archetype) return;
    if (archetype.tagMask.has(tag as number)) return;

    const next = this._transformEntityForTag(archetype, entity, tag as number);
    this._deferredCacheRebuilds.add(entity);
    if (executeSystems) this._executeEventSystems(next);
  }

  /**
   * Removes a tag from the entity.
   * The entity will be moved to a different archetype in the tag graph
   */
  removeTag(entity: string, tag: Tags, executeSystems = true) {
    const archetype = this.entityArchetype.get(entity);
    if (!archetype) return;
    if (!archetype.tagMask.has(tag as number)) return;

    const next = this._transformEntityForTag(archetype, entity, tag as number);
    this._deferredCacheRebuilds.add(entity);
    if (executeSystems) this._executeEventSystems(next);
  }

  executeEventSystems(id: string) {
    this._assertEntity(id);
    const archetype = this.entityArchetype.get(id);
    if (archetype) this._executeEventSystems(archetype);
  }

  public parent(id: string, childId: string): Pick<E, "id" | "children"> | undefined {
    const parent = this.entity(id);
    const child = this.entity(childId);
    if (!parent || !child) return;
    if (!parent.children) {
      return this.put(id, {
        children: {
          set: [childId],
        },
      } as unknown as D);
    } else {
      if (parent.children.includes(childId)) return parent;
      return this.put(id, {
        children: {
          add: [childId],
        },
      } as unknown as D);
    }
  }

  public unparent(id: string, childId: string): E | undefined {
    const parent = this.entity(id);
    if (!parent) return;
    if (parent.children) {
      return this.put(id, {
        children: {
          remove: [childId],
        },
      } as unknown as D);
    }
  }
}
