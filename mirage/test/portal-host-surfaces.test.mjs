// Host-level regressions for the portal surfaces (RA3-P-02, P-03, P-06): document uploads against the organization's
// blocked extensions, the ServerLogic/* site settings and the InvokeCustomApi principal, through a running simulator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { describe as serverLogicDescribe } from '../lib/exported-operations.mjs';
import { platformChangeDiagnostics } from '../lib/platform-changes.mjs';

const SITE = '77777777-7777-4777-8777-777777777761', CASE = '77777777-7777-4777-8777-777777777760', ITEM = '77777777-7777-4777-8777-777777777762';
const ROLE = '77777777-7777-4777-8777-777777777763';
const entity = name => `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>`;
const write = async (dir, entries) => { for (const [name, text] of Object.entries(entries)) { await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await fs.writeFile(path.join(dir, name), text); } };
const siteSettings = settings => settings.map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`).join('\n') || '[]';

async function host(t, { files = {}, settings = [], initial = {}, authorization = 0 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, {
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedHost</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_case/Entity.xml': entity('x_case'), 'solution/Entities/x_item/Entity.xml': entity('x_item'),
    'solution/customapis/x_Bound/customapi.xml': '<customapi uniquename="x_Bound"><bindingtype>1</bindingtype><boundentitylogicalname>x_item</boundentitylogicalname><isfunction>0</isfunction><name>x_Bound</name></customapi>',
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented host\nadx_enhancedauthorization: ${authorization}`,
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main', 'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main', 'portal/Main.webtemplate.source.html': '<main>home</main>',
    'portal/webrole.yml': `- adx_webroleid: ${ROLE}\n  adx_name: Member`,
    'portal/sitesetting.yml': siteSettings(settings), ...files });
  const state = { version: 1, mappings: { x_case: { entitySet: 'x_cases', idColumn: 'x_caseid', nameColumn: 'x_name' }, x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } },
    tables: { contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }], x_case: [{ x_caseid: CASE, x_name: 'Invented case', statecode: 0, statuscode: 1 }], x_item: [{ x_itemid: ITEM, x_name: 'Invented item' }],
      sharepointsite: [{ sharepointsiteid: SITE, name: 'Default Site', absoluteurl: 'https://site.example.test/sites/invented', isdefault: true, statecode: 0, statuscode: 1 }] },
    permissions: [{ id: 'case', entity: 'x_case', scope: 'global', roles: ['Member'], operations: ['read', 'appendTo', 'update'] },
      { id: 'docs', entity: 'sharepointdocumentlocation', scope: 'parent', roles: ['Member'], operations: ['read', 'create', 'update', 'append', 'delete'], parentPermissionId: 'case', relationship: { entity: 'x_case', from: 'regardingobjectid', to: 'x_caseid' } }],
    settings: { permissionMode: 'enforce' }, simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', live: { allowWrites: false }, endpoints: [] } };
  for (const [key, value] of Object.entries(initial)) state[key] = Array.isArray(value) ? [...state[key], ...value] : { ...state[key], ...value };
  const sim = await createSimulator({ sourceDir: path.join(root, 'portal'), solutionRoots: [path.join(root, 'solution')], stateFile: path.join(root, 'state.json'), port: 0, watch: false, initial: state });
  t.after(() => sim.close());
  return sim;
}
const token = async (sim, headers) => /value="([^"]+)"/.exec(await (await fetch(sim.url + '/_layout/tokenhtml', { headers })).text())?.[1];
const upload = async (sim, name) => {
  const member = signInHeaders(sim, 'alex', { roles: ['Member'] });
  return fetch(`${sim.url}/_apps/portal-documents/x_case/${CASE}?name=${name}`, { method: 'POST', body: 'MZ', headers: { ...member, __RequestVerificationToken: await token(sim, member) } });
};

test('a document upload of payload.exe is refused by the Dataverse default blocked extensions; the setting stays overridable', async t => {
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
async function serverLogicHost(t, { settings = [], itemRead = false } = {}) {
  const sim = await host(t, { settings, files: { 'portal/sample.serverlogic.yml': `adx_serverlogicid: sample\nadx_name: sample\nadx_serverlogic_adx_webrole:\n- ${ROLE}`, 'portal/sample.js': LOGIC },
    initial: { permissions: itemRead ? [{ id: 'item', entity: 'x_item', scope: 'global', roles: ['Member'], operations: ['read'] }] : [] } });
  const csrf = sim.state().csrf;
  for (const item of (await (await fetch(sim.url + '/__sim/api/operations')).json()).items.filter(entry => entry.kind === 'server-logic'))
    await fetch(sim.url + '/__sim/api/operations/' + encodeURIComponent(item.key), { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf }, body: '{"mode":"exported"}' });
  const member = signInHeaders(sim, 'alex', { roles: ['Member'] });
  const response = await fetch(sim.url + '/_api/serverlogics/sample', { headers: { ...member, __RequestVerificationToken: await token(sim, member) } });
  const body = await response.json();
  return { sim, status: response.status, body, data: body.data ? JSON.parse(body.data) : null, codes: (sim.state().diagnostics ?? []).map(entry => entry.code) };
}

test('ServerLogic/Enabled false refuses server logic by name with SERVER_LOGIC_DISABLED', async t => {
  const { status, body, codes } = await serverLogicHost(t, { settings: [['ServerLogic/Enabled', 'false']] });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'ServerLogicDisabled');
  assert.ok(codes.includes('SERVER_LOGIC_DISABLED'));
});

test('ServerLogic/AllowedDomains applies to the original HttpClient host before any rewrite', async t => {
  const { data, codes } = await serverLogicHost(t, { settings: [['ServerLogic/AllowedDomains', 'allowed.example.test']] });
  assert.equal(data.cloud.StatusCode, 403);
  assert.ok(codes.includes('SERVER_LOGIC_HTTP_DOMAIN_BLOCKED'));
  assert.equal(codes.includes('SERVER_LOGIC_HTTP_REFUSED'), false);
});

test('InvokeCustomApi runs as the portal application user and needs the caller\'s table-permission read on the bound row', async t => {
  const denied = await serverLogicHost(t);
  assert.equal(denied.data.bound.StatusCode, 403);
  const allowed = await serverLogicHost(t, { itemRead: true });
  assert.ok([200, 204].includes(allowed.data.bound.StatusCode), JSON.stringify(allowed.data.bound));
  const users = allowed.sim.store.tableRows('systemuser');
  assert.ok(users.some(user => user.fullname === '# Portals-Invented host' && user.applicationid), 'the site application user exists');
  // The capability record names the bridge levels.
  const record = serverLogicDescribe();
  assert.deepEqual(record.operations.map(operation => [operation.name, operation.level]).find(([name]) => name === 'httpClient'), ['httpClient', 'contract']);
  assert.equal(record.principal, 'portal-application-user');
});

// Learn (security/unify-pages-security-with-dataverse): "Dataverse operations execute on behalf of the site user by using
// impersonation rather than the application user". x_Gated needs a privilege only System Administrator holds.
test('under enhanced authorization InvokeCustomApi runs as the mapped site user and the bound row needs table-permission read', async t => {
  const gated = { 'solution/customapis/x_Gated/customapi.xml': '<customapi uniquename="x_Gated"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_Gated</name><executeprivilegename>prvActOnBehalfOfAnotherUser</executeprivilegename></customapi>',
    'portal/sample.serverlogic.yml': `adx_serverlogicid: sample\nadx_name: sample\nadx_serverlogic_adx_webrole:\n- ${ROLE}`,
    'portal/sample.js': `function get(){ return JSON.stringify({ gated: JSON.parse(Server.Connector.Dataverse.InvokeCustomApi('post', 'x_Gated', '{}')), bound: JSON.parse(Server.Connector.Dataverse.InvokeCustomApi('post', 'x_items(${ITEM})/Microsoft.Dynamics.CRM.x_Bound', '')) }); }` };
  const run = async (authorization, itemRead) => {
    const sim = await host(t, { authorization, files: gated, initial: { permissions: itemRead ? [{ id: 'item', entity: 'x_item', scope: 'global', roles: ['Member'], operations: ['read'] }] : [] } });
    const csrf = sim.state().csrf;
    for (const item of (await (await fetch(sim.url + '/__sim/api/operations')).json()).items.filter(entry => entry.kind === 'server-logic'))
      await fetch(sim.url + '/__sim/api/operations/' + encodeURIComponent(item.key), { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf }, body: '{"mode":"exported"}' });
    const member = signInHeaders(sim, 'alex', { roles: ['Member'] });
    const body = await (await fetch(sim.url + '/_api/serverlogics/sample', { headers: { ...member, __RequestVerificationToken: await token(sim, member) } })).json();
    const data = JSON.parse(body.data);
    return [data.gated.StatusCode, data.bound.StatusCode];
  };
  const [standardGated] = await run(0, true);
  assert.ok([200, 204].includes(standardGated), 'the application user (System Administrator) holds the privilege');
  const [enhancedGated, readable] = await run(3, true);
  assert.equal(enhancedGated, 403, 'the mapped site user lacks the privilege');
  assert.ok([200, 204].includes(readable));
  assert.equal((await run(3, false))[1], 403);
});

test('a modern list with actions the local list does not serve is a blocking modern-list requirement row', () => {
  const lists = [{ name: 'Items', id: 'l1', metadata: { adx_settings: JSON.stringify({ ItemActions: [{ Type: 'CrmEntityFormView-DeleteAction' }, { Type: 'CrmEntityFormView-WorkflowAction' }] }) } }];
  const pages = [{ url: '/', html: "{% include 'entity_list' key: 'Items' isModern: 'true' %}" }];
  const unserved = platformChangeDiagnostics({ lists, pages }).find(entry => entry.code === 'MODERN_LIST_FEATURES_UNSERVED');
  assert.deepEqual(unserved.requirement, { id: 'portal:modern-list/Items', status: 'unsupported', level: 'contract' });
  assert.deepEqual(unserved.items, ['CrmEntityFormView-WorkflowAction']);
});
