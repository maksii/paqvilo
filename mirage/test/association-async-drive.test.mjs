// RC4a-01: Associate/Disassociate outside a plug-in run on the asynchronous drive (Learn use-webhooks: a synchronous web hook
// runs inside its operation). A flow Relate/Unrelate rows action (with and without an organization) and a Web API $ref post a
// synchronous web hook step in process, so timers keep running while the step waits and a receiver in this process answers.
// Invented x_ tables, GUIDs and loopback endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { serviceEndpointDelivery } from '../lib/dataverse-webhooks.mjs';
import { pluginPhaseRequiresCheckpoint, runPluginPhase } from '../lib/exported-plugins.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { closeSyncIoBridge } from '../lib/sync-io-bridge.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const ID = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const PARENT = ID(901), CHILD = ID(902), ENDPOINT = ID(903), STEP = ID(904), USER = ID(905);
const ops = ['read', 'create', 'update', 'delete', 'associate', 'disassociate'];
const profile = { userId: USER, evidence: 'Invented test grants', grants: [{ entity: 'x_parent', operations: ops }, { entity: 'x_child', operations: ops }] };
const mappings = {
  x_parent: { logicalName: 'x_parent', entitySet: 'x_parents', idColumn: 'x_parentid', nameColumn: 'x_name', fields: { x_name: { dataverseType: 'nvarchar' } },
    relationships: { x_parent_children: { schemaName: 'x_parent_children', entity: 'x_child', from: 'x_parentid', to: 'x_parentid', many: true, partner: 'x_parentid' } } },
  x_child: { logicalName: 'x_child', entitySet: 'x_children', idColumn: 'x_childid', nameColumn: 'x_name', fields: { x_name: { dataverseType: 'nvarchar' }, x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] } },
    relationships: { x_parentid: { schemaName: 'x_parent_children', entity: 'x_parent', from: 'x_parentid', to: 'x_parentid', many: false, partner: 'x_parent_children' } } },
};
test.after(() => closeSyncIoBridge());

async function receiver(t) {
  const received = [];
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { received.push(req.url); setTimeout(() => res.writeHead(200).end(), 200); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, received };
}
const tables = (url) => ({
  x_parent: [{ x_parentid: PARENT, x_name: 'Invented parent', statecode: 0 }],
  x_child: [{ x_childid: CHILD, x_name: 'Invented child', x_parentid: null, statecode: 0 }],
  systemuser: [{ systemuserid: USER, fullname: 'Invented flow user', statecode: 0 }],
  serviceendpoint: [{ serviceendpointid: ENDPOINT, name: 'Invented hook', contract: 8, authtype: 5, authvalue: '', url }],
});
function wire(store, message, diagnostics = []) {
  const items = [{ id: STEP, name: 'Invented sync hook', enabled: true, mode: 'webhook', entity: 'x_parent', message, stage: 40, rank: 1, contract: { mode: 0 }, filteringAttributes: [], images: [], serviceEndpointId: ENDPOINT }];
  const webhooks = serviceEndpointDelivery(store);
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers: new Map(), webhooks, diagnostic: (entry) => diagnostics.push(entry) }),
    () => true, (context) => pluginPhaseRequiresCheckpoint(items, context));
}
const ticking = () => { let ticks = 0; const timer = setInterval(() => ticks++, 25); return () => { clearInterval(timer); return ticks; }; };
const relate = (store, operationId) => createConnectorRuntime({ store }).invoke({ connectorId: 'shared_commondataserviceforapps', operationId,
  parameters: { entityName: 'x_parents', recordId: PARENT, associationEntityRelationship: 'x_parent_children',
    [operationId === 'AssociateEntities' ? '@odata.id' : '$id']: `http://localhost:5555/api/data/v9.2/x_children(${CHILD})` }, context: { principal: profile } });

test('a flow Relate/Unrelate rows action without an organization awaits its synchronous web hook in process', { timeout: 20_000 }, async (t) => {
  const hook = await receiver(t);
  const state = emptyState();
  Object.assign(state.mappings, structuredClone(mappings));
  Object.assign(state.tables, tables(hook.url));
  state.settings.permissionMode = 'permissive';
  const store = await new DataStore({ state }).init();
  wire(store, 'Associate');
  let stop = ticking();
  assert.equal((await relate(store, 'AssociateEntities')).statusCode, 204);
  assert.ok(stop() >= 2, 'timers kept running while the Associate step waited');
  assert.equal(store.tableRows('x_child')[0].x_parentid, PARENT);
  wire(store, 'Disassociate');
  stop = ticking();
  assert.equal((await relate(store, 'DisassociateEntities')).statusCode, 204);
  assert.ok(stop() >= 2, 'timers kept running while the Disassociate step waited');
  assert.equal(store.tableRows('x_child')[0].x_parentid ?? null, null);
  assert.deepEqual(hook.received, ['/hook', '/hook']);
});

test('with an organization, the flow action and a Web API $ref both run the association on the asynchronous drive', { timeout: 30_000 }, async (t) => {
  const hook = await receiver(t);
  const { store, request } = await contractModuleFixture(t, { mappings, tables: tables(hook.url), extension: { name: 'x-invented-none', install() {} } });
  wire(store, 'Associate');
  let stop = ticking();
  assert.equal((await relate(store, 'AssociateEntities')).statusCode, 204);
  assert.ok(stop() >= 2, 'timers kept running while the flow step waited');
  assert.equal(store.tableRows('x_child')[0].x_parentid?.id ?? store.tableRows('x_child')[0].x_parentid, PARENT);
  wire(store, 'Disassociate');
  stop = ticking();
  const removed = await request('DELETE', `/x_parents(${PARENT})/x_parent_children(${CHILD})/$ref`);
  assert.equal(removed.status, 204, await removed.text());
  assert.ok(stop() >= 2, 'timers kept running while the $ref step waited');
  assert.equal(store.tableRows('x_child')[0].x_parentid ?? null, null);
  assert.deepEqual(hook.received, ['/hook', '/hook']);
});
