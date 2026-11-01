import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCanvasHandler } from '../lib/canvas-http.mjs';
import { createCanvasRuntime } from '../lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { readCanvasSource } from '../lib/canvas-source.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';

const closeServer = (server) => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
};

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
  t.after(() => closeServer(server));
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
  app.source.revision = 'new-source';
  const stale = await fetch(`${url}/_apps/api/canvas/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': 'token' },
    body: JSON.stringify({ action: 'select', control: 'OldButton', sourceRevision: 'old-source' }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'CanvasSourceChanged');
  assert.equal(starts, 2, 'a stale browser action cannot start a new source revision');
  const oversized = await fetch(`${url}/_apps/api/canvas/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': 'token' },
    body: JSON.stringify({ action: 'run', formula: 'x'.repeat(65536) }),
  });
  assert.equal(oversized.status, 413);
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
  t.after(() => closeServer(server));
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

test('collision source is inventoried without starting, and real runtime refuses start before OnStart', async (t) => {
  const archive = writeSolutionAssetEntries([
    { name: 'Src/App.pa.yaml', data: Buffer.from('App:\n  Properties:\n    OnStart: =Set(marker, true)\n') },
    {
      name: 'Src/Home.pa.yaml',
      data: Buffer.from('Screens:\n  Home:\n    Children:\n      - Name: { Control: Label }\n'),
    },
    {
      name: 'Src/Other.pa.yaml',
      data: Buffer.from('Screens:\n  Other:\n    Children:\n      - Name: { Control: Label }\n'),
    },
  ]);
  const source = await readCanvasSource({ msapp: archive, name: 'Collision' });
  assert.ok(source.diagnostics.some((entry) => entry.code === 'CANVAS_SOURCE_NAME_COLLISION'));
  const app = { uniqueName: 'collision', source };
  const evaluator = createPowerFxEvaluator();
  let evaluations = 0;
  const evaluate = evaluator.evaluate.bind(evaluator);
  evaluator.evaluate = (...args) => {
    evaluations++;
    return evaluate(...args);
  };
  const evaluateSync = evaluator.evaluateSync.bind(evaluator);
  evaluator.evaluateSync = (...args) => {
    evaluations++;
    return evaluateSync(...args);
  };
  const principal = { kind: 'staff', principalId: 'local' };
  const runtime = createCanvasRuntime({ apps: () => [app], evaluator });
  const handler = createCanvasHandler({ apps: () => [app], runtime, principal: () => principal, csrf: () => 'token' });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const url = `http://127.0.0.1:${server.address().port}`;
  const inventory = await (await fetch(`${url}/_apps/canvas/api/collision`)).json();
  assert.equal(inventory.reason, 'CANVAS_SOURCE_NAME_COLLISION');
  assert.equal(inventory.screens.length, 2);
  assert.equal((await (await fetch(`${url}/_apps/api/canvas/collision`)).json()).started, false);
  assert.equal(runtime.size, 0);
  const result = await fetch(`${url}/_apps/api/canvas/collision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': 'token' },
    body: JSON.stringify({ action: 'start' }),
  });
  assert.equal(result.status, 501);
  assert.equal((await result.json()).error.code, 'CanvasSourceNameCollision');
  assert.equal(runtime.size, 0);
  assert.equal(evaluations, 0);
});

test('canvas archive media is served only through bounded same-origin asset routes', async (t) => {
  const archive = writeSolutionAssetEntries([
    { name: 'Src/Home.pa.yaml', data: Buffer.from('Screens:\n  Home: {}\n') },
    { name: 'Assets/icon.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    { name: 'Assets/Images/nested.jpg', data: Buffer.from([255, 216, 255, 217]) },
    { name: 'Assets/script.html', data: Buffer.from('<script>bad()</script>') },
  ]);
  const source = await readCanvasSource({ msapp: archive, name: 'Media' });
  const app = { uniqueName: 'media', source };
  const handler = createCanvasHandler({ apps: () => [app], runtime: { existing: () => null } });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const url = `http://127.0.0.1:${server.address().port}`;
  const inventory = await (await fetch(`${url}/_apps/canvas/api/media`)).json();
  assert.deepEqual(inventory.assets, {
    'icon.png': '/_apps/canvas/media/assets/icon.png',
    'Images/nested.jpg': '/_apps/canvas/media/assets/Images%2Fnested.jpg',
  });
  assert.doesNotMatch(JSON.stringify(inventory), /137,80,78,71/);
  const image = await fetch(url + inventory.assets['icon.png']);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('content-security-policy'), /img-src 'self'/);
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((await fetch(url + inventory.assets['Images/nested.jpg'])).status, 200);
  assert.equal((await fetch(`${url}/_apps/canvas/media/assets/script.html`)).status, 404);
  assert.equal((await fetch(`${url}/_apps/canvas/media/assets/%2e%2e%2fscript.html`)).status, 404);
  assert.equal((await fetch(`${url}/_apps/canvas/media/assets/icon.png`, { method: 'POST' })).status, 405);
});
