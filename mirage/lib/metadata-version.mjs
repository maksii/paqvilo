import { createHash } from 'node:crypto';

const versions = new WeakMap();
const emptyMappings = Object.freeze({});

/** Synthetic mapping version shared by both APIs. Cache identity is the immutable mappings object. */
export function globalMetadataVersion(store) {
  if (store.observed?.webApiGlobalMetadataVersion != null) return store.observed.webApiGlobalMetadataVersion;
  const mappings = store.state.mappings ?? emptyMappings;
  if (!versions.has(mappings)) {
    const digest = createHash('sha256').update(JSON.stringify(mappings)).digest('hex');
    versions.set(mappings, String(parseInt(digest.slice(0, 8), 16)));
  }
  return versions.get(mappings);
}
