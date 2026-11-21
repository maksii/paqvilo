// @test-kind security: real owned IPC children exercise progress admission, stall termination and output/cancellation bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runNpmAudit } from '../scripts/audit-process.mjs';
import { auditAllProjects, auditedProjects } from '../scripts/audit-dependencies.mjs';

const fixture = fileURLToPath(new URL('./fixtures/audit-progress-child.mjs', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-audit-ipc-'));
fs.writeFileSync(
  path.join(directory, 'package-lock.json'),
  JSON.stringify({ packages: { '': {}, 'node_modules/alpha': {}, 'node_modules/bravo': {} } }),
);
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

async function run(mode, { late = false, signal, abort, throwSend = false, spawnFailure = false } = {}) {
  let now = 0;
  let owned;
  const result = await runNpmAudit(
    process.execPath,
    ['unused-cli', 'audit', '--json'],
    { cwd: directory, timeout: 60_000, maxBuffer: mode === 'overflow' ? 1024 : 8192, signal },
    {
      launch(_cli, _args, options) {
        owned = fork(fixture, [mode], {
          ...options,
          execArgv: [],
          ...(spawnFailure ? { execPath: path.join(directory, 'missing-node') } : {}),
        });
        if (throwSend)
          owned.send = () => {
            throw new Error('Controlled synchronous IPC send failure.');
          };
        owned.on('message', (packet) => {
          if (packet.seq === 9) now = late ? 60_000 : 40_000;
          if (packet.seq === 17) now = 80_000;
          if (abort && packet.type === 'hello') queueMicrotask(abort);
        });
        return owned;
      },
      progressOptions: { clock: { now: () => now }, schedule: () => 0, cancel: () => {} },
    },
  );
  assert.ok(owned.exitCode !== null || owned.signalCode !== null, 'owned process must be reaped before returning');
  assert.equal(owned.stdout.destroyed, true, 'owned output must be drained before returning');
  return result;
}

test('real IPC audit with finite 80s work survives the former 60s whole-process counterfactual', async () => {
  const result = await run('progress');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { fresh: true });
});

test('a silent real IPC load is killed by the scheduled guard before the serial runner starts context two', async () => {
  const root = path.join(directory, 'serial');
  const lock = fs.readFileSync(path.join(directory, 'package-lock.json'));
  for (const project of auditedProjects) {
    const cwd = path.join(root, project);
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"invented-audit-test"}');
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), lock);
    if (project === '.') fs.writeFileSync(path.join(cwd, 'paqvilo-lock.json'), lock);
  }
  let owned;
  let now = 0;
  let scheduled;
  const calls = [];
  const clean = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      dependencies: { prod: 2, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 2 },
    },
  };
  const failed = await auditAllProjects('unused-cli', {
    rootDirectory: root,
    log: () => {},
    error: () => {},
    async runAudit(executable, args, settings) {
      calls.push(settings.cwd);
      if (calls.length > 1) {
        assert.ok(owned.exitCode !== null || owned.signalCode !== null);
        assert.equal(owned.stdout.destroyed, true);
        return { status: 0, stdout: JSON.stringify(clean), stderr: '' };
      }
      return runNpmAudit(executable, args, settings, {
        launch(_cli, _args, options) {
          owned = fork(fixture, ['hold'], { ...options, execArgv: [] });
          owned.on('message', (packet) => {
            if (packet.type === 'work' && packet.kind === 'load' && packet.action === 'start')
              queueMicrotask(() => {
                now = 60_000;
                scheduled();
              });
          });
          return owned;
        },
        progressOptions: {
          clock: { now: () => now },
          schedule: (callback) => {
            scheduled = callback;
            return 0;
          },
          cancel: () => {},
        },
      });
    },
  });
  assert.equal(failed, true);
  assert.equal(calls.length, 10);
});

test('a queued load end at its exact 60s deadline fails and reaps the actual child', async () => {
  const result = await run('progress', { late: true });
  assert.match(result.error.message, /load stalled/);
});

test('fresh stdout cannot replace missing observer evidence and output is capped', async () => {
  const absent = await run('absent');
  assert.match(absent.error.message, /missing fresh observer completion/);
  const overflow = await run('overflow');
  assert.match(overflow.error.message, /output limit/);
  assert.ok(Buffer.byteLength(overflow.stdout) <= 1024);
});

test('cancellation terminates and drains the retained child before returning', async () => {
  const controller = new AbortController();
  const result = await run('cancel', { signal: controller.signal, abort: () => controller.abort() });
  assert.match(result.error.message, /cancelled/);
});

test('pre-configuration cancellation, synchronous send errors and failed launches retain the close barrier', async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = await run('cancel', { signal: controller.signal });
  assert.match(cancelled.error.message, /cancelled/);
  const send = await run('cancel', { throwSend: true });
  assert.match(send.error.message, /synchronous IPC send failure/);
  const launch = await run('cancel', { spawnFailure: true });
  assert.ok(launch.error);
});

test('the actual observer exits when its owning parent disconnects before or after configuration', async () => {
  const npm = path.join(directory, 'invented-npm');
  fs.mkdirSync(path.join(npm, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(npm, 'package.json'), '{"version":"12.2.2"}');
  const cli = path.join(npm, 'bin/npm-cli.js');
  fs.writeFileSync(cli, 'setInterval(() => {}, 1000);');
  for (const configured of [false, true]) {
    const child = fork(cli, [], {
      execArgv: ['--import', new URL('../scripts/audit-observer.mjs', import.meta.url).href],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const drained = Promise.all([once(child.stdout, 'close'), once(child.stderr, 'close')]);
    const closed = Promise.all([exited, drained]).then(([status]) => status);
    child.stdout.resume();
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    await once(child, 'spawn');
    if (configured) {
      const hello = new Promise((resolve) => child.once('message', resolve));
      child.send({ v: 1, nonce: 'a'.repeat(64) });
      const packet = await Promise.race([
        hello,
        closed.then(() => {
          throw new Error(stderr);
        }),
      ]);
      assert.equal(packet.type, 'hello');
    }
    child.disconnect();
    assert.equal(await closed, 1);
    assert.equal(child.stdout.destroyed, true);
  }
});

test('only an observed freshly empty npm bulk request permits the normal link-only null report', async () => {
  const npm = path.join(directory, 'empty-bulk-npm');
  fs.mkdirSync(path.join(npm, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(npm, 'package.json'), '{"version":"12.2.2"}');
  const cli = path.join(npm, 'bin/npm-cli.js');
  for (const emptyRequest of [false, true]) {
    const empty = emptyRequest ? "process.emit('log','silly','audit','bulk request',{});" : '';
    fs.writeFileSync(
      cli,
      `${empty}process.emit('log','silly','audit report',null);process.emit('time','end','command:audit');process.stdout.write('{"fresh":true}');`,
    );
    const result = await runNpmAudit(process.execPath, [cli, 'audit', '--json'], {
      cwd: directory,
      timeout: 60_000,
      maxBuffer: 8192,
    });
    if (emptyRequest) {
      assert.equal(result.error, undefined);
      assert.deepEqual(JSON.parse(result.stdout), { fresh: true });
    } else assert.match(result.error.message, /missing fresh observer completion/);
  }
});
