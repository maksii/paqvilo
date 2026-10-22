import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore } from '../lib/data.mjs';
import { executeFlowDefinition, inspectFlowDefinition } from '../lib/flow-runtime.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { operationCatalogue } from '../lib/operation-catalogue.mjs';
import { runExportedCloudFlow } from '../lib/exported-operations.mjs';

const FLOW = '77777777-7777-4777-8777-777777777777';
const profile = { userId: '10000000-0000-0000-0000-000000000001', evidence: 'Invented backend grants', grants: [{ entity: 'x_widget', operations: ['read', 'create', 'update', 'delete'] }] };
const readOnly = { ...profile, grants: [{ entity: 'x_widget', operations: ['read'] }] };
const definition = actions => ({ triggers: { request: { type: 'Request', kind: 'powerpages' } }, actions });
const dataverse = (operationId, parameters, connectionName) => ({ type: 'OpenApiConnection', inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', operationId, ...(connectionName ? { connectionName } : {}) }, parameters } });
const references = { x_dv: { connection: { connectionReferenceLogicalName: 'x_dataverseref' } }, x_api: { connection: { connectionReferenceLogicalName: 'x_widgetapiref' } } };
const store = (references = []) => new DataStore({ state: { version: 1, mappings: { x_widget: { entitySet: 'x_widgets', idColumn: 'x_widgetid' } }, tables: { x_widget: [], connectionreference: references }, plugins: [], permissions: [], settings: { permissionMode: 'enforce' } } });

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('an exported flow Http action reaches a rewritten loopback URL and failures follow runAfter', async t => {
  const local = await listen(t, (req, res) => { res.setHeader('content-type', 'application/json'); res.statusCode = req.url === '/api/missing' ? 404 : 200; res.end(JSON.stringify({ path: req.url })); });
  const notes = [];
  const connectors = createConnectorRuntime({ diagnostic: note => notes.push(note), connections: { http: { connector: 'http', provider: 'http', settings: { rewrites: { 'https://func.example.test/api/': local + '/api/' } } } } });
  const d = definition({
    call: { type: 'Http', inputs: { method: 'GET', uri: "https://func.example.test/api/@{triggerBody()?['name']}" } },
    reply: { type: 'Response', runAfter: { call: ['Succeeded', 'Failed'] }, inputs: { body: { status: "@actions('call')?['status']", code: "@outputs('call')?['statusCode']", body: "@outputs('call')?['body']", error: "@outputs('call')?['error']?['code']" } } },
  });
  // Without a connector runtime the Http action keeps today's placeholder behaviour.
  assert.equal(inspectFlowDefinition(d).supported, false);
  assert.equal(inspectFlowDefinition(d, {}, { connectors }).supported, true);
  assert.deepEqual(await executeFlowDefinition({ definition: d, input: { name: 'echo' }, connectors }), { status: 200, body: { status: 'Succeeded', code: 200, body: { path: '/api/echo' }, error: null } });
  assert.deepEqual(await executeFlowDefinition({ definition: d, input: { name: 'missing' }, connectors }), { status: 200, body: { status: 'Failed', code: 404, body: { path: '/api/missing' }, error: null } });
  assert.equal(notes.filter(n => n.code === 'CONNECTOR_INVOKE' && n.caller === 'flow').length, 2);
  // A non-loopback URL without a rewrite fails the action instead of reaching the network.
  const bare = await executeFlowDefinition({ definition: { ...d, actions: { ...d.actions, call: { type: 'Http', inputs: { method: 'GET', uri: 'https://other.example.test/' } } } }, input: {}, connectors });
  assert.deepEqual(bare.body, { status: 'Failed', code: null, body: null, error: 'ProviderUnavailable' });
});

test('inspectFlowDefinition reports the connection of every connector action', () => {
  const pack = { id: 'x-pack', connectors: { x_widgetapi: { operations: { List: () => ({ statusCode: 200, body: { value: [] } }) } } } };
  const connectors = createConnectorRuntime({ store: store([{ connectionreferencelogicalname: 'x_widgetapiref', connectionid: 'conn-api' }]), packs: [pack], connections: { 'conn-api': { connector: 'x_widgetapi', provider: 'pack:x-pack' } } });
  const d = definition({
    list: { type: 'OpenApiConnection', inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/x_widgetapi', operationId: 'List', connectionName: 'x_api' }, parameters: {} } },
    create: { ...dataverse('CreateRecord', { entityName: 'x_widgets' }, 'x_dv'), runAfter: { list: ['Succeeded'] } },
    compose: { type: 'Compose', inputs: 1, runAfter: { create: ['Succeeded'] } },
  });
  const contract = inspectFlowDefinition(d, {}, { connectors, connectionReferences: references });
  const byKey = Object.fromEntries(contract.actions.map(a => [a.key, a]));
  assert.deepEqual(byKey.list.connection, { referenceLogicalName: 'x_widgetapiref', bound: true, provider: 'pack:x-pack' });
  assert.deepEqual(byKey.create.connection, { referenceLogicalName: 'x_dataverseref', bound: false, provider: null });
  assert.equal(byKey.compose.connection, undefined);
  assert.equal(byKey.list.supported, true);
  assert.equal(byKey.create.supported, false);
  assert.match(contract.errors.join(' '), /Unbound connection reference x_dataverseref for action create/);
  // The per-flow override (flowIdentities) binds the Dataverse action.
  const overridden = inspectFlowDefinition(d, {}, { connectors, connectionReferences: references, principal: profile });
  assert.equal(overridden.supported, true);
  assert.deepEqual(overridden.connections.map(c => [c.referenceLogicalName, c.bound, c.usedBy]), [['x_widgetapiref', true, ['list']], ['x_dataverseref', true, ['create']]]);
});

test('a flow with an unbound connection reference stays a placeholder until the connection binds', () => {
  const pack = { id: 'x-pack', connectionPrincipals: { owner: profile } };
  const workflow = { file: '/invented/flow.json', active: true, definition: { properties: { connectionReferences: references, definition: definition({ create: dataverse('CreateRecord', { entityName: 'x_widgets' }, 'x_dv') }) } } };
  const catalogue = connectors => operationCatalogue({ portal: { cloudFlows: [{ id: 'consumer', name: 'Invented', processId: FLOW, path: '/_api/cloudflow/v1.0/trigger/' + FLOW }] }, workflows: new Map([[FLOW, workflow]]), connectors })[0];
  const unbound = catalogue(createConnectorRuntime({ store: store([]), packs: [pack] }));
  assert.equal(unbound.mode, 'placeholder');
  assert.deepEqual(unbound.contract.connections.map(c => [c.name, c.bound]), [['x_dv', false]]);
  const rows = [{ connectionreferencelogicalname: 'x_dataverseref', connectionid: 'conn-dv' }];
  const bound = catalogue(createConnectorRuntime({ store: store(rows), packs: [pack], connections: { 'conn-dv': { connector: 'shared_commondataserviceforapps', provider: 'dataverse', principal: 'owner' } } }));
  assert.equal(bound.mode, 'exported');
  assert.deepEqual(bound.contract.connections.map(c => [c.name, c.connectionId, c.provider, c.bound]), [['x_dv', 'conn-dv', 'dataverse', true]]);
});

test('Dataverse actions behave as before and a connection principal yields to the flowIdentities override', async () => {
  const actions = { create: dataverse('CreateRecord', { entityName: 'x_widgets', 'item/x_name': "@triggerBody()?['name']" }, 'x_dv'), reply: { type: 'Response', runAfter: { create: ['Succeeded', 'Failed'] }, inputs: { body: { row: "@outputs('create')?['body']", error: "@outputs('create')?['error']?['code']" } } } };
  const workflows = new Map([[FLOW, { definition: { properties: { connectionReferences: references, definition: definition(actions) } } }]]);
  const data = store([{ connectionreferencelogicalname: 'x_dataverseref', connectionid: 'conn-dv' }]);
  const connectors = createConnectorRuntime({ store: data, packs: [{ id: 'x-pack', connectionPrincipals: { owner: profile } }], connections: { 'conn-dv': { connector: 'shared_commondataserviceforapps', principal: 'owner' } } });
  const run = options => runExportedCloudFlow({ record: { processId: FLOW }, workflows, store: data, connectors, ...options });
  // Connection principal alone. A Dataverse row write runs on the asynchronous drive (a flow action is not nested in a
  // plug-in: its synchronous service endpoint steps are awaited in process), so the run answers a promise.
  const created = await run({ input: { name: 'Via connection' } });
  assert.equal(created.body.row.x_name, 'Via connection');
  assert.equal(created.body.error, null);
  // flowIdentities override with read-only grants takes precedence over the connection principal.
  assert.deepEqual(await run({ input: { name: 'Denied' }, serviceProfile: readOnly }), { status: 200, body: { row: null, error: 'LocalBackendPermissionDenied' } });
  assert.equal(data.snapshot().tables.x_widget.length, 1);
  // Without a connector runtime the flow keeps today's behaviour: the override alone drives the action.
  const legacy = await executeFlowDefinition({ definition: definition(actions), input: { name: 'Legacy' }, store: data, serviceProfile: profile });
  assert.equal(legacy.body.row.x_name, 'Legacy');
  assert.equal(data.snapshot().tables.x_widget.length, 2);
});
