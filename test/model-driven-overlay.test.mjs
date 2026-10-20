import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModelDrivenOverlay, modelDrivenOrigin } from '../lense/model-driven.mjs';
import { modelDrivenReloadQueue, refreshModelDrivenPage, publishModelDrivenReload } from '../lense/commands/model-driven.mjs';
import { importModelDrivenResources } from '../mirage/lib/model-driven-resources.mjs';

const imported = text => ({ resources: [{ name: 'x_script.js', type: 'script', url: '/_apps/resources/script' }], assets: new Map([
  ['/_apps/resources/script', { name: 'x_script.js', data: Buffer.from(text), mime: 'text/javascript' }],
  ['/_apps/controls/c/bundle.js', { name: 'x_Invented.Control/bundle.js', data: Buffer.from('pcf'), mime: 'text/javascript' }],
]), diagnostics: [] });
const fake = (url, method = 'GET', resourceType = 'script', page) => {
  const result = { fallback: 0 };
  return { result, request: () => ({ url: () => url, method: () => method, resourceType: () => resourceType, frame: () => ({ page: () => page }) }), fallback: async () => { result.fallback++; }, fulfill: async value => { result.response = value; } };
};

test('Solution overlays admit exact declared resources and never intercept API mutations or another origin', async () => {
  const overlay = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('local'), mappings: [{ path: '/%7B123%7D/webresources/native.Control/bundle.js', resource: 'x_Invented.Control/bundle.js' }] });
  const script = fake('https://invented.invalid/webresources/x_script.js?credential=never-record'); await overlay.handle(script);
  assert.equal(script.result.response.body.toString(), 'local');
  const pcf = fake('https://invented.invalid/%7b123%7d/webresources/native.Control/bundle.js'); await overlay.handle(pcf);
  assert.equal(pcf.result.response.body.toString(), 'pcf');
  for (const route of [fake('https://other.invalid/WebResources/x_script.js'), fake('https://invented.invalid/WebResources/x_script.js', 'POST'), fake('https://invented.invalid/api/data/v9.2/x_items')]) {
    await overlay.handle(route); assert.equal(route.result.fallback, 1);
  }
  const report = overlay.report(); assert.equal(report.applied, 2); assert.equal(report.unbound.length, 0);
  assert.equal(JSON.stringify(report).includes('never-record'), false);
  assert.equal(JSON.stringify(report).includes('/api/data'), false);
});

test('overlay import publication is atomic and HEAD has no body', async () => {
  const overlay = createModelDrivenOverlay({ origin: 'http://127.0.0.1:3210', imported: imported('first') });
  assert.throws(() => overlay.replace(imported('broken'), [{ path: '/not-found.js', resource: 'undeclared.js' }]), /undeclared/);
  const first = fake('http://127.0.0.1:3210/WebResources/x_script.js'); await overlay.handle(first); assert.equal(first.result.response.body.toString(), 'first');
  overlay.replace(imported('second'));
  assert.equal(overlay.report().applied, 1); assert.equal(overlay.report().currentRevisionApplied, 0);
  assert.equal(overlay.report().resources[0].currentRevisionApplied, 0);
  const changed = fake('http://127.0.0.1:3210/WebResources/x_script.js'); await overlay.handle(changed); assert.equal(changed.result.response.body.toString(), 'second');
  const head = fake('http://127.0.0.1:3210/WebResources/x_script.js', 'HEAD'); await overlay.handle(head); assert.equal(head.result.response.body.length, 0);
  assert.equal(overlay.report().currentRevisionApplied, 2);
  assert.equal(overlay.report().revision, 2);
});

test('invalid origins, traversal and ambiguous resource maps fail before a browser opens', () => {
  for (const origin of ['https://user:password@invented.invalid', 'https://invented.invalid/main.aspx?appid=1', 'http://public.invalid', 'file:///app']) assert.throws(() => modelDrivenOrigin(origin));
  for (const path of ['//other.invalid/script.js', '/a/../b', '/%2e%2e/b', '/a?token=secret', '/a\\b', '/api/data/v9.2/items', '/api%2Fdata', '/oauth2/token', '/main.aspx', '/_apps/api/tables', '/_sim/']) assert.throws(() => createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('test'), mappings: [{ path, resource: 'x_script.js' }] }));
  assert.throws(() => createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('test'), mappings: [{ path: '/WebResources/x_script.js', resource: 'x_Invented.Control/bundle.js' }] }), /Multiple/);
});

test('a dedicated model-driven session leaves other user pages and navigation requests untouched', async () => {
  const owner = {}, user = {};
  const overlay = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('local'), ownsRequest: request => request.frame().page() === owner });
  for (const route of [fake('https://invented.invalid/WebResources/x_script.js', 'GET', 'script', user), fake('https://invented.invalid/WebResources/x_script.js', 'GET', 'document', owner)]) { await overlay.handle(route); assert.equal(route.result.fallback, 1); }
  const owned = fake('https://invented.invalid/WebResources/x_script.js', 'GET', 'script', owner); await overlay.handle(owned);
  assert.equal(owned.result.response.body.toString(), 'local'); assert.equal(overlay.report().applied, 1);
});

test('an in-flight old resource response never proves the replacement revision was applied', async () => {
  const events = [];
  const overlay = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('old'), onApplied: event => events.push(event) });
  const route = fake('https://invented.invalid/WebResources/x_script.js');
  let finish;
  route.fulfill = () => new Promise(resolve => { finish = resolve; });
  const handling = overlay.handle(route);
  overlay.replace(imported('new')); finish(); await handling;
  assert.equal(overlay.report().applied, 1);
  assert.equal(overlay.report().currentRevisionApplied, 0);
  assert.equal(events[0].revision, 1);
  const current = fake('https://invented.invalid/WebResources/x_script.js'); await overlay.handle(current);
  assert.equal(overlay.report().currentRevisionApplied, 1);
});

test('an oversized source save preserves the previous working overlay and resource revision', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lense-over-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'WebResources'));
  await fs.writeFile(path.join(root, 'WebResources/x_script.js.data.xml'), '<WebResource><Name>x_script.js</Name><WebResourceType>3</WebResourceType><FileName>x_script.js</FileName></WebResource>');
  const overBudget = await importModelDrivenResources([{ type: 'directory', dir: root }], { limits: { bytes: 24 } });
  assert.ok(overBudget.diagnostics.some(item => item.code === 'MODEL_CLIENT_IMPORT_LIMIT'));
  const overlay = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: imported('working') });
  assert.throws(() => publishModelDrivenReload(overlay, overBudget, []), /MODEL_CLIENT_IMPORT_LIMIT.*previous overlay remains active/);
  const route = fake('https://invented.invalid/WebResources/x_script.js'); await overlay.handle(route);
  assert.equal(route.result.response.body.toString(), 'working'); assert.equal(overlay.report().revision, 1);
  const next = imported('localized'); next.diagnostics.push({ code: 'PCF_RESOURCE_LANGUAGE_FALLBACK' });
  publishModelDrivenReload(overlay, next, []); assert.equal(overlay.report().revision, 2);
});

test('large catalogues retain exact indexed routes and discard retired resource counters', async () => {
  const many = count => ({ resources: Array.from({ length: count }, (_, i) => ({ name: `x_${i}.js` })),
    assets: new Map(Array.from({ length: count }, (_, i) => [`asset-${i}`, { name: `x_${i}.js`, data: Buffer.from('local'), mime: 'text/javascript' }])), diagnostics: [] });
  const overlay = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: many(5000) });
  let report = overlay.report();
  assert.equal(report.resources.length, 5000); assert.equal(report.unbound.length, 0);
  assert.deepEqual(report.resources[4999].paths, ['/WebResources/x_4999.js']);
  for (let i = 0; i < 300; i++) await overlay.handle(fake(`https://invented.invalid/missing-${i}.js?secret=never-store`));
  assert.equal(overlay.report().unmatched.length, 256);
  await overlay.handle(fake('https://invented.invalid/WebResources/x_4999.js'));
  overlay.replace(many(1));
  assert.equal(overlay.report().unmatched.length, 0);
  overlay.replace(many(5000));
  report = overlay.report();
  assert.equal(report.applied, 1); assert.equal(report.resources[4999].applied, 0);
  assert.equal(report.currentRevisionApplied, 0);
});

test('local JavaScript receives a cached file source map; compiled maps and ZIP-only resources remain unchanged', async () => {
  const next = imported('local');
  next.assets.get('/_apps/resources/script').file = 'C:/invented/solution/WebResources/x_script.js';
  const mapped = next.assets.get('/_apps/controls/c/bundle.js');
  mapped.file = 'C:/invented/solution/Controls/bundle.js'; mapped.data = Buffer.from('pcf\n//# sourceMappingURL=compiled.js.map');
  const overlay = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: next,
    mappings: [{ path: '/native/bundle.js', resource: mapped.name }] });
  const first = fake('https://invented.invalid/WebResources/x_script.js'); await overlay.handle(first);
  const second = fake('https://invented.invalid/WebResources/x_script.js'); await overlay.handle(second);
  assert.strictEqual(first.result.response.body, second.result.response.body);
  const dataUrl = /sourceMappingURL=(\S+)/.exec(first.result.response.body.toString())[1];
  const map = JSON.parse(Buffer.from(dataUrl.split(',')[1], 'base64'));
  assert.equal(map.sourcesContent[0], 'local'); assert.match(map.sources[0], /x_script\.js$/);
  const pcf = fake('https://invented.invalid/native/bundle.js'); await overlay.handle(pcf);
  assert.strictEqual(pcf.result.response.body, mapped.data);
  overlay.replace(imported('zip bytes'));
  const zip = fake('https://invented.invalid/WebResources/x_script.js'); await overlay.handle(zip);
  assert.equal(zip.result.response.body.toString(), 'zip bytes');
});

test('debugger maps remain bounded for newline-heavy scripts and the aggregate map catalogue', async () => {
  const next = imported('local');
  const asset = next.assets.get('/_apps/resources/script');
  asset.file = path.join(os.tmpdir(), 'invented-newlines.js'); asset.data = Buffer.alloc(2 * 1024 * 1024, 10);
  const overlay = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: next });
  const route = fake('https://invented.invalid/WebResources/x_script.js'); await overlay.handle(route);
  assert.strictEqual(route.result.response.body, asset.data);
  assert.ok(overlay.report().diagnostics.some(item => item.code === 'MODEL_SOURCE_MAP_LIMIT' && item.name === 'x_script.js'));
  const small = imported('small');
  for (const item of small.assets.values()) item.file = path.join(os.tmpdir(), 'invented.js');
  const limited = createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: small, sourceMapLimits: { totalBytes: 700 } });
  assert.equal(limited.report().diagnostics.filter(item => item.code === 'MODEL_SOURCE_MAP_LIMIT').length, 1);
  const admitted = fake('https://invented.invalid/WebResources/x_script.js'); await limited.handle(admitted);
  assert.match(admitted.result.response.body.toString(), /sourceMappingURL=data:/);
  for (const sourceMapLimits of [{ totalBytes: 0 }, { assetBytes: 17 * 1024 * 1024 }, { unknown: 2 }]) assert.throws(() => createModelDrivenOverlay({ origin: 'https://invented.invalid', imported: small, sourceMapLimits }), /debugger map limit/);
});

test('save bursts coalesce to the latest queued import and closing drops the pending import', async () => {
  let runs = 0, concurrent = 0, peak = 0, release;
  const queue = modelDrivenReloadQueue(async () => {
    runs++; peak = Math.max(peak, ++concurrent);
    if (runs === 1) await new Promise(resolve => { release = resolve; });
    concurrent--;
  });
  const first = queue.request(); await Promise.resolve();
  for (let i = 0; i < 10000; i++) queue.request();
  release(); await first;
  assert.equal(runs, 2); assert.equal(peak, 1);
  await queue.close(); await queue.request(); assert.equal(runs, 2);
  let finish, closedRuns = 0;
  const closing = modelDrivenReloadQueue(async () => { closedRuns++; await new Promise(resolve => { finish = resolve; }); });
  closing.request(); await Promise.resolve(); closing.request();
  const stopped = closing.close(); finish(); await stopped;
  assert.equal(closedRuns, 1);
});

test('local-source refresh issues GET navigation and preserves app fragments without POST replay', async () => {
  const visits = [];
  const page = { isClosed: () => false, url: () => 'https://invented.invalid/main.aspx?appid=local#route',
    goto: async (url, options) => visits.push({ url, options }), reload: () => assert.fail('reload could replay POST') };
  assert.equal(await refreshModelDrivenPage(page, 'https://invented.invalid'), true);
  const url = new URL(visits[0].url);
  assert.equal(url.pathname, '/main.aspx'); assert.equal(url.searchParams.get('appid'), 'local'); assert.equal(url.hash, '#route');
  assert.ok(url.searchParams.has('paqvilo')); assert.equal(visits[0].options.timeout, 15000);
  assert.equal(await refreshModelDrivenPage(page, 'https://other.invalid'), false);
  assert.equal(await refreshModelDrivenPage({ ...page, isClosed: () => true }, 'https://invented.invalid'), false);
  assert.equal(visits.length, 1);
});
