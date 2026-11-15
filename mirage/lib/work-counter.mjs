// The work counters of each DataStore (DataStore#work): rows that table scans and index builds iterate (rowsVisited)
// and key-index probes (indexLookups). Each loop adds its row count once, so a scan costs one addition.
// A leaf module without imports, so any module can count without an import cycle.
const storeWork = new WeakMap();

/** Starts the work counters of `store` at zero. */
export function trackWork(store) {
  storeWork.set(store, { rowsVisited: 0, indexLookups: 0 });
}

/** The live counters of `store` (undefined for a store without counters). */
export function workOf(store) {
  return storeWork.get(store);
}

/** Adds `amount` to the work counter `name` of `store`; a store without counters is not counted. */
export function countWork(store, name, amount) {
  const work = storeWork.get(store);
  if (work) work[name] += amount;
}
