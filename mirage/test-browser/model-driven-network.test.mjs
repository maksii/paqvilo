import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';

test('lazy metadata rejects inherited table identities before making a metadata request', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(), metadata = [], errors = [];
  await page.addInitScript(() => {
    Object.defineProperty(Object.prototype, 'metadata', { value: 'lazy', configurable: true, writable: true });
    Object.defineProperty(Object.prototype, 'x_inherited', { value: { metadata: 'lazy' }, configurable: true });
  });
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/_apps/api/metadata/')) metadata.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  for (const entity of ['__proto__', 'constructor', 'toString', 'x_inherited']) {
    await page.goto(origin + '/main.aspx?appname=x_example&etn=' + encodeURIComponent(entity));
    await page.getByRole('status').filter({ hasText: 'No table metadata is available' }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-mirage-app-state'), 'error');
  }
  assert.deepEqual(metadata, []); assert.deepEqual(errors, []);
});

test('form-only overlays retain the trusted Xrm CRUD/query round trip with bounded lazy metadata requests', async t => {
  const fixture = await modelDrivenFixture(t, { stateFile: null }); await fixture.sim.close();
  await fs.unlink(path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml'));
  const initial = { version: 1, mappings: { x_item: { userConfigured: true, entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_quantity: { dataverseType: 'int' } } },
    x_extra: { userConfigured: true, entitySet: 'x_extras', idColumn: 'x_extraid', nameColumn: 'x_name',
      fields: { x_name: { dataverseType: 'nvarchar' }, x_parentid: { dataverseType: 'lookup', targets: ['x_item'] } },
      relationships: { x_parentid: { entity: 'x_item', from: 'x_parentid', to: 'x_itemid', many: false } } } },
    tables: { x_item: [{ x_itemid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', x_name: 'Mapped original', x_quantity: 2 }] } };
  const sim = await fixture.start({ stateFile: null, initial, modelDriven: { trustedExtensions: true } }); t.after(() => sim.close());
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(), paths = [], errors = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/_apps/api')) paths.push(new URL(request.url()).pathname); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(sim.url + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  assert.ok(paths.includes('/_apps/api/index')); assert.ok(paths.includes('/_apps/api/metadata/x_item'));
  assert.equal(paths.includes('/_apps/api'), false);
  assert.ok(paths.filter(route => route.startsWith('/_apps/api/metadata/')).every(route => ['/_apps/api/metadata/x_item', '/_apps/api/metadata/x_child'].includes(route)));
  const result = await page.evaluate(async () => {
    const made = await Xrm.WebApi.createRecord('x_item', { x_name: 'Browser mapped row', x_quantity: 3 });
    await Xrm.WebApi.updateRecord('x_item', made.id, { x_name: 'Browser mapped update' });
    const saved = await Xrm.WebApi.retrieveRecord('x_item', made.id, '?$select=x_name');
    const filtered = await Xrm.WebApi.retrieveMultipleRecords('x_item', "?$select=x_name&$filter=x_name eq 'Browser mapped update'");
    let unknown; try { await Xrm.WebApi.retrieveRecord('x_item', made.id, '?$select=x_unknown'); } catch (error) { unknown = error.message; }
    await Xrm.WebApi.deleteRecord('x_item', made.id);
    return { saved, filtered, unknown, id: made.id };
  });
  assert.equal(result.saved.x_name, 'Browser mapped update'); assert.equal(result.filtered.entities.length, 1);
  assert.match(result.unknown, /Could not find a property/);
  assert.equal((await fetch(sim.url + '/_apps/api/tables/x_item/' + result.id)).status, 404);
  const related = await page.evaluate(async () => {
    const made = await Xrm.WebApi.createRecord('x_extra', { x_name: 'Lazy relation', 'x_parentid@odata.bind': '/x_items(aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)' });
    const saved = await Xrm.WebApi.retrieveRecord('x_extra', made.id, '?$select=x_name,_x_parentid_value');
    await Xrm.WebApi.deleteRecord('x_extra', made.id); return saved;
  });
  assert.equal(related._x_parentid_value, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.ok(paths.includes('/_apps/api/metadata/x_extra'));
  assert.deepEqual(errors, []);
});

test('model-driven Xrm lookup writes use the local staff transport, CSRF and current ETags', async t => {
  const { sim, origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(), requests = [], external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) external.push(request.url());
    if (new URL(request.url()).pathname.startsWith('/_apps/api/tables/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname, headers: request.headers(), data: request.postData() ? request.postDataJSON() : undefined });
  });
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  const catalogue = await (await fetch(origin + '/_apps/api')).json();
  const navigation = Object.entries(catalogue.tables.x_child.relationships).find(([, value]) => value.from === 'x_parentid' && value.entity === 'x_item' && value.many === false)?.[0] ?? 'x_parentid';
  requests.length = 0;
  const result = await page.evaluate(async ({ navigation }) => {
    const original = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', replacement = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const created = await Xrm.WebApi.createRecord('x_child', { x_name: 'Network proof', [navigation + '@odata.bind']: `/x_items(${original})` });
    await Xrm.WebApi.updateRecord('x_child', created.id, { x_name: 'Network updated', [navigation + '@odata.bind']: `/x_items(${replacement})` });
    const saved = await Xrm.WebApi.retrieveRecord('x_child', created.id);
    await Xrm.WebApi.deleteRecord('x_child', created.id);
    return { created, saved };
  }, { navigation });
  assert.equal(result.saved.x_name, 'Network updated'); assert.equal(result.saved._x_parentid_value, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.deepEqual(requests.map(request => request.method), ['POST', 'GET', 'PATCH', 'GET', 'GET', 'DELETE']);
  const writes = requests.filter(request => ['POST', 'PATCH', 'DELETE'].includes(request.method));
  assert.ok(writes.every(request => request.headers['x-sim-csrf'] === sim.state().csrf));
  assert.equal(writes.some(request => 'authorization' in request.headers), false, 'the browser staff session does not mint or copy API bearer tokens');
  assert.ok(writes.slice(1).every(request => /^W\/"\d+"$/.test(request.headers['if-match'])));
  assert.deepEqual(writes[0].data.x_parentid, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', entity: 'x_item' });
  assert.deepEqual(writes[1].data.x_parentid, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', entity: 'x_item' });
  assert.equal((await fetch(origin + '/_apps/api/tables/x_child/' + result.created.id)).status, 404);
  const count = requests.length;
  const failure = await page.evaluate(async () => { try { await Xrm.WebApi.createRecord('x_child', { x_name: 'Invalid reference', 'x_parentid@odata.bind': 'https://example.invalid/x_items(aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)' }); } catch (error) { return error.message; } });
  assert.match(failure, /local entity-set/); assert.equal(requests.length, count, 'invalid paths never trigger a record request');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

for (const kind of ['portal', 'model-driven']) test(`Xrm queries share canonical filtering, expansion, FetchXML and continuation in ${kind} with the public API disabled`, async t => {
  const { sim, origin } = await modelDrivenFixture(t, kind === 'model-driven' ? { runtime: { kind }, sourceDir: undefined } : {}); assert.equal(sim.dataverse ?? null, null);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(), external = [], errors = [];
  page.on('request', request => { if (new URL(request.url()).origin !== origin) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  const catalogue = await (await fetch(origin + '/_apps/api')).json();
  const navigation = Object.entries(catalogue.tables.x_child.relationships).find(([, value]) => value.from === 'x_parentid' && value.entity === 'x_item' && value.many === false)?.[0] ?? 'x_parentid';
  const result = await page.evaluate(async ({ navigation }) => {
    const matched = await Xrm.WebApi.retrieveMultipleRecords('x_item', "?$select=x_name&$filter=contains(x_name,'pp')");
    const expanded = await Xrm.WebApi.retrieveMultipleRecords('x_child', `?$select=x_name&$expand=${navigation}($select=x_name)&$orderby=x_name`);
    const single = await Xrm.WebApi.retrieveRecord('x_child', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', `?$select=x_name,_x_parentid_value&$expand=${navigation}($select=x_name)`);
    const names = [], links = [];
    let next = '?$select=x_name&$orderby=x_name';
    do { const page = await Xrm.WebApi.retrieveMultipleRecords('x_item', next, 1); names.push(...page.entities.map(row => row.x_name)); next = page.nextLink; if (next) links.push(next); } while (next && links.length < 5);
    const xml = '<fetch><entity name="x_item"><attribute name="x_name"/><filter><condition attribute="x_quantity" operator="eq" value="0"/></filter></entity></fetch>';
    const fetched = await Xrm.WebApi.retrieveMultipleRecords('x_item', '?fetchXml=' + encodeURIComponent(xml));
    let invalid; try { await Xrm.WebApi.retrieveMultipleRecords('x_item', 'https://example.invalid/api/data/v9.2/x_items?$skiptoken=ignored'); } catch (error) { invalid = error.message; }
    return { matched, parents: expanded.entities.map(row => row[navigation].x_name), single: { name: single.x_name, parent: single[navigation].x_name, parentId: single._x_parentid_value }, names, links, fetched, invalid };
  }, { navigation });
  assert.deepEqual(result.matched.entities.map(row => row.x_name), ['Copper']);
  assert.deepEqual(result.parents, ['Copper', 'Silver']);
  assert.deepEqual(result.single, { name: 'Copper child', parent: 'Copper', parentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.deepEqual(result.names, ['Copper', 'Empty', 'Silver'], 'scripts read the table, including records outside the selected saved view');
  assert.equal(result.links.length, 2); assert.ok(result.links.every(link => new URL(link).origin === origin));
  assert.deepEqual(result.fetched.entities.map(row => row.x_name), ['Empty']); assert.match(result.invalid, /local imported table/);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('saved form and Xrm edits share concurrency without overwriting either a newer row or the rejected draft', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], external = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== origin) external.push(request.url()); });
  page.on('response', response => { if (response.request().method() === 'PATCH') writes.push(response.status()); });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', route = `/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=${id}`;
  await page.goto(origin + route);
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  await page.getByLabel('Name', { exact: true }).fill('Form draft retained');
  await page.evaluate(async id => { await Xrm.WebApi.online.updateRecord('x_item', id, { x_quantity: 19 }); }, id);
  const conflict = page.waitForResponse(response => response.request().method() === 'PATCH' && response.status() === 412);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await conflict;
  await page.getByRole('status').filter({ hasText: /version|changed|match/i }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Form draft retained');
  assert.equal(await page.getByLabel('Quantity', { exact: true }).inputValue(), '2');
  assert.equal(await page.locator('#record-form').evaluate(node => node.inert), false);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
  let saved = await (await fetch(origin + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(saved.row.x_name, 'Copper'); assert.equal(saved.row.x_quantity, 19);
  // A fresh document is an explicit discard of the rejected draft. The next
  // sparse form write must retain the value changed through Xrm.
  await page.goto(origin + route);
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  assert.equal(await page.getByLabel('Quantity', { exact: true }).inputValue(), '19');
  await page.getByLabel('Name', { exact: true }).fill('Saved after reload');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  saved = await (await fetch(origin + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(saved.row.x_name, 'Saved after reload'); assert.equal(saved.row.x_quantity, 19);
  assert.deepEqual(writes, [200, 412, 200]);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('leaving a form during Xrm ETag preflight prevents the pending update from writing afterward', async t => {
  const { origin } = await modelDrivenFixture(t);
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], methods = [];
  page.on('pageerror', error => errors.push(error.message));
  const child = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', endpoint = '/_apps/api/tables/x_child/' + child;
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && Boolean(globalThis.Xrm));
  let release, intercepted;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { intercepted = resolve; });
  t.after(() => release());
  await page.route('**' + endpoint, async route => {
    methods.push(route.request().method());
    if (route.request().method() === 'GET') { intercepted(); await gate; }
    await route.continue();
  });
  await page.evaluate(id => { window.pendingXrmUpdate = Xrm.WebApi.updateRecord('x_child', id, { x_name: 'Disposed form must not write' }).then(() => 'unexpected success', error => error.message); }, child);
  await started;
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  release();
  assert.match(await page.evaluate(() => pendingXrmUpdate), /disposed/);
  assert.deepEqual(methods, ['GET']);
  const saved = await (await fetch(origin + endpoint)).json();
  assert.equal(saved.row.x_name, 'Copper child');
  assert.deepEqual(errors, []);
});
