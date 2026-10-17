import { isDeepStrictEqual } from 'node:util';

export function validateRowIndex(rows, index, insertion = false) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(index) || index < 0 || index >= rows.length + Number(insertion) || !insertion && !Object.hasOwn(rows, index))
    throw new RangeError('Row index must identify an own array element.');
}
export function assignRowValues(row, values) {
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
 * separately; table arrays and unchanged row bodies are never cloned. */
export class RowTransaction {
  constructor(store) {
    this.store = store; this.state = store.state; this.undo = []; this.entries = [];
    this.metadata = structuredClone(Object.fromEntries(Object.entries(store.state).filter(([key]) => key !== 'tables')));
    this.tables = new Set(Object.keys(store.state.tables));
  }
  set(table, rows, index, row) {
    validateRowIndex(rows, index);
    const previous = rows.at(index);
    this.undo.push(target => replaceRow(target === this.state ? rows : tableRows(target, table), index, target === this.state ? previous : structuredClone(previous)));
    replaceRow(rows, index, row); this.entries.push({ op: 'set', table, index, row });
  }
  mutate(table, rows, index, values) {
    validateRowIndex(rows, index);
    const row = rows.at(index), previous = structuredClone(row);
    this.undo.push(target => {
      const destination = target === this.state ? row : tableRows(target, table).at(index);
      for (const key of Object.keys(destination)) delete destination[key];
      assignRowValues(destination, target === this.state ? previous : structuredClone(previous));
    });
    assignRowValues(row, values); this.entries.push({ op: 'set', table, index, row });
  }
  insert(table, rows, index, row) {
    validateRowIndex(rows, index, true);
    this.undo.push(target => (target === this.state ? rows : tableRows(target, table)).splice(index, 1)); rows.splice(index, 0, row);
    this.entries.push({ op: 'insert', table, index, row });
  }
  remove(table, rows, index) {
    validateRowIndex(rows, index);
    const previous = rows.at(index); this.undo.push(target => (target === this.state ? rows : tableRows(target, table)).splice(index, 0, target === this.state ? previous : structuredClone(previous)));
    rows.splice(index, 1); this.entries.push({ op: 'delete', table, index });
  }
  *changes() {
    // New tables may have been allocated before their first row operation.
    for (const table of Object.keys(this.state.tables)) if (!this.tables.has(table)) yield { op: 'table', table };
    for (const entry of this.entries) yield entry;
    for (const key of Object.keys(this.metadata)) if (!Object.hasOwn(this.state, key)) yield { op: 'remove-section', key };
    for (const [key, value] of Object.entries(this.state)) {
      if (key !== 'tables' && !isDeepStrictEqual(value, this.metadata[key])) yield { op: 'section', key, value };
    }
  }
  rollback(target = this.state) {
    for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i](target);
    for (const key of Object.keys(target)) if (key !== 'tables' && !Object.hasOwn(this.metadata, key)) delete target[key];
    for (const [key, value] of Object.entries(this.metadata))
      Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
    for (const table of Object.keys(target.tables)) if (!this.tables.has(table)) delete target.tables[table];
    if (target === this.state) this.store.state = this.state;
    return target;
  }
}
