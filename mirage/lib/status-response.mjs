import { stringifyExactJson } from './exact-numeric.mjs';
import { immutableStatusBytes } from './immutable-status.mjs';

/** Snapshot status serialization synchronously, then stream its parts. Reuse
 * private constant capability bytes instead of allocating a large JSON string
 * and network buffer for every poll on a large record heap. */
export function statusResponseChunks(value, capabilities) {
  const chunks = ['{'];
  let first = true;
  for (const [name, item] of Object.entries(value)) {
    const encoded =
      name === 'recordCapabilities'
        ? (capabilities.encoded(item) ?? stringifyExactJson(item))
        : (immutableStatusBytes(item) ?? stringifyExactJson(item));
    if (encoded === undefined) continue;
    chunks.push((first ? '' : ',') + JSON.stringify(name) + ':', encoded);
    first = false;
  }
  chunks.push('}');
  return chunks;
}
