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
export function clonePlainValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = clonePlainValue(value[i]);
    return out as T;
  }
  if (value instanceof Uint8Array) return value.slice() as T;
  const out: Record<string, unknown> = {};
  for (const k in value) out[k] = clonePlainValue((value as Record<string, unknown>)[k]);
  return out as T;
}
