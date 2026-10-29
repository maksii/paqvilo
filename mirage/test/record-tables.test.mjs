import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordPageSession, pagedRecordsOf, materializeRecord, assignRecordValues } from '../lib/record-tables.mjs';
import { exactNumeric, stringifyExactJson } from '../lib/exact-numeric.mjs';

function session(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-paged-records-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = new RecordPageSession(root, options);
  t.after(() => result.close());
  return result;
}
const plain = (rows) => Array.from(rows, (row) => row && materializeRecord(row));

test('copying live pages compacts versions while preserving sparse order, held aliases, removed rows and older forks', async (t) => {
  const store = session(t),
    rows = store.from(
      [
        { id: 'one', value: 1 },
        { id: 'two', value: 2 },
        { id: 'three', value: 3 },
      ],
      { primaryKey: 'id' },
    );
  const old = pagedRecordsOf(rows).fork(),
    held = rows[0],
    removed = rows[1];
  for (let i = 0; i < 200; i++) held.value = i;
  rows.push(held);
  rows.splice(1, 1);
  delete rows[1];
  rows.length = 6;
  const before = plain(rows),
    prior = store.describe(rows);
  const compacted = new RecordPageSession(store.directory);
  t.after(() => compacted.close());
  const copy = await compacted.copyTable(rows);
  const receipt = compacted.describe(copy);
  assert.deepEqual(plain(copy), before);
  assert.equal(copy[0], copy[2]);
  assert.ok(
    receipt.files.reduce((sum, file) => sum + file.prefix.bytes, 0) <
      prior.files.reduce((sum, file) => sum + file.prefix.bytes, 0),
  );
  pagedRecordsOf(rows).adopt(copy);
  assert.equal(rows[0], held);
  assert.equal(rows[2], held);
  held.value = 900;
  assert.equal(rows[2].value, 900);
  assert.equal(old[0].value, 1);
  removed.value = 700;
  rows.push(removed);
  assert.equal(rows[6], removed);
  assert.equal(rows[6].value, 700);
  assert.deepEqual(pagedRecordsOf(rows).primaryPositions('id', 'one'), [0, 2]);
});

test('multi-column updates publish once and failed payload writes restore held rows and nested arrays', (t) => {
  const store = session(t),
    rows = store.from([{ id: 'one', first: 1, second: 2, values: [1, 2, 3] }], { primaryKey: 'id' });
  const row = rows[0],
    array = row.values,
    put = store.put.bind(store);
  let puts = 0;
  store.put = (...args) => {
    puts++;
    return put(...args);
  };
  assert.equal(assignRecordValues(row, { first: 3, second: 4, third: 5 }), true);
  assert.equal(puts, 1);
  const before = materializeRecord(row),
    fingerprint = pagedRecordsOf(rows).fingerprint();
  store.put = () => {
    throw Error('Invented record write');
  };
  assert.throws(() => assignRecordValues(row, { first: 8, fourth: 9 }), /Invented record write/);
  assert.deepEqual(materializeRecord(row), before);
  assert.throws(() => array.splice(1, 1, 8, 9), /Invented record write/);
  assert.deepEqual([...array], [1, 2, 3]);
  assert.equal(row.values, array);
  assert.equal(pagedRecordsOf(rows).fingerprint(), fingerprint);
  assert.deepEqual(pagedRecordsOf(rows).primaryPositions('id', 'one'), [0]);
  store.put = put;
});

test('cleanup closes every resource after a flush error and retries only an unfinished handle close', (t) => {
  const store = session(t);
  store.from([{ id: 'one' }]);
  const writer = store.writer(),
    io = writer.io;
  let failed = false;
  writer.io = {
    ...io,
    closeSync(fd) {
      if (!failed) {
        failed = true;
        throw Error('Invented close');
      }
      return io.closeSync(fd);
    },
  };
  assert.throws(() => store.close(), /cleanup failed/);
  assert.equal(fs.existsSync(store.lease.file), true, 'The unfinished handle retains its ownership lease.');
  store.close();
  assert.equal(writer.fd, null);
  assert.equal(fs.existsSync(store.lease.file), false);
  assert.equal(store.info().openFiles, 0);
});

test('lookup and ordinary edits avoid target-table decoding and index rebuilds', (t) => {
  const store = session(t),
    table = store.from(
      Array.from({ length: 80000 }, (_, i) => ({ id: 'id-' + i, value: i })),
      { primaryKey: 'id' },
    );
  const data = pagedRecordsOf(table),
    read = store.readRow.bind(store);
  let reads = 0;
  store.readRow = (...args) => {
    reads++;
    return read(...args);
  };
  for (let i = 0; i < 200; i++) assert.deepEqual(data.primaryPositions('id', 'id-' + i * 397), [i * 397]);
  assert.equal(reads, 0, 'Lookup follows key pages and numeric positions without decoding any target record.');
  store.flushRecords();
  const count = () =>
    store.files.reduce((sum, file) => sum + file.store.entries.filter((entry) => entry?.kind >= 4).length, 0);
  let before = count();
  table.push({ id: 'added' });
  assert.ok(count() - before <= 8, 'Create path-copies a few nodes rather than rebuilding the table index.');
  before = count();
  table.splice(1000, 1);
  assert.ok(count() - before <= 8, 'Delete retains immutable payload identities across shifted positions.');
  before = count();
  table.reverse();
  assert.equal(count(), before, 'Reordering needs no new record or key pages.');
  assert.deepEqual(data.primaryPositions('id', 'added'), [0]);
});

test('restarting through many immutable history files respects one shared descriptor budget', async (t) => {
  const first = session(t);
  let current = first,
    rows = first.from([{ id: 'first' }], { primaryKey: 'id' });
  for (let version = 0; version < 12; version++) {
    const descriptor = current.describe(rows);
    const next = new RecordPageSession(first.directory, { maxOpenFiles: 2, rawBytes: 0, materializedRows: 0 });
    t.after(() => next.close());
    [rows] = await next.restoreMany([descriptor]);
    current = next;
    rows.push({ id: 'version-' + version });
    assert.ok(current.info().openFiles <= 2);
    for (let index = 0; index < rows.length; index++) {
      assert.equal(pagedRecordsOf(rows).raw(index).id, index ? 'version-' + (index - 1) : 'first');
      assert.ok(current.info().openFiles <= 2);
    }
    assert.deepEqual(pagedRecordsOf(rows).primaryPositions('id', 'first'), [0]);
  }
});

test('persistent keys survive edits, duplicate IDs, aliases, reorder, deletion, snapshots and restoration', async (t) => {
  const store = session(t),
    guid = 'ABCDEF00-1111-2222-3333-444444444444';
  const table = store.from(
    Array.from({ length: 9000 }, (_, i) => ({ id: i === 0 ? '{' + guid + '}' : 'row-' + i, value: i })),
    { primaryKey: 'id', sortOptions: { entries: 1000, fanIn: 3 } },
  );
  const data = pagedRecordsOf(table),
    lookup = (id) => data.primaryPositions('id', id);
  assert.deepEqual(lookup('(' + guid.toLowerCase() + ')'), [0]);
  assert.deepEqual(lookup(' ' + guid), []);
  const before = data.fork(),
    held = table[4000];
  held.value = 9;
  held.id = 'duplicate';
  table.push({ id: 'duplicate', value: 10 }, held);
  assert.deepEqual(lookup('DUPLICATE'), [4000, 9000, 9001]);
  delete table[9001];
  table.splice(100, 5, { id: 'replacement' });
  assert.deepEqual(lookup('duplicate'), [3996, 8996]);
  table.reverse();
  assert.deepEqual(lookup('duplicate'), [1, 5001]);
  assert.deepEqual(pagedRecordsOf(before).primaryPositions('id', 'row-4000'), [4000]);
  assert.deepEqual(pagedRecordsOf(before).primaryPositions('id', 'duplicate'), []);
  table.length = 4000;
  assert.deepEqual(lookup('duplicate'), [1]);
  const descriptors = [store.describe(table), store.describe(before)];
  const restored = new RecordPageSession(store.directory);
  t.after(() => restored.close());
  const [current, old] = await restored.restoreMany(descriptors);
  assert.deepEqual(pagedRecordsOf(current).primaryPositions('id', 'duplicate'), [1]);
  assert.deepEqual(pagedRecordsOf(old).primaryPositions('id', 'row-4000'), [4000]);
  current.push({ id: 'after-restore' });
  assert.deepEqual(pagedRecordsOf(current).primaryPositions('id', 'after-restore'), [4000]);
  assert.ok(restored.info().keyBytes <= 2 * 1024 * 1024);
  assert.deepEqual(
    fs.readdirSync(store.directory).filter((name) => name.endsWith('.sort')),
    [],
  );
});

test('key indexes use the serialized key once and fall back for non-string primary keys', (t) => {
  const store = session(t);
  let reads = 0;
  const table = store.from(
    [
      {
        get id() {
          reads++;
          return 'stored-' + reads;
        },
      },
    ],
    { primaryKey: 'id' },
  );
  assert.equal(reads, 1);
  const data = pagedRecordsOf(table);
  assert.deepEqual(data.primaryPositions('id', 'stored-1'), [0]);
  table[0].id = 12;
  assert.equal(data.primaryPositions('id', 'stored-1'), null);
  const mixed = store.from([{ id: 'one' }, { id: 2 }, { id: 'three' }], { primaryKey: 'id' });
  assert.equal(pagedRecordsOf(mixed).primaryPositions('id', 'one'), null);
});

test('a real streamed table keeps array reads, page boundaries, Unicode and bounded caches', (t) => {
  const store = session(t, { decodedBytes: 64000, materializedRows: 5 });
  function* rows() {
    for (let i = 0; i < 4500; i++) yield { id: 'id-' + i, name: 'Δ 日本語 ' + i, quantity: i % 7 };
  }
  const table = store.from(rows());
  assert.ok(Array.isArray(table));
  assert.equal(table.length, 4500);
  assert.equal(Object.getOwnPropertyDescriptor(table, 'length').value, 4500);
  for (const i of [0, 511, 512, 4095, 4096, 4499]) assert.equal(table[i].id, 'id-' + i);
  assert.equal(table.find((row) => row.quantity === 6).id, 'id-6');
  assert.deepEqual(
    table
      .filter((row) => row.quantity === 0)
      .slice(0, 3)
      .map((row) => row.id),
    ['id-0', 'id-7', 'id-14'],
  );
  assert.ok(store.info().decodedBytes <= 64000);
  assert.ok(store.info().materializedRows <= 5);
  assert.equal(table[0], table[0]);
  const keys = Object.keys(table);
  assert.equal(keys.length, 4500);
  assert.equal(keys.at(-1), '4499');
});

test('nested writes and array methods persist once per changed record and forks stay detached', (t) => {
  const store = session(t);
  const table = store.from([
    { id: 'one', nested: { value: 1 }, list: [1, 2, 3] },
    { id: 'two', nested: { value: 2 } },
  ]);
  const before = pagedRecordsOf(table).fork();
  const row = table[0];
  row.nested.value = 3;
  row.list.splice(1, 1, 8, 9);
  assert.deepEqual(materializeRecord(table[0]), { id: 'one', nested: { value: 3 }, list: [1, 8, 9, 3] });
  assert.deepEqual(materializeRecord(before[0]), { id: 'one', nested: { value: 1 }, list: [1, 2, 3] });
  delete row.nested.value;
  assert.deepEqual(materializeRecord(table[0]).nested, {});
  before[0].nested.value = 10;
  assert.deepEqual(materializeRecord(table[0]).nested, {});
  assert.equal(table[0], row);
});

test('splice, reverse, aliases and removed held records retain their visible values and identity', (t) => {
  const store = session(t);
  const table = store.from([
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
    { id: 'c', value: 3 },
  ]);
  const first = table[0],
    last = table[2];
  table.reverse();
  assert.equal(table[0], last);
  assert.equal(table[2], first);
  first.value = 4;
  assert.equal(table[2].value, 4);
  table.push(first);
  assert.equal(table[2], table[3]);
  first.value = 5;
  assert.equal(table[2].value, 5);
  assert.equal(table[3].value, 5);
  const removed = table.splice(2, 2);
  assert.equal(removed[0], first);
  first.value = 6;
  assert.deepEqual(
    table.map((row) => row.id),
    ['c', 'b'],
  );
  table.unshift(first);
  assert.equal(table[0], first);
  assert.equal(table[0].value, 6);
  assert.deepEqual(
    table.map((row) => row.id),
    ['a', 'c', 'b'],
  );
});

test('length changes and holes survive chunk boundaries, deletion and copy-on-write forks', (t) => {
  const store = session(t);
  const table = store.from([{ id: 'one' }]);
  table.length = 4097;
  table[4096] = { id: 'last' };
  assert.equal(table.length, 4097);
  assert.equal(4095 in table, false);
  assert.equal(4096 in table, true);
  const before = pagedRecordsOf(table).fork();
  delete table[0];
  table.length = 3;
  assert.equal(0 in table, false);
  assert.equal(before[0].id, 'one');
  assert.equal(before[4096].id, 'last');
  assert.throws(() => {
    table.length = 1n;
  }, TypeError);
  assert.throws(() => table.splice(1n), TypeError);
  assert.throws(() => {
    table.length = -1;
  }, RangeError);
});

test('ordinal chunks fork without copying every record or changing serialized values', (t) => {
  const store = session(t);
  const rows = Array.from({ length: 4200 }, (_, i) => ({ id: String(i), text: 'Invented ' + i }));
  const table = store.from(rows),
    fork = pagedRecordsOf(table).fork();
  const originalChunks = pagedRecordsOf(table).chunks,
    copiedChunks = pagedRecordsOf(fork).chunks;
  assert.equal(originalChunks[0], copiedChunks[0]);
  fork[0].text = 'Changed';
  assert.notEqual(pagedRecordsOf(fork).chunks[0], originalChunks[0]);
  assert.equal(pagedRecordsOf(fork).chunks[1], originalChunks[1]);
  assert.equal(table[0].text, 'Invented 0');
  assert.equal(JSON.stringify(table), JSON.stringify(rows));
  const ref = store.putIndex(originalChunks[0].ids);
  assert.deepEqual(store.readIndex(ref), originalChunks[0].ids);
});

test('numeric storage markers retain their type and exact wire digits, and failed edits restore the old value', (t) => {
  const store = session(t);
  const original = { id: 'one', amount: exactNumeric('12345678901234567890.1234', 'Decimal'), nested: { value: 1 } };
  const table = store.from([original]),
    row = table[0];
  assert.deepEqual(materializeRecord(row), original);
  assert.equal(stringifyExactJson(materializeRecord(row)), stringifyExactJson(original));
  assert.throws(() => {
    row.amount = 1n;
  }, TypeError);
  assert.deepEqual(materializeRecord(row), original);
  assert.throws(() => {
    row.nested.self = row.nested;
  }, TypeError);
  assert.equal(Object.hasOwn(row.nested, 'self'), false);
  assert.deepEqual(pagedRecordsOf(table).raw(0), original);
});

test('large mutable records do not bypass the materialized-cache byte budget', (t) => {
  const store = session(t, { materializedBytes: 8192 });
  const table = store.from([{ id: 'one', text: 'short' }]);
  const held = table[0];
  held.text = 'x'.repeat(100000);
  assert.equal(store.info().materializedRows, 0);
  assert.equal(store.info().materializedBytes, 0);
  assert.equal(table[0], held, 'An explicitly held record keeps its identity outside the cache.');
  assert.equal(store.info().materializedRows, 0);
});

test('published tables reopen, widen new locators, retain old snapshots and verify actual counts', async (t) => {
  const store = session(t);
  const first = store.from(Array.from({ length: 4300 }, (_, i) => ({ id: String(i), value: i })));
  const before = store.describe(first);
  first[0].value = 10;
  delete first[3];
  const after = store.describe(first);
  const resumed = new RecordPageSession(store.directory, { rawBytes: 65536 });
  t.after(() => resumed.close());
  const [older, current] = await resumed.restoreMany([before, after]);
  assert.equal(older[0].value, 0);
  assert.equal(current[0].value, 10);
  assert.equal(3 in older, true);
  assert.equal(3 in current, false);
  current[0].value = 12;
  assert.equal(older[0].value, 0);
  assert.equal(first[0].value, 10);
  const changed = resumed.describe(current);
  assert.equal(changed.files.length, 2, 'Restoration creates a new owned writer instead of appending to an old file.');
  assert.ok(pagedRecordsOf(current).chunks[0].ids instanceof Float64Array);
  const final = new RecordPageSession(store.directory);
  t.after(() => final.close());
  const [again] = await final.restoreMany([changed]);
  assert.equal(again[0].value, 12);
  assert.equal(again[4299].value, 4299);
  assert.equal(3 in again, false);
  assert.equal(changed.records, 4299);
  assert.ok(resumed.info().rawBytes <= 65536);
  const invalid = new RecordPageSession(store.directory);
  t.after(() => invalid.close());
  await assert.rejects(invalid.restoreMany([{ ...changed, records: 4300 }]), /count disagrees/);
});

test('a sparse table stores only ordinal holes and cannot masquerade as generated records', async (t) => {
  const store = session(t),
    table = store.from([]);
  table.length = 100000;
  const descriptor = store.describe(table);
  assert.equal(descriptor.records, 0);
  assert.equal(descriptor.files.length, 0);
  assert.ok(pagedRecordsOf(table).chunks.every((chunk) => !chunk.ids));
  const restored = new RecordPageSession(store.directory);
  t.after(() => restored.close());
  const [again] = await restored.restoreMany([descriptor]);
  assert.equal(again.length, 100000);
  assert.equal(99999 in again, false);
  const invalid = new RecordPageSession(store.directory);
  t.after(() => invalid.close());
  await assert.rejects(invalid.restoreMany([{ ...descriptor, records: 100000 }]), /count disagrees/);
});
