// Connector runtime in the host (lib/organization-host.mjs): an exported flow's Http action reaches a loopback fixture through
// the project `connections` entry, from the portal cloud-flow route and from a Dataverse row trigger; flow parameters bound to
// an environment variable use its effective value.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const ROLE = '77777777-7777-4777-8777-0000000000a1';
const PORTAL_FLOW = '77777777-7777-4777-8777-0000000000a2';
const ROW_FLOW = '77777777-7777-4777-8777-0000000000a3';
const CORRELATION = '77777777-7777-4777-8777-0000000000cc';
const PARAMETER = 'Api Base (x_apibase)';
const parameters = {
  [PARAMETER]: {
    defaultValue: 'https://exported.example.test/api/',
    type: 'String',
    metadata: { schemaName: 'x_apibase' },
  },
};
const profile = {
  userId: '77777777-7777-4777-8777-0000000000b1',
  evidence: 'Invented backend profile',
  grants: [
    { entity: 'x_widget', operations: ['read'] },
    { entity: 'x_audit', operations: ['create', 'read'] },
  ],
};

async function fixture(t) {
  const calls = [];
  const local = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => local.close(resolve)));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-connector-host-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const call = (uri) => ({ type: 'Http', inputs: { method: 'GET', uri } });
  const portalFlow = {
    properties: {
      definition: {
        parameters,
        triggers: { manual: { type: 'Request', kind: 'powerpages' } },
        actions: {
          call: call(`@{parameters('${PARAMETER}')}@{triggerBody()?['name']}`),
          reply: { type: 'Response', runAfter: { call: ['Succeeded'] }, inputs: { body: "@body('call')" } },
        },
      },
    },
  };
  const rowFlow = {
    properties: {
      definition: {
        parameters,
        triggers: {
          row: {
            type: 'OpenApiConnectionWebhook',
            inputs: {
              host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger' },
              parameters: {
                'subscriptionRequest/message': 1,
                'subscriptionRequest/entityname': 'x_widget',
                'subscriptionRequest/scope': 4,
              },
            },
          },
        },
        actions: {
          call: call(`@{parameters('${PARAMETER}')}row-@{triggerBody()?['x_title']}`),
          record: {
            type: 'OpenApiConnection',
            runAfter: { call: ['Succeeded'] },
            inputs: {
              host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'CreateRecord' },
              parameters: { entityName: 'x_audits', 'item/x_message': "@body('call')?['path']" },
            },
          },
        },
      },
    },
  };
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented connector host',
    'Runner.webrole.yml': `adx_webroleid: ${ROLE}\nadx_name: Runner`,
    'Request.cloudflowconsumer.yml': `adx_cloudflowconsumerid: consumer\nadx_name: Invented request\nadx_processid: ${PORTAL_FLOW}\nadx_flowapiurl: /_api/cloudflow/v1.0/trigger/${PORTAL_FLOW}\nadx_cloudflowconsumer_adx_webrole:\n- ${ROLE}`,
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedConnectors</UniqueName><Version>1.0</Version></SolutionManifest></ImportExportXml>',
    'environmentvariabledefinitions/x_apibase/environmentvariabledefinition.xml':
      '<environmentvariabledefinition schemaname="x_apibase"><displayname default="Api base"/><type>100000000</type><defaultvalue>https://default.example.test/api/</defaultvalue></environmentvariabledefinition>',
    'environmentvariabledefinitions/x_apikey/environmentvariabledefinition.xml':
      '<environmentvariabledefinition schemaname="x_apikey"><displayname default="Api key"/><type>100000005</type></environmentvariabledefinition>',
    'Workflows/portal.json': JSON.stringify(portalFlow),
    'Workflows/portal.json.data.xml': `<Workflow WorkflowId="${PORTAL_FLOW}" Name="Invented portal flow"/>`,
    'Workflows/row.json': JSON.stringify(rowFlow),
    'Workflows/row.json.data.xml': `<Workflow WorkflowId="${ROW_FLOW}" Name="Invented row flow"><StateCode>1</StateCode></Workflow>`,
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const origin = `http://127.0.0.1:${local.address().port}`;
  const pack = {
    id: 'invented-connector-host',
    name: 'Invented',
    description: 'Invented flow identities',
    matches: () => true,
    presets: () => ({}),
    flowIdentities: { [ROW_FLOW]: profile },
  };
  const app = await createSimulator({
    sourceDir: dir,
    solutionRoots: [dir],
    port: 0,
    watch: false,
    packs: [pack],
    // The project value of x_apibase wins over the definition default and the flow's exported defaultValue.
    environmentVariables: { x_apibase: 'https://func.example.test/api/' },
    connections: {
      http: {
        connector: 'http',
        provider: 'http',
        settings: { rewrites: { 'https://func.example.test/api/': `${origin}/api/` } },
      },
    },
    initial: {
      version: 1,
      tables: { x_widget: [], x_audit: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
      mappings: {
        x_widget: { entitySet: 'x_widgets', idColumn: 'x_widgetid' },
        x_audit: { entitySet: 'x_audits', idColumn: 'x_auditid' },
      },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identityScope: 'configured',
        identity: { id: 'caller', roles: ['Runner'], roleSource: 'override' },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  return { app, calls };
}

test('the portal cloud-flow route runs an Http action through the project connection with the effective parameter value', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await fetch(`${app.url}/_api/cloudflow/v1.0/trigger/${PORTAL_FLOW}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      __RequestVerificationToken: app.csrf,
      'x-ms-correlation-request-id': CORRELATION,
    },
    body: JSON.stringify({ name: 'echo' }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { path: '/api/echo' });
  assert.deepEqual(calls, ['/api/echo']);
  // The portal request's correlation reaches the flow run's connector diagnostic.
  const invoke = app
    .state()
    .diagnostics.find((entry) => entry.code === 'CONNECTOR_INVOKE' && entry.connectorId === 'http');
  assert.equal(invoke.correlationId, CORRELATION);
  assert.equal(invoke.connectionId, 'http');
});

test('a row trigger runs the same connection from committed work and writes the fixture answer back', async (t) => {
  const { app, calls } = await fixture(t);
  await app.store.create('x_widget', { x_title: 'alpha' }, { admin: true });
  await app.settle();
  assert.deepEqual(calls, ['/api/row-alpha']);
  assert.deepEqual(
    app.store.tableRows('x_audit').map((row) => row.x_message),
    ['/api/row-alpha'],
  );
  const completed = app.state().diagnostics.find((entry) => entry.code === 'FLOW_TRIGGER_COMPLETED');
  assert.ok(completed, JSON.stringify(app.state().diagnostics.filter((entry) => /FLOW|CONNECTOR/.test(entry.code))));
});

test('the _sim environment PUT takes a Key Vault reference for a Secret definition and refuses a plain value', async (t) => {
  const { app } = await fixture(t);
  const put = (value) =>
    fetch(`${app.url}/__sim/api/environment/variables/x_apikey`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
      body: JSON.stringify({ value }),
    });
  const refused = await put('plain-invented-value');
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, 'SecretValueNotAccepted');
  assert.equal((await put('https://inventedvault.vault.azure.net/secrets/x-api-key')).status, 200);
});
