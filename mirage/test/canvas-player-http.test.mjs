// @test-kind contract: local Canvas player HTTP admission, capability diagnostics and source-asset routing are Paqvilo-specific policies, not native rendering claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvasHandler } from '../lib/canvas-http.mjs';
import { createCanvasRuntime } from '../lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { readCanvasSource } from '../lib/canvas-source.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { canvasLocalIdentity } from './canvas-player-fixture.mjs';

const closeServer = (server) => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
};

// Serves handler on a loopback port that closes after t; a request the handler does not take is answered 404. Resolves to the origin.
async function serveHandler(t, handler) {
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  return `http://127.0.0.1:${server.address().port}`;
}

// One trusted PCF control in an invented solution, the fixture of test-browser/canvas-pcf.test.mjs without its browser steps.
async function pcfSimulator(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'canvas-pcf-http-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'portal/website.yml':
      'adx_websiteid: 77777777-7777-4777-8777-777777777777\nadx_name: Invented\nadx_enhancedauthorization: 1\n',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedCanvasPcf</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Controls/tst_Invented.Editor/ControlManifest.xml.data.xml':
      '<CustomControl><Name>tst_Invented.Editor</Name></CustomControl>',
    'solution/Controls/tst_Invented.Editor/ControlManifest.xml':
      '<manifest><control namespace="Invented" constructor="Editor" control-type="standard"><property name="Value" usage="bound" of-type="SingleLine.Text"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
    'solution/Controls/tst_Invented.Editor/bundle.js':
      "window.ComponentFramework.registerControl('Invented.Editor',class {init(){}updateView(){}getOutputs(){return {}}destroy(){}});",
    'apps/invented/Src/App.pa.yaml': 'App:\n  Properties:\n    OnStart: =Set(events, 0)\n',
    'apps/invented/Src/Home.pa.yaml':
      'Screens:\n  Home:\n    Children:\n      - Editor:\n          Control: CodeComponent\n          ComponentName: tst_Invented.Editor\n          Properties:\n            Value: ="initial"\n            Width: =250\n            Height: =80\n',
  };
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    stateFile: path.join(root, 'state.json'),
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    canvas: { sources: ['apps/invented'], codeComponents: true },
    initial: canvasLocalIdentity(),
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

// The Canvas player's control resources are same-origin with the apps page, and refuse what the portal route refuses.
test('Canvas PCF resources load from relative apps URLs and refuse what the portal route refuses', async (t) => {
  const sim = await pcfSimulator(t);
  const inventory = await (await fetch(new URL('/_apps/canvas/api/invented', sim.appsUrl))).json();
  const component = inventory.codeComponents.Editor;
  assert.equal(component.admitted, true);
  const [bundle] = component.resources.code;
  assert.equal(component.resources.code.length, 1);
  for (const url of [...component.resources.code, ...component.resources.css]) {
    assert.match(url, /^\/_apps\/canvas\/pcf\//);
    assert.doesNotMatch(url, /^[a-z]+:|__sim-static/i);
  }
  const token = bundle.split('/')[4];
  const declared = await fetch(new URL(bundle, sim.appsUrl));
  assert.equal(declared.status, 200);
  assert.match(declared.headers.get('content-type'), /^text\/javascript/);
  assert.equal(declared.headers.get('x-content-type-options'), 'nosniff');
  const portalBundle = await fetch(new URL(`/__sim-static/pcf/${token}/bundle.js`, sim.url));
  assert.equal(portalBundle.status, 200, 'the portal route still serves a portal page control');
  const probes = {
    traversal: `/${token}/..%2f..%2fpackage.json`,
    unknownToken: `/${'0'.repeat(token.length)}/bundle.js`,
    notDeclared: `/${token}/not-declared.js`,
  };
  for (const [name, probe] of Object.entries(probes)) {
    const canvas = await fetch(new URL(`/_apps/canvas/pcf${probe}`, sim.appsUrl));
    const portal = await fetch(new URL(`/__sim-static/pcf${probe}`, sim.url));
    assert.equal(canvas.status, portal.status, name);
    assert.equal(canvas.status, 404, name);
  }
  const head = await fetch(new URL(bundle, sim.appsUrl), { method: 'HEAD' });
  assert.equal(head.status, 200);
  const post = await fetch(new URL(bundle, sim.appsUrl), { method: 'POST' });
  assert.equal(
    post.status,
    (await fetch(new URL(`/__sim-static/pcf/${token}/bundle.js`, sim.url), { method: 'POST' })).status,
  );
});

// @test-kind security+contract: local GET/inspection is inert; explicit starts require CSRF, bounded inputs and the current source revision before the runtime stub is called.
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
  const url = await serveHandler(t, handler);
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

// Source-coverage levels and bounded-player wording are explicit local inventory contracts; this test never invokes native controls.
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

// @test-kind security+contract: a locally diagnosed name collision is inspected without evaluation and refused before executing an admitted formula; native collision handling is not asserted.
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

// @test-kind security: local archive asset routes expose only admitted image bytes and refuse HTML, traversal and writes under same-origin response headers.
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

test('player page declares an empty icon so the browser does not request favicon.ico', async (t) => {
  const app = {
    uniqueName: 'test',
    source: { app: { name: 'Invented' }, screens: [{ name: 'Home', controls: [] }], formulas: [], diagnostics: [] },
  };
  const handler = createCanvasHandler({
    apps: () => [app],
    csrf: () => 'token',
    principal: () => ({ kind: 'staff', principalId: 'local' }),
    runtime: { existing: () => null, session: async () => ({ observe: async () => ({}) }) },
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const page = await fetch(`http://127.0.0.1:${server.address().port}/_apps/canvas/test`);
  assert.match(await page.text(), /<link rel="icon" href="data:,">/);
});

test('the canvas app list page declares an empty icon so the browser does not request favicon.ico', async (t) => {
  const source = { app: { name: 'Invented' }, screens: [], formulas: [], diagnostics: [] };
  const handler = createCanvasHandler({
    apps: () => [{ uniqueName: 'invented', source }],
    runtime: { existing: () => null },
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const html = await (await fetch(`http://127.0.0.1:${server.address().port}/_apps/canvas/`)).text();
  assert.match(html, /<link rel="icon" href="data:,">/);
});

// A form-posted driver action carries its anti-forgery token as _csrf; the admin token is accepted there only when the host names it.
async function formStart(t, options, token) {
  let starts = 0;
  const app = {
    uniqueName: 'test',
    source: { app: { name: 'Invented' }, screens: [{ name: 'Home', controls: [] }], formulas: [], diagnostics: [] },
  };
  const handler = createCanvasHandler({
    apps: () => [app],
    principal: () => ({ kind: 'staff', principalId: 'local' }),
    runtime: {
      existing: () => null,
      session: async () => {
        starts++;
        return { observe: async () => ({}) };
      },
    },
    ...options,
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/_apps/api/canvas/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'start', _csrf: token }),
    redirect: 'manual',
  });
  return { status: response.status, starts: () => starts };
}

test('the admin token is accepted as a form _csrf only when the host configures it', async (t) => {
  const configured = await formStart(t, { csrf: () => 'token', adminToken: () => 'admin-token' }, 'admin-token');
  assert.equal(configured.status, 303);
  assert.equal(configured.starts(), 1);
  const wrong = await formStart(t, { csrf: () => 'token', adminToken: () => 'admin-token' }, 'wrong');
  assert.equal(wrong.status, 403);
  assert.equal(wrong.starts(), 0);
  const unconfigured = await formStart(t, { csrf: () => 'token' }, '');
  assert.equal(unconfigured.status, 403);
  assert.equal(unconfigured.starts(), 0);
});

test('the canvas start CSRF header is compared exactly and each variant is refused as a wrong token', async (t) => {
  let starts = 0;
  const app = {
    uniqueName: 'test',
    source: { app: { name: 'Invented' }, screens: [{ name: 'Home', controls: [] }], formulas: [], diagnostics: [] },
  };
  const handler = createCanvasHandler({
    apps: () => [app],
    csrf: () => 'token',
    principal: () => ({ kind: 'staff', principalId: 'local' }),
    runtime: {
      existing: () => null,
      session: async () => {
        starts++;
        return { observe: async () => ({ currentScreen: 'Home' }) };
      },
    },
  });
  const origin = await serveHandler(t, handler);
  const url = `${origin}/_apps/api/canvas/test`;
  const start = async (token) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': token },
      body: JSON.stringify({ action: 'start' }),
    });
    return { status: response.status, body: await response.text() };
  };
  const wrong = await start('wrong-token');
  assert.equal(wrong.status, 403);
  for (const token of ['tokenx', 'toke', 'tokem', '']) assert.deepEqual(await start(token), wrong, token);
  assert.equal(starts, 0);
  assert.equal((await start('token')).status, 200);
  assert.equal(starts, 1);
});
