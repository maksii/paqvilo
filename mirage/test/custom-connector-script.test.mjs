// Task 42: a custom connector's C# script (script.csx, ScriptBase) runs through the local .NET SDK for its scriptOperations:
// the host is generated and built once per script hash under the state directory, Context.SendAsync reaches the backend
// through the connection rewrites (loopback only), and the script's response is the action's. Skipped with a note when
// `dotnet` is not on PATH; the refusal path without the SDK is tested in custom-connector.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { inventoryEntry, mergeInventory } from '../lib/solution-inventory.mjs';
import { customConnectorsOf } from '../lib/custom-connector.mjs';
import { dotnetSdk, scriptHash } from '../lib/custom-connector-script.mjs';
import { createConnectorRuntime, connectionSettings } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition } from '../lib/flow-runtime.mjs';

const NAME = 'x_5fscriptapi', AT = `Connectors/${NAME}/`;
const OPENAPI = { swagger: '2.0', info: { title: 'Invented scripted API' }, host: 'api.example.test', basePath: '/v1', schemes: ['https'],
  paths: { '/items/{id}': { get: { operationId: 'GetItem', parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }], responses: { 200: { description: 'ok' } } } },
    '/plain': { get: { operationId: 'Plain', responses: { 200: { description: 'ok' } } } } } };
const SCRIPT = `public class Script : ScriptBase
{
    public override async Task<HttpResponseMessage> ExecuteAsync()
    {
        if (this.Context.OperationId != "GetItem")
        {
            var refused = new HttpResponseMessage(HttpStatusCode.BadRequest);
            refused.Content = CreateJsonContent($"Unknown operation ID '{this.Context.OperationId}'");
            return refused;
        }
        var response = await this.Context.SendAsync(this.Context.Request, this.CancellationToken).ConfigureAwait(false);
        var result = JObject.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
        response.Content = CreateJsonContent(new JObject { ["wrapped"] = result, ["operation"] = this.Context.OperationId }.ToString());
        return response;
    }
}`;
const records = () => mergeInventory([
  inventoryEntry(AT + `${NAME}_openapidefinition.json`, { size: 100, text: JSON.stringify(OPENAPI), component: 'connector', componentName: NAME })[0],
  inventoryEntry(AT + `${NAME}_apiproperties.json`, { size: 100, text: JSON.stringify({ properties: { scriptOperations: ['GetItem'] } }), component: 'connector', componentName: NAME })[0],
  inventoryEntry(AT + 'script.csx', { size: SCRIPT.length, text: SCRIPT, component: 'connector', componentName: NAME })[0]]);

test('a C# script runs its operation through the .NET SDK and Context.SendAsync reaches the loopback backend', { timeout: 300000, skip: dotnetSdk() ? false : 'dotnet is not on PATH: the script host cannot be built here' }, async t => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: req.url.split('/').pop() })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-script-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const merged = records();
  assert.equal(merged.find(r => r.component === 'connector').level, 'contract', 'with the SDK on PATH the scripted connector compiles at contract');
  const [connector] = customConnectorsOf(merged);
  assert.deepEqual([connector.blocked, connector.script.operations], [null, ['GetItem']]);
  const connectors = createConnectorRuntime({ customConnectors: [connector], stateDirectory, trustedScripts: [{ connector: NAME, sha256: scriptHash(SCRIPT) }],
    connections: connectionSettings({ [NAME]: { connector: NAME, settings: { rewrites: { 'https://api.example.test/v1/': `http://127.0.0.1:${server.address().port}/` } } } }) });
  const answer = await connectors.invoke({ connectorId: NAME, operationId: 'GetItem', parameters: { id: '7' }, context: { timeoutMs: 120000 } });
  assert.equal(answer.statusCode, 200);
  assert.deepEqual(answer.body, { wrapped: { id: '7' }, operation: 'GetItem' });
  assert.deepEqual(seen, ['/items/7']);
  const hosts = await fs.readdir(path.join(stateDirectory, 'connector-scripts'));
  assert.equal(hosts.length, 1, 'one host per script hash under the state directory');
  // An operation outside scriptOperations goes to the backend directly.
  assert.deepEqual((await connectors.invoke({ connectorId: NAME, operationId: 'Plain', parameters: {}, context: { timeoutMs: 120000 } })).body, { id: 'plain' });
  // A flow action reaches the scripted operation; the build is reused.
  const definition = { triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } }, actions: {
    Call: { type: 'OpenApiConnection', runAfter: {}, inputs: { host: { apiId: `/providers/Microsoft.PowerApps/apis/${NAME}`, operationId: 'GetItem' }, parameters: { id: '9' } } },
    Reply: { type: 'Response', runAfter: { Call: ['Succeeded'] }, inputs: { statusCode: 200, body: "@body('Call')" } } } };
  assert.deepEqual(await executeFlowDefinition({ definition, input: {}, connectors, limits: { timeoutMs: 5000 } }), { status: 200, body: { wrapped: { id: '9' }, operation: 'GetItem' } });
  assert.equal((await fs.readdir(path.join(stateDirectory, 'connector-scripts'))).length, 1);
});

// RC4b-01: a trusted script host gets a minimal environment (PATH, SystemRoot, TEMP/TMP, HOME/USERPROFILE, DOTNET_*, NUGET_*),
// never process.env, so another connection's env: secret is invisible to it; it runs in its folder under the state directory.
const ENV_SCRIPT = `public class Script : ScriptBase
{
    public override async Task<HttpResponseMessage> ExecuteAsync()
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK);
        response.Content = CreateJsonContent(new JObject { ["secret"] = Environment.GetEnvironmentVariable("X_INVENTED_OTHER_SECRET"),
            ["path"] = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PATH")), ["cwd"] = Environment.CurrentDirectory }.ToString());
        return response;
    }
}`;
test('a trusted script host does not see process.env secrets and runs under the state directory', { timeout: 300000, skip: dotnetSdk() ? false : 'dotnet is not on PATH: the script host cannot be built here' }, async t => {
  process.env.X_INVENTED_OTHER_SECRET = 'invented-other-secret';
  t.after(() => { delete process.env.X_INVENTED_OTHER_SECRET; });
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-script-env-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const [connector] = customConnectorsOf(mergeInventory([
    inventoryEntry(AT + `${NAME}_openapidefinition.json`, { size: 100, text: JSON.stringify(OPENAPI), component: 'connector', componentName: NAME })[0],
    inventoryEntry(AT + 'script.csx', { size: ENV_SCRIPT.length, text: ENV_SCRIPT, component: 'connector', componentName: NAME })[0]]));
  const connectors = createConnectorRuntime({ customConnectors: [connector], stateDirectory, trustedScripts: [{ connector: NAME, sha256: scriptHash(ENV_SCRIPT) }],
    connections: connectionSettings({ [NAME]: { connector: NAME, settings: {} } }) });
  const { body } = await connectors.invoke({ connectorId: NAME, operationId: 'Plain', parameters: {}, context: { timeoutMs: 120000 } });
  assert.equal(body.secret, null, 'the other connection secret is not in the host environment');
  assert.equal(body.path, true);
  assert.ok(path.resolve(body.cwd).startsWith(path.join(await fs.realpath(stateDirectory), 'connector-scripts')) || path.resolve(body.cwd).startsWith(path.join(stateDirectory, 'connector-scripts')), body.cwd);
});
