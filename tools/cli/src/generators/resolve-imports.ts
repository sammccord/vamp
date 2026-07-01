import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Extract the import paths from a bebop source file. Bebop imports look like
 * `import "../relative/path.bop"` or `import "@scope/pkg/schema/foo.bop"`.
 */
export function extractImportPaths(source: string): string[] {
  const re = /^\s*import\s+"([^"]+)"\s*;?\s*$/gm;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

/**
 * Resolve a single bebop import specifier to an absolute filesystem path.
 *
 * - Relative specifiers (`./`, `../`) resolve against `fromDir`.
 * - Bare/package specifiers resolve via Node module resolution, falling back to
 *   resolving the package root and joining the subpath when the package's
 *   `exports` map blocks subpath access (the common case for `.bop` files).
 *
 * Returns null if the specifier cannot be resolved.
 */
export function resolveBebopImport(specifier: string, fromDir: string): string | null {
  // Relative or absolute path.
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const abs = isAbsolute(specifier) ? specifier : resolve(fromDir, specifier);
    return existsSync(abs) ? abs : null;
  }

  // Package specifier (e.g. "@vampgg/utils/schema/pool.bop").
  const req = createRequire(resolve(fromDir, "noop.js"));
  // 1. Try the full subpath directly (works when there is no `exports` map or
  //    the subpath is exported).
  try {
    const direct = req.resolve(specifier);
    if (existsSync(direct)) return direct;
  } catch {
    // fall through
  }
  // 2. Resolve the package root via its package.json, then join the subpath.
  const segments = specifier.split("/");
  const pkgName = specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
  const subpath = segments.slice(specifier.startsWith("@") ? 2 : 1).join("/");
  try {
    const pkgJson = req.resolve(`${pkgName}/package.json`);
    const joined = resolve(dirname(pkgJson), subpath);
    if (existsSync(joined)) return joined;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Transitively read the entity source plus every reachable imported `.bop` file,
 * returning their concatenated source text. Used so the lightweight message
 * parser can see component messages and `<Type>Delta` definitions that live in
 * imported files (e.g. `PoolDelta` in `@vampgg/utils/schema/pool.bop`).
 *
 * Unresolved imports are skipped (the caller fails loudly later if a referenced
 * type is missing). Visited files are de-duplicated to avoid cycles.
 */
export function collectReachableSource(entityPath: string): string {
  const visited = new Set<string>();
  const parts: string[] = [];

  const visit = (filePath: string): void => {
    const abs = resolve(filePath);
    if (visited.has(abs)) return;
    visited.add(abs);
    let src: string;
    try {
      src = readFileSync(abs, "utf-8");
    } catch {
      return;
    }
    parts.push(src);
    for (const spec of extractImportPaths(src)) {
      const resolved = resolveBebopImport(spec, dirname(abs));
      if (resolved) visit(resolved);
    }
  };

  visit(entityPath);
  return parts.join("\n\n");
}
