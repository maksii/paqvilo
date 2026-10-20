import test from 'node:test';
import assert from 'node:assert/strict';
import { startupProgress, waitForStartupPage, readStartupPhases } from '../lense/startup-progress.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('runtime log progress is incremental and bounded without forwarding arbitrary log fields', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-startup-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'startup.log');
  await fs.writeFile(file, 'x'.repeat(40000) + '\n' + JSON.stringify({ type: 'runtime-startup', phase: 'state-restore', elapsedMs: 20, secret: 'never-forward' }) + '\n' + '{"type":"runtime-startup",');
  const first = await readStartupPhases(file);
  assert.deepEqual(first.events, [{ phase: 'state-restore', elapsedMs: 20 }]);
  await fs.appendFile(file, '"phase":"organization","elapsedMs":30}\n' + JSON.stringify({ type: 'runtime-startup', phase: 'untrusted', elapsedMs: 40 }) + '\n');
  const second = await readStartupPhases(file, first.cursor);
  assert.deepEqual(second.events, [{ phase: 'organization', elapsedMs: 30 }]);
  assert.deepEqual((await readStartupPhases(file, second.cursor)).events, []);
});

test('cancelled process ownership checks do not launch Windows subprocess probes', async () => {
  const { processIdentityAsync } = await import('../lense/commands/mirage.mjs');
  assert.equal(await processIdentityAsync(process.pid, { signal: AbortSignal.abort() }), null);
});

test('startup diagnostics begin immediately and retain command-total across phases', () => {
  let time = 100;
  const lines = [], progress = startupProgress({ structured: true, now: () => time, write: line => lines.push(JSON.parse(line)) });
  assert.deepEqual(lines[0], { type: 'startup', status: 'started', phase: 'configuration', totalElapsedMs: 0, phaseElapsedMs: 0 });
  time += 61000; progress.phase('process ownership');
  time += 7000; progress.complete('runtime listening; application pending');
  assert.equal(lines[1].totalElapsedMs, 61000);
  assert.equal(lines[1].phaseElapsedMs, 0);
  assert.equal(lines[2].totalElapsedMs, 68000);
  assert.equal(lines[2].phaseElapsedMs, 7000);
  assert.equal(progress.elapsedMs, 68000);
  progress.phase('ignored');
  assert.equal(lines.length, 3);
});

test('slow startup phases emit bounded heartbeats until closed, independently of phase changes', async () => {
  const lines = [], progress = startupProgress({ intervalMs: 10, write: line => lines.push(line) });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.ok(lines.some(line => line.endsWith('…')), JSON.stringify(lines));
  progress.fail('cancelled during discovery');
  const count = lines.length;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(lines.length, count);
});

test('document navigation cannot complete model-driven startup before application and initial data readiness', async () => {
  let documentReady, applicationReady, finished = false;
  const navigation = new Promise(resolve => { documentReady = resolve; });
  const application = new Promise(resolve => { applicationReady = resolve; });
  const progress = startupProgress({ write() {} });
  const page = { on() {}, off() {}, goto: () => navigation, url: () => 'http://127.0.0.1:1234/main.aspx', waitForFunction: () => application,
    evaluate: async () => ({ state: 'ready' }) };
  const loading = waitForStartupPage(page, page.url(), { progress, modelDriven: true }).then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  documentReady(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.equal(progress.events.at(-1).phase, 'application data');
  applicationReady(); assert.equal(await loading, true);
  assert.equal(progress.events.at(-1).status, 'complete'); assert.equal(progress.events.at(-1).detail, 'application and initial view usable');
});

test('startup surfaces application failures and qualifies sign-in redirects as intermediate document states', async () => {
  const page = { on() {}, off() {}, waitForLoadState: async () => {}, goto: async () => {}, url: () => 'http://127.0.0.1:1234/main.aspx', waitForFunction: async () => {},
    evaluate: async () => ({ state: 'error', message: 'Invented denied initial query' }) };
  await assert.rejects(waitForStartupPage(page, page.url(), { modelDriven: true }), /Application failed to load: Invented denied initial query/);
  const progress = startupProgress({ write() {} });
  page.url = () => 'http://127.0.0.1:1234/signin';
  page.waitForFunction = () => assert.fail('A sign-in document is not a loaded app.');
  assert.equal(await waitForStartupPage(page, page.url(), { progress, modelDriven: true }), true);
  assert.match(progress.events.at(-1).detail, /sign-in and application readiness remain unverified/);
});

for (const phase of ['document', 'application']) test(`startup cancellation during ${phase} wait does not report a usable page`, async () => {
  let stop, release;
  const stopped = new Promise(resolve => { stop = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const progress = startupProgress({ write() {} });
  const page = { on() {}, off() {}, goto: () => phase === 'document' ? pending : Promise.resolve(), url: () => 'http://127.0.0.1:1234/main.aspx',
    waitForFunction: () => pending, evaluate: () => assert.fail('Cancelled startup must not evaluate readiness.') };
  const loading = waitForStartupPage(page, page.url(), { progress, stopped, modelDriven: true });
  await new Promise(resolve => setImmediate(resolve)); stop();
  assert.equal(await loading, false); assert.equal(progress.events.some(event => event.status === 'complete'), false);
  progress.close(); release();
});
