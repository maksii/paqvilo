// @test-kind contract: alternate-key indexes return the first row selected by Paqvilo value equality, inside and outside a transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { valuesEqual } from '../lib/dataverse-values.mjs';

const PLAIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const NFC = 'áaaaaaaa-0000-4000-8000-000000000001';
const NFD = 'a\u0301aaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const VALUES = [PLAIN, NFC, NFD, `{${PLAIN.toUpperCase()}}`, `(${PLAIN})`, ` ${PLAIN} `];
const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const escapeKey = (value) => value.replaceAll("'", "''");
function fixture(type, collation, values) {
  const state = emptyState();
  state.settings.collation = collation;
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    alternateKeys: [
      { name: 'x_code_key', attributes: ['x_code'] },
      { name: 'x_composite_key', attributes: ['x_code', 'x_region'] },
    ],
    fields: { x_code: type ? { dataverseType: type } : {}, x_region: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = values.map(([x_code, x_region], index) => ({ x_itemid: id(index + 1), x_code, x_region }));
  const store = new DataStore({ state });
  return { store, mapping: store.resolveMapping('x_item'), rows: store.state.tables.x_item };
}
function expectedRow(rows, literal, region, kind, collation) {
  return rows.find(
    (row) =>
      valuesEqual(row.x_code, literal, { kind, collation }) &&
      (region === null || valuesEqual(row.x_region, region, { kind: 'string', collation })),
  );
}
function key(literal, region = null) {
  return `x_code='${escapeKey(literal)}'${region === null ? '' : `,x_region='${escapeKey(region)}'`}`;
}

for (const [type, kind] of [
  ['nvarchar', 'string'],
  ['uniqueidentifier', 'guid'],
  ['lookup', 'lookup'],
  [null, null],
]) {
  for (const collation of ['CI_AI', 'CI_AS']) {
    test(`GUID-shaped alternate keys follow value equality and first-row ordering (${type ?? 'unknown'}, ${collation})`, async () => {
      // Each order places a different normalized/wild value first; duplicates deliberately exercise first-row selection.
      for (const values of [VALUES, [...VALUES].reverse()]) {
        const pairs = values.map((value, i) => [value, i % 2 ? 'south' : 'north']);
        pairs.push([values[0], pairs[0][1]]);
        const { store, mapping, rows } = fixture(type, collation, pairs);
        const cases = [...VALUES, OTHER].flatMap((literal) => [
          [literal, null],
          [literal, 'north'],
          [literal, 'south'],
          [literal, 'unrelated'],
        ]);
        for (const [literal, region] of cases) {
          const expected = expectedRow(rows, literal, region, kind, collation);
          assert.strictEqual(store.findByKey(mapping, key(literal, region)), expected, `${literal} / ${region}`);
        }
        await store.transact(
          () => {
            for (const [literal, region] of cases) {
              const expected = expectedRow(rows, literal, region, kind, collation);
              assert.strictEqual(store.findByKey(mapping, key(literal, region)), expected, `${literal} / ${region}`);
            }
          },
          { incremental: true },
        );
        assert.equal(expectedRow(rows, OTHER, null, kind, collation), undefined);
      }
    });
  }
}

test('CI_AS does not match accented GUID-shaped text to a plain GUID-shaped text', async () => {
  const { store, mapping } = fixture('nvarchar', 'CI_AS', [[PLAIN, 'north']]);
  for (const literal of [NFC, NFD, OTHER]) assert.strictEqual(store.findByKey(mapping, key(literal)), undefined);
  await store.transact(
    () => {
      for (const literal of [NFC, NFD, OTHER]) assert.strictEqual(store.findByKey(mapping, key(literal)), undefined);
    },
    { incremental: true },
  );
});

test('a newly wild row is re-read before a later matching bucket and forwards its sentinel', async () => {
  const { store, mapping, rows } = fixture('nvarchar', 'CI_AI', [
    [NFC, 'north'],
    ['other', 'north'],
  ]);
  const sentinel = new Error('wild verification getter');
  const reads = [];
  Object.defineProperty(rows[0], 'x_code', {
    configurable: true,
    enumerable: true,
    get() {
      reads.push('x_code');
      if (reads.length === 1) return NFC;
      throw sentinel;
    },
  });
  // Incremental, no-write transaction avoids a full state clone before lookup.
  await store.transact(
    () => {
      assert.throws(
        () => store.findByKey(mapping, key('other')),
        (error) => error === sentinel,
      );
      assert.deepEqual(reads, ['x_code', 'x_code']);
    },
    { incremental: true },
  );
});

test('an ambiguous literal scans to the first match without reading a later throwing getter', async () => {
  const { store, mapping, rows } = fixture('nvarchar', 'CI_AI', [
    [PLAIN, 'north'],
    ['other', 'north'],
  ]);
  const sentinel = new Error('later row getter');
  const reads = [];
  Object.defineProperty(rows[1], 'x_code', {
    configurable: true,
    enumerable: true,
    get() {
      reads.push('later');
      throw sentinel;
    },
  });
  await store.transact(
    () => {
      assert.strictEqual(store.findByKey(mapping, key(NFC)), rows[0]);
      assert.deepEqual(reads, []);
    },
    { incremental: true },
  );
});
