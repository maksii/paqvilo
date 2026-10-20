import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { runtimePerformance, LARGE_PERFORMANCE_OPTIONS } from '../../scripts/runtime-performance.mjs';
import { createSimulator } from '../server.mjs';
import { performanceFixture, performanceId } from './runtime-performance-fixture.mjs';
import { createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';
import { appCatalogue, appCatalogueAsync } from '../lib/model-driven/catalogue.mjs';

test('organization seeders checkpoint once, keep existing rows and roll back failed composition', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-bootstrap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = emptyState(); state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
  state.tables.x_item = [{ x_itemid: 'local', value: 'Keep this local edit' }];
  const file = path.join(root, 'state.json'), store = await new DataStore({ file, state, persistence: { journalThresholdBytes: 0 } }).init();
  let saves = 0; store.onSave = () => saves++;
  const extensions = Array.from({ length: 12 }, (_, i) => ({ install: api => api.store.transact(() => { api.store.state.tables[`x_seed${i}`] ??= []; }) }));
  const options = { store, settings: dataverseSettings({ enabled: false }), extensions };
  const core = await createOrganizationRuntime(options);
  assert.equal(saves, 1, 'All extension seeders share a single durable checkpoint.');
  assert.equal(store.tableRows('x_item')[0].value, 'Keep this local edit');
  await core.close(); saves = 0;
  const restart = await createOrganizationRuntime(options); await restart.close();
  assert.equal(saves, 0, 'Insert-only unchanged bootstrap does not rewrite business state.');
  const before = store.snapshot(), bytes = await fs.readFile(file);
  await assert.rejects(createOrganizationRuntime({ ...options, extensions: [{ install: api => api.store.transact(() => { api.store.state.tables.x_item[0].value = 'Must roll back'; }) },
    { install() { throw Error('Invented failure'); } }] }), /Invented failure/);
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(await fs.readFile(file), bytes);
  let closed = 0;
  const save = store.save.bind(store);
  store.save = async () => { throw Error('Invented checkpoint failure'); };
  await assert.rejects(createOrganizationRuntime({ ...options, extensions: [{ install: api => api.store.transact(() => { api.store.state.tables.x_item[0].value = 'Not durable'; }), close() { closed++; } }] }), /Invented checkpoint failure/);
  store.save = save;
  assert.equal(closed, 1, 'An organization whose final checkpoint fails closes its installed resources.');
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(await fs.readFile(file), bytes);
});

test('deferred startup callbacks read committed state while a later isolated transaction is open', async () => {
  const state = emptyState(); state.tables.x_item = [{ value: 'startup' }];
  const store = await new DataStore({ state }).init();
  let releaseContinuation, releaseIsolation, isolationEntered, continuation;
  const continuationGate = new Promise(resolve => { releaseContinuation = resolve; });
  const core = await createOrganizationRuntime({ store, settings: dataverseSettings({ enabled: false }), extensions: [{ install(api) {
    // Promise callbacks inherit their registration's async context, just as an
    // extension timer does after startup has committed and its frame has closed.
    continuation = continuationGate.then(() => api.store.state.tables.x_item[0].value);
  } }] });
  await store.transact(() => { store.state.tables.x_item[0].value = 'committed after bootstrap'; });
  const entered = new Promise(resolve => { isolationEntered = resolve; });
  const isolationGate = new Promise(resolve => { releaseIsolation = resolve; });
  const isolated = store.transact(async () => {
    store.state.tables.x_item[0].value = 'private pending transaction';
    isolationEntered(); await isolationGate;
  }, { isolated: true });
  try {
    await entered; releaseContinuation();
    assert.equal(await continuation, 'committed after bootstrap');
  } finally { releaseIsolation(); await isolated; await core.close(); }
});

test('catalogue metadata epoch reuses one snapshot and expires before later source or raw metadata edits', async () => {
  const overlay = createSolutionMetadataOverlay();
  const base = { forms: [{ id: 'form-one', entity: 'x_item', xml: '<form/>' }] };
  let xml = '<form/>', scans = 0, deferred, release;
  const row = { formid: 'form-one', get formxml() { scans++; return xml; } };
  const state = { tables: { systemform: [row] }, dataverse: { sourceSolutionComponents: { baseline: { 'systemform/form-one': {} } } } };
  const gate = new Promise(resolve => { release = resolve; });
  await overlay.withReadEpoch(async () => {
    const first = overlay(base, state), counted = scans;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(overlay(base, state), first); assert.equal(scans, counted, 'Repeated table/field reads do not rescan source rows.');
    deferred = gate.then(() => overlay(base, state));
  });
  xml = '<form><tabs/></form>';
  release(); const changed = await deferred;
  assert.equal(changed.forms[0].xml, xml, 'Deferred callbacks cannot reuse a completed read epoch.');
  await overlay.withReadEpoch(() => {
    const next = { ...base, forms: [{ ...base.forms[0], name: 'Changed source' }] };
    assert.equal(overlay(next, state).forms[0].name, 'Changed source');
    assert.equal(overlay(base, state).forms[0].name, undefined, 'An epoch does not return another metadata input\'s value.');
  });
});

test('metadata reuse stops before a potentially mutating read plug-in runs', async () => {
  const overlay = createSolutionMetadataOverlay(), state = emptyState();
  state.tables.systemform = [{ formid: 'form-one', formxml: '<form/>' }];
  state.dataverse = { sourceSolutionComponents: { baseline: { 'systemform/form-one': {} } } };
  const store = new DataStore({ state }), base = { forms: [{ id: 'form-one', entity: 'x_item', xml: '<form/>' }] };
  await store.readOperation(() => overlay.withReadEpoch(() => {
    const first = overlay(base, store.state); assert.equal(store.isUnmodifiedRead(), true);
    store.ensureReadSnapshot();
    store.state.tables.systemform[0].formxml = '<form><tabs/></form>';
    assert.equal(store.isUnmodifiedRead(), false);
    assert.notEqual(overlay(base, store.state), first);
    assert.equal(overlay(base, store.state).forms[0].xml, '<form><tabs/></form>');
  }, { valid: () => store.isUnmodifiedRead() }));
});

test('cooperative catalogue construction preserves the complete synchronous contract and supports cancellation', async () => {
  const options = { mappings: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`x_table${i}`, { idColumn: 'id', fields: { name: { type: 'nvarchar' } } }])) };
  assert.deepEqual(await appCatalogueAsync(options), appCatalogue(options));
  let checks = 0;
  await assert.rejects(appCatalogueAsync(options, { cancelled: () => ++checks > 3 }), error => error.status === 499);
  assert.deepEqual(await appCatalogueAsync(options), appCatalogue(options), 'Cancellation does not retain a partially built catalogue.');
});

for (const watch of [false, true]) test(`catalogue invalidates source, form and field-security metadata with watch ${watch}`, { timeout: 30000 }, async t => {
  const fixture = await performanceFixture({ tables: 2, records: 8 }); t.after(fixture.cleanup);
  for (let i = 0; i < 2; i++) {
    const file = path.join(fixture.solutionRoots[0], `Entities/x_scale${i}/Entity.xml`);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('</EntitySetName>', '</EntitySetName><OwnershipTypeMask>UserOwned</OwnershipTypeMask>'));
  }
  const sim = await createSimulator({ runtime: { kind: 'model-driven' }, solutionRoots: fixture.solutionRoots, watch, packs: [fixture.pack],
    preset: 'invented-scale', presetMode: 'bootstrap', dataverse: { enabled: false, users: [{ objectId: performanceId(700), domainname: 'invented@example.test', fullname: 'Invented restricted staff', roles: ['Basic User'] }] } });
  t.after(() => sim.close());
  const session = await (await fetch(sim.url + '/_sim/api/dataverse/session')).json();
  const selected = await fetch(sim.url + '/_sim/api/dataverse/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf }, body: JSON.stringify({ userId: session.users.find(user => user.name === 'Invented restricted staff').id }) });
  assert.equal(selected.status, 200); const cookie = selected.headers.get('set-cookie').split(';')[0];
  const catalogue = async () => (await (await fetch(sim.url + '/_apps/api', { headers: { cookie } })).json()).tables.x_scale0;
  const before = await catalogue(); assert.equal(before.capabilities.fields.x_value1.read, false);
  const csrf = sim.state().csrf, headers = { 'content-type': 'application/json', 'x-sim-csrf': csrf };
  const made = await fetch(sim.url + '/_apps/api/tables/x_scale0', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ x_value0: 'Invented staff row' }) });
  assert.equal(made.status, 201); const created = await made.json();
  const saved = await fetch(sim.url + '/_apps/api/tables/x_scale0/' + created.id, { method: 'PATCH', headers: { ...headers, 'if-match': created.etag }, body: JSON.stringify({ x_value1: 'Must stay masked' }) });
  assert.equal(saved.status, 200);
  const read = async route => { const response = await fetch(sim.url + '/_apps/api/' + route, { headers: { cookie } }); assert.equal(response.status, 200); return response.json(); };
  const recordRoute = 'tables/x_scale0/' + created.id;
  assert.equal((await read(recordRoute)).row.x_value1, null);
  const grid = await read('tables/x_scale0?query=' + encodeURIComponent(JSON.stringify({ columns: ['x_value0', 'x_value1'], filters: [{ field: 'x_value0', operator: 'eq', value: 'Invented staff row' }], pageSize: 50 })));
  assert.equal(grid.rows.length, 1); assert.ok(grid.rows[0].x_value1 == null); assert.doesNotMatch(JSON.stringify(grid), /Must stay masked/);
  const entityFile = path.join(fixture.solutionRoots[0], 'Entities/x_scale0/Entity.xml'), formFile = path.join(fixture.solutionRoots[0], 'Entities/x_scale0/FormXml/main/form.xml');
  await fs.writeFile(entityFile, (await fs.readFile(entityFile, 'utf8')).replace('<IsSecured>1</IsSecured>', '<IsSecured>0</IsSecured>').replace('</attributes>', '<attribute PhysicalName="x_added"><Name>x_added</Name><Type>nvarchar</Type></attribute></attributes>'));
  await fs.writeFile(formFile, (await fs.readFile(formFile, 'utf8')).replace('</rows>', '<row><cell><control datafieldname="x_added"/></cell></row></rows>'));
  if (!watch) await sim.reload();
  let changed, deadline = performance.now() + 10000;
  do { changed = await catalogue(); if (changed.fields.x_added && changed.capabilities.fields.x_value1.read) break; await new Promise(resolve => setTimeout(resolve, 100)); } while (performance.now() < deadline);
  assert.ok(changed.fields.x_added); assert.equal(changed.capabilities.fields.x_value1.read, true);
  assert.equal((await read(recordRoute)).row.x_value1, 'Must stay masked', 'The next record read uses changed source security metadata.');
  assert.ok(changed.forms.some(form => form.tabs.some(tab => tab.sections.some(section => section.fields.some(field => field.name === 'x_added')))));
});

test('catalogue yields to status while retaining one security read and releases cancelled readers', async t => {
  const store = new DataStore(), tables = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`x_item${i}`, { fields: { name: {} }, rows: [{ name: 'Never expose rows' }] }]));
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  let checks = 0, entered;
  const started = () => new Promise(resolve => { entered = resolve; });
  const handler = createModelDrivenHandler({ catalogue: () => ({ tables }), data: { capabilities(name, actor, id, fields) {
    entered?.(); entered = null; checks++; assert.equal(fields, tables[name].fields);
    const until = performance.now() + 2; while (performance.now() < until) { /* simulated bounded table work */ }
    return { read: store.state.settings.permissionMode === 'enforce' };
  } }, read: fn => store.readOperation(fn), csrf: () => 'invented', json });
  const server = http.createServer(async (req, res) => { if (req.url === '/status') return json(res, 200, { running: true }); await handler(req, res, new URL(req.url, 'http://127.0.0.1')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`, admission = started();
  let complete = false;
  const pending = fetch(origin + '/_apps/api').then(response => response.json()).finally(() => { complete = true; });
  await admission;
  const write = store.transact(() => { store.state.settings.permissionMode = 'permissive'; });
  const status = await fetch(origin + '/status'); assert.equal(status.status, 200);
  assert.equal(complete, false, 'Unrelated status completes before catalogue work finishes.');
  const value = await pending;
  assert.equal(checks, 64); assert.ok(Object.values(value.tables).every(table => table.capabilities.read && !Object.hasOwn(table, 'rows')));
  await write;
  const abort = new AbortController(), admitted = started();
  checks = 0;
  const cancelled = fetch(origin + '/_apps/api', { signal: abort.signal }).catch(error => error);
  await admitted; abort.abort(); await cancelled;
  await new Promise(resolve => setTimeout(resolve, 25));
  await store.readOperation(() => assert.equal(store.state.settings.permissionMode, 'permissive'));
  assert.ok(checks < 64, 'A disconnected consumer does not compute the remainder of its catalogue.');
});

for (const portal of [false, true]) test(`${portal ? 'portal' : 'standalone'} fresh, unchanged and grown-journal startup retains bootstrap data and reports costs`, { timeout: 60000 }, async () => {
  const report = await runtimePerformance({ scales: [2], records: 32, portal, budgetMs: 30000, heartbeatBudgetMs: 5000 });
  assert.deepEqual(report.results.map(result => result.generated), [1, 0, 0]);
  assert.deepEqual(report.results.map(result => result.preset.applied), [true, false, false]);
  assert.ok(report.results.every(result => result.rows === 16 && result.timings.stateRestoreMs >= 0 && result.timings.organizationMs >= 0));
  assert.ok(report.results[1].timings.solutionCache.hits > 0);
  assert.equal(report.results[1].timings.solutionCache.misses, 0);
  assert.equal(report.results[2].timings.stateRestore.journal, true);
  for (const result of report.results) {
    assert.deepEqual(result.progress.filter(entry => ['state-restore', 'state-composition', 'preset', 'organization', 'listener', 'listener-ready'].includes(entry.phase)).map(entry => entry.phase),
      ['state-restore', 'state-composition', 'preset', 'organization', 'listener', 'listener-ready']);
    assert.ok(result.progress.every((entry, i) => entry.elapsedMs >= (result.progress[i - 1]?.elapsedMs ?? 0)));
  }
});

test('optional source-volume probe retains every form and the exact requested records on a small fixture', { timeout: 60000 }, async () => {
  assert.ok(LARGE_PERFORMANCE_OPTIONS.scales[0] * (1 + LARGE_PERFORMANCE_OPTIONS.formsPerTable) + 2 > 10000);
  const report = await runtimePerformance({ scales: [2], formsPerTable: 3, columns: 4, records: 17, portal: false, heartbeatBudgetMs: 5000 });
  assert.deepEqual(report.findings, []);
  for (const result of report.results) {
    assert.equal(result.inventory.xmlFiles, 10); assert.equal(result.inventory.forms, 6);
    assert.equal(result.actualRecords, 17); assert.equal(result.rows, 9);
    assert.ok(result.inventory.sourceBytes > 0); assert.ok(result.fixtureMs >= 0);
  }
});
