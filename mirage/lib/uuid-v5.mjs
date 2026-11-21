// Name-based GUIDs (RFC 4122 version 5). A leaf module: settings contracts (dataverse-settings.mjs) derive ids with it
// without loading the security model, which re-exports it (dataverse-security.mjs).
import { hash } from 'node:crypto';
import { DataError } from './data-error.mjs';

const namespaceBytes = new Map();
// The ids already derived, by namespace and name. Seeding derives the same few thousand ids (a filter per message and
// table, a privilege per table and right) every time it runs: at start-up, after every extension installs and for each
// table created later. An id is a pure function of its two strings, so the map only saves the hashing; it is emptied
// when it reaches its bound.
const derivedIds = new Map(),
  DERIVED_IDS = 131_072;
/** RFC 4122 version 5 (SHA-1, name-based) GUID, lowercase. */
export function uuidV5(namespace, name) {
  if (typeof namespace !== 'string') return deriveUuidV5(namespace, name);
  const key = `${namespace}\n${name}`;
  let id = derivedIds.get(key);
  if (id === undefined) {
    id = deriveUuidV5(namespace, name);
    if (derivedIds.size >= DERIVED_IDS) derivedIds.clear();
    derivedIds.set(key, id);
  }
  return id;
}
function deriveUuidV5(namespace, name) {
  let prefix = namespaceBytes.get(namespace);
  if (!prefix) {
    const hex = String(namespace).replace(/[{}-]/g, '');
    if (!/^[0-9a-f]{32}$/i.test(hex))
      throw new DataError(`Invalid namespace GUID: ${namespace}`, 400, 'InvalidRequest');
    prefix = Buffer.from(hex, 'hex');
    // A process sees a few namespaces (its organizations and fixed ones); the bound only caps memory.
    if (typeof namespace === 'string' && namespaceBytes.size < 256) namespaceBytes.set(namespace, prefix);
  }
  // One-shot SHA-1 of the namespace bytes and the UTF-8 name: the same digest without a Hash object per id.
  const bytes = hash('sha1', Buffer.concat([prefix, Buffer.from(String(name), 'utf8')]), 'buffer').subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
