// @test-kind tooling: offline bootstrap Git readiness waits for one bounded child, drains cancellation, and distinguishes missing tools from unanswered probes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GIT_HANG_GUARD_MS } from '../lense/git.mjs';
import {
  GIT_PREREQUISITE_HANG_GUARD_MS,
  probeGitVersion,
  prerequisiteReadiness,
} from '../scripts/ensure-dependencies.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

function gatedCommand() {
  const child = new EventEmitter();
  const calls = [];
  let callback;
  return {
    child,
    calls,
    execute(file, args, options, done) {
      calls.push({ file, args, options });
      callback = done;
      return child;
    },
    answer(error = null, stdout = 'git version invented\n') {
      callback(error, stdout, '');
    },
  };
}

test('readiness awaits the asynchronous Git answer and its child close exactly once', async () => {
  const command = gatedCommand();
  let settled = false;
  const pending = prerequisiteReadiness({
    probeGit: (options) => probeGitVersion({ ...options, execute: command.execute }),
  });
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, 'an executing probe has not yet established readiness');
  assert.equal(command.calls.length, 1);
  assert.equal(command.calls[0].file, 'git');
  assert.deepEqual(command.calls[0].args, ['--version']);
  assert.equal(command.calls[0].options.timeout, GIT_HANG_GUARD_MS);
  assert.equal(GIT_PREREQUISITE_HANG_GUARD_MS, GIT_HANG_GUARD_MS);
  command.answer();
  await Promise.resolve();
  assert.equal(settled, false, 'the owned child must close before readiness returns');
  command.child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.ready, true);
  assert.equal(result.git.version, 'git version invented');
  assert.equal(result.git.error, null);
  assert.equal(command.calls.length, 1, 'there are no retries');
});

test('an unanswered bounded probe fails closed without claiming Git is missing', async () => {
  const command = gatedCommand();
  const pending = prerequisiteReadiness({
    probeGit: (options) => probeGitVersion({ ...options, execute: command.execute }),
  });
  command.answer(
    Object.assign(new Error('command hang guard expired'), { code: null, killed: true, signal: 'SIGTERM' }),
    '',
  );
  command.child.emit('close', null, 'SIGTERM');
  const result = await pending;
  assert.equal(result.ready, false);
  assert.equal(result.git.ready, false);
  assert.equal(result.git.version, null);
  assert.match(result.git.error, /did not complete.*hang guard expired/);
  assert.doesNotMatch(result.git.error, /not found|not available|PATH/);
  assert.equal(command.calls.length, 1);
});

test('missing Git and an answered nonzero exit remain separate readiness failures', async () => {
  const missing = await prerequisiteReadiness({
    probeGit: async () => ({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
  });
  assert.equal(missing.git.ready, false);
  assert.match(missing.git.error, /not found on PATH/);
  const failed = await prerequisiteReadiness({ probeGit: async () => ({ status: 2 }) });
  assert.equal(failed.git.ready, false);
  assert.match(failed.git.error, /exited with status 2/);
});

test('cancellation drains the one executing child and preserves its reason', async () => {
  const command = gatedCommand();
  const controller = new AbortController();
  const reason = new Error('readiness cancelled');
  const pending = prerequisiteReadiness({
    signal: controller.signal,
    probeGit: (options) => probeGitVersion({ ...options, execute: command.execute }),
  });
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  controller.abort(reason);
  assert.equal(command.calls[0].options.signal, controller.signal);
  command.answer(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }), '');
  await Promise.resolve();
  assert.equal(settled, false, 'cancellation must not abandon the child before close');
  command.child.emit('close', null, 'SIGTERM');
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(command.calls.length, 1);
  await assert.rejects(
    prerequisiteReadiness({
      signal: controller.signal,
      probeGit: () => assert.fail('pre-aborted probe must not start'),
    }),
    (error) => error === reason,
  );
});

test('real child cancellation finishes closing before the Git probe rejects', async (t) => {
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const reason = new Error('cancel executing readiness child');
  let calls = 0;
  let closed = false;
  const pending = probeGitVersion({
    signal: controller.signal,
    execute(file, args, options, callback) {
      calls++;
      assert.equal(file, 'git');
      assert.deepEqual(args, ['--version']);
      const child = execFile(
        process.execPath,
        ['-e', "process.stdin.resume(); process.stdout.write('ready\\n');"],
        options,
        callback,
      );
      child.once('close', () => {
        closed = true;
        started.reject(new Error('Readiness fixture child closed before its startup marker.'));
      });
      child.once('error', started.reject);
      child.stdout.once('data', () => started.resolve(child));
      return child;
    },
  });
  const completed = pending.then(
    () => null,
    (error) => error,
  );
  ownedFixture(t).add(async () => {
    controller.abort(reason);
    await completed;
  });
  const child = await started.promise;
  controller.abort(reason);
  assert.equal(await completed, reason);
  assert.equal(closed, true, 'the process close event precedes cancellation completion');
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(calls, 1);
});

test('the setup probe remains importable from an isolated bootstrap without toolkit dependencies', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-standalone-readiness-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'ensure-dependencies.mjs');
  await fs.copyFile(new URL('../scripts/ensure-dependencies.mjs', import.meta.url), target);
  const bootstrap = await import(pathToFileURL(target).href);
  const result = await bootstrap.prerequisiteReadiness({
    probeGit: async () => ({ status: 0, stdout: 'git version standalone\n' }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.git.version, 'git version standalone');
});
