// @test-kind contract: Paqvilo's own report of a custom connector OAuth flow that needs a static token, on both hosts
// A Solution custom connector whose OAuth flow is not run locally (implicit) is not blocked, but a flow that uses a
// connection without auth.token cannot call it: the CONNECTOR_AUTH_UNSUPPORTED warning names the flow and the connector in
// the flow's GET /_sim/api/operations entry, in GET /_sim/api/diagnostics (once) and in the preflight report.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const FLOW = '77777777-7777-4777-8777-0000000000e1';
const CONNECTOR = 'x_5fwarnhostapi';
const OPENAPI = {
  swagger: '2.0',
  info: { title: 'Invented warning API' },
  host: 'api.example.test',
  basePath: '/v1',
  schemes: ['https'],
  securityDefinitions: {
    o: { type: 'oauth2', flow: 'implicit', authorizationUrl: 'https://login.example.test/authorize', scopes: {} },
  },
  paths: { '/items': { get: { operationId: 'ListItems', responses: { 200: { description: 'ok' } } } } },
};
const FLOW_DEFINITION = {
  properties: {
    definition: {
      triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } },
      actions: {
        Call: {
          type: 'OpenApiConnection',
          runAfter: {},
          inputs: { host: { apiId: `/providers/Microsoft.PowerApps/apis/${CONNECTOR}`, operationId: 'ListItems' } },
        },
      },
    },
  },
};
const SOLUTION = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedAuthWarning</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  [`Connectors/${CONNECTOR}_openapidefinition.json`]: JSON.stringify(OPENAPI),
  'Workflows/warn.json': JSON.stringify(FLOW_DEFINITION),
  'Workflows/warn.json.data.xml': `<Workflow WorkflowId="{${FLOW}}" Name="Invented warned flow"><Category>5</Category><StateCode>1</StateCode></Workflow>`,
};
const PORTAL = {
  'website.yml': 'adx_websiteid: site\nadx_name: Invented auth warning',
  'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
};

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
}

async function start(t, kind) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'connector-auth-warning-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await writeTree(path.join(root, 'solution'), SOLUTION);
  // The connection keyed by the connector id binds the action that names no connection reference; it has no auth.token.
  const connections = { [CONNECTOR]: { connector: CONNECTOR, provider: `custom-connector:${CONNECTOR}` } };
  const common = { solutionRoots: [path.join(root, 'solution')], port: 0, watch: false, connections };
  let sim;
  if (kind === 'standalone')
    sim = await createSimulator({
      ...common,
      runtime: { kind: 'dataverse-api' },
      projectRoot: root,
      simulation: { level: 'dry-run' },
      dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    });
  else {
    await writeTree(path.join(root, 'portal'), PORTAL);
    sim = await createSimulator({
      ...common,
      sourceDir: path.join(root, 'portal'),
      stateFile: path.join(root, 'state.json'),
    });
  }
  ownedFixture(t).add(() => sim.close());
  return sim;
}

for (const kind of ['power-pages', 'standalone'])
  test(`${kind}: the CONNECTOR_AUTH_UNSUPPORTED warning names the flow and connector in operations, diagnostics and preflight`, async (t) => {
    const sim = await start(t, kind);
    const get = async (suffix) => {
      const response = await fetch(sim.url + '/_sim/api' + suffix, { headers: { 'x-sim-csrf': sim.csrf } });
      assert.equal(response.status, 200, suffix);
      return response.json();
    };
    const operations = await get('/operations');
    const entry = operations.items.find((item) => item.processId === FLOW);
    assert.ok(entry, JSON.stringify(operations.items.map((item) => item.key)));
    assert.equal(entry.contract.warnings.length, 1, JSON.stringify(entry.contract));
    assert.equal(entry.contract.warnings[0].code, 'CONNECTOR_AUTH_UNSUPPORTED');
    assert.equal(entry.contract.warnings[0].connector, CONNECTOR);
    assert.deepEqual(entry.contract.warnings[0].actions, ['Call']);
    assert.match(entry.contract.warnings[0].message, /OAuth implicit flow is not run locally/);

    // Reading the operations again rebuilds the catalogue: the flow's runtime diagnostic is still reported once (the Power
    // Pages host also lists the connector's own inventory warning, which names no flow).
    await get('/operations');
    const diagnostics = await get('/diagnostics');
    const list = Array.isArray(diagnostics) ? diagnostics : (diagnostics.items ?? diagnostics.diagnostics);
    const reported = list.filter((item) => item.code === 'CONNECTOR_AUTH_UNSUPPORTED' && item.operationKey);
    assert.equal(reported.length, 1, JSON.stringify(reported));
    assert.equal(reported[0].flow, 'Invented warned flow');
    assert.equal(reported[0].connector, CONNECTOR);
    assert.equal(reported[0].operationKey, entry.key);
    // The Power Pages host lists the connector's own inventory warning (no flow) once, however often the Solution data is
    // applied; the standalone host lists no inventory finding.
    const inventory = list.filter((item) => item.code === 'CONNECTOR_AUTH_UNSUPPORTED' && !item.flow);
    assert.equal(inventory.length, kind === 'power-pages' ? 1 : 0, JSON.stringify(inventory));

    const preflight = await get('/preflight');
    const warned = preflight.diagnostics.filter(
      (item) => item.code === 'CONNECTOR_AUTH_UNSUPPORTED' && item.operationKey,
    );
    assert.equal(warned.length, 1, JSON.stringify(warned));
    assert.equal(warned[0].flow, 'Invented warned flow');
    assert.equal(warned[0].connector, CONNECTOR);
    assert.equal(warned[0].severity, 'warning');
  });
