import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));

test('public model-driven Lense overlays native scripts and reloads on source save without native writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lense-app-')); t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const solution = path.join(root, 'solution'), resourceDir = path.join(solution, 'WebResources'); await fs.mkdir(path.join(solution, 'Other'), { recursive: true }); await fs.mkdir(resourceDir);
  await fs.writeFile(path.join(solution, 'Other/Solution.xml'), '<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>');
  await fs.writeFile(path.join(resourceDir, 'x_script.js.data.xml'), '<WebResource><Name>x_script.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/x_script.js</FileName></WebResource>');
  const script = value => `document.querySelector('h1').textContent=${JSON.stringify(value)};fetch('/observed?value='+encodeURIComponent(document.querySelector('h1').textContent));`;
  await fs.writeFile(path.join(resourceDir, 'x_script.js'), script('local first'));
  const project = path.join(root, 'project.yml'); await fs.writeFile(project, 'version: 2\nruntime:\n  kind: model-driven\nmodelDriven:\n  trustedExtensions: true\nsolutions:\n  - id: invented\n    path: ./solution\n');
  const resourceMap = path.join(root, 'resources.json'); await fs.writeFile(resourceMap, JSON.stringify({ version: 1, resources: [{ path: '/%7B123%7D/webresources/x_script.js', resource: 'x_script.js' }] }));
  const seen = []; let mutations = 0;
  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) mutations++;
    if (req.url.startsWith('/observed?')) { seen.push(new URL(req.url, 'http://loopback').searchParams.get('value')); res.end('ok'); return; }
    if (req.url.startsWith('/%7B123%7D/webresources/')) { res.setHeader('content-type', 'text/javascript'); res.end(script('native')); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><h1>Loading</h1><script src="/%7B123%7D/webresources/x_script.js?token=never-log-this"></script>');
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
  assert.equal(await exited, 0, output);
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  assert.ok(report.applied >= 2); assert.equal(report.revision >= 2, true); assert.equal(report.resources[0].name, 'x_script.js');
  assert.equal(JSON.stringify(report).includes('never-log-this'), false); assert.equal(output.includes('never-log-this'), false);
  assert.equal(mutations, 0); assert.equal(seen.includes('native'), false);
});
