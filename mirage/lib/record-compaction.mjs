import { RecordPageSession, pagedRecordsOf } from './record-tables.mjs';
import { encodeRecordReferences } from './record-state.mjs';

const at = (value, path) => path.reduce((current, key) => current[key], value);

/** Build an unpublished replacement. Metadata and unchanged plain arrays keep
 * their references; only paths to paged tables are copied. */
export async function compactRecordGraph(state, directory, owner) {
  const encoded = encodeRecordReferences({ op: 'section', key: 'state', value: state });
  if (!encoded.recordRefs?.length) return null;
  const session = new RecordPageSession(directory, typeof owner === 'string' ? { ownerKey: owner } : owner),
    replacements = new Map(),
    sources = [];
  try {
    for (const reference of encoded.recordRefs) {
      const path = reference.path.slice(1),
        original = at(state, path);
      let replacement = replacements.get(original);
      if (!replacement) {
        const source = pagedRecordsOf(original),
          fingerprint = source.fingerprint();
        replacement = await session.copyTable(original);
        replacements.set(original, replacement);
        sources.push({ source, original, replacement, fingerprint });
      }
      const parent = at(encoded.value, path.slice(0, -1));
      Object.defineProperty(parent, path.at(-1), {
        value: replacement,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    if (sources.some(({ source, fingerprint }) => source.fingerprint() !== fingerprint))
      throw Object.assign(Error('Local records changed during compaction'), { code: 'StateConflict', status: 409 });
    return {
      state: encoded.value,
      session,
      /** Adopt the copies unless a table changed after it was copied; then the
       * live tables stay as they are, false is returned, and the caller persists them. */
      publish() {
        if (sources.some(({ source, fingerprint }) => source.fingerprint() !== fingerprint)) return false;
        for (const { source, replacement } of sources) source.adopt(replacement);
        return true;
      },
    };
  } catch (error) {
    session.close();
    throw error;
  }
}
