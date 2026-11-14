// @test-kind contract: the setup page reports each source folder's Git state from Git's answers, and a command Git did not answer as its own state.
import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { sourceStatus } from '../lense/setup/store.mjs';

// Hang guard only: the real Git commands below are not raced against the setup page's display deadline.
const GIT_HANG_GUARD_MS = 170_000;

const run = promisify(execFile);
async function fixture(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-source-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const exited = (code, stderr = '') => Object.assign(new Error(`git exited ${code}`), { code, stderr });
test('setup scopes changes to each site folder in a shared committed repository', async (t) => {
  const root = await fixture(t);
  for (const site of ['one', 'two']) {
    await fs.mkdir(path.join(root, site));
    await fs.writeFile(path.join(root, site, 'page.txt'), 'original');
  }
  // The fixture repository must not depend on the caller's Git environment, hooks or signing configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (args) =>
    run('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env, windowsHide: true });
  await git(['init']);
  const unborn = await sourceStatus(root, { gitDeadlineMs: GIT_HANG_GUARD_MS });
  assert.equal(unborn.gitState, 'uncommitted', 'real Git exits 1 for HEAD before the first commit');
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
  await fs.writeFile(path.join(root, 'one', 'page.txt'), 'changed');
  const gitQueues = new Map();
  const [one, two] = await Promise.all(
    ['one', 'two'].map((site) => sourceStatus(path.join(root, site), { gitQueues, gitDeadlineMs: GIT_HANG_GUARD_MS })),
  );
  assert.equal(one.gitState, 'ready');
  assert.equal(one.git.changed, true);
  assert.equal(two.git.changed, false);
  assert.equal(one.git.commit, two.git.commit);
});
test('setup retains committed identity on status timeout and distinguishes non-checkouts', async (t) => {
  const root = await fixture(t);
  const answers = (args) => {
    if (args.includes('--show-toplevel')) return `${root}\n`;
    return args.includes('--abbrev-ref') ? 'main\n' : 'abcdef\n';
  };
  const timed = await sourceStatus(root, {
    runGit: async (_command, args) => {
      if (args.includes('status')) throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
      return { stdout: answers(args) };
    },
  });
  assert.equal(timed.gitState, 'timeout');
  assert.equal(timed.git.branch, 'main');
  assert.equal(timed.git.commit, 'abcdef');
  assert.equal(timed.git.changed, null);
  // Git's message is English only under the C locale the command runs with; any other locale is not recognised.
  const absent = await sourceStatus(root, {
    runGit: async (_command, _args, options) => {
      throw exited(
        128,
        options.env.LC_ALL === 'C' ? 'fatal: not a git repository' : 'Schwerwiegend: Kein Git-Repository',
      );
    },
  });
  assert.equal(absent.gitState, 'not-checkout');
  assert.equal(absent.git, null);
});
test('setup tells an unborn repository, a failed Git and a Git that gave no answer apart', async (t) => {
  const root = await fixture(t);
  const state = (fail) =>
    sourceStatus(root, {
      runGit: async (_command, args) => {
        const error = fail(args);
        if (error) throw error;
        return { stdout: args.includes('--show-toplevel') ? `${root}\n` : 'main\n' };
      },
    }).then((status) => [status.gitState, status.git]);
  // `rev-parse --verify --quiet HEAD` exits 1 without a message before the first commit.
  assert.deepEqual(await state((args) => args.includes('--verify') && exited(1)), ['uncommitted', null]);
  // Exit 128 for another reason than a missing repository is a failure, not a non-checkout.
  assert.deepEqual(await state((args) => args.includes('--show-toplevel') && exited(128, 'fatal: unsafe repository')), [
    'unavailable',
    null,
  ]);
  // No answer: Git was not started, or was killed at the deadline. Neither is "not a checkout" or "uncommitted",
  // even when the error carries a message that would otherwise match.
  const noAnswer = [
    [Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', stderr: 'not a git repository' }), 'unavailable'],
    [
      Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', stderr: 'not a git repository' }),
      'timeout',
    ],
  ];
  for (const [error, expected] of noAnswer) {
    assert.deepEqual(await state((args) => args.includes('--show-toplevel') && error), [expected, null]);
    assert.deepEqual(await state((args) => args.includes('--verify') && error), [expected, null]);
  }
});
