import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCanvasHandler } from '../lib/canvas-http.mjs';

test('player GET is inert, assets are same-origin and start requires CSRF', async (t) => {
  let starts = 0;
  let launchOptions;
  const app = {
    uniqueName: 'test',
    source: { app: { name: '<unsafe>' }, screens: [{ name: 'Home', controls: [] }], formulas: [], diagnostics: [] },
  };
  const handler = createCanvasHandler({
    apps: () => [app],
    csrf: () => 'token',
    principal: () => ({ kind: 'staff', principalId: 'local' }),
    runtime: {
      existing: () => null,
      session: async (_name, _caller, options) => {
        starts++;
        launchOptions = options;
        return { observe: async () => ({ currentScreen: 'Home' }) };
      },
    },
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${url}/_apps/canvas/test`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  const html = await page.text();
  assert.match(html, /data-testid="canvas-start"/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.equal(starts, 0);
  const asset = await fetch(`${url}/_apps/canvas/_player.js`);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${url}/_apps/api/canvas/test`)).status, 200);
  assert.equal(starts, 0);
  const denied = await fetch(`${url}/_apps/api/canvas/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  });
  assert.equal(denied.status, 403);
  assert.equal(starts, 0);
  const accepted = await fetch(`${url}/_apps/api/canvas/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': 'token' },
    body: JSON.stringify({ action: 'start' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(starts, 1);
  assert.equal(launchOptions.viewport, undefined, 'existing start callers keep the default viewport');
  const mobile = await fetch(`${url}/_apps/api/canvas/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': 'token' },
    body: JSON.stringify({ action: 'start', viewport: { width: 390, height: 844 } }),
  });
  assert.equal(mobile.status, 200);
  assert.deepEqual(launchOptions.viewport, { width: 390, height: 844 });
  const invalid = await fetch(`${url}/_apps/api/canvas/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': 'token' },
    body: JSON.stringify({ action: 'reset', viewport: { width: 0, height: 844 } }),
  });
  assert.equal(invalid.status, 400, 'invalid reset is refused before changing the instance');
  assert.equal(starts, 2);
  const inspect = await (await fetch(`${url}/_apps/canvas/test?view=inspect`)).text();
  assert.match(inspect, /Headless app/);
});

test('partial canvas sources remain playable but list and inventory report incomplete coverage', async (t) => {
  const source = {
    app: { name: 'Partial' },
    screens: [{ name: 'Home', controls: [] }],
    formulas: [],
    diagnostics: [{ code: 'CANVAS_SOURCE_YAML_INVALID', message: 'Invalid screen', source: 'Src/Broken.pa.yaml' }],
  };
  const handler = createCanvasHandler({
    apps: () => [{ uniqueName: 'partial', source }],
    runtime: { existing: () => null },
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${url}/_apps/canvas/`, { headers: { accept: 'application/json' } })).json();
  assert.equal(list.apps[0].level, 'inventory');
  assert.equal(list.apps[0].reason, 'CANVAS_SOURCE_YAML_INVALID');
  const inventory = await (await fetch(`${url}/_apps/canvas/api/partial`)).json();
  assert.equal(inventory.level, 'inventory');
  assert.equal(inventory.reason, 'CANVAS_SOURCE_YAML_INVALID');
  assert.match(await (await fetch(`${url}/_apps/canvas/partial`)).text(), /data-testid="canvas-start"/);
  const html = await (await fetch(`${url}/_apps/canvas/`)).text();
  assert.match(html, /bounded local player/);
  assert.doesNotMatch(html, /Canvas apps are not rendered/);
});
