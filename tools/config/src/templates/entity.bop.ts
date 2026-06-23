/**
 * Entity schema template. `__POOL_IMPORT__` is replaced at scaffold time with a
 * path to `@vamp/utils/schema/pool.bop` resolved via Node module resolution, so
 * it is correct for the actual (hoisted or pnpm) `node_modules` layout.
 */
export const entityTemplate = `import "__POOL_IMPORT__"
import "./tags.bop"

message Entity {
\t1 -> guid id;
\t2 -> guid root;
\t3 -> Tags[] tags;
\t4 -> guid parent;
\t5 -> guid[] children;
\t6 -> Pool health;
}
`;

/** Fallback import path used when `@vamp/utils` cannot be resolved at init time. */
export const POOL_IMPORT_PLACEHOLDER = "__POOL_IMPORT__";
export const POOL_IMPORT_FALLBACK = "../node_modules/@vamp/utils/schema/pool.bop";
