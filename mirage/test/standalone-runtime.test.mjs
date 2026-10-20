import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';

const APP = '77777777-7777-4777-8777-777777777777';
const CLIENT = '99999999-9999-4999-8999-999999999999';
async function fixture(t, options, sourceOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-organization-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  const files = {
    'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedStandalone</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml': '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
    'AppModules/x_workspace/AppModule.xml': `<AppModule><UniqueName>x_workspace</UniqueName><AppModuleId>{${APP}}</AppModuleId><LocalizedNames><LocalizedName description="Standalone workspace" languagecode="1033"/></LocalizedNames><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>`,
  };
  Object.assign(files, sourceOverrides);
  for (const [relative, content] of Object.entries(files)) { const file = path.join(solution, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const stateFile = path.join(root, 'must-not-be-written.json');
  const sim = await createSimulator({ solutionRoots: [solution], stateFile, projectRoot: root, watch: false,
    simulation: { level: 'dry-run' }, ...options });
  t.after(() => sim.close());
  return { sim, root, solution, stateFile, files };
}
async function body(response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text); return text ? JSON.parse(text) : null;
}
const ui = (sim, method, suffix = '', values, etag) => fetch(sim.url + '/_apps/api' + suffix, { method,
  headers: { 'x-sim-csrf': sim.state().csrf, ...(values ? { 'content-type': 'application/json' } : {}), ...(etag ? { 'if-match': etag } : {}) },
  ...(values ? { body: JSON.stringify(values) } : {}), signal: AbortSignal.timeout(10000) });
async function client(sim) {
  const registration = await body(await fetch(sim.url + '/_sim/api/dataverse/applications', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf },
    body: JSON.stringify({ appId: CLIENT, displayName: 'Invented standalone client', roles: ['System Administrator'] }) }), 201);
  const token = await body(await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT, client_secret: registration.secret, scope: sim.dataverse.origin + '/.default' }) }));
  return (method, suffix, values) => fetch(sim.dataverse.origin + '/api/data/v9.2' + suffix, { method,
    headers: { authorization: `Bearer ${token.access_token}`, ...(values ? { 'content-type': 'application/json', prefer: 'return=representation' } : {}) },
    ...(values ? { body: JSON.stringify(values) } : {}), signal: AbortSignal.timeout(10000) });
}

test('solution-only model-driven runtime uses its organization core with HTTP API disabled and no portal source', async t => {
  const { sim, root, solution, stateFile, files } = await fixture(t, { runtime: { kind: 'model-driven', defaultApp: APP } });
  assert.equal(sim.dataverse, undefined);
  assert.equal((await fetch(sim.url + '/main.aspx')).status, 200);
  const catalogue = await body(await ui(sim, 'GET'));
  assert.equal(catalogue.defaultApp, APP); assert.equal(catalogue.apps.length, 1);
  assert.equal(Object.keys(catalogue.tables).some(name => /^(adx_|mspp_)/.test(name)), false);
  const record = await body(await ui(sim, 'POST', '/tables/x_item', { x_name: 'Created without a portal' }), 201);
  const changed = await body(await ui(sim, 'PATCH', `/tables/x_item/${record.row.x_itemid}`, { x_name: 'Edited' }, record.etag));
  assert.equal(changed.row.x_name, 'Edited');
  await body(await ui(sim, 'DELETE', `/tables/x_item/${record.row.x_itemid}`, undefined, changed.etag));
  assert.equal((await fetch(sim.url + '/_api/x_items')).status, 404);
  const status = await body(await fetch(sim.url + '/_sim/api/status'));
  assert.equal(status.capabilities.organization, true); assert.equal(status.capabilities.dataverseApi, false);
  assert.equal(status.links.powerPages, null); assert.equal(status.simulation.recordPersistence, 'memory');
  assert.equal((await fetch(sim.url + '/_sim/api/dataverse/session')).status, 200);
  const summary = await body(await fetch(sim.url + '/_sim/api/state'));
  assert.equal(summary.summaryMode, true); assert.equal(Object.hasOwn(summary, 'data'), false);
  assert.ok(summary.mappings.some(mapping => mapping.logicalName === 'x_item'));
  // Follow real module imports: a successful shell alone does not prove the browser can start.
  const visited = new Set(), pending = ['/__sim/app.mjs'];
  while (pending.length) {
    const pathname = pending.shift(); if (visited.has(pathname)) continue; visited.add(pathname);
    const response = await fetch(sim.url + pathname); assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('content-type'), /javascript/);
    const source = await response.text();
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.\/[^'"]+\.mjs)['"]/g)) pending.push(new URL(match[1], sim.url + pathname).pathname);
  }
  assert.ok(visited.has('/__sim/persona-search.mjs')); assert.ok(visited.has('/__sim/persona-picker-view.mjs'));
  await assert.rejects(fs.stat(stateFile), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(root)).sort(), ['solution']);
  for (const [relative, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(solution, relative), 'utf8'), content);
});

test('solution-only API and model-driven surfaces share actual organization CRUD', async t => {
  const { sim } = await fixture(t, { runtime: { kind: 'model-driven' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  const org = await client(sim);
  const created = await body(await org('POST', '/x_items', { x_name: 'Organization row' }), 201);
  const row = await body(await ui(sim, 'GET', `/tables/x_item/${created.x_itemid}`));
  assert.equal(row.row.x_name, 'Organization row');
  await body(await ui(sim, 'PATCH', `/tables/x_item/${created.x_itemid}`, { x_name: 'Shell edit' }, row.etag));
  assert.equal((await body(await org('GET', `/x_items(${created.x_itemid})`))).x_name, 'Shell edit');
});

test('solution-only API runtime exposes administration and organization API without a model-driven or portal renderer', async t => {
  const { sim } = await fixture(t, { runtime: { kind: 'dataverse-api' }, dataverse: { tls: false, tds: { enabled: false } } });
  assert.equal((await fetch(sim.url + '/main.aspx')).status, 404);
  assert.equal((await fetch(sim.url + '/_apps/api')).status, 404);
  assert.equal((await fetch(sim.url + '/_sim/')).status, 200);
  const org = await client(sim);
  const row = await body(await org('POST', '/x_items', { x_name: 'API only' }), 201);
  assert.equal((await body(await org('GET', `/x_items(${row.x_itemid})`))).x_name, 'API only');
});

test('selected Dataverse locale reaches source apps, navigation, forms, views and canonical source rows', async t => {
  const FORM = '55555555-5555-4555-8555-555555555555', VIEW = '66666666-6666-4666-8666-666666666666';
  const labels = (en, fr) => `<LocalizedNames><LocalizedName languagecode="1033" description="${en}"/><LocalizedName languagecode="1036" description="${fr}"/></LocalizedNames>`;
  const titles = (en, fr) => `<Titles><Title LCID="1033" Title="${en}"/><Title LCID="1036" Title="${fr}"/></Titles>`;
  const { sim, solution, files } = await fixture(t, { runtime: { kind: 'model-driven' }, dataverse: { enabled: true, tls: false, localeId: 1036, tds: { enabled: false } } }, {
    'Entities/x_item/Entity.xml': `<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item">${labels('Item', 'Article')}<EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel><displaynames><displayname description="Name" languagecode="1033"/><displayname description="Nom" languagecode="1036"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>`,
    'AppModules/x_workspace/AppModule.xml': `<AppModule><UniqueName>x_workspace</UniqueName><AppModuleId>${APP}</AppModuleId>${labels('Workspace', 'Espace')}<SiteMap><Area Id="main">${titles('Main', 'Principal')}<Group Id="work">${titles('Work', 'Travail')}<SubArea Id="items" Entity="x_item">${titles('Items', 'Articles')}</SubArea></Group></Area></SiteMap></AppModule>`,
    'Entities/x_item/FormXml/main/item.xml': `<systemform><formid>${FORM}</formid><type>2</type>${labels('Information', 'Informations')}<form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform>`,
    'Entities/x_item/SavedQueries/items.xml': `<savedquery><savedqueryid>${VIEW}</savedqueryid><querytype>0</querytype>${labels('Active items', 'Articles actifs')}<fetchxml><fetch><entity name="x_item"><attribute name="x_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="x_name" width="200"/></row></grid></layoutxml></savedquery>`,
  });
  const catalogue = await body(await ui(sim, 'GET'));
  assert.equal(catalogue.apps[0].name, 'Espace');
  assert.equal(catalogue.apps[0].navigation[0].title, 'Principal');
  assert.equal(catalogue.apps[0].navigation[0].groups[0].title, 'Travail');
  assert.equal(catalogue.apps[0].navigation[0].groups[0].items[0].title, 'Articles');
  assert.equal(catalogue.tables.x_item.forms[0].name, 'Informations');
  assert.equal(catalogue.tables.x_item.views[0].name, 'Articles actifs');
  const org = await client(sim);
  const entity = await body(await org('GET', "/EntityDefinitions(LogicalName='x_item')?$select=DisplayName"));
  assert.equal(entity.DisplayName.UserLocalizedLabel.Label, 'Article'); assert.equal(entity.DisplayName.UserLocalizedLabel.LanguageCode, 1036);
  const attribute = await body(await org('GET', "/EntityDefinitions(LogicalName='x_item')/Attributes(LogicalName='x_name')?$select=DisplayName"));
  assert.equal(attribute.DisplayName.UserLocalizedLabel.Label, 'Nom'); assert.equal(attribute.DisplayName.UserLocalizedLabel.LanguageCode, 1036);
  assert.equal((await body(await org('GET', `/appmodules(${APP})?$select=name`))).name, 'Espace');
  assert.equal((await body(await org('GET', `/systemforms(${FORM})?$select=name`))).name, 'Informations');
  assert.equal((await body(await org('GET', `/savedqueries(${VIEW})?$select=name`))).name, 'Articles actifs');
  await body(await org('PATCH', `/appmodules(${APP})`, { name: 'Locally renamed' }));
  assert.equal((await body(await ui(sim, 'GET'))).apps[0].name, 'Locally renamed');
  for (const [relative, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(solution, relative), 'utf8'), content);
});

test('standalone close settles an accepted admin write before tearing down its organization', async t => {
  const { sim } = await fixture(t, { runtime: { kind: 'model-driven' } });
  let entered, release, closed = false;
  const waiting = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const create = sim.store.create.bind(sim.store), closeOrganization = sim.organization.close.bind(sim.organization);
  sim.store.create = async (...args) => { entered(); await blocked; assert.equal(closed, false); return create(...args); };
  sim.organization.close = async () => { closed = true; return closeOrganization(); };
  const request = fetch(sim.url + '/_sim/api/records/x_item', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf }, body: JSON.stringify({ x_name: 'Accepted write' }) });
  await waiting;
  const closing = sim.close();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release();
  assert.equal((await body(await request, 201)).x_name, 'Accepted write');
  await closing; assert.equal(closed, true);
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Accepted write');
});
