import { TypedFastBitSet } from "typedfastbitset";

export type Archetype = {
  readonly mask: TypedFastBitSet;
  readonly tagMask: TypedFastBitSet;
  readonly entities: Set<string>;
  readonly adjacent: Map<number, Archetype>;
  readonly tagAdjacent: Map<number, Archetype>;
  /**
   * The id of the archetype is a hexadecimal representation of a set of unique bits for all of the `componentIds` and `tagIds`
   */
  readonly id: string;
  /**
   * Check if an entity is currently included in this archetype
   */
  hasEntity(entity: string): boolean;
  /**
   * Check if this archetype has a `componentId`.
   * This is typically much faster than checking if `componentIds` includes a given componentId
   */
  hasComponent(component: number): boolean;
  /**
   * Check if this archetype has a `tagId`
   */
  hasTag(tag: number): boolean;
  /**
   * All the `componentIds` constituting this archetype
   */
  componentIds(): number[];
  /**
   * All the `tagIds` constituting this archetype
   */
  tagIds(): number[];
};

export function archetypeId(mask: TypedFastBitSet, tagMask: TypedFastBitSet): string {
  return `${mask.toString()}|${tagMask.toString()}`;
}

export function createArchetype(
  id: string,
  mask: TypedFastBitSet,
  tagMask: TypedFastBitSet = new TypedFastBitSet(),
): Archetype {
  const entities = new Set<string>();
  const adjacent = new Map<number, Archetype>();
  const tagAdjacent = new Map<number, Archetype>();

  return Object.freeze<Archetype>({
    id,
    mask,
    tagMask,
    entities,
    adjacent,
    tagAdjacent,
    hasEntity: (id) => entities.has(id),
    hasComponent(component: number) {
      return mask.has(component);
    },
    hasTag(tag: number) {
      return tagMask.has(tag);
    },
    componentIds() {
      return mask.array();
    },
    tagIds() {
      return tagMask.array();
    },
  });
}

/**
 * Find (or create) the archetype reached by toggling `componentId` on `archetype`.
 *
 * The `index` is a per-ECS `Map<string, Archetype>` keyed by archetype id. Passing
 * it lets discovery of a novel archetype be an O(1) map lookup instead of an
 * O(n) `traverseArchetypeGraph` rescan — turning warmup from O(n²) to O(n)
 * (proposal 15). The live archetype's mask is never mutated: we clone first and
 * flip the clone, so the function is re-entrant and the "frozen" mask is never
 * transiently corrupted (proposal 19).
 */
export function transformArchetype(
  archetype: Archetype,
  componentId: number,
  index?: Map<string, Archetype>,
): Archetype {
  const existing = archetype.adjacent.get(componentId);
  if (existing !== undefined) {
    return existing;
  }

  // Clone first; never touch the live archetype's mask (re-entrancy safety).
  const nextMask = archetype.mask.clone();
  nextMask.flip(componentId);
  const nextId = archetypeId(nextMask, archetype.tagMask);

  let transformed = index?.get(nextId);
  if (transformed === undefined) {
    transformed = createArchetype(nextId, nextMask, archetype.tagMask.clone());
    index?.set(nextId, transformed);
  }
  transformed.adjacent.set(componentId, archetype);
  archetype.adjacent.set(componentId, transformed);
  return transformed;
}

/**
 * Find (or create) the archetype reached by toggling `tagId` on `archetype`.
 * Same id-index lookup and clone-first (non-mutating) contract as
 * {@link transformArchetype}.
 */
export function transformArchetypeTag(
  archetype: Archetype,
  tagId: number,
  index?: Map<string, Archetype>,
): Archetype {
  const existing = archetype.tagAdjacent.get(tagId);
  if (existing !== undefined) {
    return existing;
  }

  // Clone first; never touch the live archetype's tagMask (re-entrancy safety).
  const nextTagMask = archetype.tagMask.clone();
  nextTagMask.flip(tagId);
  const nextId = archetypeId(archetype.mask, nextTagMask);

  let transformed = index?.get(nextId);
  if (transformed === undefined) {
    transformed = createArchetype(nextId, archetype.mask.clone(), nextTagMask);
    index?.set(nextId, transformed);
  }
  transformed.tagAdjacent.set(tagId, archetype);
  archetype.tagAdjacent.set(tagId, transformed);
  return transformed;
}

export function traverseArchetypeGraph(
  archetype: Archetype,
  callback: (archetype: Archetype) => boolean | void,
  traversed = new Set<Archetype>(),
): boolean {
  traversed.add(archetype);
  if (callback(archetype) === false) return false;
  for (const arch of archetype.adjacent.values()) {
    if (traversed.has(arch)) continue;
    if (traverseArchetypeGraph(arch, callback, traversed) === false) return false;
  }
  for (const arch of archetype.tagAdjacent.values()) {
    if (traversed.has(arch)) continue;
    if (traverseArchetypeGraph(arch, callback, traversed) === false) return false;
  }
  return true;
}
