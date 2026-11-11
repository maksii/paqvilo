import { createHash } from 'node:crypto';

const versions = new WeakMap();
const emptyMappings = Object.freeze({});
const sourceEpochs = new WeakMap();

// An organization binds its CSDL epoch so an evidenced version and its invalidation
// are shared by both HTTP APIs. Runtimes without a witness keep their old default.
export function bindGlobalMetadataEpoch(store, provider) {
  sourceEpochs.set(store, provider);
}

/** Synthetic mapping version shared by both APIs. Cache identity is the immutable mappings object. */
export function globalMetadataVersion(store) {
  const epoch = sourceEpochs.get(store)?.();
  if (epoch !== undefined) return epoch;
  if (store.observed?.webApiGlobalMetadataVersion != null) return store.observed.webApiGlobalMetadataVersion;
  const mappings = store.state.mappings ?? emptyMappings;
  if (!versions.has(mappings)) {
    const digest = createHash('sha256').update(JSON.stringify(mappings)).digest('hex');
    versions.set(mappings, String(Number.parseInt(digest.slice(0, 8), 16)));
  }
  return versions.get(mappings);
}
