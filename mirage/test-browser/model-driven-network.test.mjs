import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';

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
