import { stateDigest } from './state-stream.mjs';
import { pagedRecordsOf } from './record-tables.mjs';

// An envelope preserves object-property omission (undefined versus null).
const fingerprint = (value) => stateDigest({ value }, { sortKeys: true, recordVersions: true });

/** Bounded comparison receipts, without retaining another state graph. */
export function initializationFingerprint(state) {
  return {
    sections: new Map(
      Object.keys(state)
        .filter((key) => key !== 'tables')
        .map((key) => [key, fingerprint(state[key])]),
    ),
    tables: new Map(Object.keys(state.tables ?? {}).map((name) => [name, fingerprint(state.tables[name])])),
  };
}

/** A changed table retains its existing rows, not an operation object per row. */
export function initializationDelta(before, state) {
  const changes = [],
    after = initializationFingerprint(state);
  for (const key of before.sections.keys()) if (!Object.hasOwn(state, key)) changes.push({ op: 'remove-section', key });
  for (const key of Object.keys(state))
    if (key !== 'tables' && before.sections.get(key) !== after.sections.get(key))
      changes.push({ op: 'section', key, value: state[key] });
  const tables = state.tables ?? {};
  for (const table of before.tables.keys())
    if (!Object.hasOwn(tables, table)) changes.push({ op: 'remove-table', table });
  for (const table of Object.keys(tables))
    if (before.tables.get(table) !== after.tables.get(table))
      changes.push({ op: 'replace-table', table, rows: tables[table] });
  return { changes, fingerprint: after };
}

/** Existing journal operations/checksums preserve atomic restart and recovery. */
export function* initializationEntries(changes) {
  for (const change of changes) {
    if (change.op !== 'replace-table') {
      yield change;
      continue;
    }
    if (pagedRecordsOf(change.rows)) {
      yield { op: 'table-value', table: change.table, value: change.rows };
      continue;
    }
    yield { op: 'table', table: change.table };
    for (let index = 0; index < change.rows.length; index++)
      yield { op: 'insert', table: change.table, index, row: change.rows[index] };
  }
}
