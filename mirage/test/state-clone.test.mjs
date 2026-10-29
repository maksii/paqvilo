import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneStateData, plainDataObject } from '../lib/state-clone.mjs';

test('wide metadata maps retain ordinary spread semantics, descriptors, ordering and guarded keys', () => {
  const marker = Symbol('metadata'),
    shared = { value: 'Retained' },
    source = Object.create({ inherited: 'Excluded' });
  let reads = 0;
  Object.defineProperty(source, 'accessor', { enumerable: true, get: () => ++reads });
  Object.defineProperty(source, '__proto__', { enumerable: true, value: shared });
  Object.defineProperty(source, 'hidden', { value: 'Excluded' });
  source[marker] = shared;
  const wide = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => ['x_field' + index, index]));
  const expected = { ...source, ...wide, accessor: 'Override' };
  reads = 0;
  const actual = plainDataObject(source, wide, { accessor: 'Override' });
  assert.equal(reads, 1);
  assert.deepEqual(actual, expected);
  assert.deepEqual(Object.getOwnPropertyDescriptors(actual), Object.getOwnPropertyDescriptors(expected));
  assert.deepEqual(Reflect.ownKeys(actual), Reflect.ownKeys(expected));
  assert.equal(Object.getPrototypeOf(actual), Object.prototype);
  assert.equal(actual.__proto__, shared);
  assert.equal(actual[marker], shared);
  assert.deepEqual(plainDataObject(null, 'Δx', 5, undefined), { ...null, ...'Δx', ...5, ...undefined });
});

// Exercise the public dispatch through a genuinely bulk, sparse envelope.
// Holes keep compatibility cases cheap without exposing implementation helpers.
const copyPlainGraph = (value) => cloneStateData({ tables: { bulk: new Array(100000) }, value }).value;

test('bulk data copying preserves native clone aliases, cycles, holes, descriptors and scalar values', () => {
  const shared = { text: 'Δ 日本語', value: -0, integer: 123456789012345678901n, absent: undefined, number: NaN };
  const sparse = new Array(5);
  sparse[3] = shared;
  sparse.extra = shared;
  const nullPrototype = Object.create(null);
  nullPrototype.value = shared;
  const original = { a: shared, b: shared, sparse, nullPrototype };
  original.cycle = original;
  Object.defineProperty(original, '__proto__', { value: shared, enumerable: true });
  Object.defineProperty(original, 'frozen', { value: 'kept', enumerable: true, writable: false });
  Object.defineProperty(original, 'hidden', { value: 'not cloned' });
  original[Symbol('ignored')] = 'not cloned';
  const copy = copyPlainGraph(original);
  assert.deepEqual(copy, structuredClone(original));
  assert.notEqual(copy.a, shared);
  assert.equal(copy.a, copy.b);
  assert.equal(copy.a, copy.sparse[3]);
  assert.equal(copy.a, copy.sparse.extra);
  assert.equal(copy.cycle, copy);
  assert.ok(!(0 in copy.sparse));
  assert.equal(copy.sparse.length, 5);
  assert.equal(Object.getOwnPropertyDescriptor(copy, 'frozen').writable, true);
  assert.equal(Object.getPrototypeOf(copy.nullPrototype), Object.prototype);
  copy.a.text = 'changed';
  assert.equal(shared.text, 'Δ 日本語');
});

test('special types, getters and rejected values retain native structured-clone behavior', () => {
  for (const value of [
    new Date(0),
    new Map([['x', new Set([1, 2])]]),
    /abc/gi,
    new Uint8Array([1, 2]),
    new Error('invented'),
  ]) {
    const source = { value, again: value };
    assert.deepEqual(copyPlainGraph(source), structuredClone(source));
    const cloned = copyPlainGraph(source);
    assert.equal(cloned.value, cloned.again);
  }
  let reads = 0;
  const source = {
    a: { plain: true },
    get value() {
      reads++;
      return { value: 7 };
    },
  };
  assert.deepEqual(copyPlainGraph(source), { a: { plain: true }, value: { value: 7 } });
  assert.equal(reads, 1);
  for (const value of [() => {}, Symbol('x'), new Proxy({}, {})])
    assert.throws(() => copyPlainGraph({ value }), { name: 'DataCloneError' });
  assert.throws(() => copyPlainGraph({ value: JSON.rawJSON('12345678901234567890') }), { name: 'DataCloneError' });
});

test('copying creates own data properties without invoking inherited setters', () => {
  let writes = 0;
  Object.defineProperty(Object.prototype, '__paqviloCloneProbe', {
    set() {
      writes++;
    },
    configurable: true,
  });
  try {
    const source = { __paqviloCloneProbe: { value: 7 } };
    assert.deepEqual(copyPlainGraph(source), structuredClone(source));
    assert.equal(writes, 0);
  } finally {
    delete Object.prototype.__paqviloCloneProbe;
  }
});

test('inherited read-only properties and numeric array setters do not interfere with copying', () => {
  Object.defineProperty(Object.prototype, '__paqviloCloneReadonly', { value: 1, writable: false, configurable: true });
  let copy,
    writes = 0;
  try {
    const source = [{ __paqviloCloneReadonly: 7 }];
    Object.defineProperty(Array.prototype, '0', {
      set() {
        writes++;
      },
      configurable: true,
    });
    try {
      copy = copyPlainGraph(source);
    } finally {
      delete Array.prototype[0];
    }
    assert.deepEqual(copy, structuredClone(source));
    assert.equal(writes, 0);
  } finally {
    delete Object.prototype.__paqviloCloneReadonly;
  }
});

test('large state and table-section copies preserve every row and cross-table aliases', () => {
  const shared = { widgetid: 'shared', payload: 'kept' };
  const table = Array.from({ length: 100000 }, (_, i) => ({
    widgetid: String(i),
    payload: 'Retained immutable payload',
  }));
  table[100] = shared;
  const state = { tables: { widget: table, other: [shared] }, settings: { shared } };
  const copy = cloneStateData(state);
  assert.equal(copy.tables.widget.length, 100000);
  assert.equal(copy.tables.widget.at(-1).widgetid, '99999');
  assert.equal(copy.tables.widget[100], copy.tables.other[0]);
  assert.equal(copy.tables.other[0], copy.settings.shared);
  copy.tables.other[0].payload = 'changed';
  assert.equal(shared.payload, 'kept');
  const sections = cloneStateData(state.tables);
  assert.equal(sections.widget[100], sections.other[0]);
});

test('wide metadata graphs preserve fields, relationships and shared facts independently of row volume', () => {
  const facts = { source: 'invented/Entity.xml', labels: { 1033: 'Invented' } };
  const mappings = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [
      'x_table' + i,
      { fields: Object.fromEntries(Array.from({ length: 500 }, (_, j) => ['x_field' + j, { type: 'text', facts }])) },
    ]),
  );
  const copied = cloneStateData(mappings);
  assert.equal(Object.keys(copied.x_table199.fields).length, 500);
  assert.equal(copied.x_table0.fields.x_field0.facts, copied.x_table199.fields.x_field499.facts);
  assert.notEqual(copied.x_table0.fields.x_field0.facts, facts);
  copied.x_table0.fields.x_field0.facts.labels[1033] = 'Changed';
  assert.equal(facts.labels[1033], 'Invented');
});

test('section-only source snapshots detach mutable rows without duplicating large immutable XML through native serialization', () => {
  const row = { formxml: '<form>' + 'Invented XML '.repeat(1000) + '</form>', labels: { 1033: 'Invented' } };
  const dataverse = {
    sourceSolutionComponents: {
      baseline: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [String(index), { row }])),
    },
  };
  const native = globalThis.structuredClone;
  let copied;
  try {
    globalThis.structuredClone = (value) => {
      if (value?.dataverse?.sourceSolutionComponents || value?.sourceSolutionComponents)
        throw new Error('Whole source snapshot serialization is unavailable');
      return native(value);
    };
    copied = cloneStateData({ dataverse });
    assert.equal(cloneStateData(dataverse).sourceSolutionComponents.baseline[0].row.formxml, row.formxml);
  } finally {
    globalThis.structuredClone = native;
  }
  const first = copied.dataverse.sourceSolutionComponents.baseline[0].row;
  assert.notEqual(first, row);
  assert.equal(first, copied.dataverse.sourceSolutionComponents.baseline[999].row);
  first.labels[1033] = 'Changed';
  assert.equal(row.labels[1033], 'Invented');
});
