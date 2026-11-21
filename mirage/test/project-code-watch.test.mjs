// @test-kind contract: a served runtime names and ends project code that never returns, and survives an error project code throws outside a request
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  designedWait,
  guardProjectCodeFaults,
  onProjectCodeFault,
  projectCode,
  projectCodeOrigin,
  stalledMessage,
} from '../lib/project-code-watch.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const WATCH = pathToFileURL(fileURLToPath(new URL('../lib/project-code-watch.mjs', import.meta.url))).href;
const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** An error as V8 reports one thrown at `frames` (innermost first). */
function thrownAt(message, frames) {
  const error = new Error(message);
  error.stack = `Error: ${message}\n${frames.map((frame) => `    at ${frame}`).join('\n')}`;
  return error;
}

test('an error is project code when its innermost file frame is outside the toolkit', () => {
  const project = path.join(os.tmpdir(), 'invented-project', 'pack', 'plugins.mjs');
  assert.deepEqual(
    projectCodeOrigin(
      thrownAt('late', [
        `Timeout._onTimeout (${pathToFileURL(project).href}:13:9)`,
        'listOnTimeout (node:internal/timers:605:17)',
      ]),
      TOOLKIT,
    ),
    { file: project, line: 13 },
  );
  // Frames without a file (Node's internals) are passed over on the way to the first file.
  assert.deepEqual(
    projectCodeOrigin(
      thrownAt('late', ['process.processTimers (node:internal/timers:541:7)', `${project}:4:1`]),
      TOOLKIT,
    ),
    { file: project, line: 4 },
  );
  assert.equal(
    projectCodeOrigin(
      thrownAt('toolkit', [`reload (${pathToFileURL(path.join(TOOLKIT, 'mirage', 'server.mjs')).href}:10:3)`]),
      TOOLKIT,
    ),
    null,
  );
  assert.equal(
    projectCodeOrigin(
      thrownAt('installed toolkit', [
        `run (${pathToFileURL(path.join(os.tmpdir(), 'p', 'node_modules', 'paqvilo', 'mirage', 'server.mjs')).href}:1:1)`,
      ]),
      TOOLKIT,
    ),
    null,
  );
  assert.equal(projectCodeOrigin('a thrown string', TOOLKIT), null);
  assert.equal(projectCodeOrigin(thrownAt('internal only', ['node:internal/timers:605:17']), TOOLKIT), null);
});

test('an uncaught error of project code becomes a diagnostic and is not fatal; any other uncaught error is', (t) => {
  const target = new EventEmitter();
  const reported = [];
  const fatal = [];
  const release = guardProjectCodeFaults({
    target,
    toolkitRoot: TOOLKIT,
    report: (diagnostic) => reported.push(diagnostic),
    fatal: (error) => fatal.push(error),
  });
  t.after(release);
  const project = path.join(os.tmpdir(), 'invented-project', 'pack', 'plugins.mjs');
  target.emit('uncaughtException', thrownAt('invented late failure', [`${project}:13:9`]));
  target.emit('unhandledRejection', thrownAt('invented rejection', [`${project}:20:3`]));
  assert.deepEqual(
    reported.map(({ code, severity, file, line }) => ({ code, severity, file, line })),
    [
      { code: 'PROJECT_CODE_UNCAUGHT', severity: 'error', file: project, line: 13 },
      { code: 'PROJECT_CODE_UNCAUGHT', severity: 'error', file: project, line: 20 },
    ],
  );
  assert.match(
    reported[0].message,
    /^Uncaught error in project code at .*plugins\.mjs:13, outside any request: invented late failure\./,
  );
  assert.match(reported[1].message, /^Unhandled promise rejection in project code at /);
  assert.deepEqual(fatal, []);
  const own = thrownAt('toolkit failure', [`${path.join(TOOLKIT, 'mirage', 'server.mjs')}:1:1`]);
  target.emit('uncaughtException', own);
  assert.deepEqual(fatal, [own]);
  assert.equal(reported.length, 2);
  release();
  assert.equal(target.listenerCount('uncaughtException'), 0);
  assert.equal(target.listenerCount('unhandledRejection'), 0);
});

test('the guard of a process hands its diagnostic to every runtime that registered for it', (t) => {
  const target = new EventEmitter();
  const seen = [];
  const first = onProjectCodeFault((diagnostic) => seen.push(['first', diagnostic.code]));
  const second = onProjectCodeFault((diagnostic) => seen.push(['second', diagnostic.code]));
  t.mock.method(console, 'error', () => {});
  const release = guardProjectCodeFaults({ target, toolkitRoot: TOOLKIT, fatal: () => assert.fail('not fatal') });
  t.after(() => {
    release();
    first();
    second();
  });
  const project = path.join(os.tmpdir(), 'invented-project', 'pack.mjs');
  target.emit('uncaughtException', thrownAt('late', [`${project}:1:1`]));
  second();
  target.emit('uncaughtException', thrownAt('late again', [`${project}:2:1`]));
  assert.deepEqual(seen, [
    ['first', 'PROJECT_CODE_UNCAUGHT'],
    ['second', 'PROJECT_CODE_UNCAUGHT'],
    ['first', 'PROJECT_CODE_UNCAUGHT'],
  ]);
});

test('without a watch, marked project code and designed waits run as plain calls', () => {
  assert.equal(
    projectCode('invented step', () => designedWait(() => 7)),
    7,
  );
  assert.throws(
    () =>
      projectCode('invented step', () => {
        throw new Error('passes through');
      }),
    /passes through/,
  );
});

/** Runs `body` (module source using `watch`, the imported module) in its own process; resolves its end and stderr. */
async function inProcess(t, body) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-project-code-watch-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'main.mjs');
  await fs.writeFile(file, `import * as watch from ${JSON.stringify(WATCH)};\n${body}\n`);
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const [code, signal] = await once(child, 'exit');
  return { code, signal, stderr, stdout };
}

test('marked project code that never returns is named on standard error and the process ends', async (t) => {
  const { code, signal, stderr, stdout } = await inProcess(
    t,
    `watch.watchProjectCode({ limitMs: 200, intervalMs: 20 });
     console.log('entered');
     watch.projectCode('plug-in step Invented validation (00000000-0000-4000-8000-000000000001)', () => { for (;;) {} });
     console.log('returned');`,
  );
  assert.equal(stdout, 'entered\n', 'the endless section never returned');
  assert.ok(code !== 0 || signal, `the process was ended (code ${code}, signal ${signal})`);
  assert.equal(stderr, stalledMessage('plug-in step Invented validation (00000000-0000-4000-8000-000000000001)', 200));
});

test('a wait the runtime makes by design inside project code is not counted against that code', async (t) => {
  const { code, stderr, stdout } = await inProcess(
    t,
    `watch.watchProjectCode({ limitMs: 200, intervalMs: 20 });
     const flag = new Int32Array(new SharedArrayBuffer(4));
     watch.projectCode('plug-in step with a bridged call', () => {
       // Three times the limit, as one designed wait: a CLR call or a bridged web hook with its own deadline.
       watch.designedWait(() => Atomics.wait(flag, 0, 0, 600));
     });
     console.log('returned');`,
  );
  assert.equal(stderr, '');
  assert.equal(stdout, 'returned\n');
  assert.equal(code, 0);
});

test('project code that returns in time, and code outside any marked section, are left alone', async (t) => {
  const { code, stderr, stdout } = await inProcess(
    t,
    `watch.watchProjectCode({ limitMs: 200, intervalMs: 20 });
     const flag = new Int32Array(new SharedArrayBuffer(4));
     for (let round = 0; round < 5; round += 1) watch.projectCode('quick step', () => Atomics.wait(flag, 0, 0, 60));
     // The main thread is busy far longer than the limit here, but in no project code section.
     Atomics.wait(flag, 0, 0, 600);
     console.log('done');`,
  );
  assert.equal(stderr, '');
  assert.equal(stdout, 'done\n');
  assert.equal(code, 0);
});
