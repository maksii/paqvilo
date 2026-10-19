// Custom APIs: customapi tables, unpacked solution parsing and registry operations. Invented sample_ names and loopback URLs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { install, parseCustomApiFiles, readCustomApiSolution } from '../lib/dataverse-customapi.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const ADMIN = { systemuserid: 'aaaaaaaa-0000-4000-8000-000000000001' };
const LOGICAL = ['customapi', 'customapirequestparameter', 'customapiresponseproperty'];

const el = (name, value = '') => `<${name}>${value}</${name}>`;
const label = (name, text) => `<${name} default="${text}"><label description="${text}" languagecode="1033" /></${name}>`;
const apiXml = (uniquename, { bindingtype = 0, entity = '', isfunction = 0, isprivate = 0, privilege = '' }) => `<customapi uniquename="${uniquename}">${el('bindingtype', bindingtype)}${el('boundentitylogicalname', entity)}${label('displayname', uniquename)}${el('executeprivilegename', privilege)}${el('isfunction', isfunction)}${el('isprivate', isprivate)}${el('name', uniquename)}</customapi>`;
const paramXml = (api, uniquename, { type, optional = 0, entity = '' }) => `<customapirequestparameter uniquename="${uniquename}">${label('displayname', uniquename)}${el('isoptional', optional)}${el('logicalentityname', entity)}${el('name', `${api}.${uniquename}`)}${el('type', type)}</customapirequestparameter>`;
const propXml = (api, uniquename, { type, entity = '' }) => `<customapiresponseproperty uniquename="${uniquename}">${label('displayname', uniquename)}${el('logicalentityname', entity)}${el('name', `${api}.${uniquename}`)}${el('type', type)}</customapiresponseproperty>`;

// One custom API as unpacked files: customapi.xml, then its request parameters and response properties.
function apiFiles(uniquename, { params = [], props = [], ...options } = {}) {
  return [
    { path: `${uniquename}/customapi.xml`, text: apiXml(uniquename, options) },
    ...params.map(([name, o]) => ({ path: `${uniquename}/customapirequestparameters/${name}/customapirequestparameter.xml`, text: paramXml(uniquename, name, o) })),
    ...props.map(([name, o]) => ({ path: `${uniquename}/customapiresponseproperties/${name}/customapiresponseproperty.xml`, text: propXml(uniquename, name, o) })),
  ];
}

// Type codes: Boolean 0, DateTime 1, Entity 3, EntityCollection 4, Integer 7, Guid 12, String 10, StringArray 11.
const FILES = [
  ...apiFiles('sample_Unbound', { params: [['Message', { type: 10 }], ['Count', { type: 7, optional: 1 }]] }),
  ...apiFiles('sample_Bound', {
    bindingtype: 1, entity: 'account', isfunction: 1, params: [['Flag', { type: 0 }]],
    props: [['Score', { type: 7 }], ['Labels', { type: 11 }], ['Enabled', { type: 0 }], ['Stamp', { type: 1 }], ['Id', { type: 12 }]],
  }),
  ...apiFiles('sample_Collection', { bindingtype: 2, entity: 'sample_item', isfunction: 1, privilege: 'prvSampleRun', props: [['Items', { type: 4, entity: 'sample_item' }]] }),
  ...apiFiles('sample_Private', { isprivate: 1, props: [['Note', { type: 10 }]] }),
  ...apiFiles('sample_Empty', { isfunction: 1 }),
];

function harness(files = FILES) {
  const state = emptyState();
  const rows = parseCustomApiFiles(files);
  for (const logical of LOGICAL) state.tables[logical] = rows[logical];
  const store = new DataStore({ state });
  const ops = [];
  const grants = new Map();
  const registry = { register: (op) => ops.push(op), has: (name) => ops.some((o) => o.name === name), find: () => null };
  const api = { store, change: (fn) => fn(), registry, principals: { privileges: () => grants } };
  const { sync } = install(api);
  const op = (name) => ops.find((o) => o.name === name);
  const call = (name, { method = 'GET', params = {}, body, user = ADMIN } = {}) => op(name).handle({
    method, url: new URL(`/api/data/${VERSION}/${name}`, ORIGIN), origin: ORIGIN, version: VERSION, params, body, user,
  });
  return { store, ops, grants, sync, op, call };
}

const innerCode = (code) => (error) => error.details?.innerCode === code;

test('install seeds the three tables as dataverse-only mappings and keeps an existing mapping', () => {
  const state = emptyState();
  state.mappings.customapi = { logicalName: 'customapi', entitySet: 'custom', idColumn: 'customapiid', fields: {} };
  const store = new DataStore({ state });
  install({ store, change: (fn) => fn(), registry: { register() {}, has: () => false } });
  assert.equal(store.state.mappings.customapi.entitySet, 'custom');
  assert.equal(store.state.mappings.customapi.dataverseOnly, undefined);
  for (const logical of LOGICAL.slice(1)) {
    const mapping = store.state.mappings[logical];
    assert.equal(mapping.userConfigured, true);
    assert.equal(mapping.dataverseOnly, true);
  }
  assert.equal(store.state.mappings.customapirequestparameter.relationships.customapiid.entity, 'customapi');
});

test('each row registers on its binding: unbound action, entity function, collection function', () => {
  const { op } = harness();
  assert.equal(op('sample_Unbound').kind, 'action');
  assert.equal(op('sample_Unbound').binding, 'unbound');
  assert.equal(op('sample_Unbound').entity, undefined);
  assert.equal(op('sample_Bound').kind, 'function');
  assert.equal(op('sample_Bound').binding, 'entity');
  assert.equal(op('sample_Bound').entity, 'account');
  assert.equal(op('sample_Collection').binding, 'collection');
  assert.equal(op('sample_Collection').entity, 'sample_item');
});

test('an action with no response properties returns 204; optional parameters may be omitted', async () => {
  const { call } = harness();
  assert.equal((await call('sample_Unbound', { method: 'POST', body: { Message: 'hi' } })).status, 204);
  assert.equal((await call('sample_Unbound', { method: 'POST', body: { Message: 'hi', Count: 2 } })).status, 204);
});

test('a missing required parameter or a value of the wrong type is a 400 0x80040203', async () => {
  const { call } = harness();
  await assert.rejects(call('sample_Unbound', { method: 'POST', body: { Count: 1 } }), innerCode('0x80040203'));
  await assert.rejects(call('sample_Unbound', { method: 'POST', body: { Message: 5 } }), innerCode('0x80040203'));
  await assert.rejects(call('sample_Unbound', { method: 'POST', body: { Message: 'hi', Count: 1.5 } }), innerCode('0x80040203'));
  await assert.rejects(call('sample_Bound', {}), innerCode('0x80040203'));
});

test('a function returns each response property at its type default in a complex response', async () => {
  const { call } = harness();
  const res = await call('sample_Bound', { params: { Flag: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    '@odata.context': `${ORIGIN}/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.sample_BoundResponse`,
    Score: 0, Labels: [], Enabled: false, Stamp: null, Id: null,
  });
});

test('functions are GET and actions are POST: another verb is the generic 404', async () => {
  const { call } = harness();
  await assert.rejects(call('sample_Bound', { method: 'POST', params: { Flag: true } }), (e) => e.status === 404);
  await assert.rejects(call('sample_Unbound', { method: 'GET' }), (e) => e.status === 404);
});

test('a lone collection response property is the collection type itself', async () => {
  const { call, grants } = harness();
  grants.set('prvSampleRun', 1);
  const res = await call('sample_Collection');
  assert.deepEqual(res.body, { '@odata.context': `${ORIGIN}/api/data/v9.2/$metadata#Collection(mscrm.sample_item)`, value: [] });
});

test('executeprivilegename is checked: a missing privilege is a 403 0x80040220', async () => {
  const { call, grants } = harness();
  await assert.rejects(call('sample_Collection'), innerCode('0x80040220'));
  grants.set('prvSampleRun', 1);
  assert.equal((await call('sample_Collection')).status, 200);
});

test('a function with no response property is absent: 404 0x8006088a', async () => {
  const { call } = harness();
  await assert.rejects(call('sample_Empty'), innerCode('0x8006088a'));
});

test('CSDL: entity-bound function, unbound action, collection-bound function; private and empty functions left out', () => {
  const { op } = harness();
  assert.equal(
    op('sample_Bound').csdl,
    '<ComplexType Name="sample_BoundResponse"><Property Name="Score" Type="Edm.Int32" /><Property Name="Labels" Type="Collection(Edm.String)" /><Property Name="Enabled" Type="Edm.Boolean" /><Property Name="Stamp" Type="Edm.DateTimeOffset" /><Property Name="Id" Type="Edm.Guid" /></ComplexType>'
    + '<Function Name="sample_Bound" IsBound="true"><Parameter Name="entity" Type="mscrm.account" /><Parameter Name="Flag" Type="Edm.Boolean" /><ReturnType Type="mscrm.sample_BoundResponse" /></Function>',
  );
  assert.equal(op('sample_Unbound').csdl, '<Action Name="sample_Unbound"><Parameter Name="Message" Type="Edm.String" /><Parameter Name="Count" Type="Edm.Int32" /></Action>');
  assert.equal(op('sample_Collection').csdl, '<Function Name="sample_Collection" IsBound="true"><Parameter Name="entityset" Type="Collection(mscrm.sample_item)" /><ReturnType Type="Collection(mscrm.sample_item)" /></Function>');
  assert.equal(op('sample_Private').csdl, '');
  assert.equal(op('sample_Empty').csdl, '');
});

test('sync registers rows added after install once per revision; a deleted row fails at call time', async () => {
  const { store, ops, sync, call, op } = harness();
  const before = ops.length;
  const later = parseCustomApiFiles(apiFiles('sample_Later')).customapi;
  await store.transact(() => store.state.tables.customapi.push(...later));
  sync();
  assert.equal(ops.length, before + 1);
  assert.ok(op('sample_Later'));
  sync();
  assert.equal(ops.length, before + 1);
  await store.transact(() => {
    const rows = store.state.tables.customapi;
    rows.splice(rows.findIndex((r) => r.uniquename === 'sample_Later'), 1);
  });
  await assert.rejects(call('sample_Later', { method: 'POST' }), innerCode('0x8006088a'));
});

test('the solution parser links child rows to their API and reads flags, types and labels', () => {
  const rows = parseCustomApiFiles(FILES);
  const bound = rows.customapi.find((r) => r.uniquename === 'sample_Bound');
  assert.equal(bound.bindingtype, 1);
  assert.equal(bound.boundentitylogicalname, 'account');
  assert.equal(bound.isfunction, true);
  assert.equal(bound.isprivate, false);
  assert.equal(bound.displayname, 'sample_Bound');
  const flag = rows.customapirequestparameter.find((p) => p.uniquename === 'Flag');
  assert.equal(flag.customapiid, bound.customapiid);
  assert.equal(flag.type, 0);
  assert.equal(flag.isoptional, false);
  assert.equal(rows.customapirequestparameter.find((p) => p.uniquename === 'Count').isoptional, true);
  assert.equal(rows.customapiresponseproperty.find((p) => p.uniquename === 'Items').logicalentityname, 'sample_item');
  assert.equal(rows.customapi.find((r) => r.uniquename === 'sample_Collection').executeprivilegename, 'prvSampleRun');
  assert.equal(rows.customapi.find((r) => r.uniquename === 'sample_Unbound').boundentitylogicalname, null);
});

test('readCustomApiSolution reads the unpacked folders from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'customapi-'));
  try {
    for (const file of FILES) {
      const path = join(dir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.text);
    }
    const rows = await readCustomApiSolution(dir);
    assert.deepEqual(rows.customapi.map((r) => r.uniquename).sort(), ['sample_Bound', 'sample_Collection', 'sample_Empty', 'sample_Private', 'sample_Unbound']);
    assert.equal(rows.customapirequestparameter.length, 3);
    assert.equal(rows.customapiresponseproperty.length, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
