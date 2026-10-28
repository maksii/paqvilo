import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import { generateSchemaDeclarations } from '../fixtures.mjs';

const schema = () => ({
  targets: { 'x_item/x_owner': ['x_group', 'x_item'] },
  optionSets: { x_global: { options: [{ value: 10 }, { value: 20 }] } },
  tables: {
    x_item: {
      primaryIdAttribute: 'x_itemid',
      attributes: {
        x_itemid: { name: 'x_itemid', type: 'primarykey' },
        x_name: {
          name: 'x_name',
          type: 'nvarchar',
          requiredLevel: 'required',
          labels: { 1033: 'DO NOT EMIT BUSINESS LABEL' },
        },
        x_kind: { name: 'x_kind', type: 'picklist', optionSetName: 'x_global' },
        x_tags: { name: 'x_tags', type: 'multiselectpicklist', optionSet: { options: [{ value: 0 }, { value: 1 }] } },
        x_amount: { name: 'x_amount', type: 'money' },
        x_owner: { name: 'x_owner', type: 'customer' },
        x_binary: { name: 'x_binary', type: 'image' },
        x_empty: { name: 'x_empty', type: 'picklist', optionSet: { options: [] } },
        x_emptytags: { name: 'x_emptytags', type: 'multiselectpicklist', optionSet: { options: [] } },
      },
    },
    x_group: { primaryIdAttribute: 'x_groupid', attributes: { x_groupid: { name: 'x_groupid', type: 'primarykey' } } },
  },
});

test('source-derived declarations type-check project fixtures and reject wrong choices, identities, lookups and columns', async (t) => {
  const input = schema(),
    before = structuredClone(input),
    report = generateSchemaDeclarations(input);
  assert.deepEqual(input, before);
  assert.equal(report.declarations.includes('DO NOT EMIT'), false);
  assert.deepEqual(report.diagnostics, [
    { code: 'SCHEMA_TYPE_UNSUPPORTED', table: 'x_item', column: 'x_binary', type: 'image' },
  ]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-types-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'schema.d.ts'), report.declarations);
  const fixture = path.join(dir, 'fixture.ts');
  await fs.writeFile(
    fixture,
    `import type { Row, FixtureRow, Choices } from './schema.js';
const row: Row<'x_item'> = {x_itemid:'local-id',x_name:'Synthetic',x_kind:10,x_owner:{id:'local-id',logical_name:'x_group'},x_tags:[0,{value:1}]};
const partial: FixtureRow<'x_item'> = {x_itemid:'local-id',x_amount:{$type:'DataverseNumeric',numericType:'Money',value:'1.25'}};
const kind: Choices['x_item']['x_kind'] = 20;
// @ts-expect-error unknown option
const wrongChoice: Choices['x_item']['x_kind'] = 99;
// @ts-expect-error fixture identity required
const noIdentity: FixtureRow<'x_item'> = {x_name:'Synthetic'};
// @ts-expect-error required source field
const noName: Row<'x_item'> = {x_itemid:'local-id'};
// @ts-expect-error unknown lookup target
const wrongLookup: FixtureRow<'x_item'> = {x_itemid:'local-id',x_owner:{id:'x',logical_name:'x_unknown'}};
// @ts-expect-error unknown column
const wrongColumn: FixtureRow<'x_item'> = {x_itemid:'local-id',x_private:123};
// @ts-expect-error a closed empty Choice cannot accept any numeric value
const closedEmpty: FixtureRow<'x_item'> = {x_itemid:'local-id',x_empty:99};
// @ts-expect-error a closed empty Choices cannot accept nonempty CSV
const closedEmptyTags: FixtureRow<'x_item'> = {x_itemid:'local-id',x_emptytags:'99'};
const omittedOrNull: FixtureRow<'x_item'> = {x_itemid:'local-id',x_empty:null,x_emptytags:[]};
void [row,partial,kind,wrongChoice,noIdentity,noName,wrongLookup,wrongColumn,closedEmpty,closedEmptyTags,omittedOrNull];`,
  );
  const program = ts.createProgram([fixture], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  });
  const failures = ts
    .getPreEmitDiagnostics(program)
    .map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' '));
  assert.deepEqual(failures, []);
});
test('declarations are deterministic across source and selection ordering and disclose unresolved metadata', () => {
  const input = schema(),
    other = structuredClone(input);
  other.tables = Object.fromEntries(Object.entries(other.tables).reverse());
  other.tables.x_item.attributes = Object.fromEntries(Object.entries(other.tables.x_item.attributes).reverse());
  assert.deepEqual(
    generateSchemaDeclarations(input),
    generateSchemaDeclarations(other, { tables: ['x_item', 'x_group', 'x_item'] }),
  );
  delete other.tables.x_item.primaryIdAttribute;
  delete other.targets['x_item/x_owner'];
  other.tables.x_item.attributes.x_kind.optionSetName = 'x_missing';
  assert.deepEqual(
    generateSchemaDeclarations(other)
      .diagnostics.map((row) => row.code)
      .sort(),
    [
      'SCHEMA_LOOKUP_TARGETS_UNRESOLVED',
      'SCHEMA_OPTIONS_UNRESOLVED',
      'SCHEMA_PRIMARY_ID_INFERRED',
      'SCHEMA_TYPE_UNSUPPORTED',
    ],
  );
  assert.equal(generateSchemaDeclarations({ tables: {} }).declarations.includes('export interface Tables'), true);
});
test('invalid logical names, prototype keys and excessive schemas are refused', () => {
  assert.throws(() => generateSchemaDeclarations(schema(), { tables: ['__proto__'] }), /logical table/);
  assert.throws(() => generateSchemaDeclarations(schema(), { tables: Array(1001).fill('x_item') }), /1000/);
  const input = schema();
  input.tables.x_item.attributes.bad = { name: 'x_bad"; process.exit()', type: 'nvarchar' };
  assert.throws(() => generateSchemaDeclarations(input), /logical names/);
});

test('aliased option metadata is charged before repeated materialization', () => {
  const input = schema(),
    options = Array(100000).fill({ value: 1 });
  input.tables.x_item.attributes = Object.fromEntries(
    Array.from({ length: 15 }, (_, i) => [
      `x_kind${i}`,
      { name: `x_kind${i}`, type: 'picklist', optionSet: { options } },
    ]),
  );
  assert.throws(() => generateSchemaDeclarations(input), /inspection limit/);
});
