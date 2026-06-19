import { isScalar } from "./emit-delta";

export interface SourceField {
  /** Bebop field tag/index */
  index: number;
  name: string;
  /** Raw type token as written (e.g. "guid", "Pool", "Tags", "guid[]", "map[guid, Foo]") */
  rawType: string;
  /** Resolved element/base type name (e.g. "guid", "Pool"). For maps this is "map". */
  typeName: string;
  isArray: boolean;
  isMap: boolean;
  /** For arrays, the member type name */
  memberType?: string;
  /** For maps, the key type name */
  keyType?: string;
  /** For maps, the value type name */
  valueType?: string;
  /** True when the resolved base/member type is a bebop scalar */
  isScalar: boolean;
}

export interface SourceMessage {
  name: string;
  fields: SourceField[];
}

/** Strip line comments (`//`) and block comments (`/* *​/`) from bebop source. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Extract the body of `message <name> { ... }` from bebop source text.
 * Returns null if the message is not found.
 */
export function extractMessageBody(source: string, messageName: string): string | null {
  const clean = stripComments(source);
  const headerRe = new RegExp(`message\\s+${messageName}\\s*\\{`, "m");
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

function classifyType(
  rawType: string,
): Pick<
  SourceField,
  "typeName" | "isArray" | "isMap" | "memberType" | "keyType" | "valueType" | "isScalar"
> {
  const type = rawType.trim();

  // map[K, V]
  const mapMatch = /^map\s*\[\s*([^,\]]+?)\s*,\s*(.+?)\s*\]$/.exec(type);
  if (mapMatch) {
    return {
      typeName: "map",
      isArray: false,
      isMap: true,
      keyType: mapMatch[1].trim(),
      valueType: mapMatch[2].trim(),
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
 */
export function parseMessage(source: string, messageName: string): SourceMessage | null {
  const body = extractMessageBody(source, messageName);
  if (body === null) return null;

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
