import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDataset } from '../fixtures.mjs';

const id = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const schema = () => ({
  targets: { 'x_item/x_parent': ['x_item'], 'x_item/x_party': ['x_item', 'x_group'] },
  tables: {
    x_item: {
      primaryIdAttribute: 'x_itemid',
      attributes: {
        x_itemid: { name: 'x_itemid', type: 'primarykey' },
        x_value: { name: 'x_value', type: 'nvarchar', requiredLevel: 'required' },
        x_kind: {
          name: 'x_kind',
          type: 'picklist',
          optionSet: { options: [{ value: 0 }, { value: 1 }, { value: 2 }] },
        },
        x_tags: { name: 'x_tags', type: 'multiselectpicklist', optionSet: { options: [{ value: 0 }, { value: 1 }] } },
        x_parent: { name: 'x_parent', type: 'lookup' },
        x_party: { name: 'x_party', type: 'customer' },
      },
    },
    x_group: { primaryIdAttribute: 'x_groupid', attributes: { x_groupid: { name: 'x_groupid', type: 'primarykey' } } },
  },
});

test('population partitions missing, null, empty and populated without exposing values or changing inputs', () => {
  const input = {
    schema: schema(),
    tables: {
      x_item: [
        { x_itemid: id(1) },
        { x_itemid: id(2), x_value: null },
        { x_itemid: id(3), x_value: '' },
        { x_itemid: id(4), x_value: false },
        { x_itemid: id(5), x_value: 0 },
        { x_itemid: id(6), x_value: 'private fixture text' },
      ],
    },
  };
  const before = structuredClone(input),
    report = summarizeDataset(input);
  assert.deepEqual(report.tables.x_item.columns.x_value, {
    type: 'nvarchar',
    required: true,
    missing: 1,
    null: 1,
    empty: 1,
    populated: 3,
  });
  assert.equal(JSON.stringify(report).includes('private fixture text'), false);
  assert.equal(JSON.stringify(report).includes(id(1)), false);
  assert.deepEqual(input, before);
  assert.deepEqual(summarizeDataset({ ...input, tables: { x_item: [...input.tables.x_item].reverse() } }), report);
});

test('choice coverage counts row membership, preserves zero and distinguishes malformed/unlisted values', () => {
  const report = summarizeDataset({
    schema: schema(),
    tables: {
      x_item: [
        { x_kind: 0, x_tags: '0,1,1' },
        { x_kind: 1, x_tags: [0, 1] },
        { x_kind: 9, x_tags: '1,,' },
        { x_kind: [0, 1], x_tags: [] },
      ],
    },
  }).tables.x_item.columns;
  assert.deepEqual(report.x_kind.choice.options, [
    { value: 0, rows: 1 },
    { value: 1, rows: 1 },
    { value: 2, rows: 0 },
  ]);
  assert.equal(report.x_kind.choice.unlistedRows, 1);
  assert.equal(report.x_kind.choice.malformedRows, 1);
  assert.deepEqual(report.x_tags.choice.options, [
    { value: 0, rows: 2 },
    { value: 1, rows: 2 },
  ]);
  assert.equal(report.x_tags.choice.malformedRows, 1);
  assert.equal(report.x_tags.empty, 1);
});

test('lookup coverage resolves cycles and explicit existing rows and leaves polymorphic scalar references ambiguous', () => {
  const rows = [
    { x_itemid: id(1), x_parent: { id: id(2), logical_name: 'x_item' }, x_party: id(1) },
    { x_itemid: id(2), x_parent: id(1), x_party: { id: id(3), logical_name: 'x_group' } },
    { x_itemid: id(4), x_parent: id(99), x_party: { id: id(1), logical_name: 'x_other' } },
  ];
  const report = summarizeDataset({
    schema: schema(),
    tables: { x_item: rows },
    existing: { x_group: [{ x_groupid: id(3) }] },
  }).tables.x_item.columns;
  assert.deepEqual(report.x_parent.lookup, { resolved: 2, dangling: 1, ambiguous: 0, invalid: 0 });
  assert.deepEqual(report.x_party.lookup, { resolved: 1, dangling: 0, ambiguous: 1, invalid: 1 });
});

test('identity and unknown-column counts use own fields and normalized IDs without returning records', () => {
  const report = summarizeDataset({
    schema: schema(),
    tables: {
      x_item: [
        { x_itemid: id(1), x_extra: 'secret' },
        { x_itemid: `{${id(1).toUpperCase()}}`, x_extra: 'other' },
        { x_itemid: 'invalid' },
        {},
      ],
    },
  }).tables.x_item;
  assert.deepEqual(report.identity, { missing: 1, invalid: 1, duplicates: 1 });
  assert.deepEqual(report.unknownColumns, { x_extra: 2 });
  assert.deepEqual(summarizeDataset({ schema: schema(), tables: { x_item: [] } }).tables.x_item.columns.x_value, {
    type: 'nvarchar',
    required: true,
    missing: 0,
    null: 0,
    empty: 0,
    populated: 0,
  });
});

test('inspection limits and malformed inputs fail explicitly', () => {
  const unsafe = JSON.parse('{"__proto__":[]}');
  assert.throws(
    () => summarizeDataset({ schema: { tables: JSON.parse('{"__proto__":{"attributes":{}}}') }, tables: unsafe }),
    /metadata/,
  );
  const malformed = schema();
  malformed.tables.x_item.attributes.x_bad = { name: '__proto__', type: 'nvarchar' };
  assert.throws(() => summarizeDataset({ schema: malformed, tables: { x_item: [] } }), /logical names/);
  assert.throws(() => summarizeDataset({ schema: schema(), tables: { x_other: [] } }), /metadata/);
  assert.throws(() => summarizeDataset({ schema: schema(), tables: { x_item: [null] } }), /plain objects/);
  assert.throws(() => summarizeDataset({ schema: schema(), tables: { x_item: Array(100001).fill({}) } }), /100000/);
  let nested = 0;
  for (let i = 0; i < 35; i++) nested = [nested];
  assert.throws(
    () => summarizeDataset({ schema: schema(), tables: { x_item: [{ x_tags: nested }] } }),
    /inspection limit/,
  );
});

test('single-choice arrays and strings and nested multiselect arrays never certify option coverage', () => {
  const report = summarizeDataset({
    schema: schema(),
    tables: {
      x_item: [{ x_kind: [1], x_tags: [[1]] }, { x_kind: '1' }, { x_kind: { value: 1 }, x_tags: [{ value: 1 }] }],
    },
  }).tables.x_item.columns;
  assert.equal(report.x_kind.choice.malformedRows, 2);
  assert.equal(report.x_tags.choice.malformedRows, 1);
  assert.equal(report.x_kind.choice.options.find((option) => option.value === 1).rows, 1);
  assert.equal(report.x_tags.choice.options.find((option) => option.value === 1).rows, 1);
});

test('aliased choice/member and option metadata products share the aggregate inspection budget', () => {
  const values = Array(1000).fill(1);
  assert.throws(
    () => summarizeDataset({ schema: schema(), tables: { x_item: Array(1500).fill({ x_tags: values }) } }),
    /inspection limit/,
  );
  const input = schema(),
    options = Array(100000).fill({ value: 1 });
  input.tables.x_item.attributes = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      `x_kind${i}`,
      { name: `x_kind${i}`, type: 'picklist', optionSet: { options } },
    ]),
  );
  assert.throws(() => summarizeDataset({ schema: input, tables: { x_item: [] } }), /inspection limit/);
});
