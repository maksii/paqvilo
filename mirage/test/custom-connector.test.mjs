import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inventoryEntry, mergeInventory } from '../lib/solution-inventory.mjs';
import { customConnectorsOf, buildRequest } from '../lib/custom-connector.mjs';
import { createConnectorRuntime, connectionSettings } from '../lib/connector-runtime.mjs';
import { scriptHash } from '../lib/custom-connector-script.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeFlowDefinition, inspectFlowDefinition } from '../lib/flow-runtime.mjs';

// A Solution custom connector compiles into a contract-level connector provider.
const NAME = 'x_5ffxapi', AT = `Connectors/${NAME}/`;
const OPENAPI = { swagger: '2.0', info: { title: 'Invented FX API' }, host: 'api.example.test', basePath: '/v1', schemes: ['https'],
  securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'x-fx-key' } },
  paths: {
    '/items/{id}': { get: { operationId: 'GetItem', parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }, { name: 'expand', in: 'query', type: 'string' }, { name: 'x-trace', in: 'header', type: 'string' }], responses: { 200: { description: 'ok' } } } },
    '/items': { post: { operationId: 'CreateItem', parameters: [{ name: 'item', in: 'body', required: true, schema: { type: 'object' } }], responses: { 201: { description: 'created' } } } },
  } };
const POLICIES = [
  { templateId: 'routerequesttoendpoint', parameters: { 'x-ms-apimTemplateParameter.newPath': "/@connectionParameters('x_region', 'eu')/items/{id}", 'x-ms-apimTemplate-operationName': ['GetItem'] } },
  { templateId: 'setheader', parameters: { 'x-ms-apimTemplateParameter.name': 'x-fx-client', 'x-ms-apimTemplateParameter.value': 'invented', 'x-ms-apimTemplateParameter.existsAction': 'override', 'x-ms-apimTemplate-policySection': 'Request' } },
  { templateId: 'setqueryparameter', parameters: { 'x-ms-apimTemplateParameter.name': 'api-version', 'x-ms-apimTemplateParameter.value': '2026-01-01', 'x-ms-apimTemplate-policySection': 'Request' } },
];
const entry = (file, value) => inventoryEntry(AT + file, { size: 100, text: typeof value === 'string' ? value : JSON.stringify(value), component: 'connector', componentName: NAME })[0];
const compiled = (extra = []) => customConnectorsOf(mergeInventory([entry(`${NAME}_openapidefinition.json`, OPENAPI), entry(`${NAME}_policytemplateinstances.json`, POLICIES),
  entry(`${NAME}_connectionparameters.json`, { api_key: { type: 'securestring' } }), ...extra]));
const flow = (operationId, parameters) => ({ triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } }, actions: {
  Call: { type: 'OpenApiConnection', runAfter: {}, inputs: { host: { apiId: `/providers/Microsoft.PowerApps/apis/${NAME}`, operationId }, parameters } },
  Reply: { type: 'Response', runAfter: { Call: ['Succeeded'] }, inputs: { statusCode: 200, body: "@body('Call')" } } } });

test('compile keeps path, query, header and body parameters, auth and policies, and builds the request', () => {
  const [connector] = compiled();
  assert.equal(connector.blocked, null);
  assert.equal(connector.baseUrl, 'https://api.example.test/v1');
  assert.deepEqual(connector.auth, { type: 'apiKey', in: 'header', name: 'x-fx-key' });
  assert.deepEqual(connector.operations.GetItem.parameters.map(p => [p.name, p.in, p.required]), [['id', 'path', true], ['expand', 'query', false], ['x-trace', 'header', false]]);
  assert.deepEqual(connector.policies.map(p => [p.templateId, p.supported]), [['routerequesttoendpoint', true], ['setheader', true], ['setqueryparameter', true]]);
  const req = buildRequest(connector, 'GetItem', { id: 'a b', expand: 'all', 'x-trace': 't1' }, { parameters: { x_region: 'us' }, credentials: { apiKey: 'k' } });
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'https://api.example.test/v1/us/items/a%20b?expand=all&api-version=2026-01-01');
  assert.deepEqual(req.headers, { 'x-trace': 't1', 'x-fx-client': 'invented', 'x-fx-key': 'k' });
  const body = buildRequest(connector, 'CreateItem', { 'item/x_name': 'n', 'item/x_tags/first': 't' }, { credentials: { apiKey: 'k' } });
  assert.deepEqual([body.method, body.url, JSON.parse(body.body)], ['POST', 'https://api.example.test/v1/items?api-version=2026-01-01', { x_name: 'n', x_tags: { first: 't' } }]);
  assert.throws(() => buildRequest(connector, 'GetItem', {}, { credentials: { apiKey: 'k' } }), /id is required/);
  assert.throws(() => buildRequest(connector, 'GetItem', { id: '1' }, {}), e => e.code === 'ConnectionUnauthorized');
});

test('a flow action on an imported custom connector reaches a loopback service through its compiled operation and policies', async t => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, client: req.headers['x-fx-client'], key: req.headers['x-fx-key'] }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"x_name":"found"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.INVENTED_FX_KEY = 'invented-key';
  t.after(() => { delete process.env.INVENTED_FX_KEY; });
  const connections = connectionSettings({ [NAME]: { connector: NAME, provider: `custom-connector:${NAME}`, settings: {
    rewrites: { 'https://api.example.test/v1/': `http://127.0.0.1:${server.address().port}/` }, auth: { apiKey: 'env:INVENTED_FX_KEY' }, parameters: { x_region: 'eu' } } } });
  const connectors = createConnectorRuntime({ connections, customConnectors: () => compiled() });
  assert.ok(connectors.describe().some(r => r.name === `custom-connector:${NAME}` && r.level === 'contract'));
  const answer = await executeFlowDefinition({ definition: flow('GetItem', { id: '7' }), input: {}, connectors });
  assert.deepEqual(answer, { status: 200, body: { x_name: 'found' } });
  assert.deepEqual(seen, [{ url: '/eu/items/7?api-version=2026-01-01', client: 'invented', key: 'invented-key' }]);
  // Without the rewrite the non-loopback host is refused, never contacted.
  const remote = createConnectorRuntime({ connections: { [NAME]: { connector: NAME, settings: { auth: { apiKey: 'env:INVENTED_FX_KEY' } } } }, customConnectors: compiled() });
  await assert.rejects(remote.invoke({ connectorId: NAME, operationId: 'GetItem', parameters: { id: '7' } }), { code: 'ProviderUnavailable' });
  // A pack http fixture answers instead of the network.
  const fixtures = createConnectorRuntime({ connections: { [NAME]: { connector: NAME, settings: { auth: { apiKey: 'env:INVENTED_FX_KEY' } } } }, customConnectors: compiled(),
    packs: [{ id: 'fx-pack', httpFixtures: [{ id: 'item', method: 'GET', url: /^https:\/\/api\.example\.test\/v1\/eu\/items\/7/, respond: () => ({ status: 200, body: { x_name: 'fixture' } }) }] }] });
  assert.deepEqual((await fixtures.invoke({ connectorId: NAME, operationId: 'GetItem', parameters: { id: '7' } })).body, { x_name: 'fixture' });
});

test('an unsupported policy blocks the connector; a script operation without the .NET SDK refuses naming it', async () => {
  const blocked = customConnectorsOf(mergeInventory([entry(`${NAME}_openapidefinition.json`, OPENAPI), entry(`${NAME}_policytemplateinstances.json`, [{ templateId: 'setqueryparameter', parameters: { 'x-ms-apimTemplate-policySection': 'Response' } }])]))[0];
  assert.equal(blocked.blocked.code, 'CONNECTOR_POLICY_UNSUPPORTED');
  // A script compiles (its text is kept); without dotnet the script operations are a named gap, never a silent default.
  const script = customConnectorsOf(mergeInventory([entry(`${NAME}_openapidefinition.json`, OPENAPI), inventoryEntry(AT + 'script.csx', { size: 10, text: 'class Script {}', component: 'connector', componentName: NAME })[0]]))[0];
  assert.deepEqual([script.blocked, script.script], [null, { text: 'class Script {}', operations: [] }]);
  const trustedScripts = [{ connector: NAME, sha256: scriptHash('class Script {}') }];
  const connectors = createConnectorRuntime({ customConnectors: [script], dotnet: 'x-invented-missing-dotnet', trustedScripts, connections: { [NAME]: { connector: NAME, settings: { auth: { apiKey: 'env:X_UNSET_KEY' } } } } });
  assert.match(inspectFlowDefinition(flow('GetItem', { id: '1' }), {}, { connectors }).errors.join(' '), /CONNECTOR_SCRIPT_SDK_MISSING/);
  await assert.rejects(async () => connectors.invoke({ connectorId: NAME, operationId: 'GetItem', parameters: { id: '1' } }), e => e.code === 'OperationUnsupported' && /CONNECTOR_SCRIPT_SDK_MISSING.*\.NET SDK/.test(e.message));
  assert.ok(connectors.describe().some(r => r.name === `custom-connector:${NAME}` && r.reason === 'CONNECTOR_SCRIPT_SDK_MISSING' && r.operations.some(o => o.name === 'script' && o.level === 'inventory')));
  // A script the project does not register (connectorScripts: connector + SHA-256 of its text) is refused before
  // anything is generated or built, whether or not the SDK is present; the preflight row names it untrusted.
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-untrusted-'));
  try {
    for (const trusted of [[], [{ connector: NAME, sha256: scriptHash('class Other {}') }], [{ connector: 'x_other', sha256: scriptHash('class Script {}') }]]) {
      const untrusted = createConnectorRuntime({ customConnectors: [script], stateDirectory, trustedScripts: trusted, connections: { [NAME]: { connector: NAME, settings: { auth: { apiKey: 'env:X_UNSET_KEY' } } } } });
      assert.match(inspectFlowDefinition(flow('GetItem', { id: '1' }), {}, { connectors: untrusted }).errors.join(' '), /CONNECTOR_SCRIPT_UNTRUSTED/);
      await assert.rejects(async () => untrusted.invoke({ connectorId: NAME, operationId: 'GetItem', parameters: { id: '1' } }),
        e => e.code === 'OperationUnsupported' && e.message.includes('CONNECTOR_SCRIPT_UNTRUSTED') && e.message.includes(scriptHash('class Script {}')));
      const row = untrusted.describe().find(r => r.name === `custom-connector:${NAME}`);
      assert.equal(row.reason, 'CONNECTOR_SCRIPT_UNTRUSTED');
      assert.match(row.operations.find(o => o.name === 'script').reason, /CONNECTOR_SCRIPT_UNTRUSTED.*user rights/);
    }
    assert.equal(fs.existsSync(path.join(stateDirectory, 'connector-scripts')), false, 'nothing generated or built for an untrusted script');
  } finally { fs.rmSync(stateDirectory, { recursive: true, force: true }); }
  const v3 = customConnectorsOf(mergeInventory([entry(`${NAME}_openapidefinition.json`, { openapi: '3.0.0', info: { title: 'x' }, paths: {} })]))[0];
  assert.equal(v3.blocked.code, 'CONNECTOR_OPENAPI_VERSION_UNSUPPORTED');
  assert.match(inspectFlowDefinition(flow('Missing', {}), {}, { connectors: createConnectorRuntime({ customConnectors: compiled() }) }).errors.join(' '), /CONNECTOR_OPERATION_UNKNOWN/);
});

test('a literal credential in connection settings is rejected', () => {
  assert.throws(() => connectionSettings({ fx: { settings: { auth: { apiKey: 'literal-key' } } } }), /references only/);
  assert.throws(() => connectionSettings({ fx: { settings: { parameters: { api_token: 'literal' } } } }), /must not hold a credential/);
  assert.doesNotThrow(() => connectionSettings({ fx: { provider: 'custom-connector:x_fx', settings: { auth: { username: 'env:U', password: 'variable:x_pw' }, parameters: { x_region: 'eu' } } } }));
});
