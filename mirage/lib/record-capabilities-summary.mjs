/** Reuse fixed local CRUD summaries only inside HTTP serialization. Public state
 * callers receive detached values; storage adapters retain fresh dynamic reads. */
export function createRecordCapabilitiesSummary(store) {
  let previousNames, previous, encoded;
  const summary = ({ reuse = false } = {}) => {
    const names = Object.keys(store.state.mappings);
    if (!reuse || store.storageAdapter)
      return Object.fromEntries(
        names.map((name) => [
          name,
          store.storageAdapter?.recordCapabilities(name) ?? { create: true, update: true, delete: true },
        ]),
      );
    if (previousNames?.length === names.length && names.every((name, index) => name === previousNames[index]))
      return previous;
    previousNames = names;
    encoded = undefined;
    previous = Object.freeze(
      Object.fromEntries(names.map((name) => [name, Object.freeze({ create: true, update: true, delete: true })])),
    );
    return previous;
  };
  // Only the private immutable result may reuse serialized bytes. Adapter and
  // public results never enter this cache. Keep buffers for pending writes alive.
  summary.encoded = (value) =>
    value === previous && previous ? (encoded ??= Buffer.from(JSON.stringify(previous))) : undefined;
  return summary;
}
