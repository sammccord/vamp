import { TypedFastBitSet } from "typedfastbitset";
import type { Archetype } from "./Archetype";

type QueryMatcher = (target: TypedFastBitSet, archetype: Archetype) => boolean;

function makeMask(componentIds: number[]): TypedFastBitSet {
  return new TypedFastBitSet(componentIds);
}

function makeAndMatcher(matcher: QueryMatcher, ...matchers: QueryMatcher[]): QueryMatcher {
  return (target, targetArchetype) =>
    matcher(target, targetArchetype) && matchers.every((m) => m(target, targetArchetype));
}

function makeOrMatcher(matcher: QueryMatcher, ...matchers: QueryMatcher[]): QueryMatcher {
  return (target, targetArchetype) =>
    matcher(target, targetArchetype) || matchers.some((m) => m(target, targetArchetype));
}

export type Query = {
  readonly tryAdd: (archetype: Archetype, add?: boolean) => boolean;
  /**
   * All archetypes matching the query
   */
  readonly archetypes: Set<Archetype>;
};

const alwaysTrue: QueryMatcher = (_: TypedFastBitSet, __: Archetype) => true;

export type QueryBuilder = {
  /**
   * Archetypes that has *every* componentId of `componentIds` will be included in the result
   */
  every(...cids: number[]): QueryBuilder;
  /**
   * Archetypes that has *some* of the `componentIds` will be included in the result
   */
  some(...cids: number[]): QueryBuilder;
  /**
   * Archetypes that has *some* of the `componentIds` will *not* be included in the result
   */
  not(...cids: number[]): QueryBuilder;
  /**
   * Archetypes that has *every* componentId of `componentIds` will *not* be included in the result
   */
  none(...cids: number[]): QueryBuilder;
  /**
   * Build a subquery to match a different set of Archetypes.
   * You may combine as many or subqueries and nested or subqueries as you need
   */
  or(callback: (builder: QueryBuilder) => QueryBuilder): QueryBuilder;
  /**
   * Add a custom query matcher.
   * The matcher function receives a `BitSet` that indicates the presence of `componentIds`, and the `Archetype` associated with the `BitSet`
   */
  custom(matcher: QueryMatcher): QueryBuilder;
  /**
   * Query for a prefabricated `archetype`.
   * May match descendant archetypes, ie archetypes with all of the component ids in the prefab *and* additional component ids added to entities in the prefabricated archetype or descendant archetypes
   */
  prefabricated(archetype: Archetype): QueryBuilder;
  toQuery(): Query;
  readonly matchers: ReadonlyArray<QueryMatcher>;
};

export function createBuilder(): QueryBuilder {
  let _matchers: QueryMatcher[] = [];
  return {
    get matchers() {
      return _matchers;
    },
    or(cb) {
      const [first = alwaysTrue, ...rest] = _matchers;
      _matchers = [makeOrMatcher(makeAndMatcher(first, ...rest), ...cb(createBuilder()).matchers)];
      return this;
    },
    every(...components) {
      if (components.length === 0) {
        return this;
      }
      const mask = makeMask(components);
      _matchers.push((target, _targetArchetype) => {
        return target.intersection_size(mask) === components.length;
      });
      return this;
    },
    some(...components) {
      if (components.length === 0) {
        return this;
      }
      const mask = makeMask(components);
      _matchers.push((target, _targetArchetype) => target.intersects(mask));
      return this;
    },
    not(...components) {
      if (components.length === 0) {
        return this;
      }
      const mask = makeMask(components);
      _matchers.push((target, _targetArchetype) => !target.intersects(mask));
      return this;
    },
    none(...components) {
      if (components.length === 0) {
        return this;
      }
      const mask = makeMask(components);
      _matchers.push((target, _targetArchetype) => target.intersection_size(mask) === 0);
      return this;
    },
    prefabricated(archetype) {
      const size = archetype.componentIds().length;
      _matchers.push((target, _targetArchetype) => {
        return target.intersection_size(archetype.mask) === size;
      });
      return this;
    },
    custom(matcher) {
      _matchers.push(matcher);
      return this;
    },
    toQuery() {
      const [first = alwaysTrue, ...rest] = _matchers;
      const matcher = rest.length ? makeAndMatcher(first, ...rest) : first;

      const archetypes: Set<Archetype> = new Set();
      return Object.freeze({
        archetypes,
        tryAdd(archetype: Archetype, add = true): boolean {
          if (!matcher(archetype.mask, archetype)) return false;
          if (add) archetypes.add(archetype);
          return true;
        },
      });
    },
  };
}

export function query(callback: (builder: QueryBuilder) => QueryBuilder): Query {
  return callback(createBuilder()).toQuery();
}
