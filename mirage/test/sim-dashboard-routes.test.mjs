// GET /_sim/api/dashboard on both hosts: the payload shape, node ids and statuses, no credential material, memoised
// nodes, and counters that move after a Web API create, a web hook that is not contacted and a storage put.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { createDashboardRoutes, DASHBOARD_STATUSES, activityFacts } from '../lib/sim-dashboard-routes.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CLIENT = '77777777-7777-4777-8777-777777777781';
const ENDPOINT = '77777777-7777-4777-8777-777777777782';
const STEP = '77777777-7777-4777-8777-777777777783';
const FUNCTION_KEY = 'invented-function-key-value';
const AUTH_VALUE = 'invented-auth-value';
const NODE_ID =
  /^(?:client:(?:browser|staff|api|lense)|host:(?:portal|model-driven|dataverse-api|tds|identity-provider|setup|admin)|org:[a-z0-9-]+|provider:(?:storage|storage-route:[A-Za-z]+|messaging|messaging-endpoint:.+|outbox|connectors|secrets|local-service:.+|service-fixture:.+|powerfx)|connection:.+|app:(?:canvas|code|pcf)|external:(?:azurite|servicebus-emulator|functions|keyvault|webhook:.+)|persona-runtime:.+|bridge:live)$/;
const TOP_LEVEL = ['generatedAt', 'runtime', 'nodes', 'edges', 'activity', 'configuration', 'docs'];

async function json(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
}

async function standalone(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sim-dashboard-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  const files = {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedDashboard</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_widget/Entity.xml':
      '<Entity><Name>x_widget</Name><EntityInfo><entity Name="x_widget"><EntitySetName>x_widgets</EntitySetName><PrimaryIdAttribute>x_widgetid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_widgetid"><Name>x_widgetid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(solution, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const sim = await createSimulator({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [solution],
    projectRoot: root,
    port: 0,
    watch: false,
    stateFile: path.join(root, 'state.json'),
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    connections: {
      'x-invented-connection': {
        provider: 'fixture',
        settings: { url: `https://api.example.test/x?code=${FUNCTION_KEY}` },
      },
    },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

function assertSafe(text, csrf) {
  assert.ok(!text.includes(csrf), 'the CSRF token value never appears');
  for (const value of [FUNCTION_KEY, AUTH_VALUE]) assert.ok(!text.includes(value), `${value} never appears`);
  assert.doesNotMatch(text, /"(?:csrf|authvalue|secret|token|accessToken|settings)"\s*:/i);
  assert.doesNotMatch(text, /https?:\/\/[^"\s]*\?/, 'no URL with a query');
}

function assertShape(body) {
  assert.deepEqual(Object.keys(body).sort(), [...TOP_LEVEL].sort());
  assert.equal(body.runtime.product, 'Mirage');
  for (const node of body.nodes) {
    assert.match(node.id, NODE_ID, node.id);
    assert.ok(DASHBOARD_STATUSES.includes(node.status), `${node.id} status ${node.status}`);
    assert.equal(typeof node.detail, 'object');
  }
  assert.equal(new Set(body.nodes.map((node) => node.id)).size, body.nodes.length, 'node ids are unique');
  for (const edge of body.edges) assert.ok(DASHBOARD_STATUSES.includes(edge.status), `${edge.from}->${edge.to}`);
  for (const key of [
    'dataverseRequests',
    'plugins',
    'flows',
    'jobs',
    'asyncOperations',
    'messages',
    'outbox',
    'webhooks',
    'storage',
    'diagnostics',
  ])
    assert.ok(body.activity[key], `activity.${key}`);
  assert.equal(typeof body.docs.simAdministration.path, 'string');
}

test('standalone dashboard: payload shape, no credential material, memoised nodes and moving counters', async (t) => {
  const sim = await standalone(t);
  const dashboard = async () => json(await fetch(`${sim.url}/_sim/api/dashboard`));
  const first = await dashboard();
  assertShape(first);
  const ids = first.nodes.map((node) => node.id);
  for (const id of [
    'host:dataverse-api',
    'host:admin',
    'host:model-driven',
    'org:store',
    'org:plugins',
    'org:jobs',
    'provider:storage',
    'connection:x-invented-connection',
  ])
    assert.ok(ids.includes(id), id);
  assert.deepEqual(first.nodes.find((node) => node.id === 'connection:x-invented-connection').detail, {
    provider: 'fixture',
    connector: null,
    principal: 'none',
  });
  assert.equal(first.activity.inFlight, 0, 'the dashboard request itself is not in flight');
  assert.equal(first.activity.reloads, null);
  assert.equal(first.runtime.revision, null);
  assert.equal(
    first.configuration.settingsKeys,
    null,
    'an embedded runtime does not know which settings were authored',
  );
  assert.deepEqual(
    first.configuration.solutionLayers.map((layer) => layer.solution),
    ['InventedDashboard'],
  );
  assert.equal(first.configuration.ports.dataverseApi, Number(new URL(sim.dataverse.origin).port));
  assert.deepEqual(first.configuration.packs, []);
  assert.deepEqual((await dashboard()).nodes, first.nodes, 'no writes: the memoised nodes are identical');

  // A Web API create moves dataverseRequests.
  const registration = await json(
    await fetch(`${sim.url}/_sim/api/dataverse/applications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({
        appId: CLIENT,
        displayName: 'Invented dashboard client',
        roles: ['System Administrator'],
      }),
    }),
    201,
  );
  const token = await json(
    await fetch(`${sim.dataverse.authority}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT,
        client_secret: registration.secret,
        scope: `${sim.dataverse.origin}/.default`,
      }),
    }),
  );
  await json(
    await fetch(`${sim.dataverse.origin}/api/data/v9.2/x_widgets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ x_name: 'Invented widget' }),
    }),
    204,
  );

  // A synchronous web hook to a non-loopback host is not contacted.
  const { store } = sim;
  const messageId = store.tableRows('sdkmessage').find((row) => row.name === 'Create').sdkmessageid;
  const filterId = store
    .tableRows('sdkmessagefilter')
    .find((row) => row.sdkmessageid === messageId && row.primaryobjecttypecode === 'x_widget').sdkmessagefilterid;
  await store.create(
    'serviceendpoint',
    {
      serviceendpointid: ENDPOINT,
      name: 'Invented hook',
      contract: 8,
      authtype: 5,
      authvalue: AUTH_VALUE,
      url: `https://hooks.example.test/api/x?code=${FUNCTION_KEY}`,
    },
    { admin: true },
  );
  await store.create(
    'sdkmessageprocessingstep',
    {
      sdkmessageprocessingstepid: STEP,
      name: 'Invented hook step',
      sdkmessageid: messageId,
      sdkmessagefilterid: filterId,
      eventhandler: { id: ENDPOINT, logical_name: 'serviceendpoint' },
      stage: 40,
      mode: 0,
      rank: 1,
      statecode: 0,
      supporteddeployment: 0,
    },
    { admin: true },
  );
  await store.create('x_widget', { x_name: 'Hooked widget' }, { admin: true });

  // A storage put through the routed provider.
  await sim.organization.api.providers.storage
    .forRoute('annotations')
    .put('x/invented.txt', Buffer.from('invented bytes'));

  // An overwrite is a second write; a delete counts once and never subtracts.
  await sim.organization.api.providers.storage.forRoute('annotations').put('x/invented.txt', Buffer.from('six b!'));
  await sim.organization.api.providers.storage.forRoute('annotations').delete('x/invented.txt');

  const after = await dashboard();
  assertShape(after);
  assertSafe(JSON.stringify(after), sim.csrf);
  assert.equal(after.activity.dataverseRequests.total, 1, 'only the data-plane create counts');
  assert.ok(after.activity.dataverseRequests.other >= 1, 'the token request counts as other');
  assert.ok(
    after.activity.dataverseRequests.recent.some((item) => item.method === 'POST' && item.path.endsWith('/x_widgets')),
  );
  assert.deepEqual(Object.keys(after.activity.dataverseRequests.recent[0]).sort(), [
    'at',
    'method',
    'ms',
    'path',
    'status',
  ]);
  assert.equal(after.activity.webhooks.notContacted, 1);
  assert.deepEqual(after.nodes.find((node) => node.id === 'org:plugins').detail.webhooks, [
    { name: 'Invented hook', host: 'hooks.example.test', loopback: false },
  ]);
  assert.deepEqual(
    after.nodes.find((node) => node.id === 'external:webhook:hooks.example.test'),
    {
      id: 'external:webhook:hooks.example.test',
      kind: 'external',
      label: 'hooks.example.test',
      status: 'declared',
      link: '#flows',
      detail: { endpoints: 1, loopback: false },
    },
  );
  assert.deepEqual(
    after.edges.filter((edge) => edge.kind === 'webhook'),
    [
      {
        from: 'org:plugins',
        to: 'external:webhook:hooks.example.test',
        kind: 'webhook',
        status: 'declared',
        label: 'not contacted',
      },
    ],
  );
  const local = after.activity.storage.byProvider.find((item) => item.id === 'local');
  assert.deepEqual(local, {
    id: 'local',
    writes: 2,
    deletes: 1,
    bytesWritten: 'invented bytes'.length + 'six b!'.length,
  });
  assert.notDeepEqual(after.nodes, first.nodes, 'a write rebuilds the topology');

  // The loopback flag and node status follow the delivery rule (isLoopbackUrl): *.localhost and 127.0.0.0/8 over http(s) only.
  for (const [index, url] of ['http://api.localhost:9/x', 'http://127.0.0.2:9/x', 'ftp://localhost/x'].entries())
    await store.create(
      'serviceendpoint',
      {
        serviceendpointid: `77777777-7777-4777-8777-77777777779${index}`,
        name: `Invented loopback ${index}`,
        contract: 8,
        authtype: 5,
        url,
      },
      { admin: true },
    );
  const hooks = Object.fromEntries(
    (await dashboard()).nodes
      .filter((node) => node.id.startsWith('external:webhook:'))
      .map((node) => [node.label, [node.status, node.detail.loopback]]),
  );
  assert.deepEqual(hooks, {
    'hooks.example.test': ['declared', false],
    'api.localhost': ['listening', true],
    '127.0.0.2': ['listening', true],
    localhost: ['declared', false],
  });

  const refused = await fetch(`${sim.url}/_sim/api/dashboard`, { method: 'POST', headers: { 'x-sim-csrf': sim.csrf } });
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get('allow'), 'GET, HEAD');
  const head = await fetch(`${sim.url}/_sim/api/dashboard`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(
    (await json(await fetch(`${sim.url}/_sim/api/status`))).docs.simAdministration.path,
    'mirage/docs/sim-administration.md',
  );
});

const portalFiles = {
  'website.yml':
    'adx_name: Invented Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
  'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': '<p>Invented</p>',
};

test('Power Pages dashboard adds the portal listener, admin hosts and the portal request ring', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sim-dashboard-pp-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(portalFiles)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const sim = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: {},
      tables: {},
      permissions: [],
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        live: { allowWrites: false },
        endpoints: [],
      },
    },
  });
  ownedFixture(t).add(() => sim.close());
  assert.equal((await fetch(`${sim.url}/`)).status, 200);
  const body = await json(await fetch(`${sim.url}/_sim/api/dashboard`));
  assertShape(body);
  assertSafe(JSON.stringify(body), sim.csrf);
  const ids = body.nodes.map((node) => node.id);
  for (const id of [
    'client:browser',
    'host:portal',
    'host:identity-provider',
    'host:setup',
    'host:admin',
    'bridge:live',
    'app:pcf',
    'org:store',
  ])
    assert.ok(ids.includes(id), id);
  assert.equal(body.nodes.find((node) => node.id === 'host:portal').status, 'listening');
  assert.equal(body.configuration.ports.portal, Number(new URL(sim.url).port));
  assert.ok(
    body.activity.requests.recent.some(
      (item) =>
        item.path === '/' && item.status === 200 && typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at)),
    ),
  );
  assert.ok(body.activity.audit && body.activity.diagnostics.byCode);
  assert.equal(body.configuration.settingsKeys, null);
  // requests.total counts every portal request since start; the ring keeps the last 300.
  for (let batch = 0; batch < 6; batch += 1)
    await Promise.all(
      Array.from({ length: 50 }, async () => (await fetch(`${sim.url}/x-invented-missing`)).arrayBuffer()),
    );
  const busy = await json(await fetch(`${sim.url}/_sim/api/dashboard`));
  assert.equal(busy.activity.requests.retained, 300);
  assert.ok(busy.activity.requests.total >= 301, `total ${busy.activity.requests.total}`);
  const again = await json(await fetch(`${sim.url}/_sim/api/dashboard`));
  assert.deepEqual(again.nodes, body.nodes);
  assert.equal(
    (await json(await fetch(`${sim.url}/_sim/api/status`))).docs.simAdministration.path,
    'mirage/docs/sim-administration.md',
  );
});

test('Power Pages dashboard connects code components to the pages that host them and the records they read', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sim-dashboard-pcf-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const control = 'solution/Controls/x_Invented.Editor';
  const files = {
    ...Object.fromEntries(Object.entries(portalFiles).map(([name, body]) => [`portal/${name}`, body])),
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedPcf</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    [`${control}/ControlManifest.xml`]:
      '<manifest><control namespace="Invented" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
    [`${control}/ControlManifest.xml.data.xml`]: '<CustomControl><Name>x_Invented.Editor</Name></CustomControl>',
    [`${control}/bundle.js`]: 'window.ComponentFramework.registerControl("Invented.Editor",class{});',
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    stateFile: path.join(dir, 'state.json'),
    port: 0,
    watch: false,
  });
  ownedFixture(t).add(() => sim.close());
  const body = await json(await fetch(`${sim.url}/_sim/api/dashboard`));
  const pairs = body.edges.map((edge) => `${edge.from}>${edge.to}`);
  assert.equal(body.nodes.find((node) => node.id === 'app:pcf').status, 'ready');
  for (const pair of ['app:pcf>host:portal', 'org:store>org:security']) assert.ok(pairs.includes(pair), pair);
  // Code components call /_api of their page, or Xrm.WebApi of a model-driven form only with trusted extensions.
  const edges = new Map(body.edges.map((edge) => [`${edge.from}>${edge.to}`, edge]));
  assert.equal(edges.get('app:pcf>host:portal').status, 'ready');
  assert.equal(edges.get('app:pcf>host:model-driven').status, 'disabled');
  assert.ok(
    !pairs.includes('host:portal>app:pcf') && !pairs.includes('app:pcf>org:store'),
    'code components do not reach records past the portal',
  );
  // Visitor sign-in: the browser and the portal talk to the provider; without an external provider it is switched off.
  for (const pair of [
    'client:browser>host:identity-provider',
    'host:portal>host:identity-provider',
    'host:identity-provider>org:store',
  ])
    assert.equal(edges.get(pair)?.status, 'disabled', pair);
  for (const pair of [
    'host:portal>org:flows',
    'host:portal>provider:storage-route:annotations',
    'client:staff>host:admin',
  ])
    assert.ok(edges.has(pair), pair);
  assert.equal(
    edges.get('host:portal>org:security').status,
    'disabled',
    'web roles map to security roles only with enhanced authorization',
  );
  // The map script is never cached, so a restarted runtime draws with its own version.
  assert.equal((await fetch(`${sim.url}/__sim/dashboard-map.mjs`)).headers.get('cache-control'), 'no-store');
});

test('standalone dashboard connects each part to what really calls it, and draws the connections of a switched-off part switched off', async (t) => {
  const sim = await standalone(t);
  const body = await json(await fetch(`${sim.url}/_sim/api/dashboard`));
  const byPair = new Map(body.edges.map((edge) => [`${edge.from}>${edge.to}`, edge])),
    nodes = new Map(body.nodes.map((node) => [node.id, node]));
  // Web API messages are dispatched by the Web API host; save hooks run inside the store; background work goes through jobs.
  for (const pair of [
    'host:dataverse-api>org:dataverse-solutions',
    'host:dataverse-api>org:dataverse-customapi',
    'org:store>org:dataverse-formula',
    'org:dataverse-formula>provider:powerfx',
    'org:store>org:workflows',
    'org:workflows>org:jobs',
    'org:jobs>org:flows',
    'org:dataverse-async>org:jobs',
    'provider:connectors>org:store',
    'host:admin>org:store',
    'host:setup>host:admin',
    'host:model-driven>org:store',
    'org:plugins>org:store',
  ])
    assert.ok(byPair.has(pair), pair);
  assert.equal(
    byPair.get('host:model-driven>org:store').label,
    'records and Web API messages, in the app',
    'the model-driven shell does not use the Web API listener',
  );
  // Power Fx and storage are reached from the modules that use them, never from the store as a hub.
  for (const pair of ['org:store>provider:powerfx', 'org:store>provider:storage']) assert.ok(!byPair.has(pair), pair);
  // A part that is switched off keeps its connections, drawn switched off.
  assert.equal(nodes.get('app:code').status, 'disabled');
  assert.equal(byPair.get('app:code>org:store')?.status, 'disabled');
  for (const edge of body.edges)
    if (nodes.get(edge.from)?.status === 'disabled' || nodes.get(edge.to)?.status === 'disabled')
      assert.equal(edge.status, 'disabled', `${edge.from}>${edge.to}`);
  for (const edge of body.edges) assert.ok(edge.label, `${edge.from}>${edge.to} is named`);
  // A part with no runtime connection says why.
  assert.match(nodes.get('org:dataverse-addon-handlers')?.detail.note ?? '', /startup/);
});

test('with the Web API listener off, Web API messages still run from the model-driven in-app Web API', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sim-dashboard-md-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'solution', 'Other'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'solution', 'Other', 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>InventedMd</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  const sim = await createSimulator({
    runtime: { kind: 'model-driven' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
  });
  ownedFixture(t).add(() => sim.close());
  const body = await json(await fetch(`${sim.url}/_sim/api/dashboard`));
  const edges = new Map(body.edges.map((edge) => [`${edge.from}>${edge.to}`, edge]));
  assert.equal(body.nodes.find((node) => node.id === 'host:dataverse-api').status, 'disabled');
  assert.equal(edges.get('host:model-driven>org:dataverse-solutions')?.status, 'ready');
  assert.ok(
    !edges.has('host:dataverse-api>org:dataverse-solutions'),
    'messages are not drawn from the switched-off listener',
  );
});

test('the dashboard route answers 503 starting before its host exists', async (t) => {
  const route = createDashboardRoutes({ host: () => null });
  const server = http.createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://127.0.0.1')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/_sim/api/dashboard`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'starting' });
  assert.equal((await fetch(`${origin}/_sim/api/other`)).status, 404);
});

test('activity keeps counts named like credentials; the rest of the body is redacted', async (t) => {
  const host = {
    organization: null,
    topology: () => ({
      runtime: {},
      configuration: {},
      nodes: [
        { id: 'org:store', kind: 'org', label: 'Store', status: 'ready', detail: { accessToken: 'invented-token' } },
      ],
      edges: [],
      activity: {
        diagnostics: { total: 2, byCode: { X_AUTHORIZATION: 2 } },
        counters: { tokenRequests: 3, 'x.accessToken': 1 },
        requests: { total: 1, recent: [{ at: 1, method: 'GET', path: '/x', status: 200, ms: 1, note: 'dropped' }] },
        label: 'dropped',
        storage: { byProvider: [{ id: 'local', writes: 1 }] },
      },
    }),
  };
  const route = createDashboardRoutes({ host });
  const server = http.createServer(async (req, res) => {
    await route(req, res, new URL(req.url, 'http://127.0.0.1'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const body = await json(await fetch(`http://127.0.0.1:${server.address().port}/_sim/api/dashboard`));
  assert.deepEqual(body.activity.diagnostics.byCode, { X_AUTHORIZATION: 2 });
  assert.deepEqual(body.activity.counters, { tokenRequests: 3, 'x.accessToken': 1 });
  assert.deepEqual(body.activity.requests.recent, [{ at: 1, method: 'GET', path: '/x', status: 200, ms: 1 }]);
  assert.equal(body.activity.label, undefined);
  assert.deepEqual(body.activity.storage.byProvider, [{ id: 'local', writes: 1 }]);
  assert.equal(body.nodes[0].detail.accessToken, '[redacted]');
  assert.deepEqual(activityFacts({ a: true, b: 'x', c: [1, 'y'], d: null }), { c: [1], d: null });
});
