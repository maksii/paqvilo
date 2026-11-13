// @test-kind tooling: the test helper that ends Mirage runtimes a failed test or a failed stop leaves running
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { isAlive, ownedSessions, processIdentity } from '../lense/commands/mirage.mjs';
import { ownStartedRuntimes } from './helpers/mirage-runtimes.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
);

/** Resolves true when nothing listens on `port` any more: this process can bind it. */
const portFree = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

test('the runtime owner ends a started runtime nobody stopped, and never a process without its start identity', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-runtime-owner-'));
  const project = path.join(directory, 'organization.project.json');
  await fs.writeFile(
    project,
    JSON.stringify({ version: 2, runtime: { kind: 'model-driven' }, simulation: { level: 'dry-run' }, solutions: [] }),
  );
  const mirage = (action, ...args) =>
    execute(process.execPath, [cli, 'mirage', action, '--project', project, ...args, '--json'], {
      cwd: directory,
      env,
      windowsHide: true,
    });
  // The product's own stop is the last resort should the owner under test leave the runtime running.
  ownedFixture(t).add(() => mirage('stop').catch(() => {}));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { stdout } = await mirage('start', '--port', '0');
  // Should a case below fail before its own owner ends the runtime, the test's owner does.
  ownStartedRuntimes(t, stdout);
  const answer = JSON.parse(stdout);
  const ownershipFile = answer.writesFiles.find((file) => file.endsWith(path.join('mirage', 'sessions.json')));
  const recorded = (await ownedSessions({ ownershipFile })).find((entry) => entry.pid === answer.pid).processIdentity;
  const port = Number(new URL(answer.url).port);
  assert.ok(recorded, 'the start recorded the runtime identity');

  const foreign = [];
  await t.test('a PID whose identity is not the recorded one is not signalled, and the owner says so', (st) => {
    const owned = ownStartedRuntimes(st, stdout, {
      identityOf: () => 'an invented identity of another program',
      report: (line) => foreign.push(line),
    });
    assert.deepEqual(
      owned.map((runtime) => runtime.pid),
      [answer.pid],
    );
  });
  assert.equal(foreign.length, 1);
  assert.match(foreign[0], new RegExp(`pid ${answer.pid} .*was not ended`));
  assert.equal(isAlive(answer.pid), true, 'the process was left running');
  assert.equal(processIdentity(answer.pid), recorded);
  assert.equal((await fetch(new URL('/_sim/api/status', answer.url))).status, 200);

  const reports = [];
  await t.test('a started runtime is ended after its test when nothing stopped it', (st) => {
    ownStartedRuntimes(st, stdout, { report: (line) => reports.push(line) });
  });
  assert.deepEqual(reports, []);
  assert.ok(!isAlive(answer.pid) || processIdentity(answer.pid) !== recorded, 'the runtime process has gone');
  assert.equal(await portFree(port), true, 'its port is free');
});

test('the runtime owner leaves a refused or reused start alone', (t) => {
  assert.deepEqual(ownStartedRuntimes(t, '{"error":{"message":"refused"}}'), []);
  assert.deepEqual(ownStartedRuntimes(t, 'not JSON'), []);
  assert.deepEqual(ownStartedRuntimes(t, { pid: 4, started: false, writesFiles: [] }), []);
});
