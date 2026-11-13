// Host-level regressions for the portal surfaces: document uploads against the organization's
// blocked extensions, the ServerLogic/* site settings and the InvokeCustomApi principal, through a running simulator.
// @test-kind unproven: local model of the portal host surfaces (blocked attachments, ServerLogic settings, custom API principal); no native capture backs these assertions
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { describe as serverLogicDescribe } from '../lib/exported-operations.mjs';
import { platformChangeDiagnostics } from '../lib/platform-changes.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '77777777-7777-4777-8777-777777777761',
  CASE = '77777777-7777-4777-8777-777777777760',
  ITEM = '77777777-7777-4777-8777-777777777762';
const ROLE = '77777777-7777-4777-8777-777777777763';
const entity = (name) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>`;
const write = async (dir, entries) => {
  for (const [name, text] of Object.entries(entries)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
};
const siteSettings = (settings) =>
  settings
    .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`)
    .join('\n') || '[]';

// The default of ServerLogic/TimeoutInSeconds: a server-logic run here is bound by the site's platform limit, not the
// 5 s local default, so host load never decides a result.
const PLATFORM_SERVER_LOGIC_LIMIT_MS = 120_000;

async function host(t, { files = {}, settings = [], initial = {}, authorization = 0, options = {} }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-host-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedHost</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_case/Entity.xml': entity('x_case'),
    'solution/Entities/x_item/Entity.xml': entity('x_item'),
    'solution/customapis/x_Bound/customapi.xml':
      '<customapi uniquename="x_Bound"><bindingtype>1</bindingtype><boundentitylogicalname>x_item</boundentitylogicalname><isfunction>0</isfunction><name>x_Bound</name></customapi>',
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented host\nadx_enhancedauthorization: ${authorization}`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': '<main>home</main>',
    'portal/webrole.yml': `- adx_webroleid: ${ROLE}\n  adx_name: Member`,
    'portal/sitesetting.yml': siteSettings(settings),
    ...files,
  });
  const state = {
    version: 1,
    mappings: {
      x_case: { entitySet: 'x_cases', idColumn: 'x_caseid', nameColumn: 'x_name' },
      x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' },
    },
    tables: {
      contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }],
      x_case: [{ x_caseid: CASE, x_name: 'Invented case', statecode: 0, statuscode: 1 }],
      x_item: [{ x_itemid: ITEM, x_name: 'Invented item' }],
      sharepointsite: [
        {
          sharepointsiteid: SITE,
          name: 'Default Site',
          absoluteurl: 'https://site.example.test/sites/invented',
          isdefault: true,
          statecode: 0,
          statuscode: 1,
        },
      ],
    },
    permissions: [
      { id: 'case', entity: 'x_case', scope: 'global', roles: ['Member'], operations: ['read', 'appendTo', 'update'] },
      {
        id: 'docs',
        entity: 'sharepointdocumentlocation',
        scope: 'parent',
        roles: ['Member'],
        operations: ['read', 'create', 'update', 'append', 'delete'],
        parentPermissionId: 'case',
        relationship: { entity: 'x_case', from: 'regardingobjectid', to: 'x_caseid' },
      },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      permissionSource: 'configured',
      live: { allowWrites: false },
      endpoints: [],
    },
  };
  for (const [key, value] of Object.entries(initial))
    state[key] = Array.isArray(value) ? [...state[key], ...value] : { ...state[key], ...value };
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    port: 0,
    watch: false,
    initial: state,
    serverLogicTimeoutMs: PLATFORM_SERVER_LOGIC_LIMIT_MS,
    ...options,
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}
const token = async (sim, headers) =>
  /value="([^"]+)"/.exec(await (await fetch(sim.url + '/_layout/tokenhtml', { headers })).text())?.[1];
const upload = async (sim, name) => {
  const member = signInHeaders(sim, 'alex', { roles: ['Member'] });
  return fetch(`${sim.url}/_apps/portal-documents/x_case/${CASE}?name=${name}`, {
    method: 'POST',
    body: 'MZ',
    headers: { ...member, __RequestVerificationToken: await token(sim, member) },
  });
};

test('a document upload of payload.exe is refused by the Dataverse default blocked extensions; the setting stays overridable', async (t) => {
  const blocked = await upload(await host(t, {}), 'payload.exe');
  assert.equal(blocked.status, 400);
  assert.equal((await blocked.json()).error.code, 'AttachmentTypeBlocked');
  const overridden = await host(t, { initial: { simulator: { platformOverrides: { BlockedAttachments: 'bat' } } } });
  assert.equal((await upload(overridden, 'payload.exe')).status, 201);
  assert.equal((await upload(overridden, 'payload.bat')).status, 400);
});

const LOGIC = `async function get(){ const out = {};
  out.bound = JSON.parse(Server.Connector.Dataverse.InvokeCustomApi('post', 'x_items(${ITEM})/Microsoft.Dynamics.CRM.x_Bound', ''));
  out.cloud = JSON.parse(await Server.Connector.HttpClient.GetAsync('https://api.example.test/x', {}));
  return JSON.stringify(out); }`;
async function serverLogicHost(
  t,
  {
    settings = [],
    itemRead = false,
    expectedStatus = 200,
    logic = LOGIC,
    permissions = [],
    files = {},
    authorization = 0,
    options = {},
  } = {},
) {
  const sim = await host(t, {
    settings,
    authorization,
    options,
    files: {
      'portal/sample.serverlogic.yml': `adx_serverlogicid: sample\nadx_name: sample\nadx_serverlogic_adx_webrole:\n- ${ROLE}`,
      'portal/sample.js': logic,
      ...files,
    },
    initial: {
      permissions: [
        ...(itemRead
          ? [{ id: 'item', entity: 'x_item', scope: 'global', roles: ['Member'], operations: ['read'] }]
          : []),
        ...permissions,
      ],
    },
  });
  const csrf = sim.csrf;
  for (const item of (await (await fetch(sim.url + '/__sim/api/operations')).json()).items.filter(
    (entry) => entry.kind === 'server-logic',
  ))
    await fetch(sim.url + '/__sim/api/operations/' + encodeURIComponent(item.key), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf },
      body: '{"mode":"exported"}',
    });
  const member = signInHeaders(sim, 'alex', { roles: ['Member'] });
  const response = await fetch(sim.url + '/_api/serverlogics/sample', {
    headers: { ...member, __RequestVerificationToken: await token(sim, member) },
  });
  const body = await response.json();
  const codes = (sim.state().diagnostics ?? []).map((entry) => entry.code);
  const details = JSON.stringify({ body, codes });
  if (expectedStatus !== null) assert.equal(response.status, expectedStatus, details);
  if (expectedStatus === 200) assert.equal(typeof body.data, 'string', details);
  return {
    sim,
    status: response.status,
    body,
    data: body.data ? JSON.parse(body.data) : null,
    codes,
  };
}

test('ServerLogic/Enabled false refuses server logic by name with SERVER_LOGIC_DISABLED', async (t) => {
  const { status, body, codes } = await serverLogicHost(t, {
    settings: [['ServerLogic/Enabled', 'false']],
    expectedStatus: 403,
  });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'ServerLogicDisabled');
  assert.ok(codes.includes('SERVER_LOGIC_DISABLED'));
});

test('ServerLogic/AllowedDomains applies to the original HttpClient host before any rewrite', async (t) => {
  const { data, codes } = await serverLogicHost(t, {
    settings: [['ServerLogic/AllowedDomains', 'allowed.example.test']],
  });
  assert.equal(data.cloud.StatusCode, 403);
  assert.ok(codes.includes('SERVER_LOGIC_HTTP_DOMAIN_BLOCKED'));
  assert.equal(codes.includes('SERVER_LOGIC_HTTP_REFUSED'), false);
});

test("InvokeCustomApi runs as the portal application user and needs the caller's table-permission read on the bound row", async (t) => {
  const denied = await serverLogicHost(t);
  assert.equal(denied.data.bound.StatusCode, 403);
  const allowed = await serverLogicHost(t, { itemRead: true });
  assert.equal(allowed.data.bound.StatusCode, 204, JSON.stringify(allowed.data.bound));
  const users = allowed.sim.store.tableRows('systemuser');
  assert.ok(
    users.some((user) => user.fullname === '# Portals-Invented host' && user.applicationid),
    'the site application user exists',
  );
  // The capability record names the bridge levels.
  const record = serverLogicDescribe();
  assert.deepEqual(
    record.operations.map((operation) => [operation.name, operation.level]).find(([name]) => name === 'httpClient'),
    ['httpClient', 'contract'],
  );
  assert.equal(record.principal, 'portal-application-user');
});

// Regression: the application user is provisioned before the bounded run starts. Its one-time creation is a persisted
// transaction; done lazily inside the first InvokeCustomApi it spent the exported code's local time limit and a loaded
// Windows runner answered 501 "Script execution timed out". Code that never calls a custom API already sees it.
test('the site application user is provisioned before exported server logic runs', async (t) => {
  const { data } = await serverLogicHost(t, {
    logic:
      "function get(){ return Server.Connector.Dataverse.RetrieveMultipleRecords('systemusers', '?$select=fullname'); }",
    permissions: [{ id: 'users', entity: 'systemuser', scope: 'global', roles: ['Member'], operations: ['read'] }],
  });
  assert.equal(data.StatusCode, 200, JSON.stringify(data));
  assert.ok(
    JSON.parse(data.Body).value.some((user) => user.fullname === '# Portals-Invented host'),
    data.Body,
  );
});

// @test-kind contract: the simulator option serverLogicTimeoutMs sets the local server-logic limit up to ServerLogic/TimeoutInSeconds; unset it is 5 s
test('serverLogicTimeoutMs raises the local server-logic limit up to ServerLogic/TimeoutInSeconds', async (t) => {
  const bound = async (serverLogicTimeoutMs) => {
    const { codes, sim } = await serverLogicHost(t, {
      settings: [['ServerLogic/TimeoutInSeconds', '30']],
      logic: "function get(){ return '{}'; }",
      options: { serverLogicTimeoutMs },
    });
    assert.equal(codes.includes('SERVER_LOGIC_TIMEOUT_LOCAL'), serverLogicTimeoutMs === undefined);
    return sim.state().diagnostics.find((entry) => entry.code === 'SERVER_LOGIC_TIMEOUT_LOCAL')?.message ?? null;
  };
  assert.match(await bound(undefined), /ServerLogic\/TimeoutInSeconds is 30 s; the local run is bounded at 5000 ms\./);
  assert.equal(await bound(30_000), null);
  assert.equal(await bound(PLATFORM_SERVER_LOGIC_LIMIT_MS), null, 'a larger limit is capped at the site setting');
});

// @test-kind contract: the applied server-logic limit is the option capped at ServerLogic/TimeoutInSeconds
test('a serverLogicTimeoutMs above ServerLogic/TimeoutInSeconds runs exported code under the site limit', async (t) => {
  // Either limit may end the run: the worker's script limit (501), or the host's limit (504) when the worker thread is
  // descheduled past its own. Both name the bound they applied, so the cap is read from the answer, not from a clock.
  const { status, body } = await serverLogicHost(t, {
    settings: [['ServerLogic/TimeoutInSeconds', '1']],
    logic: 'function get(){ for(;;){} }',
    options: { serverLogicTimeoutMs: 10_000 },
    expectedStatus: null,
  });
  const capped = {
    501: 'Script execution timed out after 1000ms',
    504: 'Server-logic execution exceeded its local time limit of 1000 ms.',
  };
  assert.ok(Object.hasOwn(capped, status), `unexpected status ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error.message, capped[status]);
});

// @test-kind contract: createSimulator refuses a serverLogicTimeoutMs that is not a finite number greater than 0
test('createSimulator refuses a serverLogicTimeoutMs that is not a finite number greater than 0', async () => {
  for (const serverLogicTimeoutMs of [0, -1, Number.NaN, Infinity, '5000', null])
    await assert.rejects(
      createSimulator({ serverLogicTimeoutMs, watch: false }),
      { name: 'TypeError', message: /^serverLogicTimeoutMs must be a finite number/ },
      String(serverLogicTimeoutMs),
    );
});

// Under enhanced authorization Dataverse operations run on behalf of the site user by impersonation, not as the
// application user. x_Gated needs a privilege only System Administrator holds.
test('under enhanced authorization InvokeCustomApi runs as the mapped site user and the bound row needs table-permission read', async (t) => {
  const files = {
    'solution/customapis/x_Gated/customapi.xml':
      '<customapi uniquename="x_Gated"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_Gated</name><executeprivilegename>prvActOnBehalfOfAnotherUser</executeprivilegename></customapi>',
  };
  const logic = `function get(){ return JSON.stringify({ gated: JSON.parse(Server.Connector.Dataverse.InvokeCustomApi('post', 'x_Gated', '{}')), bound: JSON.parse(Server.Connector.Dataverse.InvokeCustomApi('post', 'x_items(${ITEM})/Microsoft.Dynamics.CRM.x_Bound', '')) }); }`;
  const run = async (authorization, itemRead) => {
    const { data } = await serverLogicHost(t, { authorization, itemRead, files, logic });
    return [data.gated.StatusCode, data.bound.StatusCode];
  };
  const [standardGated] = await run(0, true);
  assert.equal(standardGated, 204, 'the application user (System Administrator) holds the privilege');
  const [enhancedGated, readable] = await run(3, true);
  assert.equal(enhancedGated, 403, 'the mapped site user lacks the privilege');
  assert.equal(readable, 204);
  assert.equal((await run(3, false))[1], 403);
});

// @test-kind contract: the MODERN_LIST_FEATURES_UNSERVED requirement row is a Paqvilo diagnostic
test('a modern list with actions the local list does not serve is a blocking modern-list requirement row', () => {
  const lists = [
    {
      name: 'Items',
      id: 'l1',
      metadata: {
        adx_settings: JSON.stringify({
          ItemActions: [{ Type: 'CrmEntityFormView-DeleteAction' }, { Type: 'CrmEntityFormView-WorkflowAction' }],
        }),
      },
    },
  ];
  const pages = [{ url: '/', html: "{% include 'entity_list' key: 'Items' isModern: 'true' %}" }];
  const unserved = platformChangeDiagnostics({ lists, pages }).find(
    (entry) => entry.code === 'MODERN_LIST_FEATURES_UNSERVED',
  );
  assert.deepEqual(unserved.requirement, { id: 'portal:modern-list/Items', status: 'unsupported', level: 'contract' });
  assert.deepEqual(unserved.items, ['CrmEntityFormView-WorkflowAction']);
});
