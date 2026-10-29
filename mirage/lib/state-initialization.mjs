import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { jsonChunks } from './state-stream.mjs';
import { pagedRecordsOf, rawRecordOf } from './record-tables.mjs';

// Receipts compare JSON content with sorted object keys: a reordered row or
// section is unchanged. A plain table's receipt is a list of row blocks. Block
// boundaries follow row keys, so an inserted or removed row changes one block
// instead of shifting every later one. A block hashes its rows' text, so an
// in-place edit outside the store's row operations is still detected.
const BLOCK_ROWS = 2048;
const BOUNDARY_MASK = 255;

// Comparison work yields to the event loop at least every 8 ms.
function pacer() {
  let at = performance.now();
  return async () => {
    if (performance.now() - at < 8) return;
    await nextTurn();
    at = performance.now();
  };
}

// An envelope preserves object-property omission (undefined versus null).
async function sectionFingerprint(value, pace) {
  const hash = createHash('sha256');
  for (const chunk of jsonChunks({ value }, { sortKeys: true, recordVersions: true })) {
    hash.update(chunk);
    await pace();
  }
  return hash.digest('hex');
}

// Sorted-key text of an ordinary flat row through a reused ordered object, as
// jsonChunks does; anything else (nested values, toJSON, proxies) uses
// jsonChunks itself. Undefined, function and symbol values are omitted alike.
function rowText(row, shapes) {
  const item = rawRecordOf(row) ?? row;
  if (
    item === null ||
    typeof item !== 'object' ||
    Array.isArray(item) ||
    types.isProxy(item) ||
    'toJSON' in item ||
    (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
  )
    return [...jsonChunks(row, { sortKeys: true, recordVersions: true })].join('') || 'null';
  const keys = Object.keys(item);
  let shape;
  candidates: for (const entry of shapes) {
    if (entry.keys.length !== keys.length) continue;
    for (let index = 0; index < keys.length; index++) if (entry.keys[index] !== keys[index]) continue candidates;
    shape = entry;
    break;
  }
  if (!shape) {
    const sorted = [...keys].sort();
    const ordered = Object.create(null);
    for (const key of sorted) ordered[key] = null;
    // Integer keys require lexical order rather than native numeric order.
    shape = { keys, sorted, ordered, numeric: sorted.some((key) => /^(?:0|[1-9]\d*)$/.test(key)) };
    if (shapes.length === 16) shapes.shift();
    shapes.push(shape);
  }
  for (const key of keys) {
    const value = item[key];
    if ((value !== null && typeof value === 'object') || typeof value === 'bigint')
      return [...jsonChunks(row, { sortKeys: true, recordVersions: true })].join('');
    shape.ordered[key] = value;
  }
  return shape.numeric ? JSON.stringify(item, shape.sorted) : JSON.stringify(shape.ordered);
}

const boundary = (row, idColumn) => {
  const value = idColumn === undefined ? undefined : (rawRecordOf(row) ?? row)?.[idColumn];
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value);
  let hash = 0x811c9dc5;
  // Identifiers vary most at their end; a bounded suffix keeps this cheap.
  for (let index = Math.max(0, text.length - 12); index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return ((hash ^ (hash >>> 16)) & BOUNDARY_MASK) === 0;
};

async function tableReceipt(rows, idColumn, pace) {
  const paged = pagedRecordsOf(rows);
  if (paged) return { version: paged.fingerprint() };
  const blocks = [],
    shapes = [];
  let hash = createHash('sha256'),
    count = 0;
  for (let index = 0; index < rows.length; index++) {
    hash.update(rowText(rows[index], shapes));
    hash.update('\n');
    count++;
    if (count === BLOCK_ROWS || index === rows.length - 1 || boundary(rows[index], idColumn)) {
      blocks.push({ hash: hash.digest('base64'), rows: count });
      hash = createHash('sha256');
      count = 0;
      await pace();
    }
  }
  return { length: rows.length, blocks };
}

/** Bounded comparison receipts, without retaining another state graph. */
export async function initializationFingerprint(state) {
  const pace = pacer(),
    sections = new Map(),
    tables = new Map();
  for (const key of Object.keys(state))
    if (key !== 'tables') sections.set(key, await sectionFingerprint(state[key], pace));
  for (const name of Object.keys(state.tables ?? {}))
    tables.set(name, await tableReceipt(state.tables[name], state.mappings?.[name]?.idColumn, pace));
  return { sections, tables };
}

// Row operations that turn the receipt's rows into `rows`. Unchanged blocks are
// matched in order (each next match is the earliest later block of both); the
// rows of the blocks between two matches are set, inserted or deleted.
function rowChanges(table, before, after, rows) {
  if (before.version !== undefined || after.version !== undefined) return null;
  const positions = new Map();
  before.blocks.forEach((block, index) => {
    const list = positions.get(block.hash);
    if (list) list.push(index);
    else positions.set(block.hash, [index]);
  });
  const entries = [];
  let i = 0,
    j = 0,
    position = 0;
  const replace = (untilBefore, untilAfter) => {
    let removed = 0,
      added = 0;
    for (; i < untilBefore; i++) removed += before.blocks[i].rows;
    for (; j < untilAfter; j++) added += after.blocks[j].rows;
    for (let offset = 0; offset < Math.min(removed, added); offset++)
      entries.push({ op: 'set', table, index: position + offset, row: rows[position + offset] });
    for (let offset = added; offset < removed; offset++) entries.push({ op: 'delete', table, index: position + added });
    for (let offset = removed; offset < added; offset++)
      entries.push({ op: 'insert', table, index: position + offset, row: rows[position + offset] });
    position += added;
  };
  while (i < before.blocks.length || j < after.blocks.length) {
    if (i < before.blocks.length && j < after.blocks.length && before.blocks[i].hash === after.blocks[j].hash) {
      position += after.blocks[j].rows;
      i++;
      j++;
      continue;
    }
    let next = null;
    for (let candidate = j; candidate < after.blocks.length && !next; candidate++) {
      const match = positions.get(after.blocks[candidate].hash)?.find((index) => index >= i);
      if (match !== undefined) next = [match, candidate];
    }
    replace(...(next ?? [before.blocks.length, after.blocks.length]));
    // Rewriting the table is never longer than one operation per row.
    if (entries.length > rows.length) return null;
  }
  return entries;
}

/** A changed plain table journals the rows between its unchanged blocks; a
 * rewritten table retains its existing rows, not an operation object per row. */
export async function initializationDelta(before, state) {
  const changes = [],
    after = await initializationFingerprint(state);
  for (const key of before.sections.keys()) if (!Object.hasOwn(state, key)) changes.push({ op: 'remove-section', key });
  for (const key of Object.keys(state))
    if (key !== 'tables' && before.sections.get(key) !== after.sections.get(key))
      changes.push({ op: 'section', key, value: state[key] });
  const tables = state.tables ?? {};
  for (const table of before.tables.keys())
    if (!Object.hasOwn(tables, table)) changes.push({ op: 'remove-table', table });
  for (const table of Object.keys(tables)) {
    const previous = before.tables.get(table),
      current = after.tables.get(table);
    if (previous && JSON.stringify(previous) === JSON.stringify(current)) continue;
    const rows = previous && rowChanges(table, previous, current, tables[table]);
    changes.push(rows ? { op: 'rows', table, entries: rows } : { op: 'replace-table', table, rows: tables[table] });
  }
  return { changes, fingerprint: after };
}

/** Existing journal operations/checksums preserve atomic restart and recovery. */
export function* initializationEntries(changes) {
  for (const change of changes) {
    if (change.op === 'rows') {
      yield* change.entries;
      continue;
    }
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
