// Server objects in exported server logic, through runExportedServerLogic (the production caller), not the bare worker:
// environment variables, Dataverse.InvokeCustomApi, CloudFlow.TriggerAsync, HttpClient (loopback contract) and Logger.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { organizationCustomApi, runExportedServerLogic } from '../lib/exported-operations.mjs';

const SITE = '77777777-7777-4777-8777-777777777730';
const CONTACT = '77777777-7777-4777-8777-777777777731';
const portal = { settings: {}, website: { id: SITE, name: 'Invented site' } };
const identity = { id: CONTACT, contactId: CONTACT, roleIds: ['77777777-7777-4777-8777-777777777732'] };

async function logic(t, code) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-logic-bridges-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'logic.js'), code);
  return { name: 'invented', file: await fs.realpath(path.join(dir, 'logic.js')) };
}
const run = async (t, code, options = {}) =>
  JSON.parse(
    await runExportedServerLogic({
      record: await logic(t, code),
      portal,
      store: options.store ?? { state: emptyState() },
      identity,
      method: 'POST',
      operation: 'post',
      timeout: 4000,
      ...options,
    }),
  );

test('Server.EnvironmentVariable.get reads the store effective values when the caller passes none; a Secret answers null', async (t) => {
  const state = emptyState();
  state.tables.environmentvariabledefinition = [
    {
      environmentvariabledefinitionid: '77777777-7777-4777-8777-777777777740',
      schemaname: 'fx_SitePath',
      type: 100000000,
      defaultvalue: '/invented/',
    },
    {
      environmentvariabledefinitionid: '77777777-7777-4777-8777-777777777741',
      schemaname: 'fx_Key',
      type: 100000005,
      defaultvalue: 'https://fx.vault.example.test/secrets/key',
    },
  ];
  state.tables.environmentvariablevalue = [];
  const diagnostics = [];
  const result = await run(
    t,
    "function post(){ return [Server.EnvironmentVariable.get('FX_SITEPATH'), Server.EnvironmentVariable.get('fx_Key')]; }",
    { store: { state }, services: { diagnostic: (entry) => diagnostics.push(entry) } },
  );
  assert.deepEqual(result, ['/invented/', null]);
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['SECRET_NOT_EXPOSED_TO_SERVER_LOGIC'],
  );
  assert.ok(diagnostics[0].operationId);
  assert.doesNotMatch(JSON.stringify(diagnostics), /vault/);
});

test('Dataverse.InvokeCustomApi runs the custom API through the organization', async (t) => {
  const store = await new DataStore({ state: emptyState() }).init();
  const callers = [];
  const handler = async (context) => {
    callers.push(context.caller);
    return { outputs: { Result: `echo:${context.inputs.Text}` } };
  };
  const organization = await createOrganizationRuntime({
    store,
    extensions: await sourceOrganizationExtensions({ customApis: new Map([['fx_echo', { handler }]]) }),
    settings: dataverseSettings({ enabled: false }),
  });
  t.after(() => organization.close());
  await (async () => {
    const api = await store.create(
      'customapi',
      { uniquename: 'fx_Echo', name: 'Echo', bindingtype: 0, isfunction: false },
      { admin: true },
    );
    const id = api.customapiid;
    await store.create(
      'customapirequestparameter',
      { uniquename: 'Text', name: 'Text', type: 10, isoptional: false, customapiid: { id, logical_name: 'customapi' } },
      { admin: true },
    );
    await store.create(
      'customapiresponseproperty',
      { uniquename: 'Result', name: 'Result', type: 10, customapiid: { id, logical_name: 'customapi' } },
      { admin: true },
    );
  })();
  const system =
    store.tableRows('systemuser').find((row) => /SYSTEM/i.test(String(row.fullname ?? row.domainname ?? ''))) ??
    store.tableRows('systemuser')[0];
  const services = { invokeCustomApi: organizationCustomApi(organization, { principal: system.systemuserid }) };
  const [ok, missing] = await run(
    t,
    "function post(){ return [JSON.parse(Server.Connector.Dataverse.InvokeCustomApi('post', 'fx_Echo', JSON.stringify({ Text: 'hi' }))), JSON.parse(Server.Connector.Dataverse.InvokeCustomApi('post', 'fx_Missing', '{}'))]; }",
    { services },
  );
  assert.equal(ok.StatusCode, 200, JSON.stringify(ok));
  assert.equal(ok.IsSuccessStatusCode, true);
  assert.equal(JSON.parse(ok.Body).Result, 'echo:hi');
  assert.equal(callers.length, 1);
  assert.deepEqual([missing.StatusCode, missing.IsSuccessStatusCode], [404, false]);
  // Without the host service the bridge answers an error envelope, never a success.
  const unwired = await run(
    t,
    "function post(){ return JSON.parse(Server.Connector.Dataverse.InvokeCustomApi('post', 'fx_Echo', '{}')); }",
  );
  assert.deepEqual([unwired.StatusCode, unwired.IsSuccessStatusCode, unwired.ServerError], [501, false, true]);
});

test('CloudFlow.TriggerAsync answers the trigger pipeline envelope, including the web-role refusal and 202', async (t) => {
  const calls = [];
  const triggerFlow = async ({ flowId, payload, identity: caller }) => {
    calls.push({ flowId, payload });
    if (!caller?.roleIds?.length) return { status: 403, body: { error: 'Forbidden' } };
    return flowId.endsWith('51') ? { status: 202, body: null } : { status: 200, body: { Echo: payload.Location } };
  };
  const code =
    "async function post(){ const a = JSON.parse(await Server.Connector.CloudFlow.TriggerAsync('{77777777-7777-4777-8777-777777777750}', JSON.stringify({ Location: 'Invented' }))); const b = JSON.parse(await Server.Connector.CloudFlow.TriggerAsync('77777777-7777-4777-8777-777777777751')); return [a, b]; }";
  const [answered, accepted] = await run(t, code, { services: { triggerFlow } });
  assert.deepEqual(
    [answered.StatusCode, answered.IsSuccessStatusCode, JSON.parse(answered.Body)],
    [200, true, { Echo: 'Invented' }],
  );
  assert.deepEqual([accepted.StatusCode, accepted.IsSuccessStatusCode, accepted.Body], [202, true, '']);
  assert.deepEqual(calls[0], {
    flowId: '77777777-7777-4777-8777-777777777750',
    payload: { Location: 'Invented', siteId: SITE, userId: CONTACT },
  });
  const refused = JSON.parse(
    await runExportedServerLogic({
      record: await logic(t, code),
      portal,
      store: { state: emptyState() },
      identity: { id: CONTACT, contactId: CONTACT, roleIds: [] },
      method: 'POST',
      operation: 'post',
      services: { triggerFlow },
    }),
  )[0];
  assert.deepEqual([refused.StatusCode, refused.IsSuccessStatusCode], [403, false]);
});

test('HttpClient reaches a declared loopback rewrite and refuses any other host with the envelope; Logger writes with the operation id', async (t) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method, body, client: req.headers.client_id ?? null }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}/`;
  const logs = [],
    diagnostics = [];
  const code =
    "async function post(){ Server.Logger.Error('invented failure', 7); const a = JSON.parse(await Server.Connector.HttpClient.PostAsync('https://api.example.test/objects', JSON.stringify({ n: 1 }), { client_id: 'c1' }, 'application/json')); const b = JSON.parse(await Server.Connector.HttpClient.GetAsync('https://other.example.test/x')); return [a, b]; }";
  const [reached, refused] = await run(t, code, {
    services: {
      httpRewrites: { 'https://api.example.test/': local },
      log: (entry) => logs.push(entry),
      diagnostic: (entry) => diagnostics.push(entry),
    },
  });
  assert.deepEqual([reached.StatusCode, reached.IsSuccessStatusCode], [200, true]);
  assert.deepEqual(JSON.parse(reached.Body), { path: '/objects', method: 'POST', body: '{"n":1}', client: 'c1' });
  assert.deepEqual(
    [refused.StatusCode, refused.IsSuccessStatusCode, refused.ServerError, refused.ServerErrorMessage],
    [502, false, true, 'HTTP target is not a declared local service'],
  );
  assert.deepEqual(
    diagnostics.map((entry) => [entry.code, entry.host]),
    [['SERVER_LOGIC_HTTP_REFUSED', 'other.example.test']],
  );
  assert.deepEqual(
    logs.map((entry) => [entry.level, entry.message]),
    [['Error', 'invented failure 7']],
  );
  assert.equal(logs[0].operationId, diagnostics[0].operationId);
});
