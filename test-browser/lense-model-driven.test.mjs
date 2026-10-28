import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { SourceMap } from 'node:module';
import { createModelDrivenOverlay, readModelDrivenResourceMap } from '../lense/model-driven.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { refreshModelDrivenPage } from '../lense/commands/model-driven.mjs';
import { readDiscovery } from '../lense/commands/agent.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
// Bound for one awaited CLI signal (an observation or output line); the session itself
// runs until the test stops it through its agent API.
const SIGNAL_TIMEOUT_MS = 30_000;

// Releases this test's interception and context before its loopback server and keep-alive sockets.
function ownBrowserResources(t, server, owned) {
  ownedFixture(t).add(async () => {
    await owned.release?.();
  });
  ownedFixture(t).add(async () => {
    await owned.context?.close();
  });
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
}
const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
let browser;
before(async () => {
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true });
});
after(() => browser?.close());

test(
  'an original-source breakpoint resolved through an explicitly served compiled sidecar binds and pauses',
  { timeout: 15000 },
  async (t) => {
    const owner = ownedFixture(t),
      root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-compiled-map-'));
    let context, release, cdp;
    owner.add(() => cdp?.detach());
    owner.add(() => release?.());
    owner.add(() => context?.close());
    owner.remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const original = 'export function answer(): number {\n  return 42;\n}',
      compiled = 'globalThis.compiledAnswer = function(){\n  return 42;\n};\n//# sourceMappingURL=bundle.js.map',
      payload = {
        version: 3,
        sources: ['src/original.ts'],
        sourcesContent: [original],
        names: [],
        mappings: 'AAAA;AACA;AACA',
      },
      file = path.join(root, 'bundle.js'),
      mappingFile = path.join(root, 'map.json');
    await fs.writeFile(file, compiled);
    await fs.writeFile(path.join(root, 'bundle.js.map'), JSON.stringify(payload));
    await fs.writeFile(
      mappingFile,
      JSON.stringify({
        version: 1,
        resources: [
          {
            path: '/WebResources/bundle.js',
            resource: 'bundle.js',
            sourceMap: { path: '/WebResources/bundle.js.map', file: 'bundle.js.map' },
          },
        ],
      }),
    );
    const server = http.createServer((_request, response) =>
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><script src="/WebResources/bundle.js"></script>'),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    owner.add(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    context = await browser.newContext();
    const page = await context.newPage(),
      imported = {
        resources: [{ name: 'bundle.js' }],
        diagnostics: [],
        assets: new Map([
          ['bundle', { name: 'bundle.js', file, data: Buffer.from(compiled), mime: 'text/javascript' }],
        ]),
      };
    const overlay = createModelDrivenOverlay({
      origin,
      imported,
      mappings: await readModelDrivenResourceMap(mappingFile, { assets: imported.assets }),
    });
    release = await interceptOrigin(context, origin, (route) => overlay.handle(route));
    cdp = await context.newCDPSession(page);
    const pauses = [];
    await cdp.send('Debugger.enable');
    cdp.on('Debugger.paused', (event) => {
      pauses.push(event);
      cdp.send('Debugger.resume').catch(() => {});
    });
    await page.goto(origin);
    const served = await page.evaluate(() => fetch('/WebResources/bundle.js.map').then((response) => response.json()));
    assert.equal(served.sourcesContent[0], original);
    const map = new SourceMap(served),
      requested = { source: 'src/original.ts', line: 1, column: 0 };
    const binding = compiled
      .split('\n')
      .map((_, line) => map.findEntry(line, 0))
      .find(
        (entry) =>
          entry.originalSource === requested.source &&
          entry.originalLine === requested.line &&
          entry.originalColumn === requested.column,
      );
    assert.ok(binding, 'the requested original-source line has a generated location');
    const breakpoint = await cdp.send('Debugger.setBreakpointByUrl', {
      url: origin + '/WebResources/bundle.js',
      lineNumber: binding.generatedLine,
      columnNumber: binding.generatedColumn,
    });
    assert.equal(breakpoint.locations.length, 1);
    assert.equal(await page.evaluate(() => globalThis.compiledAnswer()), 42);
    assert.equal(pauses.length, 1);
    const paused = pauses[0].callFrames[0].location;
    assert.equal(map.findEntry(paused.lineNumber, paused.columnNumber).originalLine, requested.line);
  },
);

test(
  'model-driven overlay refresh bypasses an existing worker only in its owned tab and restores it on release',
  { timeout: 30000 },
  async (t) => {
    const worker = `self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', event => { if (new URL(event.request.url).pathname === '/WebResources/x_cached.js')
      event.respondWith(new Response('window.cachedAsset = "native-worker"', { headers: { 'content-type': 'text/javascript' } })); });`;
    const server = http.createServer((request, response) => {
      if (request.url === '/worker.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end(worker);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        request.url.startsWith('/main.aspx')
          ? '<!doctype html><script src="/WebResources/x_cached.js"></script>'
          : '<!doctype html>Worker registration fixture',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const owned = {};
    ownBrowserResources(t, server, owned);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = (owned.context = await browser.newContext());
    const page = await context.newPage();
    await page.goto(origin + '/register');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/worker.js');
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.goto(origin + '/main.aspx');
    assert.equal(await page.evaluate(() => window.cachedAsset), 'native-worker');
    const sibling = await context.newPage();
    await sibling.goto(origin + '/main.aspx');
    const imported = (value) => ({
      resources: [{ name: 'x_cached.js' }],
      diagnostics: [],
      assets: new Map([
        [
          'x_cached.js',
          {
            name: 'x_cached.js',
            mime: 'text/javascript',
            data: Buffer.from(`window.cachedAsset = ${JSON.stringify(value)}`),
          },
        ],
      ]),
    });
    const overlay = createModelDrivenOverlay({ origin, imported: imported('local first') });
    owned.release = await interceptOrigin(context, origin, (route) => overlay.handle(route), {
      ownsPage: (candidate) => candidate === page,
    });
    await refreshModelDrivenPage(page, origin);
    assert.equal(await page.evaluate(() => window.cachedAsset), 'local first');
    overlay.replace(imported('local changed'));
    await refreshModelDrivenPage(page, origin);
    assert.equal(await page.evaluate(() => window.cachedAsset), 'local changed');
    assert.equal(overlay.report().currentRevisionApplied, 1);
    await sibling.goto(origin + '/main.aspx?unowned');
    assert.equal(await sibling.evaluate(() => window.cachedAsset), 'native-worker');
    assert.equal(
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
      1,
      'the worker remains registered',
    );
    await owned.release();
    owned.release = null;
    await page.goto(origin + '/main.aspx?released');
    assert.equal(await page.evaluate(() => window.cachedAsset), 'native-worker');
  },
);

test(
  'model-driven local scripts publish file debugger maps and hit an executable source breakpoint',
  { timeout: 30000 },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'lense-app-debug-'));
    const file = path.join(root, 'x_debug.js');
    const source =
      'globalThis.modelDrivenProof = function () {\n  globalThis.modelDrivenRan = true;\n};\nglobalThis.modelDrivenProof();';
    await fs.writeFile(file, source);
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><script src="/WebResources/x_debug.js"></script>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const owned = {};
    ownBrowserResources(t, server, owned);
    ownedFixture(t).remove(async () => {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = (owned.context = await browser.newContext({ serviceWorkers: 'block' }));
    const page = await context.newPage();
    const overlay = createModelDrivenOverlay({
      origin,
      imported: {
        resources: [{ name: 'x_debug.js' }],
        diagnostics: [],
        assets: new Map([['local', { name: 'x_debug.js', file, data: Buffer.from(source), mime: 'text/javascript' }]]),
      },
    });
    owned.release = await interceptOrigin(context, origin, (route) => overlay.handle(route), {
      ownsPage: (candidate) => candidate === page,
    });
    const cdp = await context.newCDPSession(page),
      scripts = [],
      pauses = [];
    cdp.on('Debugger.scriptParsed', (event) => {
      if (event.url === `${origin}/WebResources/x_debug.js`) scripts.push(event);
    });
    cdp.on('Debugger.paused', (event) => {
      pauses.push(event);
      cdp.send('Debugger.resume').catch(() => {});
    });
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.setBreakpointByUrl', { url: `${origin}/WebResources/x_debug.js`, lineNumber: 1 });
    await page.goto(`${origin}/main.aspx`, { waitUntil: 'load' });
    assert.equal(await page.evaluate(() => globalThis.modelDrivenRan), true);
    assert.equal(scripts.length, 1);
    assert.equal(pauses.length, 1);
    assert.equal(pauses[0].callFrames[0].location.lineNumber, 1);
    const map = JSON.parse(Buffer.from(scripts[0].sourceMapURL.split(',')[1], 'base64'));
    assert.equal(fileURLToPath(map.sources[0]), file);
    assert.equal(map.sourcesContent[0], source);
    assert.equal(overlay.report().currentRevisionApplied, 1);
    await cdp.detach();
  },
);

test(
  'public model-driven Lense overlays native scripts and reloads on source save without native writes',
  { timeout: 90_000 },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'lense-app-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const solution = path.join(root, 'solution'),
      resourceDir = path.join(solution, 'WebResources');
    await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
    await fs.mkdir(resourceDir);
    await fs.writeFile(
      path.join(solution, 'Other/Solution.xml'),
      '<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    );
    await fs.writeFile(
      path.join(resourceDir, 'x_script.js.data.xml'),
      '<WebResource><Name>x_script.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/x_script.js</FileName></WebResource>',
    );
    // Each execution reports its value and the native path it was requested from.
    const script = (value) =>
      `document.querySelector('h1').textContent=${JSON.stringify(value)};fetch('/observed?value='+encodeURIComponent(document.querySelector('h1').textContent)+'&src='+encodeURIComponent(new URL(document.currentScript.src).pathname));`;
    await fs.writeFile(path.join(resourceDir, 'x_script.js'), script('local first'));
    const project = path.join(root, 'project.yml');
    await fs.writeFile(
      project,
      'version: 2\nruntime:\n  kind: model-driven\nmodelDriven:\n  trustedExtensions: true\nsolutions:\n  - id: invented\n    path: ./solution\n',
    );
    // Explicit maps remain watched even inside a directory otherwise ignored by
    // Solution discovery (the normal home of project observation files).
    await fs.mkdir(path.join(solution, '.paqvilo'));
    const resourceMap = path.join(solution, '.paqvilo/resources.json');
    await fs.writeFile(
      resourceMap,
      JSON.stringify({
        version: 1,
        resources: [{ path: '/%7B123%7D/webresources/x_script.js', resource: 'x_script.js' }],
      }),
    );
    let nativeResourcePath = '/%7B123%7D/webresources/x_script.js';
    const seen = [];
    const observations = new EventEmitter();
    let mutations = 0;
    // The initial document is held while a source edit is saved, so that edit lands
    // deterministically during startup (document navigation), after the watcher is ready.
    let documentRequested, releaseDocument;
    const firstDocument = new Promise((resolve) => {
      documentRequested = resolve;
    });
    const documentGate = new Promise((resolve) => {
      releaseDocument = resolve;
    });
    let documents = 0;
    const server = http.createServer(async (req, res) => {
      if (!['GET', 'HEAD'].includes(req.method)) mutations++;
      if (req.url === '/long-poll') return;
      if (req.url === '/worker.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' }).end('postMessage("ready");');
        return;
      }
      if (req.url.startsWith('/observed?')) {
        const query = new URL(req.url, 'http://loopback').searchParams;
        seen.push({ value: query.get('value'), src: query.get('src') });
        observations.emit('seen');
        res.end('ok');
        return;
      }
      if (req.url.startsWith(nativeResourcePath)) {
        res.setHeader('content-type', 'text/javascript');
        res.end(script('native'));
        return;
      }
      if (++documents === 1) {
        documentRequested();
        await documentGate;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><h1>Loading</h1><script src="${nativeResourcePath}?token=never-log-this"></script><script>new Worker('/worker.js');fetch('/long-poll');</script>`,
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ownedFixture(t).add(() => {
      releaseDocument();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const origin = `http://127.0.0.1:${server.address().port}`,
      reportFile = path.join(root, 'report.json');
    const child = spawn(
      process.execPath,
      [
        cli,
        'lense',
        'model-driven',
        'dev',
        '--project',
        project,
        '--url',
        origin,
        '--resource-map',
        resourceMap,
        '--browser',
        'chromium',
        '--headless',
        '--output',
        reportFile,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    const printed = new EventEmitter();
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        output += data;
        printed.emit('data');
      });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    const closed = new Promise((resolve) => child.once('close', resolve));
    ownedFixture(t).add(async () => {
      if (!child.killed && child.exitCode === null && child.signalCode === null)
        assert.ok(child.kill(), 'Owned Lense process termination must be accepted');
      await closed;
    });
    // Wait for a real signal (an observation request or CLI output); an exit fails at once.
    const until = async (ready, emitter, event, label) => {
      const signal = AbortSignal.timeout(SIGNAL_TIMEOUT_MS);
      while (!ready()) {
        const next = await Promise.race([
          once(emitter, event, { signal }).then(
            () => 'next',
            () => 'timeout',
          ),
          exited.then(() => 'exited'),
        ]);
        if (next !== 'next' && !ready()) assert.fail(`${label} (${next}): ${output}`);
      }
    };
    const observed = (value, src) =>
      until(() => seen.some((entry) => entry.value === value && entry.src === src), observations, 'seen', value);
    const initialPath = nativeResourcePath;
    await firstDocument;
    // Startup edit: saved while the initial document is still outstanding.
    await fs.writeFile(path.join(resourceDir, 'x_script.js'), script('local during startup'));
    releaseDocument();
    await observed('local during startup', initialPath);
    await until(() => /Model-driven overlay installed; document loaded/.test(output), printed, 'data', 'startup end');
    // Post-startup edits run only after startup ended and local application was observed.
    await fs.writeFile(path.join(resourceDir, 'x_script.js'), script('local changed'));
    await observed('local changed', initialPath);
    nativeResourcePath = '/native-client/x_script.js';
    await fs.writeFile(
      resourceMap,
      JSON.stringify({ version: 1, resources: [{ path: nativeResourcePath, resource: 'x_script.js' }] }),
    );
    // Only a reloaded explicit map overlays the new native path; otherwise it serves 'native'.
    await observed('local changed', nativeResourcePath);
    const discoveryFile = /Model-driven agent API: (.+\.json)/.exec(output)?.[1].trim();
    assert.ok(discoveryFile, 'the dev session advertises its agent API');
    const discovery = await readDiscovery(discoveryFile);
    const stopping = await fetch(discovery.endpoint + '/v1/stop', {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(stopping.status, 200);
    // 'exit' can precede the last stdout chunks; 'close' fires once both pipes are drained.
    const code = await exited;
    await closed;
    assert.equal(code, 0, output);
    assert.match(output, /startup\s+configuration/);
    assert.match(output, /startup\s+source discovery and Solution resources/);
    assert.match(output, /startup\s+document navigation/);
    assert.match(output, /startup\s+page resources/);
    // A watched reload may keep initial resource settling pending until this
    // bounded session ends. Both progress and settled states must avoid claiming
    // sign-in or application readiness from an installed resource overlay.
    assert.match(output, /(?:Sign-in and native application readiness remain|application readiness is) unverified/);
    assert.doesNotMatch(output, /Model-driven overlay ready\.|application and initial view usable/);
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    assert.ok(report.applied >= 3);
    assert.equal(report.revision >= 3, true);
    assert.equal(report.resources[0].name, 'x_script.js');
    assert.ok(report.resources[0].paths.includes(nativeResourcePath));
    assert.equal(JSON.stringify(report).includes('never-log-this'), false);
    assert.equal(output.includes('never-log-this'), false);
    assert.equal(mutations, 0);
    assert.equal(
      seen.some((entry) => entry.value === 'native'),
      false,
    );
  },
);
