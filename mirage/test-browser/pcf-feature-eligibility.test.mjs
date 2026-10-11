import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { importCodeComponents, renderCodeComponent } from '../lib/code-components.mjs';

async function closeOwnedResources({ browser, server, root }, phase = () => {}) {
  try {
    phase('closing owned browser');
    await browser?.close();
  } finally {
    try {
      phase('closing owned server connections');
      server?.closeAllConnections();
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      if (root) await fs.rm(root, { recursive: true, force: true });
      phase('owned resources closed');
    }
  }
}

test('PCF required declarations never load a constructor while optional features retain host APIs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-features-'));
  let server, browser;
  t.after(() => closeOwnedResources({ browser, server, root }, phase => t.diagnostic(phase)));
  const unsupported = ['Device.captureAudio', 'Device.captureImage', 'Device.captureVideo', 'Device.getBarcodeValue', 'Device.getCurrentPosition', 'Device.pickFile', 'Utility'];
  const variations = [
    { key: 'RequiredWebAPI', features: [{ name: 'WebAPI', required: 'true' }], eligible: false },
    ...unsupported.map((name, index) => ({ key: `Required${index}`, features: [{ name, required: '1' }], eligible: false })),
    { key: 'Optional', features: [{ name: 'WebAPI', required: 'false' }, ...unsupported.map(name => ({ name, required: '0' })), { name: 'Unqualified.Feature', required: 'false' }], eligible: true },
    { key: 'Undeclared', features: [], eligible: true },
  ];
  for (const { key, features } of variations) {
    const dir = path.join(root, 'Controls', `tst_Synthetic.${key}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'ControlManifest.xml'), `<manifest><control namespace="Synthetic" constructor="${key}" control-type="standard"><feature-usage>${features.map(f => `<uses-feature name="${f.name}" required="${f.required}"/>`).join('')}</feature-usage><resources><code path="bundle.js"/></resources></control></manifest>`);
    await fs.writeFile(path.join(dir, 'ControlManifest.xml.data.xml'), `<CustomControl><Name>tst_Synthetic.${key}</Name></CustomControl>`);
    await fs.writeFile(path.join(dir, 'bundle.js'), `window.bundleCalls.push('${key}'); ComponentFramework.registerControl('Synthetic.${key}', class { constructor() { window.constructorCalls.push('${key}'); } init(c,n,s,el) { window.initCalls.push('${key}'); window.contexts['${key}']=c; el.textContent='${key}'; } updateView() {} getOutputs() { return {}; } destroy() { window.destroyCalls.push('${key}'); } });`);
  }
  const catalog = await importCodeComponents([{ dir: root }]);
  assert.equal(catalog.controls.size, variations.length);
  const diagnostics = [];
  const html = '<!doctype html><html><body><script>window.bundleCalls=[];window.constructorCalls=[];window.initCalls=[];window.destroyCalls=[];window.contexts={};window.shell={getTokenDeferred(){return {done(cb){cb("loopback-fixture");return this;},fail(){return this;}};}};</script>' + variations.map(({ key }) => renderCodeComponent({ name: `tst_Synthetic.${key}`, catalog, portal: {}, mappings: { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid' } }, diagnostic: d => diagnostics.push(d) })).join('') + '</body></html>';
  assert.equal(diagnostics.length, variations.filter(v => !v.eligible).length);
  const host = await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url));
  const assetBodies = new Map(await Promise.all([...catalog.assets].map(async ([url, asset]) => [url, await fs.readFile(asset.file)])));
  const requests = [], apiCalls = [];
  server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/__sim-static/pcf-host.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(host); }
    else if (assetBodies.has(request.url)) { response.setHeader('Content-Type', 'text/javascript'); response.end(assetBodies.get(request.url)); }
    else if (request.url.startsWith('/_api/tst_rows')) { apiCalls.push(request.method); response.setHeader('Content-Type', 'application/json'); response.end('{"value":[{"tst_rowid":"d0000000-0000-4000-8000-000000000001"}]}'); }
    else { response.setHeader('Content-Type', 'text/html'); response.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], external = [], origin = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin + '/')) external.push(request.url()); });
  await page.goto(origin, { timeout: 15000 });
  await page.waitForFunction(() => window.initCalls.length === 2);
  const state = await page.evaluate(async () => {
    const availability = Object.fromEntries(Object.entries(window.contexts).map(([name, c]) => [name, { webAPI: typeof c.webAPI.retrieveMultipleRecords, device: typeof c.device, utility: typeof c.utility, utils: typeof c.utils }]));
    const result = await window.contexts.Optional.webAPI.retrieveMultipleRecords('tst_row');
    document.querySelectorAll('[data-pcf-schema]').forEach(node => node.remove());
    return { bundles: window.bundleCalls, constructors: window.constructorCalls, inits: window.initCalls, availability, result };
  });
  assert.deepEqual(state.bundles.sort(), ['Optional', 'Undeclared']);
  assert.deepEqual(state.constructors.sort(), ['Optional', 'Undeclared']);
  assert.deepEqual(state.inits.sort(), ['Optional', 'Undeclared']);
  for (const item of Object.values(state.availability)) assert.deepEqual(item, { webAPI: 'function', device: 'undefined', utility: 'undefined', utils: 'undefined' });
  assert.equal(state.result.entities[0].tst_rowid, 'd0000000-0000-4000-8000-000000000001');
  assert.deepEqual(apiCalls, ['GET']);
  const deniedUrls = variations.filter(v => !v.eligible).flatMap(v => catalog.controls.get(`tst_Synthetic.${v.key}`).resources.map(r => r.url));
  assert.ok(deniedUrls.every(url => !requests.includes(url)));
  await page.waitForFunction(() => window.destroyCalls.length === 2);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  t.diagnostic('feature, API and error assertions completed');
});

test('PCF feature fixture closes the browser before its server and releases active owned responses after browser close failures', { timeout: 5000 }, async t => {
  for (const failBrowser of [false, true]) {
    const order = [];
    const server = http.createServer((_request, response) => { response.writeHead(200); response.write('held response'); });
    let request;
    t.after(async () => { request?.destroy(); await closeOwnedResources({ server }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await new Promise((resolve, reject) => {
      request = http.get(`http://127.0.0.1:${server.address().port}`, { agent: false }, resolve);
      request.on('error', reject);
    });
    response.on('error', () => {});
    const clientClosed = new Promise(resolve => response.once('close', resolve));
    server.once('close', () => order.push('server'));
    const failure = new Error('Invented browser close failure');
    const browser = { async close() { assert.equal(server.listening, true); order.push('browser'); if (failBrowser) throw failure; } };
    if (failBrowser) await assert.rejects(closeOwnedResources({ browser, server }), error => error === failure);
    else await closeOwnedResources({ browser, server });
    await clientClosed;
    assert.deepEqual(order, ['browser', 'server']);
    assert.equal(server.listening, false);
    assert.equal(response.destroyed, true);
  }
});
