// Native write-pipeline data semantics (Dataverse recorder parity corpus, crud/upsert/pipelineEffects): which columns
// each stage's Target carries, how the Web API's empty text reaches it, when the platform derives exchange rates and
// base amounts, and the Upsert main operation a bare PATCH runs under. Invented tables and identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { clrContext, recordToSdkEntity } from '../lib/plugin-clr.mjs';
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

async function fixture(t, edit = () => {}, { fields = {}, extraSteps = [] } = {}) {
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
          ...fields,
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
    ...extraSteps,
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
  return { ...f, seen, backend };
}

const keysAt = (seen, message, stage) =>
  Object.keys(seen.find((entry) => entry.message === message && entry.stage === stage)?.target ?? {}).sort();

// @test-kind parity: native dev-environment recorder corpus 2026-10-30, Create stage 10/20/40 Target columns repeated across the crud, upsert, reads and pipelineEffects scenarios (organizationid from the organization-owned child create)
test('a Create Target gains platform stamps at PreOperation and the derived currency values only at PostOperation', async (t) => {
  const f = await fixture(t);
  const created = await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created', x_amount: 3.5 });
  assert(created.status < 300, await created.text());
  assert.deepEqual(keysAt(f.seen, 'Create', 10), ['transactioncurrencyid', 'x_amount', 'x_itemid', 'x_name']);
  const pre = keysAt(f.seen, 'Create', 20);
  for (const name of [
    'createdby',
    'createdon',
    'modifiedby',
    'modifiedon',
    'modifiedonbehalfby',
    'statecode',
    'organizationid',
  ])
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

// @test-kind unproven: base amounts follow the PreOperation money value; no native capture of a PreOperation money edit
test('base amounts derive from the money value PreOperation leaves, not the submitted one', async (t) => {
  const f = await fixture(t, (context) => {
    if (context.MessageName === 'Create' && context.Stage === 20) context.InputParameters.Target.x_amount = 8;
  });
  const created = await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created', x_amount: 3.5 });
  assert(created.status < 300, await created.text());
  assert.equal(f.store.tableRows('x_item')[0].x_amount_base, 8);
});

// @test-kind parity+observation: Update stage 20/40 modification stamps repeated in the native recorder corpus 2026-10-30 (crud, upsert, pipelineEffects); the cleared text as an empty string is a single capture (crud third PATCH)
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

// @test-kind parity: native dev-environment recorder corpus 2026-10-30, every bare PATCH in the crud and upsert scenarios (Upsert parent, existence RetrieveMultiple inputs and query, If-Match on a missing row)
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

// @test-kind parity: native recorder corpus 2026-10-30 Targets and images repeated across scenarios (metadata types, unnamed Target references, TimeZoneIndependent kinds per stage, ten-place decimals, yominame companions, unnamed owninguser)
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
  // @parity-evidence: unchanged guarantee, renamed encoder option only; the native recorder corpus 2026-10-30 proves these
  // values for pre/post images (crud, upsert, reads, pipelineEffects), so the rules now apply to images, not SDK reads.
  const image = recordToSdkEntity(store, 'x_item', row, { allColumns: true, image: true });
  assert.equal(image.attributes.x_ratio.value, '1.5000000000');
  assert.equal(image.attributes.ownerid.name, 'Invented User');
  assert.equal(image.attributes.owneridyominame, 'Invented User');
  assert.equal(image.attributes.owninguser.name, null);
});

// @test-kind unproven: local store form of an option list a step hands back
test('a choices value a step hands back as an option list is stored, not read as a Web API payload', async (t) => {
  const f = await fixture(t, (context) => {
    if (context.MessageName === 'Create' && context.Stage === 10) context.InputParameters.Target.x_choices = [1, 2];
  });
  const created = await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created', x_choices: '1' });
  assert(created.status < 300, await created.text());
  assert.equal(f.store.tableRows('x_item')[0].x_choices, '1,2');
});

// @test-kind compatibility: Web API lookup properties _<lookup>_value name the logical lookup column (Microsoft Learn, lookup properties)
test('a Web API lookup value property reads as its logical lookup column in an SDK query', () => {
  const query = odataToSdkQuery('x_item', { $select: '_x_parentid_value', $filter: `_x_parentid_value eq ${keyed}` });
  assert.deepEqual(query.columnSet.columns, ['x_parentid']);
  assert.equal(query.criteria.conditions[0].attributeName, 'x_parentid');
});

// @test-kind parity: native recorder nullSemantics Create 10/20/40 and async 40, events 3751-3784 (native) and 6897-6936 (native-r2)
test('a Web API Create keeps a null text column null in every Target; an Update Target shows it as an empty string', async (t) => {
  const f = await fixture(t, undefined, { extraSteps: [{ ...step(30, 'Create', 40), mode: 1 }] });
  const created = await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created', x_note: null });
  assert(created.status < 300, await created.text());
  await f.backend.settle();
  const creates = f.seen.filter((entry) => entry.message === 'Create');
  assert.deepEqual(creates.map((entry) => entry.stage).sort(), [10, 20, 40, 40]);
  for (const entry of creates) {
    assert(Object.hasOwn(entry.target, 'x_note'), `Create ${entry.stage} Target carries x_note`);
    assert.equal(entry.target.x_note, null);
  }
  assert.equal(f.store.tableRows('x_item')[0].x_note, null);
  f.seen.length = 0;
  const cleared = await f.request('PATCH', `/x_items(${id})`, { x_note: null }, { 'If-Match': '*' });
  assert(cleared.status < 300, await cleared.text());
  for (const stage of [10, 20, 40])
    assert.equal(f.seen.find((entry) => entry.message === 'Update' && entry.stage === stage).target.x_note, '');
  assert.equal(f.store.tableRows('x_item')[0].x_note, null);
});

// @test-kind parity: native-r2 nullSemantics full PATCH Update 20/40/async timezoneruleversionnumber (6955, 6965, 6972); all-null PATCH without it
test('a PATCH that writes a date-time value stamps timezoneruleversionnumber on Update 20, 40 and async; a null PATCH does not', async (t) => {
  const f = await fixture(t, undefined, {
    fields: {
      x_when: { dataverseType: 'datetime', dateTimeBehavior: 'TimeZoneIndependent' },
      x_day: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
    },
    extraSteps: [{ ...step(31, 'Update', 40), mode: 1 }],
  });
  assert((await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created' })).status < 300);
  f.seen.length = 0;
  const dated = await f.request(
    'PATCH',
    `/x_items(${id})`,
    { x_when: '2026-10-30T10:00:00Z', x_day: '2026-10-30' },
    { 'If-Match': '*' },
  );
  assert(dated.status < 300, await dated.text());
  await f.backend.settle();
  assert.equal(f.store.tableRows('x_item')[0].timezoneruleversionnumber, 4);
  const updates = (stage) => f.seen.filter((entry) => entry.message === 'Update' && entry.stage === stage);
  assert.equal(updates(10).length, 1);
  assert(!Object.hasOwn(updates(10)[0].target, 'timezoneruleversionnumber'));
  assert.equal(updates(20).length, 1);
  assert.equal(updates(20)[0].target.timezoneruleversionnumber, 4);
  assert.equal(updates(40).length, 2);
  for (const entry of updates(40)) assert.equal(entry.target.timezoneruleversionnumber, 4);
  f.seen.length = 0;
  const nulled = await f.request('PATCH', `/x_items(${id})`, { x_when: null, x_day: null }, { 'If-Match': '*' });
  assert(nulled.status < 300, await nulled.text());
  await f.backend.settle();
  for (const stage of [10, 20, 40])
    for (const entry of updates(stage)) assert(!Object.hasOwn(entry.target, 'timezoneruleversionnumber'));
});

const zoneUser = '10000000-0000-0000-0000-000000000001';
const zoneRuntime = {
  descriptor: {
    context: { initiatingUserId: zoneUser, organizationId: zoneUser, businessUnitId: zoneUser },
    serviceProfile: { userId: zoneUser, evidence: 'Invented TimeZoneIndependent kinds', grants: [] },
  },
};
// @test-kind parity: native and native-r2 crud/crudNoAsync Create/10 and CreateMultiple/10 Utc, nullSemantics Update/10 and UpdateMultiple/10 Unspecified TimeZoneIndependent kinds
test('a Create PreValidation Target keeps a TimeZoneIndependent value as sent; an Update Target strips its zone at stages 10 and 20', () => {
  const store = new DataStore({
    state: {
      version: 1,
      mappings: {
        x_item: {
          logicalName: 'x_item',
          entitySet: 'x_items',
          idColumn: 'x_itemid',
          fields: { x_when: { dataverseType: 'datetime', dateTimeBehavior: 'TimeZoneIndependent' } },
        },
      },
      tables: { x_item: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
  const value = '2026-10-30T10:00:00Z';
  const target = (operation, stage) =>
    clrContext({
      runtime: zoneRuntime,
      store,
      step: { id: '30000000-0000-0000-0000-000000000090', images: [], contract: { mode: 0 } },
      entity: 'x_item',
      operation,
      stage,
      target: { x_when: value },
      record: { x_itemid: id, x_when: value },
      previous: operation === 'update' ? { x_itemid: id, x_when: value } : null,
      frame: {},
      depth: 1,
    }).inputParameters.values.Target;
  assert.equal(target('create', 10).attributes.x_when.value, value);
  assert.equal(target('update', 10).attributes.x_when.value, '2026-10-30T10:00:00');
  assert.equal(target('update', 20).attributes.x_when.value, '2026-10-30T10:00:00');
});

// @test-kind parity: native-r2 relationsReads 1:N $ref associate child Update 10/20/40 Target keys
test('a $ref association of a 1:N child sends a lookup-only Update 10 Target and stamps the child from stage 20', async (t) => {
  const parent = '20000000-0000-0000-0000-0000000000b1',
    child = '20000000-0000-0000-0000-0000000000b2';
  const f = await contractModuleFixture(t, {
    mappings: {
      x_parent: {
        logicalName: 'x_parent',
        entitySet: 'x_parents',
        idColumn: 'x_parentid',
        fields: { x_name: { dataverseType: 'nvarchar' } },
        relationships: {
          x_parent_children: {
            schemaName: 'x_parent_children',
            entity: 'x_child',
            from: 'x_parentid',
            to: 'x_parentid',
            many: true,
            partner: 'x_parentid',
          },
        },
      },
      x_child: {
        logicalName: 'x_child',
        entitySet: 'x_children',
        idColumn: 'x_childid',
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] },
        },
        relationships: {
          x_parentid: {
            schemaName: 'x_parent_children',
            entity: 'x_parent',
            from: 'x_parentid',
            to: 'x_parentid',
            many: false,
            partner: 'x_parent_children',
          },
        },
      },
    },
    tables: {
      x_parent: [{ x_parentid: parent, x_name: 'Parent' }],
      x_child: [{ x_childid: child, x_name: 'Child', x_parentid: null }],
    },
    extension: { name: 'data-semantics-relation', install: () => {} },
  });
  const seen = [];
  const steps = [10, 20, 40].map((stage) => ({ ...step(40 + stage, 'Update', stage), entity: 'x_child' }));
  const handlers = new Map([
    [
      steps[0].typeName,
      ({ context }) => {
        seen.push({
          message: context.MessageName,
          stage: context.Stage,
          keys: Object.keys(context.InputParameters.Target ?? {}).sort(),
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  await f.json(
    await f.request('POST', `/x_parents(${parent})/x_parent_children/$ref`, {
      '@odata.id': `${f.server.origin}/api/data/v9.2/x_children(${child})`,
    }),
    204,
  );
  await backend.settle();
  const keys = (stage) => seen.find((entry) => entry.message === 'Update' && entry.stage === stage).keys;
  assert.deepEqual(keys(10), ['x_childid', 'x_parentid']);
  for (const stage of [20, 40]) {
    for (const name of ['modifiedby', 'modifiedon', 'modifiedonbehalfby']) assert(keys(stage).includes(name), name);
    assert(!keys(stage).includes('versionnumber'));
  }
});

// @test-kind parity: native-r2 currency Update/40 and UpdateMultiple/40 (7050, 7053), Web API CreateMultiple/40 and bridged Create/40 (7082, 7086), nullSemantics Update/40 full and all-null PATCH (6965, 6991)
test('a PATCH that writes a money value gives Update 40 and its async copy the rate and base amount; a null PATCH keeps only the null base', async (t) => {
  const f = await fixture(t, undefined, { extraSteps: [{ ...step(32, 'Update', 40), mode: 1 }] });
  assert((await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created' })).status < 300);
  f.seen.length = 0;
  const written = await f.request('PATCH', `/x_items(${id})`, { x_amount: 3.5 }, { 'If-Match': '*' });
  assert(written.status < 300, await written.text());
  await f.backend.settle();
  const updates = (stage) => f.seen.filter((entry) => entry.message === 'Update' && entry.stage === stage);
  assert.equal(updates(20).length, 1);
  for (const name of ['exchangerate', 'x_amount_base'])
    assert(!Object.hasOwn(updates(20)[0].target, name), `Update 20 Target omits ${name}`);
  assert.equal(updates(40).length, 2);
  for (const entry of updates(40)) {
    assert.equal(entry.target.exchangerate, 1);
    assert.equal(entry.target.x_amount_base, 3.5);
  }
  f.seen.length = 0;
  const cleared = await f.request('PATCH', `/x_items(${id})`, { x_amount: null }, { 'If-Match': '*' });
  assert(cleared.status < 300, await cleared.text());
  await f.backend.settle();
  assert.equal(updates(40).length, 2);
  for (const entry of updates(40)) {
    assert(Object.hasOwn(entry.target, 'x_amount_base'));
    assert.equal(entry.target.x_amount_base, null);
    assert(!Object.hasOwn(entry.target, 'exchangerate'));
  }
});

// @test-kind parity: native-r2 currency Update/40 and UpdateMultiple/40 (7050, 7053), Web API CreateMultiple/40 and bridged Create/40 (7082, 7086), nullSemantics Update/40 full and all-null PATCH (6965, 6991)
test('a Web API CreateMultiple gives its stage-40 Targets the rate and base amounts; stage 20 has neither', async (t) => {
  const bulk = [];
  const f = await fixture(
    t,
    (context) => {
      if (context.MessageName === 'CreateMultiple')
        bulk.push({ stage: context.Stage, targets: context.InputParameters.Targets });
    },
    { extraSteps: [step(33, 'CreateMultiple', 20), step(34, 'CreateMultiple', 40)] },
  );
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
    Targets: [
      { x_name: 'One', x_amount: 3.5 },
      { x_name: 'Two', x_amount: 7 },
    ],
  });
  assert.equal(response.status, 200, await response.text());
  const entities = (stage) => bulk.find((entry) => entry.stage === stage).targets;
  for (const entity of entities(20)) assert(!Object.hasOwn(entity.attributes, 'exchangerate'));
  for (const entity of entities(20)) assert(!Object.hasOwn(entity.attributes, 'x_amount_base'));
  assert.deepEqual(
    entities(40).map((entity) => entity.attributes.x_amount_base.value),
    ['3.5', '7'],
  );
  for (const entity of entities(40)) assert.equal(entity.attributes.exchangerate.value, '1.000000000000');
  for (const entry of f.seen.filter((item) => item.message === 'Create' && item.stage === 20))
    assert(!Object.hasOwn(entry.target, 'x_amount_base'));
  const creates = f.seen.filter((item) => item.message === 'Create' && item.stage === 40);
  assert.deepEqual(
    creates.map((entry) => entry.target.x_amount_base),
    [3.5, 7],
  );
  for (const entry of creates) assert.equal(entry.target.exchangerate, 1);
});

// @test-kind parity: native-r2 currency Update/40 and UpdateMultiple/40 (7050, 7053), Web API CreateMultiple/40 and bridged Create/40 (7082, 7086), nullSemantics Update/40 full and all-null PATCH (6965, 6991)
test('a Web API UpdateMultiple money write gives its stage-40 Targets the rate and base amount; stage 20 has neither', async (t) => {
  const bulk = [];
  const f = await fixture(
    t,
    (context) => {
      if (context.MessageName === 'UpdateMultiple')
        bulk.push({ stage: context.Stage, targets: context.InputParameters.Targets });
    },
    { extraSteps: [step(35, 'UpdateMultiple', 20), step(36, 'UpdateMultiple', 40)] },
  );
  assert((await f.request('POST', '/x_items', { x_itemid: id, x_name: 'Created' })).status < 300);
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpdateMultiple', {
    Targets: [{ x_itemid: id, x_amount: 3.5 }],
  });
  assert(response.status < 300, await response.text());
  const bulkAt = (stage) => bulk.find((entry) => entry.stage === stage).targets[0].attributes;
  assert(!Object.hasOwn(bulkAt(20), 'exchangerate'));
  assert(!Object.hasOwn(bulkAt(20), 'x_amount_base'));
  assert.equal(bulkAt(40).exchangerate.value, '1.000000000000');
  assert.equal(bulkAt(40).x_amount_base.value, '3.5');
});
