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
   * Archetypes that has *every* tagId of `tagIds` will be included in the result
   */
  everyTag(...tags: number[]): QueryBuilder;
  /**
   * Archetypes that has *some* of the `tagIds` will be included in the result
   */
  someTag(...tags: number[]): QueryBuilder;
  /**
   * Archetypes that has *some* of the `tagIds` will *not* be included in the result
   */
  notTag(...tags: number[]): QueryBuilder;
  /**
   * Archetypes that has *every* tagId of `tagIds` will *not* be included in the result
   */
  noneTag(...tags: number[]): QueryBuilder;
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
    everyTag(...tags) {
      if (tags.length === 0) return this;
      const mask = makeMask(tags);
      _matchers.push((_target, archetype) => {
        return archetype.tagMask.intersection_size(mask) === tags.length;
      });
      return this;
    },
    someTag(...tags) {
      if (tags.length === 0) return this;
      const mask = makeMask(tags);
      _matchers.push((_target, archetype) => archetype.tagMask.intersects(mask));
      return this;
    },
    notTag(...tags) {
      if (tags.length === 0) return this;
      const mask = makeMask(tags);
      _matchers.push((_target, archetype) => !archetype.tagMask.intersects(mask));
      return this;
    },
    noneTag(...tags) {
      if (tags.length === 0) return this;
      const mask = makeMask(tags);
      _matchers.push((_target, archetype) => archetype.tagMask.intersection_size(mask) === 0);
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
      // Snapshot the matcher list and run a flat, monomorphic loop in `tryAdd`
      // instead of composing a recursive `makeAndMatcher(first, ...rest)` closure
      // chain. Same boolean algebra (AND of all matchers; `or` already folded its
      // alternatives into a single matcher), but `tryAdd` no longer pays an
      // `Array.prototype.every` call + polymorphic dispatch per archetype tested.
      const matchers = _matchers.slice();
      const len = matchers.length;

      const archetypes: Set<Archetype> = new Set();
      return Object.freeze({
        archetypes,
        tryAdd(archetype: Archetype, add = true): boolean {
          const mask = archetype.mask;
          for (let i = 0; i < len; i++) {
            if (!matchers[i](mask, archetype)) return false;
          }
          if (add) archetypes.add(archetype);
          return true;
        },
      });
    },
  };
}

/**
 * Build a {@link Query} from a {@link QueryBuilder} callback, e.g.
 * `query((q) => q.every(Position, Velocity).someTag(Hostile))`. Pass the result
 * to {@link ECS.query} (or a system factory) to match entities by their
 * component + tag set.
 */
export function query(callback: (builder: QueryBuilder) => QueryBuilder): Query {
  return callback(createBuilder()).toQuery();
}
