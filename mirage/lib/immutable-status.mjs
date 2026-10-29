import { stringifyExactJson } from './exact-numeric.mjs';

const encoded = new WeakMap();

/** Only private, recursively frozen snapshots may reuse their HTTP bytes. */
export function immutableStatus(value) {
  const seen = new WeakSet();
  const objects = [];
  const inspect = (item) => {
    if (!item || typeof item !== 'object' || seen.has(item)) return true;
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    seen.add(item);
    objects.push(item);
    for (const child of Object.values(item)) if (!inspect(child)) return false;
    return true;
  };
  // Capability descriptors historically admit structured-clone types too.
  // Dates, maps and typed arrays keep their original uncached JSON behavior.
  if (!inspect(value)) return undefined;
  for (const item of objects) Object.freeze(item);
  encoded.set(value, undefined);
  return value;
}

export function immutableStatusBytes(value) {
  if (!value || !encoded.has(value)) return undefined;
  let bytes = encoded.get(value);
  if (!bytes) {
    bytes = Buffer.from(stringifyExactJson(value));
    encoded.set(value, bytes);
  }
  return bytes;
}
