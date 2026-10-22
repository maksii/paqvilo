// Cheap in-process activity counters for the /_sim/ dashboard (sim-dashboard-routes.mjs): O(1) increments by name, a
// snapshot copy, and `tick`, which moves on every change so a memoised view can key on it. Counts start at zero when the
// organization runtime starts; they are activity since start, never persisted.
export function createCounters() {
  const values = new Map();
  const counters = {
    tick: 0,
    increment(name, by = 1) {
      if (!by) return;
      values.set(name, (values.get(name) ?? 0) + by);
      counters.tick += 1;
    },
    get: name => values.get(name) ?? 0,
    snapshot: () => Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b))),
  };
  return counters;
}
