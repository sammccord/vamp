import { isScalar } from "./emit-delta";

/** Recursive classification of a type token (base/array/map). */
export interface TypeClassification {
  /** Resolved element/base type name (e.g. "guid", "Pool"). For maps this is "map". */
  typeName: string;
  isArray: boolean;
  isMap: boolean;
  /** For arrays, the member type name */
  memberType?: string;
  /** For maps, the key type name */
  keyType?: string;
  /** For maps, the value type name (raw substring) */
  valueType?: string;
  /** For maps, the recursive classification of the value type */
  valueClassified?: TypeClassification;
  /** For arrays, the recursive classification of the member type */
  memberClassified?: TypeClassification;
  /** True when the resolved base/member type is a bebop scalar */
  isScalar: boolean;
}

export interface SourceField extends TypeClassification {
  /** Bebop field tag/index */
  index: number;
  name: string;
  /** Raw type token as written (e.g. "guid", "Pool", "Tags", "guid[]", "map[guid, Foo]") */
  rawType: string;
}

export interface SourceMessage {
  name: string;
  fields: SourceField[];
}

/** A bebop identifier per the grammar `[A-Za-z_][A-Za-z0-9_]*`. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escape regex metacharacters so an arbitrary name can be embedded in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip line comments (`//`) and block comments (`/* *​/`) from bebop source. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Remove nested brace blocks (inline messages/structs) from a message body,
 * leaving only top-level declarations. This prevents an inline `message X {...}`
 * inside `Entity` from leaking its fields in as top-level Entity fields.
 */
function stripNestedBlocks(body: string): string {
  let out = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Extract the body of `message <name> { ... }` from bebop source text.
 * Returns null if the message is not found.
 */
export function extractMessageBody(source: string, messageName: string): string | null {
  if (!IDENTIFIER_RE.test(messageName)) {
    throw new Error(
      `Invalid message name '${messageName}': bebop identifiers must match [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }
  const clean = stripComments(source);
  // Word-boundary anchor + escaped name: a name with a regex metacharacter can
  // neither throw a SyntaxError nor mis-scope; `message Foo` will not match a
  // request for `FooBar` (or vice-versa).
  const headerRe = new RegExp(`(?:^|\\b)message\\s+${escapeRegExp(messageName)}\\s*\\{`, "m");
  const match = headerRe.exec(clean);
  if (!match) return null;

  // Walk braces from the opening `{` to find the matching close.
  let depth = 0;
  let start = -1;
  for (let i = match.index + match[0].length - 1; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return clean.slice(start, i);
    }
  }
  return null;
}

export function classifyType(rawType: string): TypeClassification {
  const type = rawType.trim();

  // map[K, V] — greedy value capture so nested map/array values parse.
  const mapMatch = /^map\s*\[\s*([^,\]]+?)\s*,\s*(.+)\s*\]$/.exec(type);
  if (mapMatch) {
    const keyRaw = mapMatch[1].trim();
    const valueRaw = mapMatch[2].trim();
    return {
      typeName: "map",
      isArray: false,
      isMap: true,
      keyType: keyRaw,
      valueType: valueRaw,
      valueClassified: classifyType(valueRaw),
      isScalar: false,
    };
  }

  // T[]
  if (type.endsWith("[]")) {
    const member = type.slice(0, -2).trim();
    return {
      typeName: member,
      isArray: true,
      isMap: false,
      memberType: member,
      memberClassified: classifyType(member),
      isScalar: isScalar(member),
    };
  }

  return {
    typeName: type,
    isArray: false,
    isMap: false,
    isScalar: isScalar(type),
  };
}

/**
 * Parse `message <name>` field declarations from bebop source text.
 *
 * This is intentionally a lightweight, syntax-focused parser (no import
 * resolution). It only understands the constrained field syntax used in
 * generated/authored entity schemas: `<index> -> <type> <name>;`.
 *
 * Nested/inline message blocks inside the message body are stripped before
 * field extraction; their fields are NOT emitted as fields of this message. A
 * warning is logged so the user knows an inline component was ignored.
 */
export function parseMessage(source: string, messageName: string): SourceMessage | null {
  const rawBody = extractMessageBody(source, messageName);
  if (rawBody === null) return null;

  if (/\bmessage\s+[A-Za-z_]|\bstruct\s+[A-Za-z_]/.test(rawBody)) {
    console.warn(
      `Warning: an inline message/struct block inside '${messageName}' was ignored. ` +
        `Inline components are not supported; declare it as a top-level message and ` +
        `reference it by name.`,
    );
  }

  const body = stripNestedBlocks(rawBody);
  const fields: SourceField[] = [];
  // Field declarations look like: `1 -> guid id;` or `5 -> map[guid, Foo] m;`
  const fieldRe = /(\d+)\s*->\s*(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(body)) !== null) {
    const index = Number.parseInt(m[1], 10);
    const rawType = m[2].trim();
    const name = m[3];
    fields.push({ index, name, rawType, ...classifyType(rawType) });
  }

  return { name: messageName, fields };
}

/** Convenience wrapper for the `Entity` message. */
export function parseEntityMessage(source: string): SourceMessage {
  const entity = parseMessage(source, "Entity");
  if (!entity) {
    throw new Error("No 'message Entity { ... }' found in entity schema source");
  }
  return entity;
}

/**
 * Collect the names of every top-level `message <Name>` (not inline) declared
 * in the given source. Used to discover user-supplied `<Type>Delta` messages
 * and component message definitions.
 */
export function collectMessageNames(source: string): Set<string> {
  const clean = stripComments(source);
  const names = new Set<string>();
  // Only top-level messages: walk braces and only record `message X {` at depth 0.
  const re = /\bmessage\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let depth = 0;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // Track brace depth incrementally between matches.
  const tally = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") depth--;
    }
  };
  while ((m = re.exec(clean)) !== null) {
    tally(lastIndex, m.index);
    if (depth === 0) names.add(m[1]);
    lastIndex = m.index;
  }
  return names;
}
