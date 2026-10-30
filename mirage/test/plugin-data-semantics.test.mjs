// Native write-pipeline data semantics (Dataverse recorder parity corpus, crud/upsert/pipelineEffects): which columns
// each stage's Target carries, how the Web API's empty text reaches it, when the platform derives exchange rates and
// base amounts, and the Upsert main operation a bare PATCH runs under. Invented tables and identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { recordToSdkEntity } from '../lib/plugin-clr.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { odataToSdkQuery } from '../lib/plugin-query.mjs';

const id = '20000000-0000-0000-0000-0000000000a1';
const keyed = '20000000-0000-0000-0000-0000000000a2';
const step = (n, message, stage) => ({
  id: `30000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`,
  enabled: true,
  entity: message === 'RetrieveMultiple' ? 'x_item' : 'x_item',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Recorder',
  assemblyId: 'invented',
});

async function fixture(t, edit = () => {}) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_note: { dataverseType: 'nvarchar' },
          x_code: { dataverseType: 'nvarchar' },
          x_amount: { dataverseType: 'money', precision: 2 },
          x_choices: { dataverseType: 'multiselectpicklist', options: [{ value: 1 }, { value: 2 }] },
        },
        alternateKeys: [{ name: 'x_code_key', attributes: ['x_code'] }],
      },
    },
    tables: { x_item: [] },
    extension: { name: 'data-semantics-probe', install: () => {} },
  });
  const seen = [];
  const steps = [
    ...['Create', 'Update'].flatMap((message, m) =>
      [10, 20, 40].map((stage, s) => step(m * 3 + s + 1, message, stage)),
    ),
    ...[10, 20, 40].map((stage, s) => step(20 + s, 'RetrieveMultiple', stage)),
  ];
  const handlers = new Map(
    [steps[0]].map((item) => [
      item.typeName,
      ({ context }) => {
        seen.push({
          message: context.MessageName,
          stage: context.Stage,
          target: structuredClone(context.InputParameters.Target ?? null),
          inputs: Object.keys(context.InputParameters ?? {}),
          query: context.InputParameters.Query ?? null,
          parent: context.ParentContext
            ? {
                message: context.ParentContext.MessageName,
                stage: context.ParentContext.Stage,
                entity: context.ParentContext.PrimaryEntityName,
              }
            : null,
        });
        edit(context);
      },
    ]),
  );
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen };
}

const keysAt = (seen, message, stage) =>
  Object.keys(seen.find((entry) => entry.message === message && entry.stage === stage)?.target ?? {}).sort();

test('a Create Target gains platform stamps at PreOperation and the derived currency values only at PostOperation', async (t) => {
  const f = await fixture(t);
  const created = await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created', x_amount: 3.5 });
  assert(created.status < 300, await created.text());
  assert.deepEqual(keysAt(f.seen, 'Create', 10), ['transactioncurrencyid', 'x_amount', 'x_itemid', 'x_name']);
  const pre = keysAt(f.seen, 'Create', 20);
  for (const name of ['createdby', 'createdon', 'modifiedby', 'modifiedon', 'modifiedonbehalfby', 'statecode'])
    assert(pre.includes(name), `PreOperation Target carries ${name}`);
  for (const name of ['versionnumber', 'createdonbehalfby', 'owningteam', 'exchangerate', 'x_amount_base'])
    assert(!pre.includes(name), `PreOperation Target omits ${name}`);
  const post = keysAt(f.seen, 'Create', 40);
  assert(post.includes('exchangerate') && post.includes('x_amount_base'));
  assert(!post.includes('versionnumber'));
  const row = f.store.tableRows('x_item')[0];
  assert.equal(row.exchangerate, 1);
  assert.equal(row.x_amount_base, 3.5);
});

test('base amounts derive from the money value PreOperation leaves, not the submitted one', async (t) => {
  const f = await fixture(t, (context) => {
    if (context.MessageName === 'Create' && context.Stage === 20) context.InputParameters.Target.x_amount = 8;
  });
  const created = await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created', x_amount: 3.5 });
  assert(created.status < 300, await created.text());
  assert.equal(f.store.tableRows('x_item')[0].x_amount_base, 8);
});

test('an Update Target gains the modification stamps after PreValidation; a cleared text column shows an empty string', async (t) => {
  const f = await fixture(t);
  assert((await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created', x_note: 'Note' })).status < 300);
  f.seen.length = 0;
  const updated = await f.request('PATCH', `/x_items(${id})`, { x_note: null }, { 'If-Match': '*' });
  assert(updated.status < 300, await updated.text());
  assert.deepEqual(keysAt(f.seen, 'Update', 10), ['x_note']);
  assert.deepEqual(keysAt(f.seen, 'Update', 20), [
    'modifiedby',
    'modifiedon',
    'modifiedonbehalfby',
    'x_itemid',
    'x_note',
  ]);
  for (const stage of [10, 20, 40])
    assert.equal(f.seen.find((entry) => entry.message === 'Update' && entry.stage === stage).target.x_note, '');
  assert.equal(f.store.tableRows('x_item')[0].x_note, null);
});

test('a bare PATCH checks existence with a RetrieveMultiple pipeline under its Upsert main operation', async (t) => {
  const f = await fixture(t);
  const created = await f.request('PATCH', `/x_items(${id})`, { x_name: 'Upserted' });
  assert(created.status < 300, await created.text());
  const checks = f.seen.filter((entry) => entry.message === 'RetrieveMultiple');
  assert.deepEqual(
    checks.map((entry) => entry.stage),
    [10, 20, 40],
  );
  for (const check of checks) {
    assert.deepEqual(check.parent, { message: 'Upsert', stage: 30, entity: 'none' });
    assert.deepEqual(check.inputs.sort(), ['AppModuleId', 'IsAppModuleContext', 'Query']);
    assert.equal(check.query.topCount, 2);
    assert.deepEqual(check.query.columnSet, { allColumns: false, columns: [] });
    assert.deepEqual(
      check.query.criteria.conditions.map((condition) => condition.attributeName),
      ['x_itemid'],
    );
  }
  const preValidation = f.seen.find((entry) => entry.message === 'Create' && entry.stage === 10);
  assert.deepEqual(preValidation.parent, { message: 'Upsert', stage: 30, entity: 'none' });
  assert.ok(
    f.seen.findIndex((entry) => entry.message === 'RetrieveMultiple') <
      f.seen.findIndex((entry) => entry.message === 'Create'),
  );
  f.seen.length = 0;
  assert((await f.request('PATCH', `/x_items(${id})`, { x_name: 'Again' })).status < 300);
  assert.deepEqual(f.seen.find((entry) => entry.message === 'Update' && entry.stage === 10).parent, {
    message: 'Upsert',
    stage: 30,
    entity: 'none',
  });
  f.seen.length = 0;
  assert((await f.request('PATCH', `/x_items(x_code='K1')`, { x_name: 'By key' })).status < 300);
  assert.deepEqual(
    f.seen.find((entry) => entry.message === 'RetrieveMultiple').query.criteria.conditions.map((c) => c.attributeName),
    ['x_code'],
  );
  f.seen.length = 0;
  const missing = await f.request('PATCH', `/x_items(${keyed})`, { x_name: 'No create' }, { 'If-Match': '*' });
  assert.equal(missing.status, 404);
  assert.equal(f.seen.length, 0);
});

test('SDK values: platform columns typed from metadata, unnamed Target references, retrieved decimals at storage scale', () => {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    idColumn: 'x_itemid',
    fields: {
      x_ratio: { dataverseType: 'decimal', precision: 2 },
      x_when: { dataverseType: 'datetime', dateTimeBehavior: 'TimeZoneIndependent' },
      ownerid: { dataverseType: 'owner', targets: ['systemuser'] },
    },
  };
  state.mappings.systemuser = { logicalName: 'systemuser', idColumn: 'systemuserid', nameColumn: 'fullname' };
  state.tables.systemuser = [{ systemuserid: keyed, fullname: 'Invented User' }];
  const store = new DataStore({ state });
  store.platformFields = () => ({
    createdon: { dataverseType: 'datetime' },
    exchangerate: { dataverseType: 'decimal', precision: 12, validForCreate: false },
    owneridname: { dataverseType: 'nvarchar' },
    owneridyominame: { dataverseType: 'nvarchar' },
  });
  const row = {
    x_itemid: id,
    x_ratio: 1.5,
    x_when: '2026-01-02T03:04:05Z',
    createdon: '2026-01-02T03:04:05Z',
    exchangerate: 1,
    ownerid: { id: keyed, logical_name: 'systemuser' },
    owninguser: { id: keyed, logical_name: 'systemuser' },
  };
  const submitted = recordToSdkEntity(store, 'x_item', row, { allColumns: true, submitted: true, target: true });
  assert.deepEqual(submitted.attributes.createdon, { $type: 'DateTime', value: '2026-01-02T03:04:05Z' });
  assert.equal(submitted.attributes.x_when.value, '2026-01-02T03:04:05Z');
  assert.equal(submitted.attributes.ownerid.name, null);
  assert.equal(submitted.attributes.x_ratio.value, '1.5');
  assert.equal(submitted.attributes.exchangerate.value, '1.000000000000');
  const later = recordToSdkEntity(store, 'x_item', row, { allColumns: true, target: true });
  assert.equal(later.attributes.x_when.value, '2026-01-02T03:04:05');
  const image = recordToSdkEntity(store, 'x_item', row, { allColumns: true, retrieved: true });
  assert.equal(image.attributes.x_ratio.value, '1.5000000000');
  assert.equal(image.attributes.ownerid.name, 'Invented User');
  assert.equal(image.attributes.owneridyominame, 'Invented User');
  assert.equal(image.attributes.owninguser.name, null);
});

test('a choices value a step hands back as an option list is stored, not read as a Web API payload', async (t) => {
  const f = await fixture(t, (context) => {
    if (context.MessageName === 'Create' && context.Stage === 10) context.InputParameters.Target.x_choices = [1, 2];
  });
  const created = await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created', x_choices: '1' });
  assert(created.status < 300, await created.text());
  assert.deepEqual(f.store.tableRows('x_item')[0].x_choices, [1, 2]);
});

test('a Web API lookup value property reads as its logical lookup column in an SDK query', () => {
  const query = odataToSdkQuery('x_item', { $select: '_x_parentid_value', $filter: `_x_parentid_value eq ${keyed}` });
  assert.deepEqual(query.columnSet.columns, ['x_parentid']);
  assert.equal(query.criteria.conditions[0].attributeName, 'x_parentid');
});
