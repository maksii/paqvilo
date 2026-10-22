import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoElements } from './assert-markup.mjs';
import http from 'node:http';
import { createCanvasHandler } from '../lib/canvas-http.mjs';

const source = (name, extra = {}) => ({ app: { name, version: '1.0.0.2', schemaVersion: '3.0' },
  screens: [{ name: 'HomeScreen', controls: [] }, { name: 'DetailScreen', controls: [] }], components: [],
  formulas: [{ owner: 'App', property: 'OnStart', text: '=1', source: 'Src/App.pa.yaml', line: 3 }], dataSources: [], diagnostics: [], ...extra });

async function server(t, apps) {
  const diagnostics = [];
  const handler = createCanvasHandler({ apps: () => apps, diagnostic: item => diagnostics.push(item) });
  const instance = http.createServer((req, res) => {
    if (!handler(req, res)) { res.writeHead(418); res.end('not canvas'); }
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return { url: `http://127.0.0.1:${instance.address().port}`, diagnostics };
}

const sharedHeaders = response => {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
};

test('canvas page of a host without the runtime shows the inventory, its banner and hardened headers', async t => {
  const { url, diagnostics } = await server(t, [{ uniqueName: 'fx_inventedcanvas', source: source('Invented Canvas', {
    diagnostics: [{ code: 'CANVAS_SOURCE_LEGACY_FXYAML', message: 'Retired sources.', source: 'Src/A.fx.yaml' }] }) }]);
  const response = await fetch(url + '/_apps/canvas/fx_inventedcanvas');
  assert.equal(response.status, 200);
  sharedHeaders(response);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  for (const expected of ['Canvas apps are inventoried only on this host; nothing is executed', 'This host does not run canvas apps', 'Invented Canvas', '1.0.0.2', 'HomeScreen', 'DetailScreen', '<dt>Formulas</dt><dd>1</dd>', 'CANVAS_SOURCE_LEGACY_FXYAML'])
    assert.ok(html.includes(expected), expected);
  assert.doesNotMatch(html, /<script/i);
  assert.deepEqual(diagnostics.map(item => item.code), ['CANVAS_HOST_NOT_IMPLEMENTED']);
});

test('canvas page reports its diagnostic once per app, not per page view', async t => {
  const { url, diagnostics } = await server(t, [{ uniqueName: 'fx_inventedcanvas', source: source('Invented Canvas') },
    { uniqueName: 'fx_secondcanvas', source: source('Second Canvas') }]);
  for (const path of ['/_apps/canvas/fx_inventedcanvas', '/_apps/canvas/fx_inventedcanvas', '/_apps/canvas/fx_secondcanvas']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.deepEqual(diagnostics.map(item => [item.code, item.source]), [
    ['CANVAS_HOST_NOT_IMPLEMENTED', 'fx_inventedcanvas'],
    ['CANVAS_HOST_NOT_IMPLEMENTED', 'fx_secondcanvas'],
  ]);
});

test('canvas list and inventory API answer inventory without the runtime and behaviour with it', async t => {
  const { url } = await server(t, [{ uniqueName: 'fx_inventedcanvas', source: source('Invented Canvas') }]);
  const list = await fetch(url + '/_apps/canvas/', { headers: { accept: 'application/json' } });
  sharedHeaders(list);
  assert.deepEqual(await list.json(), { level: 'inventory', reason: 'CANVAS_HOST_NOT_IMPLEMENTED', hosted: false,
    apps: [{ uniqueName: 'fx_inventedcanvas', name: 'Invented Canvas', version: '1.0.0.2', screens: 2, formulas: 1, diagnostics: 0, level: 'inventory' }] });
  const hosted = createCanvasHandler({ apps: () => [{ uniqueName: 'fx_inventedcanvas', source: source('Invented Canvas') }], runtime: { session: async () => { throw new Error('unused'); } } });
  const instance = http.createServer((req, res) => { if (!hosted(req, res)) { res.writeHead(418); res.end(); } });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  const hostedList = await (await fetch(`http://127.0.0.1:${instance.address().port}/_apps/canvas/`, { headers: { accept: 'application/json' } })).json();
  assert.deepEqual([hostedList.level, hostedList.reason, hostedList.apps[0].level], ['behaviour', 'CANVAS_NOT_RENDERED', 'behaviour']);
  const htmlList = await fetch(url + '/_apps/canvas/');
  assert.match(await htmlList.text(), /href="\/_apps\/canvas\/fx_inventedcanvas"/);
  const api = await fetch(url + '/_apps/canvas/api/fx_inventedcanvas');
  assert.equal(api.status, 200);
  sharedHeaders(api);
  const body = await api.json();
  assert.equal(body.level, 'inventory');
  assert.equal(body.uniqueName, 'fx_inventedcanvas');
  assert.deepEqual(body.formulas, source('x').formulas);
});

test('canvas handler answers 404 for unknown apps and 405 for writes', async t => {
  const { url } = await server(t, [{ uniqueName: 'fx_inventedcanvas', source: source('Invented Canvas') }]);
  for (const path of ['/_apps/canvas/fx_missing', '/_apps/canvas/api/fx_missing', '/_apps/canvas/fx_inventedcanvas/extra', '/_apps/canvas/%E0%A4%A']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, 'CanvasAppNotFound');
  }
  const post = await fetch(url + '/_apps/canvas/fx_inventedcanvas', { method: 'POST', body: '{}' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
});

test('canvas handler leaves other paths to the host', async t => {
  const { url } = await server(t, []);
  for (const path of ['/_apps/canvasx', '/_apps/canvasx/app', '/canvas', '/canvas/fx_inventedcanvas', '/_apps/', '/main.aspx']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 418, path);
    await response.text();
  }
});

test('canvas handler escapes app values in HTML', async t => {
  const name = '<script>alert("fx")</script>';
  const { url } = await server(t, [{ uniqueName: 'fx_<b>app', source: source(name, { screens: [{ name: '<img src=x onerror=1>', controls: [] }] }) }]);
  const page = await (await fetch(url + '/_apps/canvas/' + encodeURIComponent('fx_<b>app'))).text();
  assertNoElements(page, ['script', 'img', 'b']);
  assert.ok(page.includes('&lt;script&gt;alert(&quot;fx&quot;)&lt;/script&gt;'));
  const list = await (await fetch(url + '/_apps/canvas/')).text();
  assertNoElements(list, ['script', 'b']);
});
