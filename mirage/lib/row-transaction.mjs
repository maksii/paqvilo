import { cloneStateData } from './state-clone.mjs';
import { assignRecordValues, materializeRecord, pagedRecordsOf } from './record-tables.mjs';
import { privateRecordEqual } from './record-clone.mjs';

export function validateRowIndex(rows, index, insertion = false) {
  if (
    !Array.isArray(rows) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= rows.length + Number(insertion) ||
    (!insertion && !Object.hasOwn(rows, index))
  )
    throw new RangeError('Row index must identify an own array element.');
}
export function assignRowValues(row, values) {
  if (assignRecordValues(row, values)) return;
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(row, key, { value, enumerable: true, configurable: true, writable: true });
}
function replaceRow(rows, index, row) {
  validateRowIndex(rows, index);
  Object.defineProperty(rows, index, { value: row, enumerable: true, configurable: true, writable: true });
}
function tableRows(target, table) {
  const rows = Object.getOwnPropertyDescriptor(target.tables, table)?.value;
  if (!Array.isArray(rows)) throw new TypeError('Rollback table must be an own row array.');
  return rows;
}

/** Undo entries retain only replaced rows. Metadata is small and captured
 * separately; table arrays and unchanged row bodies are never cloned.
 *
 * `reuse` (a transaction-level journal): a section copy that the previous journaled commit proved
 * deep-equal to the committed section (changes() compares every section anyway) is reused instead
 * of cloned again, while the store has committed nothing since and the section object is the same.
 * Mappings are nearly all of the section bytes, so ordinary row writes stop copying them per write.
 * The copy is single-use: a failed or promoted transaction leaves nothing to reuse. Like the journal,
 * this relies on sections changing only inside store transactions. */
export class RowTransaction {
  constructor(store, { reuse = false } = {}) {
    this.store = store;
    this.state = store.state;
    this.undo = [];
    this.entries = [];
    const cached = reuse ? store.sectionSnapshot : null;
    if (reuse) store.sectionSnapshot = null;
    const valid = cached?.state === store.state && cached.revision === store.revision;
    const reused = {},
      fresh = {};
    for (const [key, value] of Object.entries(store.state)) {
      if (key === 'tables') continue;
      const hit = valid ? cached.sections.get(key) : undefined;
      if (hit && hit.value === value) reused[key] = hit.copy;
      else fresh[key] = value;
    }
    const copies = cloneStateData(fresh, { forkTables: true });
    // Keep the state's section order (rollback re-adds removed sections in this order).
    this.metadata = Object.fromEntries(
      Object.keys(store.state)
        .filter((key) => key !== 'tables')
        .map((key) => [key, Object.hasOwn(reused, key) ? reused[key] : copies[key]]),
    );
    this.unchanged = new Set();
    this.compared = false;
    this.tables = new Set(Object.keys(store.state.tables));
    this.lengths = new Map(Object.entries(store.state.tables).map(([table, rows]) => [table, rows?.length]));
  }
  set(table, rows, index, row) {
    validateRowIndex(rows, index);
    const previous = rows.at(index);
    const snapshot = pagedRecordsOf(rows)?.fork();
    if (snapshot) {
      this.undo.push((target) =>
        pagedRecordsOf(target === this.state ? rows : tableRows(target, table)).restore(snapshot),
      );
    } else
      this.undo.push((target) =>
        replaceRow(
          target === this.state ? rows : tableRows(target, table),
          index,
          target === this.state ? previous : materializeRecord(previous),
        ),
      );
    replaceRow(rows, index, row);
    this.entries.push({ op: 'set', table, index, row });
  }
  mutate(table, rows, index, values) {
    validateRowIndex(rows, index);
    const row = rows.at(index),
      previous = materializeRecord(row);
    const snapshot = pagedRecordsOf(rows)?.fork();
    if (snapshot)
      this.undo.push((target) => {
        const destination = pagedRecordsOf(target === this.state ? rows : tableRows(target, table));
        destination.restore(snapshot, target === this.state ? row : null, previous, index);
      });
    else
      this.undo.push((target) => {
        const destination = target === this.state ? row : tableRows(target, table).at(index);
        for (const key of Object.keys(destination)) delete destination[key];
        assignRowValues(destination, target === this.state ? previous : materializeRecord(previous));
      });
    assignRowValues(row, values);
    this.entries.push({ op: 'set', table, index, row });
  }
  insert(table, rows, index, row) {
    validateRowIndex(rows, index, true);
    const snapshot = pagedRecordsOf(rows)?.fork();
    this.undo.push((target) => {
      const destination = target === this.state ? rows : tableRows(target, table);
      if (snapshot) pagedRecordsOf(destination).restore(snapshot);
      else destination.splice(index, 1);
    });
    rows.splice(index, 0, row);
    this.entries.push({ op: 'insert', table, index, row });
  }
  remove(table, rows, index) {
    validateRowIndex(rows, index);
    const previous = rows.at(index);
    const snapshot = pagedRecordsOf(rows)?.fork();
    if (snapshot)
      this.undo.push((target) =>
        pagedRecordsOf(target === this.state ? rows : tableRows(target, table)).restore(snapshot),
      );
    else
      this.undo.push((target) =>
        (target === this.state ? rows : tableRows(target, table)).splice(
          index,
          0,
          target === this.state ? previous : materializeRecord(previous),
        ),
      );
    rows.splice(index, 1);
    this.entries.push({ op: 'delete', table, index });
  }
  /**
   * Tables this transaction wrote through its row operations, tables it allocated or removed, and,
   * defensively, any table whose row count changed outside the row operations.
   */
  touchedTables() {
    const tables = new Set(this.entries.map((entry) => entry.table));
    for (const [table, length] of this.lengths) if (this.state.tables[table]?.length !== length) tables.add(table);
    for (const table of Object.keys(this.state.tables)) if (!this.tables.has(table)) tables.add(table);
    for (const table of this.tables) if (!Object.hasOwn(this.state.tables, table)) tables.add(table);
    return tables;
  }
  *changes() {
    // New tables may have been allocated before their first row operation.
    for (const table of Object.keys(this.state.tables)) if (!this.tables.has(table)) yield { op: 'table', table };
    for (const entry of this.entries) yield entry;
    for (const key of Object.keys(this.metadata))
      if (!Object.hasOwn(this.state, key)) yield { op: 'remove-section', key };
    for (const [key, value] of Object.entries(this.state)) {
      if (key === 'tables') continue;
      if (!privateRecordEqual(value, this.metadata[key])) yield { op: 'section', key, value };
      else this.unchanged.add(key);
    }
    this.compared = true;
  }
  /** After a fully compared commit: the section copies proven equal to the committed sections. */
  reusableSections() {
    if (!this.compared || this.promoted) return null;
    return {
      state: this.state,
      sections: new Map([...this.unchanged].map((key) => [key, { value: this.state[key], copy: this.metadata[key] }])),
    };
  }
  /**
   * Undo every row operation and restore the sections. `restoreSection(current, saved)` (a savepoint
   * inside a running pipeline) restores only changed sections, in place, so held references stay valid.
   */
  rollback(target = this.state, restoreSection = null) {
    for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i](target);
    for (const key of Object.keys(target))
      if (key !== 'tables' && !Object.hasOwn(this.metadata, key)) delete target[key];
    for (const [key, value] of Object.entries(this.metadata)) {
      if (restoreSection && Object.hasOwn(target, key)) {
        if (!privateRecordEqual(target[key], value)) target[key] = restoreSection(target[key], value);
        continue;
      }
      Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
    }
    for (const table of Object.keys(target.tables)) if (!this.tables.has(table)) delete target.tables[table];
    if (target === this.state) this.store.state = this.state;
    return target;
  }
}
