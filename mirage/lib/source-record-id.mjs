import { createHash } from 'node:crypto';

/** Host-independent local identity when an export intentionally omits a GUID. */
export function sourceRecordId(kind, key) {
  const hex = createHash('sha256')
    .update(`${kind}\0${String(key).toLowerCase()}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
