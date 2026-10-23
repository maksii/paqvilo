import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { createWebApiExecute } from '../lib/model-driven/client-runtime.mjs';
import { createModelDrivenWebApi } from '../lib/dataverse-model-driven.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const ENTITY = '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel><MaxLength>20</MaxLength></attribute></attributes></entity></EntityInfo></Entity>';

async function organizationFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xrm-execute-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedExecute</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': ENTITY,
    'solution/customapis/x_Echo/customapi.xml': '<customapi uniquename="x_Echo"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_Echo</name></customapi>',
  };
  for (const [name, content] of Object.entries(files)) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const sim = await createSimulator({ runtime: { kind: 'model-driven' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false,
    simulation: { level: 'dry-run' }, dataverse: { enabled: false, tds: { enabled: false } } });
  ownedFixture(t).add(() => sim.close());
  const webApi = createModelDrivenWebApi({ organization: () => sim.organization });
  const principal = { principalId: uuidV5(sim.organization.organizationId, 'systemuser:SYSTEM'), kind: 'local-admin' };
  const host = { tables: { x_item: { entity: 'x_item', entitySet: 'x_items', idColumn: 'x_itemid' } }, webApi: request => webApi({ ...request, principal, host: '127.0.0.1' }) };
  return { sim, xrm: createWebApiExecute(host), rows: () => sim.store.tableRows('x_item') };
}

const request = (metadata, values = {}) => Object.assign(Object.create({ getMetadata: () => metadata }), values);

test('Xrm.WebApi.execute runs functions, custom API actions and CRUD through the organization as the staff principal', async t => {
  const { sim, xrm, rows } = await organizationFixture(t);
  const whoAmI = await xrm.execute(request({ boundParameter: null, parameterTypes: {}, operationType: 1, operationName: 'WhoAmI' }));
  assert.equal(whoAmI.ok, true); assert.equal(whoAmI.status, 200);
  assert.equal((await whoAmI.json()).UserId, uuidV5(sim.organization.organizationId, 'systemuser:SYSTEM'));
  const action = await xrm.execute(request({ boundParameter: null, parameterTypes: {}, operationType: 0, operationName: 'x_Echo' }));
  assert.equal(action.ok, true); assert.ok([200, 204].includes(action.status));
  const created = await xrm.execute(request({ boundParameter: null, parameterTypes: {}, operationType: 2, operationName: 'Create' }, { etn: 'x_item', payload: { x_name: 'Invented' } }));
  assert.equal(created.status, 204);
  const id = rows().find(row => row.x_name === 'Invented').x_itemid;
  const read = await xrm.execute(request({ boundParameter: null, parameterTypes: {}, operationType: 2, operationName: 'Retrieve' }, { entityReference: { entityType: 'x_item', id: `{${id.toUpperCase()}}` }, columns: ['x_name'] }));
  assert.equal((await read.json()).x_name, 'Invented');
  await xrm.execute(request({ boundParameter: null, parameterTypes: {}, operationType: 2, operationName: 'Update' }, { etn: 'x_item', id, payload: { x_name: 'Renamed' } }));
  assert.equal(rows().find(row => row.x_itemid === id).x_name, 'Renamed');
  await xrm.execute(request({ boundParameter: null, parameterTypes: {}, operationType: 2, operationName: 'Delete' }, { entityReference: { entityType: 'x_item', id } }));
  assert.equal(rows().some(row => row.x_itemid === id), false);
});

test('an unknown operation rejects with the organization error and a request without metadata is refused', async t => {
  const { xrm } = await organizationFixture(t);
  await assert.rejects(xrm.execute(request({ boundParameter: null, parameterTypes: {}, operationType: 0, operationName: 'x_NotDeclared' })), error => error.status === 404);
  await assert.rejects(xrm.execute({}), /getMetadata/);
});

test('function parameters become aliases and executeMultiple runs a change set atomically', async t => {
  const { xrm, rows } = await organizationFixture(t);
  const http = xrm.toHttp(request({ boundParameter: null, operationType: 1, operationName: 'x_Lookup',
    parameterTypes: { Name: { typeName: 'Edm.String', structuralProperty: 1 }, Target: { typeName: 'mscrm.x_item', structuralProperty: 5 } } },
  { Name: "O'Neil", Target: { entityType: 'x_item', id: '{77777777-7777-4777-8777-777777777777}' } }));
  assert.equal(http.method, 'GET');
  assert.equal(decodeURIComponent(http.path), "/api/data/v9.2/x_Lookup(Name=@p1,Target=@p2)?@p1='O''Neil'&@p2={\"@odata.id\":\"x_items(77777777-7777-4777-8777-777777777777)\"}");
  const create = name => request({ boundParameter: null, parameterTypes: {}, operationType: 2, operationName: 'Create' }, { etn: 'x_item', payload: { x_name: name } });
  const done = await xrm.executeMultiple([[create('First'), create('Second')]]);
  assert.deepEqual(done.map(item => item.status), [204, 204]);
  assert.deepEqual(rows().map(row => row.x_name).sort(), ['First', 'Second']);
  // The second write exceeds the column length: the change set rolls back the first.
  // Learn executeMultiple: the rejection carries the failing request's Dataverse error (code 0x80044331, its message).
  await assert.rejects(xrm.executeMultiple([[create('Third'), create('This name is far longer than twenty')]]),
    error => error.status === 400 && error.errorCode === 0x80044331 && /x_name/.test(error.message));
  assert.deepEqual(rows().map(row => row.x_name).sort(), ['First', 'Second']);
});

test('the /_apps/api/webapi bridge validates the request and forwards the staff principal', async () => {
  const seen = [];
  const handler = createModelDrivenHandler({ catalogue: () => ({ tables: {} }), data: {}, csrf: () => 'token', json: (res, status, body) => { res.status = status; res.body = body; },
    readBody: async req => req.body, change: fn => fn(), principal: () => ({ principalId: '77777777-7777-4777-8777-777777777777', kind: 'staff' }),
    webApi: async input => { seen.push(input); return { status: 200, headers: {}, body: '{}' }; } });
  const call = async body => { const res = { setHeader() {}, destroyed: false }; await handler({ method: 'POST', headers: { 'x-sim-csrf': 'token', host: '127.0.0.1:1' }, body }, res, new URL('http://127.0.0.1:1/_apps/api/webapi')); return res; };
  assert.equal((await call({ method: 'GET', path: '/api/data/v9.2/WhoAmI' })).status, 200);
  assert.equal(seen[0].principal.principalId, '77777777-7777-4777-8777-777777777777');
  assert.equal((await call({ method: 'GET', path: '/_sim/api/state' })).status, 400);
  const unwired = createModelDrivenHandler({ catalogue: () => ({}), data: {}, csrf: () => 'token', json: (res, status, body) => { res.status = status; res.body = body; }, readBody: async req => req.body, change: fn => fn() });
  const res = { setHeader() {} };
  await unwired({ method: 'POST', headers: { 'x-sim-csrf': 'token' }, body: { method: 'GET', path: '/api/data/v9.2/WhoAmI' } }, res, new URL('http://127.0.0.1:1/_apps/api/webapi'));
  assert.equal(res.status, 501); assert.equal(res.body.error.code, 'WebApiExecuteUnavailable');
});
