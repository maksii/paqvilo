import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { scanSolutionSources } from '../lib/solution-schema.mjs';
import { solutionApps, appCatalogue } from '../lib/model-driven/catalogue.mjs';
import { compileForm } from '../lib/model-driven/solution.mjs';

test('form layout retains exported columns, hidden sections, row positions and spanning fields', () => {
  const form = compileForm({ id: 'layout', xml: '<form><tabs><tab name="general"><columns><column width="70%"><sections><section columns="11" showlabel="false"><rows><row><cell><control datafieldname="x_name"/></cell><cell><control datafieldname="x_quantity"/></cell></row><row><cell colspan="2"><control datafieldname="x_notes"/></cell></row></rows></section></sections></column><column width="30%"><sections><section visible="false"><rows><row><cell><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>' }, { x_name: {}, x_quantity: {}, x_notes: {} });
  const tab = form.tabs[0]; assert.deepEqual(tab.columnWidths, [70, 30]);
  assert.equal(tab.sections[0].showLabel, false); assert.equal(tab.sections[0].columns, 2);
  assert.deepEqual(tab.sections[0].fields.map(({ row, column, colspan }) => ({ row, column, colspan })), [{ row: 0, column: 0, colspan: 1 }, { row: 0, column: 1, colspan: 1 }, { row: 1, column: 0, colspan: 2 }]);
  assert.equal(tab.sections[1].column, 1); assert.equal(tab.sections[1].visible, false);
});

test('model-driven app catalogue imports solution navigation, forms and views alongside the default management app', async t => {
  const { origin } = await modelDrivenFixture(t);
  const response = await fetch(origin + '/_apps/api'); assert.equal(response.status, 200);
  const catalogue = await response.json();
  assert.equal(catalogue.defaultApp, 'power-pages-management');
  const app = catalogue.apps.find(app => app.uniqueName === 'x_example'); assert.ok(app);
  assert.equal(app.navigation[0].groups[0].items[0].entity, 'x_item');
  assert.equal(app.navigation[0].groups[0].items[1].supported, false);
  assert.equal(catalogue.tables.x_item.forms[0].source, 'solution');
  assert.equal(catalogue.tables.x_item.views[0].name, 'Stocked items');
  assert.equal(catalogue.tables.x_item.rows, undefined);
  const shell = await fetch(origin + '/main.aspx'); assert.equal(shell.status, 200); assert.match(await shell.text(), /Model|Power Pages Management/);
  assert.match(shell.headers.get('content-security-policy'), /connect-src 'self'/);
});

test('grid runs saved FetchXML with search, filters, columns, sorting and paging', async t => {
  const { origin } = await modelDrivenFixture(t);
  const list = async query => { const response = await fetch(origin + '/_apps/api/tables/x_item?query=' + encodeURIComponent(JSON.stringify(query))); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const first = await list({ pageSize: 1, sort: 'x_quantity', direction: 'desc' });
  assert.equal(first.rows[0].x_name, 'Silver'); assert.equal(first.total, 2); assert.equal(first.more, true);
  const search = await list({ search: 'opp', columns: ['x_name'], filters: [{ field: 'x_quantity', operator: 'lt', value: 5 }] }); assert.equal(search.rows.length, 1); assert.equal(search.rows[0].x_name, 'Copper');
  const raw = await list({ scope: 'table', columns: ['x_name'], filters: [{ field: 'x_quantity', operator: 'eq', value: 0 }] });
  assert.equal(raw.rows.length, 1); assert.equal(raw.rows[0].x_name, 'Empty', 'Client API table queries do not inherit saved-view filters.');
  const invalid = await fetch(origin + '/_apps/api/tables/x_item?query=' + encodeURIComponent(JSON.stringify({ filters: [{ field: 'unknown', operator: 'eq', value: 1 }] }))); assert.equal(invalid.status, 400);
});

test('local CRUD requires CSRF, validates values and rejects stale writes', async t => {
  const { origin } = await modelDrivenFixture(t);
  const shell = await (await fetch(origin + '/main.aspx')).text(), csrf = /name="mirage-csrf" content="([^"]+)/.exec(shell)[1];
  const request = (method, suffix, values, etag) => fetch(origin + '/_apps/api/tables/x_item' + suffix, { method, headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, ...(etag ? { 'if-match': etag } : {}) }, ...(values ? { body: JSON.stringify(values) } : {}) });
  assert.equal((await fetch(origin + '/_apps/api/tables/x_item', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await request('POST', '', { x_name: 'Bad', x_quantity: 'invalid' })).status, 400);
  const createdResponse = await request('POST', '', { x_name: 'Gold', x_quantity: 4 }); assert.equal(createdResponse.status, 201, await createdResponse.clone().text()); const created = await createdResponse.json(); const id = created.row.x_itemid;
  assert.equal((await request('PATCH', '/' + id, { x_quantity: 6 })).status, 428);
  const updated = await request('PATCH', '/' + id, { x_quantity: 6 }, created.etag); assert.equal(updated.status, 200);
  assert.equal((await request('PATCH', '/' + id, { x_quantity: 7 }, created.etag)).status, 412);
  const read = await (await fetch(origin + '/_apps/api/tables/x_item/' + id)).json(); assert.equal(read.row.x_quantity, 6);
  assert.equal((await request('DELETE', '/' + id, null, read.etag)).status, 200);
});

test('management edits recompile the local portal, persist across restarts, and leave source files untouched', async t => {
  const fixture = await modelDrivenFixture(t), { origin, sourceDir } = fixture;
  const before = await fs.readFile(path.join(sourceDir, 'content-snippets/Welcome.contentsnippet.value.html'), 'utf8');
  const shell = await (await fetch(origin + '/main.aspx')).text(), csrf = /name="mirage-csrf" content="([^"]+)/.exec(shell)[1];
  const endpoint = '/_apps/api/tables/adx_contentsnippet/55555555-5555-4555-8555-555555555555';
  const current = await (await fetch(origin + endpoint)).json(); assert.equal(current.row.adx_value, before);
  const response = await fetch(origin + endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, 'if-match': current.etag }, body: JSON.stringify({ adx_value: 'Changed locally' }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await (await fetch(origin + '/')).text(), /Changed locally/);
  assert.equal(await fs.readFile(path.join(sourceDir, 'content-snippets/Welcome.contentsnippet.value.html'), 'utf8'), before);
  await fixture.sim.close(); const restarted = await fixture.start(); t.after(() => restarted.close());
  assert.match(await (await fetch((restarted.origin ?? restarted.url) + '/')).text(), /Changed locally/);
});

test('management creates related customization records and auxiliary websites without replacing the source website', async t => {
  const { origin } = await modelDrivenFixture(t);
  const shell = await (await fetch(origin + '/main.aspx')).text(), csrf = /name="mirage-csrf" content="([^"]+)/.exec(shell)[1];
  const call = (method, entity, values, id, etag) => fetch(origin + '/_apps/api/tables/' + entity + (id ? '/' + id : ''), { method, headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, ...(etag ? { 'if-match': etag } : {}) }, ...(values ? { body: JSON.stringify(values) } : {}) });
  const primary = '11111111-1111-4111-8111-111111111111';
  const related = await fetch(origin + '/_apps/api/tables/adx_sitesetting?query=' + encodeURIComponent(JSON.stringify({ filters: [{ field: 'adx_websiteid', operator: 'eq', value: primary }] })));
  assert.equal((await related.json()).rows.length, 1, 'Source membership supplies the implicit website lookup.');
  const createdResponse = await call('POST', 'adx_sitesetting', { adx_name: 'Example/New', adx_value: 'Local value', adx_websiteid: primary });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text()); const created = await createdResponse.json();
  assert.equal((await call('DELETE', 'adx_sitesetting', null, created.row.adx_sitesettingid, created.etag)).status, 200);
  const secondaryResponse = await call('POST', 'adx_website', { adx_name: 'Secondary configuration' });
  assert.equal(secondaryResponse.status, 201, await secondaryResponse.clone().text()); const secondary = await secondaryResponse.json();
  assert.equal((await (await fetch(origin + '/_apps/api/tables/adx_website')).json()).rows.length, 2);
  assert.match(await (await fetch(origin + '/')).text(), /Hello from the export/);
  assert.equal((await call('DELETE', 'adx_website', null, secondary.row.adx_websiteid, secondary.etag)).status, 200);
  const original = await (await fetch(origin + '/_apps/api/tables/adx_website/' + primary)).json();
  assert.equal((await call('DELETE', 'adx_website', null, primary, original.etag)).status, 501);
  const rejected = await call('PATCH', 'adx_website', { adx_name: '' }, primary, original.etag); assert.equal(rejected.status, 400);
});

test('app assets stay origin-confined and reject unknown resources, cross-origin writes and inherited table names', async t => {
  const { origin } = await modelDrivenFixture(t);
  assert.equal((await fetch(origin + '/_apps/assets/missing.mjs')).status, 404);
  assert.equal((await fetch(origin + '/_apps/api/tables/constructor')).status, 404);
  assert.equal((await fetch(origin + '/_apps/api/tables/x_item', { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403);
});

test('sparse customization overlays retain later source changes to untouched sibling fields', async t => {
  const fixture = await modelDrivenFixture(t), { origin, sourceDir } = fixture;
  const shell = await (await fetch(origin + '/main.aspx')).text(), csrf = /name="mirage-csrf" content="([^"]+)/.exec(shell)[1];
  const endpoint = '/_apps/api/tables/adx_sitesetting/66666666-6666-4666-8666-666666666666';
  const current = await (await fetch(origin + endpoint)).json();
  const response = await fetch(origin + endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, 'if-match': current.etag }, body: JSON.stringify({ adx_value: 'Local value', adx_name: current.row.adx_name }) });
  assert.equal(response.status, 200);
  await fixture.sim.close();
  await fs.writeFile(path.join(sourceDir, 'site-settings/Mode.sitesetting.yml'), 'adx_sitesettingid: 66666666-6666-4666-8666-666666666666\nadx_name: Example/NewSourceName\nadx_value: New source value');
  const restarted = await fixture.start(); t.after(() => restarted.close());
  const read = await (await fetch(restarted.url + endpoint)).json();
  assert.equal(read.row.adx_name, 'Example/NewSourceName'); assert.equal(read.row.adx_value, 'Local value');
});

test('monolithic solution metadata imports app forms, views and navigation with no portal-form dependency', async t => {
  const { root } = await modelDrivenFixture(t);
  const file = path.join(root, 'embedded.xml');
  await fs.writeFile(file, '<ImportExportXml><Entities><Entity><Name>x_embedded</Name><EntityInfo><entity Name="x_embedded"><attributes><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo><FormXml><forms type="main"><systemform><formid>{embedded-form}</formid><type>2</type><form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform></forms></FormXml><SavedQueries><savedquery><savedqueryid>{embedded-view}</savedqueryid><querytype>0</querytype><fetchxml><fetch><entity name="x_embedded"><attribute name="x_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="x_name" width="100"/></row></grid></layoutxml></savedquery></SavedQueries></Entity></Entities><AppModules><AppModule><UniqueName>x_embedded_app</UniqueName><AppModuleId>embedded-app</AppModuleId><SiteMap><Area Id="main"><Group Id="items"><SubArea Id="items" Entity="x_embedded"/></Group></Area></SiteMap></AppModule></AppModules></ImportExportXml>');
  const scan = await scanSolutionSources([file]); const metadata = await importSolutionMetadata([file], { scan });
  assert.equal(metadata.forms[0].id, 'embedded-form'); assert.equal(metadata.views[0].id, 'embedded-view');
  assert.equal(solutionApps(scan)[0].navigation[0].groups[0].items[0].entity, 'x_embedded');
  const catalogue = appCatalogue({ portal: { website: {}, records: [], format: 'enhanced' }, metadata: { ...metadata, modelDrivenApps: solutionApps(scan) }, mappings: { x_embedded: { idColumn: 'x_embeddedid', nameColumn: 'x_name' } } });
  const app = catalogue.apps.find(app => app.uniqueName === 'x_embedded_app'); assert.equal(app.navigation[0].groups[0].items[0].title, 'X Embedded');
});
