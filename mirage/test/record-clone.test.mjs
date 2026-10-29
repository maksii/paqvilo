import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordPageSession, pagedRecordsOf } from '../lib/record-tables.mjs';
import { cloneStateData } from '../lib/state-clone.mjs';
import { jsonChunks } from '../lib/state-stream.mjs';
import { privateRecordEqual } from '../lib/record-clone.mjs';

test('record state copies preserve public data, held aliases, native types and private page forks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-clone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new RecordPageSession(root);
  t.after(() => session.close());
  const rows = session.from([{ id: 'one', nested: { value: 1 } }, { id: 'two' }], { primaryKey: 'id' });
  rows.push(rows[0]);
  rows.length = 5;
  const buffer = new ArrayBuffer(16),
    bytes = new Uint8Array(buffer, 4, 5),
    view = new DataView(buffer, 2, 10);
  const state = {
    tables: { item: rows },
    held: rows[0],
    buffer,
    bytes,
    view,
    date: new Date(0),
    map: new Map([[rows[0], new Set([rows[1]])]]),
  };
  state.self = state;
  const copy = cloneStateData(state);
  assert.equal(pagedRecordsOf(copy.tables.item), undefined);
  assert.equal(copy.self, copy);
  assert.equal(copy.tables.item[0], copy.held);
  assert.equal(copy.tables.item[0], copy.tables.item[2]);
  assert.equal(3 in copy.tables.item, false);
  assert.equal([...copy.map.keys()][0], copy.held);
  assert.equal([...copy.map.values()][0].has(copy.tables.item[1]), true);
  assert.equal(copy.buffer, copy.bytes.buffer);
  assert.equal(copy.buffer, copy.view.buffer);
  assert.equal(copy.view.byteOffset, 2);
  assert.equal(copy.bytes.byteLength, 5);
  assert.notEqual(copy.buffer, buffer);
  assert.deepEqual(copy.date, new Date(0));
  copy.held.nested.value = 2;
  assert.equal(rows[0].nested.value, 1);
  const privateCopy = cloneStateData({ tables: { item: rows } }, { forkTables: true });
  assert.ok(pagedRecordsOf(privateCopy.tables.item));
  privateCopy.tables.item[0].nested.value = 3;
  assert.equal(rows[0].nested.value, 1);
  const before = session.info().materializedRows;
  assert.equal(
    [...jsonChunks({ tables: { item: rows } })].join(''),
    JSON.stringify({
      tables: {
        item: copy.tables.item.map((row) => row && { ...row, ...(row.nested ? { nested: { value: 1 } } : {}) }),
      },
    }),
  );
  assert.equal(
    session.info().materializedRows,
    before,
    'Serialization reads raw immutable rows without constructing a proxy per record.',
  );
  assert.throws(() => cloneStateData({ rows, unsupported: new URL('https://example.invalid') }), {
    name: 'DataCloneError',
  });
});

test('private equality retains native metadata types and distinguishes identical locators from different record files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-equality-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new RecordPageSession(path.join(root, 'first')),
    second = new RecordPageSession(path.join(root, 'second'));
  t.after(() => {
    first.close();
    second.close();
  });
  const rows = first.from([{ id: 'one', value: 1 }]),
    other = second.from([{ id: 'one', value: 2 }]);
  const state = { tables: { item: rows }, settings: { date: new Date(0) } };
  const fork = cloneStateData(state, { forkTables: true });
  first.readRow = () => {
    throw Error('Unexpected record decoding');
  };
  assert.equal(privateRecordEqual(state, fork), true);
  assert.equal(privateRecordEqual(state, { ...state, tables: { item: other } }), false);
  assert.equal(privateRecordEqual(state, { ...fork, settings: { date: new Date(0).toISOString() } }), false);
});
