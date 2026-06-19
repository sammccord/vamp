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

export function transformArchetype(archetype: Archetype, componentId: number): Archetype {
  const existing = archetype.adjacent.get(componentId);
  if (existing !== undefined) {
    return existing;
  }

  // Mutate the current mask in order to avoid creating garbage (in case the archetype already exists)
  const mask = archetype.mask;
  mask.flip(componentId);
  const nextId = archetypeId(mask, archetype.tagMask);

  let existingArchetype: Archetype | null = null;
  traverseArchetypeGraph(archetype, (node) => {
    if (node === archetype) return;
    if (node.id === nextId) {
      existingArchetype = node;
      return false;
    }
    return existingArchetype === null;
  });

  const transformed =
    existingArchetype || createArchetype(nextId, mask.clone(), archetype.tagMask.clone());
  // reset current mask of input archetype, see comment above
  mask.flip(componentId);
  transformed.adjacent.set(componentId, archetype);
  archetype.adjacent.set(componentId, transformed);
  return transformed;
}

export function transformArchetypeTag(archetype: Archetype, tagId: number): Archetype {
  const existing = archetype.tagAdjacent.get(tagId);
  if (existing !== undefined) {
    return existing;
  }

  const tagMask = archetype.tagMask;
  tagMask.flip(tagId);
  const nextId = archetypeId(archetype.mask, tagMask);

  let existingArchetype: Archetype | null = null;
  traverseArchetypeGraph(archetype, (node) => {
    if (node === archetype) return;
    if (node.id === nextId) {
      existingArchetype = node;
      return false;
    }
    return existingArchetype === null;
  });

  const transformed =
    existingArchetype || createArchetype(nextId, archetype.mask.clone(), tagMask.clone());
  tagMask.flip(tagId);
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
