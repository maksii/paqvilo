import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordPageSession, pagedRecordsOf } from '../lib/record-tables.mjs';
import { cloneStateData } from '../lib/state-clone.mjs';
import { jsonChunks } from '../lib/state-stream.mjs';
import { privateRecordEqual, privateRecordEqualAsync } from '../lib/record-clone.mjs';
import { isDeepStrictEqual } from 'node:util';

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

test('private equality agrees with isDeepStrictEqual on ordinary and exotic values in one pass', async () => {
  const symbol = Symbol('invented');
  const sparse = () => {
    const values = [1, 2, 3];
    delete values[1];
    return values;
  };
  const holes = sparse();
  const extra = Object.assign([1, 2], { note: 1 });
  const cycle = { a: 1 },
    otherCycle = { a: 1 };
  cycle.self = cycle;
  otherCycle.self = otherCycle;
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  class Invented {
    constructor() {
      this.a = 1;
    }
  }
  const bare = Object.assign(Object.create(null), { a: 1 });
  let deep = {},
    otherDeep = {};
  for (let i = 0; i < 3000; i++) {
    deep = { next: deep };
    otherDeep = { next: otherDeep };
  }
  const cases = [
    [1, 1],
    [0, -0],
    [NaN, NaN],
    [1, '1'],
    [null, undefined],
    [{}, []],
    [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
    [{ a: 1 }, { a: 1, b: undefined }],
    [{ a: undefined }, { b: undefined }],
    [holes, [1, undefined, 3]],
    [holes, sparse()],
    [extra, [1, 2]],
    [extra, Object.assign([1, 2], { note: 1 })],
    [{ [symbol]: 1 }, {}],
    [{ [symbol]: 1 }, { [symbol]: 1 }],
    [{ [symbol]: 1 }, { [symbol]: 2 }],
    [cycle, otherCycle],
    [{ c: cycle }, { c: otherCycle }],
    [hidden, {}],
    [
      {
        get x() {
          return 1;
        },
      },
      { x: 1 },
    ],
    [new Invented(), { a: 1 }],
    [new Invented(), new Invented()],
    [bare, { a: 1 }],
    [bare, Object.assign(Object.create(null), { a: 1 })],
    [{ d: new Date(0) }, { d: new Date(0) }],
    [{ d: new Date(0) }, { d: new Date(1) }],
    [new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]])],
    [new Set([1, 2]), new Set([2, 1])],
    [{ s: new Set([{}]) }, { s: new Set([{}]) }],
    [new Uint8Array([1, 2]), new Uint8Array([1, 2])],
    [new Uint8Array([1]), new Int8Array([1])],
    [{ n: new Number(1) }, { n: new Number(1) }],
    [{ constructor: 'column' }, { constructor: 'column' }],
    [{ constructor: 'column' }, { constructor: 'other' }],
    [{}, Object.create({})],
    [Object.create(Array.prototype), []],
    [[[1, [2, { x: [3] }]]], [[1, [2, { x: [3] }]]]],
    [[[1, [2, { x: [3] }]]], [[1, [2, { x: [4] }]]]],
    [{ r: /a/g }, { r: /a/i }],
    [{ e: new Error('x') }, { e: new Error('x') }],
    [{ a: [1, { b: NaN }] }, { a: [1, { b: NaN }] }],
    [{ a: -0 }, { a: 0 }],
    [{ f: () => 1 }, { f: () => 1 }],
    [{ v: 1n }, { v: 1n }],
    [deep, otherDeep],
  ];
  for (const [a, b] of cases)
    for (const [left, right] of [
      [a, b],
      [b, a],
    ]) {
      // A graph too deep for native recursion throws the same error from both.
      const outcome = (compare) => {
        try {
          return compare();
        } catch (error) {
          return error.name;
        }
      };
      const expected = outcome(() => isDeepStrictEqual(left, right));
      assert.equal(
        outcome(() => privateRecordEqual(left, right)),
        expected,
      );
      assert.equal(await privateRecordEqualAsync(left, right, { quantum: 1 }).catch((error) => error.name), expected);
    }
});

test('asynchronous private equality yields after each bounded quantum of visited objects', async () => {
  const section = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => ['x_table' + i, { columns: Array.from({ length: 20 }, (_, c) => ({ c })) }]),
  );
  const stats = {};
  let turns = 0;
  const comparison = privateRecordEqualAsync(section, structuredClone(section), {
    quantum: 500,
    stats,
    pause: async () => {
      turns++;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  assert.equal(turns, 1, 'The first quantum runs synchronously and then yields.');
  assert.equal(await comparison, true);
  assert.equal(stats.visited, 1 + 300 * 22);
  assert.equal(stats.pauses, Math.ceil(stats.visited / 500) - 1);
  assert.equal(turns, stats.pauses);
});

test('private equality compares paged tables by version and facades by value without decoding tables', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-equality-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new RecordPageSession(root);
  t.after(() => session.close());
  const rows = session.from([{ id: 'one', nested: { value: 1 } }]);
  const facade = rows[0];
  const state = { settings: { rows, held: facade } };
  const copy = { settings: { rows: pagedRecordsOf(rows).fork(), held: { id: 'one', nested: { value: 1 } } } };
  session.readRow = () => {
    throw Error('Unexpected record decoding');
  };
  assert.equal(privateRecordEqual(state, copy), true);
  assert.equal(privateRecordEqual(state, { settings: { rows, held: { id: 'one', nested: { value: 2 } } } }), false);
  assert.equal(privateRecordEqual(state, { settings: { rows: [], held: facade } }), false);
  const map = { settings: new Map([['rows', rows]]) };
  assert.equal(privateRecordEqual(map, { settings: new Map([['rows', pagedRecordsOf(rows).fork()]]) }), true);
});

test('state copies detect record proxies during the copy instead of walking the graph first', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new RecordPageSession(root);
  t.after(() => session.close());
  const rows = session.from([{ id: 'one' }]);
  let reads = 0;
  const metadata = {
    get counted() {
      reads++;
      return { value: 1 };
    },
  };
  const plain = cloneStateData({ metadata });
  assert.deepEqual(plain, { metadata: { counted: { value: 1 } } });
  assert.equal(reads, 1, 'A graph without records is read once.');
  const nested = cloneStateData({ settings: { list: [rows] } }, { forkTables: true });
  assert.ok(pagedRecordsOf(nested.settings.list[0]));
  assert.throws(() => cloneStateData({ rows, fn: () => 1 }), { name: 'DataCloneError' });
  assert.throws(() => cloneStateData({ fn: () => 1 }), { name: 'DataCloneError' });
});
