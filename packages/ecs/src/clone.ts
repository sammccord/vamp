/**
 * Deep-clone a plain entity value: JSON-shaped data (objects, arrays,
 * primitives) plus `Uint8Array` leaves. This is what entity/component data is
 * made of (Yjs `toJSON()` output, bebop-decoded records), and on that shape it
 * is ~8× faster than `structuredClone` — which matters on the per-scope
 * reconcile drain and the per-frame client store mirror, where a clone runs
 * for every remotely-changed entity.
 *
 * Not a general clone: class instances, Maps/Sets, Dates, and cyclic values
 * are not supported (cycles recurse forever). Entity data never contains them.
 */

/** A JSON-shaped value: primitives, arrays, string-keyed objects, plus Uint8Array leaves. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }
  | Uint8Array;

export function clonePlainValue<T>(value: T): T {
  if (!(value instanceof Object)) return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = clonePlainValue(value[i]);
    // SAFETY: out has one slot per element of value, each filled by cloning the
    // matching element, so out is the same array shape as value (T).
    return out as T;
  }
  if (value instanceof Uint8Array) {
    // SAFETY: value is a Uint8Array here; slice() copies its bytes, so the clone
    // is the same Uint8Array leaf the input carried.
    return value.slice() as T;
  }
  const out: Record<string, JsonValue> = {};
  for (const k in value) {
    // SAFETY: value is a JSON-shaped object (per the clone's contract), so its
    // properties are JsonValue values.
    out[k] = clonePlainValue((value as Record<string, JsonValue>)[k]);
  }
  // SAFETY: out holds a deep clone of every property of value, so it has the
  // same object shape as value (T).
  return out as T;
}
