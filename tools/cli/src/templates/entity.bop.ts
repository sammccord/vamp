/**
 * Entity schema template. `__POOL_IMPORT__` is replaced at scaffold time with a
 * path to `@vamp/utils/schema/pool.bop` resolved via Node module resolution, so
 * it is correct for the actual (hoisted or pnpm) `node_modules` layout.
 */
export const entityTemplate = `import "__POOL_IMPORT__"
import "./tags.bop"

message Entity {
\t1 -> string id;
\t2 -> string sk;
\t3 -> Tags[] tags;
\t4 -> string parent;
\t5 -> string[] children;
\t6 -> Pool health;
}
`;

/** Fallback import path used when `@vamp/utils` cannot be resolved at init time. */
export const POOL_IMPORT_PLACEHOLDER = "__POOL_IMPORT__";
export const POOL_IMPORT_FALLBACK = "../node_modules/@vamp/utils/schema/pool.bop";
