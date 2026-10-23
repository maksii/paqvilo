import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectRuntime } from '../testing/runtime.mjs';
import { captureThroughRuntime } from '../capture-shell.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

test('capture cleanup is attempted without masking the original timeout', async () => {
  const error = Object.assign(new Error('Capture timeout'), {code: 'SHELL_CAPTURE_TIMEOUT'}), calls = [];
  const client = {liveConnect: async () => calls.push('connect'), captureShell: async () => {throw error;}, liveDisconnect: async () => {calls.push('disconnect'); throw new Error('Cleanup also timed out');}};
  await assert.rejects(captureThroughRuntime(client, 'http://127.0.0.1:9222', '/'), actual => actual === error && actual.disconnectFailed);
  assert.deepEqual(calls, ['connect', 'disconnect']);
});

test('capture has no default deadline, configurable deadlines identify the option, and ordinary calls remain bounded', async () => {
  const client = await connectRuntime({origin: 'http://127.0.0.1:8787', fetchImpl: async (url, options) => {
    if (!url.endsWith('/assets/capture-shell')) { assert.ok(options.signal); return Response.json(url.includes('/state?') ? {csrf: 'synthetic'} : {}); }
    if (!options.signal) return Response.json({applied: true});
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  }});
  assert.equal((await client.captureShell('/')).applied, true);
  // Keep the process alive while AbortSignal.timeout's unreferenced timer runs.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(client.captureShell('/', {timeoutMs: 10}), error => error.code === 'SHELL_CAPTURE_TIMEOUT' && /--timeout.*server may still be working/s.test(error.message)); }
  finally { clearTimeout(keepAlive); }
  await assert.rejects(client.captureShell('/', {timeoutMs: -1}), /timeoutMs must/);
});

test('CLI captures an endpoint taking 45 seconds, prints waiting progress and disconnects', {timeout: 65000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-long-capture-'));
  ownedFixture(t).remove(() => fs.rm(root, {recursive: true, force: true}));
  const sourceDir = path.join(root, 'portal'); await fs.mkdir(sourceDir);
  await fs.mkdir(path.join(sourceDir, 'web-pages'));
  await fs.writeFile(path.join(sourceDir, 'website.yml'), 'adx_name: Synthetic\nadx_websiteid: synthetic\n');
  const calls = [], timers = new Set();
  const server = http.createServer((req, res) => {
    calls.push(req.url); res.setHeader('content-type', 'application/json');
    req.resume();
    if (req.url.endsWith('/status')) return res.end(JSON.stringify({sourceDir}));
    if (req.url.includes('/state?')) return res.end(JSON.stringify({csrf: 'synthetic', config: {live: {origin: 'https://synthetic.example.test'}}, status: {live: {connected: false}}}));
    if (req.url.endsWith('/assets/capture-shell')) {
      const timer = setTimeout(() => { timers.delete(timer); res.end(JSON.stringify({applied: true, ready: true, complete: true, failures: []})); }, 45000);
      timers.add(timer); return;
    }
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(async () => { timers.forEach(clearTimeout); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = path.join(root, 'paqvilo.config.json');
  await fs.writeFile(config, JSON.stringify({sourceRoot: '.', sites: {synthetic: {source: 'portal', environments: {dev: 'https://synthetic.example.test'}, mirage: {port: server.address().port}}}}));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url)), 'mirage', 'capture-shell', '--config', config, '--cdp', 'http://127.0.0.1:9222'], {windowsHide: true});
  ownedFixture(t).add(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout).reports[0];
  assert.equal(report.applied, true); assert.equal(report.ready, true); assert.equal(report.complete, true);
  // Interval callbacks can run either side of a rounded second boundary.
  // Verify recurring, increasing progress while the real long capture waits.
  const progress = [...stderr.matchAll(/still capturing \((\d+) s\)/g)].map(match => Number(match[1]));
  assert.ok(progress.length >= 2, stderr);
  assert.ok(progress.every((seconds, index) => seconds > 0 && seconds < 65 && (!index || seconds > progress[index - 1])), stderr);
  assert.ok(progress.at(-1) >= 25, stderr);
  assert.deepEqual(calls.filter(route => /\/(?:live\/|assets\/capture-shell$)/.test(route)), ['/_sim/api/live/connect', '/_sim/api/assets/capture-shell', '/_sim/api/live/disconnect']);
});
