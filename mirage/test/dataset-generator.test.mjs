import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset, mergeDataset, findDanglingLookups } from '../fixtures.mjs';

const id = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function schema() {
  const table = (name, attributes) => ({
    primaryIdAttribute: `${name}id`,
    attributes: Object.fromEntries(
      [{ name: `${name}id`, type: 'primarykey' }, ...attributes].map((attribute) => [attribute.name, attribute]),
    ),
  });
  return {
    optionSets: {},
    targets: { 'x_item/x_group': ['x_group'], 'x_group/x_item': ['x_item'] },
    tables: {
      x_group: table('x_group', [
        { name: 'x_name', type: 'nvarchar', requiredLevel: 'required', maxLength: 40 },
        { name: 'x_item', type: 'lookup', requiredLevel: 'required' },
      ]),
      x_item: table('x_item', [
        { name: 'x_name', type: 'nvarchar', requiredLevel: 'required', maxLength: 40 },
        { name: 'x_group', type: 'lookup', requiredLevel: 'required' },
        { name: 'x_number', type: 'int', minValue: 0, maxValue: 20 },
        { name: 'x_amount', type: 'decimal', minValue: 0, maxValue: 10, precision: 2 },
        { name: 'x_flag', type: 'bit' },
        { name: 'x_derived', type: 'nvarchar', validForCreate: false },
        { name: 'x_shadow', type: 'nvarchar', attributeOf: 'x_name' },
        { name: 'x_kind', type: 'picklist', optionSet: { options: [{ value: 10 }, { value: 20 }] } },
      ]),
    },
  };
}
const plan = () => ({ schema: schema(), counts: { x_item: 5, x_group: 2 }, seed: 'unit-seed' });

test('different table counts and required lookup cycles produce a valid additive dataset', () => {
  const options = plan(),
    untouched = structuredClone(options);
  const fragment = generateDataset(options);
  assert.equal(fragment.tables.x_item.length, 5);
  assert.equal(fragment.tables.x_group.length, 2);
  const state = {
    mappings: { x_item: { idColumn: 'x_itemid' }, x_group: { idColumn: 'x_groupid' } },
    tables: {},
    permissions: [],
  };
  const merged = mergeDataset(state, fragment);
  assert.deepEqual(findDanglingLookups(merged.state), []);
  assert.equal(merged.report.generated.x_item.added, 5);
  assert.equal(mergeDataset(merged.state, fragment).report.generated.x_item.alreadyPresent, 5);
  assert.deepEqual(options, untouched);
  assert.deepEqual(generateDataset(options), fragment);
  assert.notEqual(
    generateDataset({ ...options, seed: 'other' }).tables.x_item[0].x_itemid,
    fragment.tables.x_item[0].x_itemid,
  );
});

test('constant, cycling choices, numeric sequence and bounded seeded ranges follow metadata', () => {
  const options = {
    ...plan(),
    rules: {
      x_item: {
        x_name: { kind: 'constant', value: 'Local sample' },
        x_kind: { kind: 'one-of', values: [10, 20] },
        x_number: { kind: 'sequence', start: 2, step: 3 },
        x_amount: { kind: 'range', min: 1.25, max: 2.75 },
        x_flag: { kind: 'constant', value: true },
      },
    },
  };
  const rows = generateDataset(options).tables.x_item;
  assert.deepEqual(
    rows.map((row) => row.x_kind),
    [10, 20, 10, 20, 10],
  );
  assert.deepEqual(
    rows.map((row) => row.x_number),
    [2, 5, 8, 11, 14],
  );
  assert.ok(rows.every((row) => row.x_name === 'Local sample' && row.x_flag === true));
  assert.ok(rows.every((row) => row.x_amount >= 1.25 && row.x_amount <= 2.75));
  assert.deepEqual(generateDataset(options).tables, generateDataset(options).tables);
});

test('random selection is stable when selected tables and existing rows are reordered', () => {
  const options = {
    ...plan(),
    rules: {
      x_item: {
        x_kind: { kind: 'one-of', values: [10, 20], mode: 'random' },
        x_group: { kind: 'lookup', source: 'existing', mode: 'random' },
      },
    },
    existing: { x_group: [{ x_groupid: id(2) }, { x_groupid: id(1) }] },
  };
  const first = generateDataset(options);
  const second = generateDataset({
    ...options,
    counts: { x_group: 2, x_item: 5 },
    existing: { x_group: [...options.existing.x_group].reverse() },
  });
  assert.deepEqual(first.tables, second.tables);
  assert.ok(first.tables.x_item.every((row) => [id(1), id(2)].includes(row.x_group.id)));
});

test('required references can use existing tables without generating them', () => {
  const options = {
    schema: schema(),
    counts: { x_item: 2 },
    existing: { x_group: [{ x_groupid: id(9) }] },
  };
  const result = generateDataset(options);
  assert.deepEqual(Object.keys(result.tables), ['x_item']);
  assert.deepEqual(result.tables.x_item[0].x_group, { id: id(9), logical_name: 'x_group' });
  const explicit = generateDataset({
    ...options,
    rules: { x_item: { x_group: { kind: 'constant', value: { id: id(9), logical_name: 'x_group' } } } },
  });
  assert.deepEqual(explicit.tables.x_item[0].x_group, result.tables.x_item[0].x_group);
});

test('required and optional owner lookups use concrete metadata user/team targets behind abstract owner relationships', () => {
  const metadata = schema();
  metadata.tables.x_item.attributes.ownerid = { name: 'ownerid', type: 'owner', requiredLevel: 'required' };
  metadata.tables.systemuser = { primaryIdAttribute: 'systemuserid', attributes: {} };
  metadata.tables.team = { primaryIdAttribute: 'teamid', attributes: {} };
  metadata.targets['x_item/ownerid'] = ['owner'];
  const options = {
    schema: metadata,
    counts: { x_item: 1 },
    existing: {
      x_group: [{ x_groupid: id(9) }],
      systemuser: [{ systemuserid: id(20) }],
      team: [{ teamid: id(21) }],
    },
  };
  assert.deepEqual(generateDataset(options).tables.x_item[0].ownerid, { id: id(20), logical_name: 'systemuser' });
  // Without exported users or teams, a required owner is left to Dataverse's default: the calling user.
  const ownerless = generateDataset({ ...options, existing: { x_group: options.existing.x_group } });
  assert.equal(Object.hasOwn(ownerless.tables.x_item[0], 'ownerid'), false);
  metadata.tables.x_item.attributes.ownerid.requiredLevel = 'none';
  assert.equal(Object.hasOwn(generateDataset(options).tables.x_item[0], 'ownerid'), false);
  const selected = generateDataset({
    ...options,
    rules: { x_item: { ownerid: { kind: 'lookup', target: 'team', source: 'existing' } } },
  });
  assert.deepEqual(selected.tables.x_item[0].ownerid, { id: id(21), logical_name: 'team' });
  const typed = generateDataset({
    ...options,
    rules: { x_item: { ownerid: { kind: 'constant', value: { id: id(20), logical_name: 'systemuser' } } } },
  });
  assert.deepEqual(typed.tables.x_item[0].ownerid, { id: id(20), logical_name: 'systemuser' });
  for (const target of ['owner', 'x_group'])
    assert.throws(
      () =>
        generateDataset({
          ...options,
          rules: { x_item: { ownerid: { kind: 'lookup', target } } },
        }),
      /not allowed by metadata/,
    );
});

test('null omits an optional column and cannot erase a required column', () => {
  const options = plan();
  const result = generateDataset({ ...options, rules: { x_item: { x_number: { kind: 'null' } } } });
  assert.equal(Object.hasOwn(result.tables.x_item[0], 'x_number'), false);
  assert.throws(
    () => generateDataset({ ...options, rules: { x_item: { x_name: { kind: 'null' } } } }),
    /required column cannot be null/,
  );
});

test('preflight rejects every invalid configured value including unsampled one-of values', () => {
  for (const [column, rule, message] of [
    ['x_name', { kind: 'constant', value: 'x'.repeat(41) }, /metadata length/],
    ['x_kind', { kind: 'one-of', values: [10, 999] }, /option set/],
    ['x_number', { kind: 'sequence', start: 19, step: 2 }, /metadata bounds/],
    ['x_number', { kind: 'range', min: 0.5, max: 1.5 }, /safe integer/],
    ['x_number', { kind: 'range', min: 5, max: 2 }, /min <= max/],
    ['x_flag', { kind: 'constant', value: 'true' }, /boolean/],
    ['x_name', { kind: 'sequence' }, /numeric column/],
    ['x_name', { kind: 'one-of', values: ['a'], mode: 'wrong' }, /cycle or random/],
    ['x_name', { kind: 'other' }, /unknown rule kind/],
    ['x_group', { kind: 'constant', value: { id: id(88), logical_name: 'x_group' } }, /does not resolve/],
    ['x_group', { kind: 'lookup', source: 'existing' }, /no candidate/],
    ['x_group', { kind: 'lookup', target: 'not_allowed' }, /not allowed/],
    ['x_group', { kind: 'lookup', source: 'remote' }, /source must/],
  ])
    assert.throws(() => generateDataset({ ...plan(), rules: { x_item: { [column]: rule } } }), message);
});

test('unknown, primary, derived and non-creatable columns cannot receive rules', () => {
  for (const column of ['absent', 'x_itemid', 'x_derived', 'x_shadow'])
    assert.throws(
      () => generateDataset({ ...plan(), rules: { x_item: { [column]: { kind: 'constant', value: 'x' } } } }),
      /unknown, primary, derived or non-creatable/,
    );
});

test('missing required targets fail with field context instead of returning dangling references', () => {
  assert.throws(
    () => generateDataset({ schema: schema(), counts: { x_item: 2 } }),
    /x_item.x_group: a required column cannot be null/,
  );
  assert.throws(() => generateDataset({ ...plan(), counts: { x_item: 2, x_group: 0 } }), /x_item.x_group/);
});

test('invalid and excessive counts are rejected before allocation', () => {
  for (const count of [-1, 0.5, '3', Infinity, 100001])
    assert.throws(() => generateDataset({ ...plan(), counts: { x_item: count } }), /integer from 0 to 100000/);
  assert.throws(() => generateDataset({ ...plan(), counts: { x_item: 60000, x_group: 60000 } }), /total count/);
  assert.throws(() => generateDataset({ ...plan(), counts: { unknown: 2 } }), /unknown table/);
  assert.throws(() => generateDataset({ ...plan(), seed: '../outside' }), /seed/);
});

test('zero-row generation is empty but configured rules still receive validation', () => {
  const options = { schema: schema(), counts: { x_item: 0 } };
  assert.deepEqual(generateDataset(options).tables, { x_item: [] });
  assert.throws(
    () => generateDataset({ ...options, rules: { x_item: { x_kind: { kind: 'constant', value: 999 } } } }),
    /option set/,
  );
});

test('unselected table rules and malformed existing identities fail without mutating input', () => {
  const options = plan(),
    before = structuredClone(options);
  assert.throws(() => generateDataset({ ...options, rules: { unknown: {} } }), /selected table/);
  assert.throws(
    () => generateDataset({ ...options, existing: { x_group: [{ x_groupid: 'invalid' }] } }),
    /GUID primary key/,
  );
  assert.deepEqual(options, before);
});

test('self-lookups resolve from reserved identities including a single required row', () => {
  const metadata = schema();
  metadata.targets['x_item/x_group'] = ['x_item'];
  const result = generateDataset({ schema: metadata, counts: { x_item: 1 } });
  assert.equal(result.tables.x_item[0].x_group.id, result.tables.x_item[0].x_itemid);
  assert.equal(result.tables.x_item[0].x_group.logical_name, 'x_item');
});

test('automatic required scalars use exported bounds, types, defaults and choices', () => {
  const metadata = schema();
  delete metadata.tables.x_item.attributes.x_group;
  const attributes = [
    { name: 'x_negative', type: 'int', minValue: -10, maxValue: -2 },
    { name: 'x_positive', type: 'decimal', minValue: 5, maxValue: 10 },
    { name: 'x_boolean', type: 'bit', appDefaultValue: '1' },
    { name: 'x_date', type: 'datetime', dateTimeBehavior: 'DateOnly' },
    { name: 'x_guid', type: 'uniqueidentifier' },
    { name: 'x_multiple', type: 'multiselectpicklist', optionSet: { options: [{ value: 10 }, { value: 20 }] } },
  ];
  for (const attribute of attributes)
    metadata.tables.x_item.attributes[attribute.name] = { ...attribute, requiredLevel: 'required' };
  const result = generateDataset({ schema: metadata, counts: { x_item: 2 } });
  assert.equal(result.tables.x_item[0].x_negative, -2);
  assert.equal(result.tables.x_item[0].x_positive, 5);
  assert.equal(result.tables.x_item[0].x_boolean, true);
  assert.equal(result.tables.x_item[0].x_date, '2026-01-01');
  assert.match(result.tables.x_item[0].x_guid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    result.tables.x_item.map((row) => row.x_multiple),
    ['10', '20'],
  );
  assert.notEqual(result.tables.x_item[0].x_guid, result.tables.x_item[1].x_guid);
});

test('malformed optional rules cannot silently disappear', () => {
  for (const rule of [null, false, [], new Date()])
    assert.throws(
      () => generateDataset({ ...plan(), rules: { x_item: { x_number: rule } } }),
      /rule must be an object/,
    );
  assert.throws(
    () => generateDataset({ ...plan(), rules: { x_item: { x_number: { kind: 'constant' } } } }),
    /constant needs a value/,
  );
});

test('datetime rules reject normalized calendar overflows and preserve valid dates and offsets', () => {
  const options = plan();
  options.schema.tables.x_item.attributes.x_date = { name: 'x_date', type: 'datetime' };
  const generate = (value) =>
    generateDataset({ ...options, rules: { x_item: { x_date: { kind: 'constant', value } } } });
  for (const value of ['2026-02-31', '2026-02-29', '1900-02-29', '2026-04-31T09:00:00Z', '2026-02-29T00:00:00+02:00'])
    assert.throws(() => generate(value), /x_item.x_date: expected an ISO date or datetime/, value);
  for (const value of [
    '2026-02-28',
    '2024-02-29',
    '2000-02-29',
    '2024-02-29T00:00:00Z',
    '2024-03-01T00:00:00+02:00',
    '2024-02-29T23:30:00-02:00',
  ])
    assert.equal(generate(value).tables.x_item[0].x_date, value);
});

test('generator date admission matches Dataverse range and DateOnly payload shape', () => {
  const options = plan();
  const attribute = { name: 'x_date', type: 'datetime' };
  options.schema.tables.x_item.attributes.x_date = attribute;
  const generate = (value) =>
    generateDataset({ ...options, rules: { x_item: { x_date: { kind: 'constant', value } } } });
  for (const value of [
    '0000-01-01',
    '0001-01-01',
    '1600-01-01',
    '1753-01-01T00:00:00+02:00',
    '9999-12-31T23:59:59-02:00',
  ])
    assert.throws(() => generate(value), /outside Dataverse years/);
  for (const value of ['1753-01-01', '1753-01-01T00:00:00Z', '9999-12-31T23:59:59Z'])
    assert.equal(generate(value).tables.x_item[0].x_date, value);
  attribute.dateTimeBehavior = 'DateOnly';
  assert.equal(generate('2026-10-28').tables.x_item[0].x_date, '2026-10-28');
  for (const value of ['2026-10-28T00:00:00Z', '2026-10-28T00:00:00+02:00'])
    assert.throws(() => generate(value), /DateOnly requires yyyy-MM-dd/);
});

test('multiselect CSV never coerces missing tokens, whitespace or nonnumeric values to option zero', () => {
  const metadata = schema();
  delete metadata.tables.x_item.attributes.x_group;
  metadata.tables.x_item.attributes.x_choices = {
    name: 'x_choices',
    type: 'multiselectpicklist',
    optionSet: { options: [{ value: 0 }, { value: 1 }] },
  };
  const generate = (value) =>
    generateDataset({
      schema: metadata,
      counts: { x_item: 1 },
      rules: { x_item: { x_choices: { kind: 'constant', value } } },
    }).tables.x_item[0];
  for (const value of ['1,', ',1', '1,,0', '1,  ,0', '0x1', '1e0', true, {}, ['1']])
    assert.throws(() => generate(value), /choices|option set/, String(value));
  for (const value of ['', '   ', [], null]) assert.equal(Object.hasOwn(generate(value), 'x_choices'), false);
  for (const value of ['0', 0, [0], ' 0, 1 '])
    assert.equal(generate(value).x_choices, String(value).trim().replaceAll(' ', ''));
  metadata.tables.x_item.attributes.x_choices.requiredLevel = 'required';
  for (const value of ['', [], null]) assert.throws(() => generate(value), /required column cannot be null/);
});

test('text patterns expand explicit sequence tokens with bounded padding and metadata validation', () => {
  const options = plan();
  options.rules = { x_item: { x_name: { kind: 'pattern', template: 'Sample {seq:4}/{seq}', start: 7, step: 3 } } };
  assert.deepEqual(
    generateDataset(options).tables.x_item.map((row) => row.x_name),
    ['Sample 0007/7', 'Sample 0010/10', 'Sample 0013/13', 'Sample 0016/16', 'Sample 0019/19'],
  );
  for (const rule of [
    { template: '{unknown}' },
    { template: '{seq:33}' },
    { template: '{seq:0}' },
    { template: 123 },
    { template: '{seq}', start: Number.MAX_SAFE_INTEGER },
    { template: 'x'.repeat(41) },
    { template: '{seq}', step: 0.5 },
  ])
    assert.throws(
      () => generateDataset({ ...options, rules: { x_item: { x_name: { kind: 'pattern', ...rule } } } }),
      /pattern|metadata length/,
    );
  assert.throws(
    () => generateDataset({ ...options, rules: { x_item: { x_number: { kind: 'pattern', template: '{seq}' } } } }),
    /text column/,
  );
  assert.equal(
    generateDataset({
      ...options,
      rules: { x_item: { x_name: { kind: 'pattern', template: '{seq:3}', start: -2, step: 0 } } },
    }).tables.x_item[0].x_name,
    '-002',
  );
  assert.throws(
    () =>
      generateDataset({
        schema: options.schema,
        counts: { x_item: 0 },
        rules: { x_item: { x_name: { kind: 'pattern', template: '{seq:99}' } } },
      }),
    /padding/,
  );
});
