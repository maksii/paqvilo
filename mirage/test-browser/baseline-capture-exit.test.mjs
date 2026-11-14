// @test-kind contract: capture CLI exit status, retained evidence and owned process cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ownedFixture, makeTemporaryDirectory, assertTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { withProcessSlot } from '../test/process-slots.mjs';

function ownedProcess(t, args, { signal = t.signal, trace = () => {} } = {}) {
  trace('spawn-requested');
  const child = spawn(process.execPath, args, {
    windowsHide: true,
    signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.once('spawn', () => trace('spawned', String(child.pid)));
  child.once('exit', (code, reason) => trace('exit', JSON.stringify({ code, reason })));
  child.once('close', (code, reason) => trace('close', JSON.stringify({ code, reason })));
  const collect = (chunk) => {
    output = (output + chunk).slice(-4000);
    trace('output', String(chunk).slice(-300));
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const closed = new Promise((resolve) => child.once('close', resolve));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  ownedFixture(t).add(async () => {
    if (child.pid !== undefined && !child.killed && child.exitCode === null && child.signalCode === null) {
      assert.ok(child.kill(), 'Owned capture process termination must be accepted');
    }
    // 'close' also waits for stdout/stderr to finish, unlike 'exit'.
    await closed;
  });
  return { child, closed, done, output: () => output };
}

async function outputDirectory(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-capture-exit-'));
  ownedFixture(t).remove(async () => {
    const physical = await assertTemporaryDirectory(directory);
    await fs.rm(physical, { recursive: true, force: true });
  });
  return directory;
}

async function captureInputs(t) {
  const dir = await outputDirectory(t);
  const source = path.join(dir, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'website.yml'), 'adx_websiteid: invented-site\nadx_name: Invented\n');
  await fs.writeFile(
    path.join(source, 'Home.webpage.yml'),
    'adx_webpageid: invented-home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\n',
  );
  await fs.writeFile(
    path.join(source, 'Home.webpage.copy.html'),
    '<main><h1 id="present">Invented capture</h1></main>',
  );
  const matrix = path.join(dir, 'matrix.json');
  await fs.writeFile(
    matrix,
    JSON.stringify({
      version: 1,
      personas: { anonymous: { anonymous: true } },
      delayMs: 0,
      scenarios: [
        { id: 'invented/failed', steps: [{ goto: '/' }], expect: { present: ['#absent'] } },
        { id: 'invented/passed', steps: [{ goto: '/' }], expect: { present: ['#present'] } },
        { id: 'invented/error', steps: [{ goto: '/' }, { click: '#absent', timeout: 100 }] },
      ],
    }),
  );
  return { dir, source, matrix };
}

function captureTrace(t) {
  const started = Date.now(),
    events = [];
  const trace = (label, phase, detail = '') => {
    events.push({ elapsedMs: Date.now() - started, label, phase, detail });
    if (events.length > 40) events.shift();
  };
  const onAbort = () => console.error('Invented capture phases: ' + JSON.stringify(events));
  t.signal.addEventListener('abort', onAbort, { once: true });
  t.after(() => t.signal.removeEventListener('abort', onAbort));
  return trace;
}

// One capture is one independent process with its own output directory; it starts when a process slot is free.
async function runCapture(t, { dir, source, matrix }, trace, { label, only }) {
  const script = fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url));
  const out = path.join(dir, label);
  let child = null;
  trace(label, 'queued');
  const code = await withProcessSlot(
    () => {
      trace(label, 'slot-acquired');
      child = ownedProcess(
        t,
        [
          script,
          'capture',
          '--matrix',
          matrix,
          '--source',
          source,
          '--out',
          out,
          '--side',
          'mirage',
          '--label',
          label,
          '--only',
          only,
        ],
        { trace: (phase, detail) => trace(label, phase, detail) },
      );
      return child.done;
    },
    undefined,
    { signal: t.signal },
  );
  return { code, child, out };
}

async function readRun(out, label) {
  return JSON.parse(await fs.readFile(path.join(out, 'run-' + label + '.json'), 'utf8'));
}

test('capture CLI reports failed assertions without losing completed evidence', async (t) => {
  const trace = captureTrace(t);
  const inputs = await captureInputs(t);
  const { code, child, out } = await runCapture(t, inputs, trace, {
    label: 'failed',
    only: 'invented/failed,invented/passed',
  });
  const run = await readRun(out, 'failed');
  assert.equal(code, 1, JSON.stringify({ label: 'failed', totals: run.totals, output: child.output().slice(-1000) }));
  assert.deepEqual(
    run.scenarios.map((item) => item.status),
    ['failed', 'captured'],
  );
  assert.equal(run.totals.failed, 1);
  assert.equal(run.totals.captured, 1);
  const meta = JSON.parse(await fs.readFile(path.join(out, 'invented/failed/failed/meta.json'), 'utf8'));
  assert.equal(meta.status, 'failed');
  assert.ok(meta.problems.some((item) => item.includes('#absent')));
  assert.ok((await fs.readdir(out)).some((name) => name.startsWith('run-failed-')));
});

test('capture CLI exits zero when every selected scenario passes', async (t) => {
  const trace = captureTrace(t);
  const inputs = await captureInputs(t);
  const { code, child, out } = await runCapture(t, inputs, trace, { label: 'passed', only: 'invented/passed' });
  const run = await readRun(out, 'passed');
  assert.equal(code, 0, JSON.stringify({ label: 'passed', totals: run.totals, output: child.output().slice(-1000) }));
});

test('capture CLI exits with the error status for a scenario that cannot run', async (t) => {
  const trace = captureTrace(t);
  const inputs = await captureInputs(t);
  const { code, child, out } = await runCapture(t, inputs, trace, { label: 'error', only: 'invented/error' });
  const run = await readRun(out, 'error');
  assert.equal(code, 2, JSON.stringify({ label: 'error', totals: run.totals, output: child.output().slice(-1000) }));
  assert.equal(run.totals.error, 1);
});

test('aborting an owned capture process drains its pipes before removing output', async (t) => {
  const dir = await outputDirectory(t);
  const controller = new AbortController();
  const child = ownedProcess(t, ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], {
    signal: controller.signal,
  });
  let closed = false;
  child.closed.then(() => {
    closed = true;
  });
  ownedFixture(t).remove(() => assert.ok(closed, 'Output removal must follow owned process close'));
  await once(child.child.stdout, 'data', { signal: t.signal });
  await fs.writeFile(path.join(dir, 'owned-output.txt'), 'invented');
  controller.abort();
  await assert.rejects(child.done, { name: 'AbortError' });
});
