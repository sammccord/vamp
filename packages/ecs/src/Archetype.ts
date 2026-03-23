import type { TypedFastBitSet } from "typedfastbitset";

export type Archetype = {
  readonly mask: TypedFastBitSet;
  readonly entities: Set<string>;
  readonly adjacent: Map<number, Archetype>;
  /**
   * The id of the archetype is a hexadecimal representation of a set of unique bits for all of the `componentIds`
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
   * All the `componentIds` constituting this archetype
   */
  componentIds(): number[];
};

export function createArchetype(id: string, mask: TypedFastBitSet): Archetype {
  const entities = new Set<string>();
  const adjacent = new Map<number, Archetype>();

  return Object.freeze<Archetype>({
    id,
    mask,
    entities,
    adjacent,
    hasEntity: entities.has,
    hasComponent(component: number) {
      return mask.has(component);
    },
    componentIds() {
      return mask.array();
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
  const nextId = mask.toString();

  let existingArchetype: Archetype | null = null;
  traverseArchetypeGraph(archetype, (node) => {
    if (node === archetype) return;
    if (node.id === nextId) {
      existingArchetype = node;
      return false;
    }
    return existingArchetype === null;
  });

  const transformed = existingArchetype || createArchetype(nextId, mask.clone());
  // reset current mask of input archetype, see comment above
  mask.flip(componentId);
  transformed.adjacent.set(componentId, archetype);
  archetype.adjacent.set(componentId, transformed);
  return transformed;
}

export function traverseArchetypeGraph(
  archetype: Archetype,
  callback: (archetype: Archetype) => boolean | void,
  traversed = new Set<Archetype>(),
): boolean {
  traversed.add(archetype);
  if (callback(archetype) === false) return false;
  const adjacent = archetype.adjacent;
  for (const arch of adjacent.values()) {
    // graph is doubly linked, so need to prevent infinite recursion
    if (traversed.has(arch)) continue;
    if (traverseArchetypeGraph(arch, callback, traversed) === false) return false;
  }
  return true;
}
