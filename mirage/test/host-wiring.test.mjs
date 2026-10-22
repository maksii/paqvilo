// Host wiring on both hosts (Power Pages simulator and standalone dataverse-api runtime): status `docs`, `routes` (from
// the mounted routers' own `routes` lists) and `modelDrivenApps`; ISO request times on the dashboard; the in-process Web
// API behind Xrm.WebApi.execute; the default /search/ page; the portal document control; Solution custom connectors and
// Recurrence trigger hosting. Invented x_ data, example.test hosts and loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';

const CASE = '77777777-7777-4777-8777-777777777760';
const SITE = '77777777-7777-4777-8777-777777777761';
const FLOW = '77777777-7777-4777-8777-0000000000b1';
const CONNECTOR = 'x_5finventedapi';
const CLIENT = '99999999-9999-4999-8999-999999999996';
const ENTITY = '<Entity><Name>x_case</Name><EntityInfo><entity Name="x_case"><EntitySetName>x_cases</EntitySetName><PrimaryIdAttribute>x_caseid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_caseid"><Name>x_caseid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>';
const OPENAPI = { swagger: '2.0', info: { title: 'Invented API' }, host: 'api.example.test', basePath: '/v1', schemes: ['https'],
  paths: { '/items/{id}': { get: { operationId: 'GetItem', parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }], responses: { 200: { description: 'ok' } } } } } };
const RECURRENCE = { properties: { definition: { triggers: { tick: { type: 'Recurrence', recurrence: { frequency: 'Hour', interval: 1 } } },
  actions: { Note: { type: 'Compose', runAfter: {}, inputs: 'tick' } } } } };
const solutionFiles = {
  'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedWiring</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'Entities/x_case/Entity.xml': ENTITY,
  [`Connectors/${CONNECTOR}_openapidefinition.json`]: JSON.stringify(OPENAPI),
  'Workflows/tick.json': JSON.stringify(RECURRENCE),
  'Workflows/tick.json.data.xml': `<Workflow WorkflowId="{${FLOW}}" Name="Invented recurrence"><Category>5</Category><StateCode>1</StateCode></Workflow>`,
};
const portalFiles = {
  'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented wiring`,
  'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
  'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'Main.webtemplate.source.html': '<main id=probe>home</main>',
  'sitesetting.yml': '- adx_sitesettingid: s0\n  adx_name: Search/Enabled\n  adx_value: "true"\n- adx_sitesettingid: s1\n  adx_name: HTTP/X-Frame-Options\n  adx_value: DENY\n'
    + '- adx_sitesettingid: s2\n  adx_name: HTTP/X-Content-Type-Options\n  adx_value: nosniff\n- adx_sitesettingid: s3\n  adx_name: HTTP/Content-Security-Policy\n  adx_value: "default-src \'self\'"',
  'webrole.yml': '- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
};

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
}
async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-wiring-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeTree(path.join(root, 'solution'), solutionFiles);
  return root;
}
const portalInitial = () => ({
  version: 1,
  mappings: { x_case: { entitySet: 'x_cases', idColumn: 'x_caseid', nameColumn: 'x_name' } },
  tables: { contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }], x_case: [{ x_caseid: CASE, x_name: 'Invented case', statecode: 0, statuscode: 1 }],
    sharepointsite: [{ sharepointsiteid: SITE, name: 'Default Site', absoluteurl: 'https://site.example.test/sites/invented', isdefault: true, statecode: 0, statuscode: 1 }] },
  permissions: [{ id: 'case', entity: 'x_case', scope: 'global', roles: ['Member'], operations: ['read', 'appendTo'] },
    { id: 'docs', entity: 'sharepointdocumentlocation', scope: 'parent', roles: ['Member'], operations: ['read'], parentPermissionId: 'case', relationship: { entity: 'x_case', from: 'regardingobjectid', to: 'x_caseid' } }],
  settings: { permissionMode: 'enforce' },
  simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', live: { allowWrites: false }, endpoints: [] },
});
async function powerPages(t, options = {}) {
  const root = await tempRoot(t);
  await writeTree(path.join(root, 'portal'), portalFiles);
  const sim = await createSimulator({ sourceDir: path.join(root, 'portal'), solutionRoots: [path.join(root, 'solution')], stateFile: path.join(root, 'state.json'),
    port: 0, watch: false, initial: portalInitial(), ...options });
  t.after(() => sim.close());
  return sim;
}
async function standalone(t, kind = 'dataverse-api') {
  const root = await tempRoot(t);
  const sim = await createSimulator({ runtime: { kind }, solutionRoots: [path.join(root, 'solution')], projectRoot: root,
    port: 0, watch: false, simulation: { level: 'dry-run' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  t.after(() => sim.close());
  return sim;
}
const body = async (response, status) => { const text = await response.text(); assert.equal(response.status, status, text.slice(0, 400)); return text ? JSON.parse(text) : null; };
const simApi = (sim, method, suffix, payload) => fetch(sim.url + '/_sim/api' + suffix, { method,
  headers: { 'x-sim-csrf': sim.state().csrf, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
// The transport of Xrm.WebApi.execute (model-driven/client-runtime.mjs): one Web API request through /_apps/api/webapi.
const execute = (sim, request) => fetch(sim.url + '/_apps/api/webapi', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf }, body: JSON.stringify(request) });
const PORTAL_ONLY = ['/experiments', '/portal-settings', '/portal-snippets', '/portal-roles', '/portal-access-rules', '/page-resources', '/scenarios', '/presets',
  '/personas', '/session', '/audit', '/persona-runtimes', '/persona-catalog', '/reference', '/assets', '/live', '/reset', '/reload', '/mappings', '/plugins', '/permissions', '/endpoints'];
const SHARED = ['/dashboard', '/packs', '/environment', '/messages', '/outbox', '/flow-runs', '/flow-waits', '/flow-triggers', '/preflight', '/status', '/dataverse', '/operations'];

for (const [name, start] of [['Power Pages', powerPages], ['standalone', standalone]]) {
  test(`${name}: status carries docs, router-derived routes and modelDrivenApps; Xrm.WebApi.execute runs an unbound function; the custom connector is a provider`, async t => {
    const sim = await start(t);
    const status = await body(await simApi(sim, 'GET', '/status'), 200);
    assert.equal(typeof status.docs, 'object');
    assert.ok(Array.isArray(status.modelDrivenApps));
    for (const route of SHARED) assert.ok(status.routes.includes(route), `${route} in ${status.routes}`);
    assert.equal(new Set(status.routes).size, status.routes.length);
    // The flow-runs capability record is valid: the registry lists it, so flow-triggers' requirement resolves.
    const preflightReport = await body(await simApi(sim, 'GET', '/preflight'), 200);
    assert.ok(preflightReport.modules.some(record => record.name === 'flow-runs' && record.kind === 'organization-module'));
    assert.ok(!JSON.stringify([preflightReport.diagnostics, status.diagnostics ?? []]).match(/CAPABILITY_RECORD_INVALID|"requires":"flow-runs"/));
    // The admin app trusts status.routes without probing: every Power Pages admin prefix is listed, none of them on standalone.
    for (const route of PORTAL_ONLY) assert.equal(status.routes.includes(route), name === 'Power Pages', route);
    // The standalone dataverse-api runtime has no model-driven surface; Xrm.WebApi.execute runs on its model-driven kind.
    const app = name === 'standalone' ? await standalone(t, 'model-driven') : sim;
    const whoAmI = await body(await execute(app, { method: 'GET', path: '/api/data/v9.2/WhoAmI' }), 200);
    assert.equal(whoAmI.status, 200, JSON.stringify(whoAmI));
    assert.match(JSON.parse(whoAmI.body).UserId, /^[0-9a-f-]{36}$/);
    const providers = sim.organizationHost?.connectors?.providers?.() ?? (await body(await simApi(sim, 'GET', '/dashboard'), 200)).nodes;
    assert.ok(JSON.stringify(providers).includes(CONNECTOR), JSON.stringify(providers).slice(0, 400));
  });
}

test('Power Pages: /state carries docs and the dashboard reports request times as ISO strings', async t => {
  const sim = await powerPages(t);
  assert.equal((await fetch(sim.url + '/')).status, 200);
  const state = await body(await simApi(sim, 'GET', '/state'), 200);
  assert.equal(typeof state.docs, 'object');
  const dashboard = await body(await simApi(sim, 'GET', '/dashboard'), 200);
  assert.match(dashboard.activity.requests.recent[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
});

test('Power Pages: the default /search/ page answers and the portal document control is wired to storage', async t => {
  const sim = await powerPages(t);
  const search = await fetch(sim.url + '/search/?q=invented');
  assert.equal(search.status, 200);
  assert.equal(search.headers.get('x-sim-route'), 'portal-search-local');
  const documents = await fetch(`${sim.url}/_apps/portal-documents/x_case/${CASE}`, { headers: signInHeaders(sim, 'alex', { roles: ['Member'] }) });
  assert.deepEqual([documents.status, (await documents.json()).documents], [200, []]);
});

test('Power Pages: the portal document control answers 503 while its document storage is not ready', async t => {
  // sharepointDocuments routed to an Azurite store whose connection string is unset: the route answers 503 Unavailable with
  // the reason (PROVIDER_SECRET_MISSING); 501 SharePointStorageNotConfigured is an organization without any storage
  // (sharepoint-portal-documents.test.mjs), which a host never composes.
  const initial = portalInitial();
  initial.permissions = [{ ...initial.permissions[0], operations: ['read', 'appendTo', 'update'] }, { ...initial.permissions[1], operations: ['read', 'create', 'update', 'append'] }];
  const sim = await powerPages(t, { initial, providers: { storage: { emulator: { kind: 'azurite', connectionString: 'env:FX_UNSET_AZURITE' } }, routes: { sharepointDocuments: 'emulator' } } });
  const upload = await fetch(`${sim.url}/_apps/portal-documents/x_case/${CASE}?name=note.txt`, { method: 'POST', body: 'invented',
    headers: { ...signInHeaders(sim, 'alex', { roles: ['Member'] }), 'content-type': 'text/plain', __RequestVerificationToken: sim.state().csrf } });
  const answer = await upload.text();
  assert.equal(upload.status, 503, answer);
  assert.match(JSON.parse(answer).error.message, /FX_UNSET_AZURITE is not set/);
});

// RA1-06/RA1-07: every prefix in status.routes is a dispatcher entry that answers (not 404) with its accepted method, and
// a prefix the routers do not list answers 404. Prefixes not in PROBES are requested with GET; /shutdown runs last.
const PROBES = {
  '/records': ['GET', '/records/contact'], '/persona-catalog': ['PUT', '/persona-catalog', {}], '/reference': ['POST', '/reference/enrich/validate', { plan: [] }],
  '/config': ['PATCH', '/config', { operations: {} }], '/assets': ['POST', '/assets/capture', {}], '/live': ['POST', '/live/disconnect', {}],
  '/reset': ['POST', '/reset', {}], '/reload': ['POST', '/reload', {}], '/shutdown': ['POST', '/shutdown', {}],
};
for (const [name, start] of [['Power Pages', powerPages], ['standalone', standalone]]) {
  test(`${name}: every listed /_sim/api prefix answers through its router and an unlisted prefix is 404`, async t => {
    const sim = await start(t);
    const { routes } = await body(await simApi(sim, 'GET', '/status'), 200);
    assert.equal((await simApi(sim, 'GET', '/x-unlisted')).status, 404);
    for (const route of [...routes.filter(item => item !== '/shutdown'), '/shutdown']) {
      const [method, suffix, payload] = PROBES[route] ?? ['GET', route];
      const response = await simApi(sim, method, suffix, payload);
      assert.ok(response.status !== 404 && response.status < 500, `${method} ${suffix}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
  });

  test(`${name}: an enabled Recurrence flow is hosted once the operation override applies; request times are ISO strings`, async t => {
    const sim = name === 'standalone' ? await start(t) : await start(t, { dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
    const key = `cloud-flow:${FLOW}`;
    const before = (await body(await simApi(sim, 'GET', '/flow-triggers'), 200)).find(host => host.processId === FLOW);
    assert.deepEqual([before.kind, before.state], ['recurrence', 'inactive']);
    const override = { mode: 'exported', activation: 'local-enabled' };
    if (name === 'standalone') await body(await simApi(sim, 'PATCH', '/config', { operations: { [key]: override } }), 200);
    else await body(await simApi(sim, 'PATCH', `/operations/${encodeURIComponent(key)}`, override), 200);
    const after = (await body(await simApi(sim, 'GET', '/flow-triggers'), 200)).find(host => host.processId === FLOW);
    assert.deepEqual([after.kind, after.state], ['recurrence', 'scheduled']);
    // One Dataverse API request (both hosts) and one portal page (Power Pages): every dashboard request time is ISO 8601.
    const { secret } = await body(await simApi(sim, 'POST', '/dataverse/applications', { appId: CLIENT, displayName: 'Invented client', roles: ['System Administrator'] }), 201);
    const token = await body(await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', { method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT, client_secret: secret, scope: sim.dataverse.origin + '/.default' }) }), 200);
    assert.equal((await fetch(sim.dataverse.origin + '/api/data/v9.2/WhoAmI', { headers: { authorization: `Bearer ${token.access_token}` } })).status, 200);
    if (name === 'Power Pages') assert.equal((await fetch(sim.url + '/')).status, 200);
    const { activity } = await body(await simApi(sim, 'GET', '/dashboard'), 200);
    const recent = [...activity.dataverseRequests.recent, ...(activity.requests?.recent ?? [])];
    assert.ok(activity.dataverseRequests.recent.length && (name === 'standalone' || activity.requests.recent.length), JSON.stringify(activity).slice(0, 300));
    for (const entry of recent) assert.match(entry.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
  });
}

test('Power Pages: /search/ carries the same site HTTP/* headers, CSP and nosniff as every portal page', async t => {
  const sim = await powerPages(t);
  const page = await fetch(sim.url + '/'), search = await fetch(sim.url + '/search/?q=invented');
  assert.equal(search.headers.get('x-sim-route'), 'portal-search-local');
  for (const name of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'cache-control']) {
    assert.ok(page.headers.get(name), `${name} on /`);
    assert.equal(search.headers.get(name), page.headers.get(name), name);
  }
});
