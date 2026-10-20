import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createModelDrivenOverlay } from '../lense/model-driven.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));

test('model-driven local scripts publish file debugger maps and hit an executable source breakpoint', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lense-app-debug-'));
  const file = path.join(root, 'x_debug.js');
  const source = 'globalThis.modelDrivenProof = function () {\n  globalThis.modelDrivenRan = true;\n};\nglobalThis.modelDrivenProof();';
  await fs.writeFile(file, source);
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><script src="/WebResources/x_debug.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, release;
  t.after(async () => {
    await release?.(); await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
  const overlay = createModelDrivenOverlay({ origin, imported: {
    resources: [{ name: 'x_debug.js' }], diagnostics: [],
    assets: new Map([['local', { name: 'x_debug.js', file, data: Buffer.from(source), mime: 'text/javascript' }]]),
  } });
  release = await interceptOrigin(context, origin, route => overlay.handle(route), { ownsPage: candidate => candidate === page });
  const cdp = await context.newCDPSession(page), scripts = [], pauses = [];
  cdp.on('Debugger.scriptParsed', event => { if (event.url === `${origin}/WebResources/x_debug.js`) scripts.push(event); });
  cdp.on('Debugger.paused', event => { pauses.push(event); cdp.send('Debugger.resume').catch(() => {}); });
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.setBreakpointByUrl', { url: `${origin}/WebResources/x_debug.js`, lineNumber: 1 });
  await page.goto(`${origin}/main.aspx`, { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => globalThis.modelDrivenRan), true);
  assert.equal(scripts.length, 1); assert.equal(pauses.length, 1);
  assert.equal(pauses[0].callFrames[0].location.lineNumber, 1);
  const map = JSON.parse(Buffer.from(scripts[0].sourceMapURL.split(',')[1], 'base64'));
  assert.equal(fileURLToPath(map.sources[0]), file); assert.equal(map.sourcesContent[0], source);
  assert.equal(overlay.report().currentRevisionApplied, 1);
  await cdp.detach();
});

test('public model-driven Lense overlays native scripts and reloads on source save without native writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lense-app-')); t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const solution = path.join(root, 'solution'), resourceDir = path.join(solution, 'WebResources'); await fs.mkdir(path.join(solution, 'Other'), { recursive: true }); await fs.mkdir(resourceDir);
  await fs.writeFile(path.join(solution, 'Other/Solution.xml'), '<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>');
  await fs.writeFile(path.join(resourceDir, 'x_script.js.data.xml'), '<WebResource><Name>x_script.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/x_script.js</FileName></WebResource>');
  const script = value => `document.querySelector('h1').textContent=${JSON.stringify(value)};fetch('/observed?value='+encodeURIComponent(document.querySelector('h1').textContent));`;
  await fs.writeFile(path.join(resourceDir, 'x_script.js'), script('local first'));
  const project = path.join(root, 'project.yml'); await fs.writeFile(project, 'version: 2\nruntime:\n  kind: model-driven\nmodelDriven:\n  trustedExtensions: true\nsolutions:\n  - id: invented\n    path: ./solution\n');
  // Explicit maps remain watched even inside a directory otherwise ignored by
  // Solution discovery (the normal home of project observation files).
  await fs.mkdir(path.join(solution, '.paqvilo'));
  const resourceMap = path.join(solution, '.paqvilo/resources.json'); await fs.writeFile(resourceMap, JSON.stringify({ version: 1, resources: [{ path: '/%7B123%7D/webresources/x_script.js', resource: 'x_script.js' }] }));
  let nativeResourcePath = '/%7B123%7D/webresources/x_script.js';
  const seen = []; let mutations = 0;
  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) mutations++;
    if (req.url.startsWith('/observed?')) { seen.push(new URL(req.url, 'http://loopback').searchParams.get('value')); res.end('ok'); return; }
    if (req.url.startsWith(nativeResourcePath)) { res.setHeader('content-type', 'text/javascript'); res.end(script('native')); return; }
    res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><h1>Loading</h1><script src="${nativeResourcePath}?token=never-log-this"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, reportFile = path.join(root, 'report.json');
  const child = spawn(process.execPath, [cli, 'lense', 'model-driven', 'dev', '--project', project, '--url', origin, '--resource-map', resourceMap, '--browser', 'chromium', '--headless', '--timeout', '10000', '--output', reportFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code))); t.after(() => { if (child.exitCode == null) child.kill(); });
  const waitSeen = async value => { const deadline = Date.now() + 15000; while (!seen.includes(value) && Date.now() < deadline && child.exitCode == null) await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(seen.includes(value), `${value} missing: ${output}`); };
  await waitSeen('local first');
  await fs.writeFile(path.join(resourceDir, 'x_script.js'), script('local changed'));
  await waitSeen('local changed');
  const observations = seen.length;
  nativeResourcePath = '/native-client/x_script.js';
  await fs.writeFile(resourceMap, JSON.stringify({ version: 1, resources: [{ path: nativeResourcePath, resource: 'x_script.js' }] }));
  const mapDeadline = Date.now() + 5000;
  while (seen.length === observations && Date.now() < mapDeadline && child.exitCode == null) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(seen.length > observations, `Explicit resource map change did not reload: ${output}`);
  assert.equal(await exited, 0, output);
  assert.match(output, /startup\s+configuration/);
  assert.match(output, /startup\s+source discovery and Solution resources/);
  assert.match(output, /startup\s+document navigation/);
  assert.match(output, /startup\s+page resources/);
  assert.match(output, /Sign-in and native application readiness remain unverified/);
  assert.doesNotMatch(output, /Model-driven overlay ready\.|application and initial view usable/);
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  assert.ok(report.applied >= 3); assert.equal(report.revision >= 3, true); assert.equal(report.resources[0].name, 'x_script.js');
  assert.ok(report.resources[0].paths.includes(nativeResourcePath));
  assert.equal(JSON.stringify(report).includes('never-log-this'), false); assert.equal(output.includes('never-log-this'), false);
  assert.equal(mutations, 0); assert.equal(seen.includes('native'), false);
});
