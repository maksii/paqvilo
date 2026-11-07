import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { sourceStatus } from '../lense/setup/store.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-source-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
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
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
  await fs.writeFile(path.join(root, 'one', 'page.txt'), 'changed');
  const gitQueues = new Map();
  const [one, two] = await Promise.all(
    ['one', 'two'].map((site) => sourceStatus(path.join(root, site), { gitQueues })),
  );
  assert.equal(one.git.changed, true);
  assert.equal(two.git.changed, false);
  assert.equal(one.git.commit, two.git.commit);
});
test('setup retains committed identity on status timeout and distinguishes non-checkouts', async (t) => {
  const root = await fixture(t);
  const timed = await sourceStatus(root, {
    runGit: async (_command, args) => {
      if (args.includes('status')) throw Object.assign(new Error('timeout'), { killed: true });
      return { stdout: args.includes('--show-toplevel') ? `${root}\nmain\n` : 'abcdef\n' };
    },
  });
  assert.equal(timed.gitState, 'timeout');
  assert.equal(timed.git.branch, 'main');
  assert.equal(timed.git.changed, null);
  const absent = await sourceStatus(root, {
    runGit: async () => {
      throw Object.assign(new Error('git error'), { stderr: 'fatal: not a git repository' });
    },
  });
  assert.equal(absent.gitState, 'not-checkout');
});
