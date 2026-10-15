import { isDeepStrictEqual } from 'node:util';

/** Undo entries retain only replaced rows. Metadata is small and captured
 * separately; table arrays and unchanged row bodies are never cloned. */
export class RowTransaction {
  constructor(store) {
    this.store = store; this.state = store.state; this.undo = []; this.entries = [];
    this.metadata = structuredClone(Object.fromEntries(Object.entries(store.state).filter(([key]) => key !== 'tables')));
    this.tables = new Set(Object.keys(store.state.tables));
  }
  set(table, rows, index, row) {
    const previous = rows[index]; this.undo.push(target => { (target === this.state ? rows : target.tables[table])[index] = target === this.state ? previous : structuredClone(previous); });
    rows[index] = row; this.entries.push({ op: 'set', table, index, row });
  }
  mutate(table, rows, index, values) {
    const row = rows[index], previous = structuredClone(row);
    this.undo.push(target => {
      const destination = target === this.state ? row : target.tables[table][index];
      for (const key of Object.keys(destination)) delete destination[key];
      for (const [key, value] of Object.entries(target === this.state ? previous : structuredClone(previous)))
        Object.defineProperty(destination, key, { value, enumerable: true, configurable: true, writable: true });
    });
    Object.assign(row, values); this.entries.push({ op: 'set', table, index, row });
  }
  insert(table, rows, index, row) {
    this.undo.push(target => (target === this.state ? rows : target.tables[table]).splice(index, 1)); rows.splice(index, 0, row);
    this.entries.push({ op: 'insert', table, index, row });
  }
  remove(table, rows, index) {
    const previous = rows[index]; this.undo.push(target => (target === this.state ? rows : target.tables[table]).splice(index, 0, target === this.state ? previous : structuredClone(previous)));
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
