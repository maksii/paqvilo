import { guidKey, scalar } from './dataverse-values.mjs';
import { fieldValue } from './fetchxml-engine.mjs';

/** One render owns this cache. It caches evaluation inputs, never query results. */
export class FetchRenderCache {
  constructor() {
    this.plans = new Map();
    this.stores = new WeakMap();
    this.indexes = new WeakMap();
  }
  plan(key, build) {
    if (!this.plans.has(key)) {
      if (this.plans.size >= 256) this.plans.delete(this.plans.keys().next().value);
      this.plans.set(key, build());
    }
    const plan = this.plans.get(key);
    return { ...plan, diagnostics: [...plan.diagnostics] };
  }
  readable(store, identity) {
    const revision = store.dataRevision();
    const identityKey = JSON.stringify([
      identity.admin,
      identity.id,
      identity.contactId,
      identity.accountId,
      [...(identity.roles ?? [])],
      [...(identity.roleIds ?? [])],
      identity.roleSource,
    ]);
    let entry = this.stores.get(store);
    if (
      !entry ||
      entry.revision !== revision ||
      entry.state !== store.state ||
      entry.observed !== store.observed ||
      entry.identity !== identityKey
    ) {
      entry = { revision, state: store.state, observed: store.observed, identity: identityKey, rows: new Map() };
      this.stores.set(store, entry);
      this.indexes = new WeakMap();
    }
    return entry.rows;
  }
  invalidate(store) {
    this.stores.delete(store);
    this.indexes = new WeakMap();
  }
  equalRows(rows, column, value) {
    const wanted = guidKey(scalar(value));
    if (!wanted) return rows;
    let columns = this.indexes.get(rows);
    if (!columns) this.indexes.set(rows, (columns = new Map()));
    let index = columns.get(column);
    if (!index) {
      index = new Map();
      index.fallback = [];
      index.positions = new Map(rows.map((row, position) => [row, position]));
      for (const row of rows) {
        const raw = scalar(fieldValue(row, column));
        const key = guidKey(raw);
        // Invented fixtures may use non-GUID identifiers. Keep their original
        // comparison/coercion behavior through the complete predicate.
        if (!key) {
          if (raw != null && raw !== '') index.fallback.push(row);
          continue;
        }
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(row);
      }
      columns.set(column, index);
    }
    const matches = index.get(wanted) ?? [];
    return index.fallback.length
      ? [...matches, ...index.fallback].sort((a, b) => index.positions.get(a) - index.positions.get(b))
      : matches;
  }
}
