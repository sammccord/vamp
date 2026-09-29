/** `@vampgg/utils/schema` files the entity template imports. */
export const UTILS_SCHEMA_FILES = ["pool.bop", "behavior.bop"] as const;
export type UtilsSchemaFile = (typeof UTILS_SCHEMA_FILES)[number];

/**
 * Placeholder in {@link entityTemplate} replaced at scaffold time with a path to
 * `@vampgg/utils/schema/<file>` resolved via Node module resolution, so it is
 * correct for the actual (hoisted or pnpm) `node_modules` layout.
 */
export const utilsSchemaPlaceholder = (file: UtilsSchemaFile): string => `__UTILS_SCHEMA_${file}__`;

/** Literal import path used when `@vampgg/utils` cannot be resolved at init time. */
export const utilsSchemaFallback = (file: UtilsSchemaFile): string =>
  `../node_modules/@vampgg/utils/schema/${file}`;

export const entityTemplate = `import "${utilsSchemaPlaceholder("pool.bop")}"
import "${utilsSchemaPlaceholder("behavior.bop")}"
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
