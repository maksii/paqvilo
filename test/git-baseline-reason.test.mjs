// @test-kind contract: Paqvilo's own baseline state (lense/git.mjs) and the panel note built from it name why there is no Git baseline, not the Git command that failed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitBaseline } from '../lense/git.mjs';
import { baselineNote } from '../lense/panel.mjs';
import { tempDirSync } from './fixture.mjs';

const outsideGit = (t) => {
  const dir = tempDirSync('paqvilo-baseline-reason-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The ceiling stops Git at the folder itself, so a repository that holds the temporary directory is not found.
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(path.dirname(dir));
  t.after(() => {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  });
  return dir;
};

test('a later ref check outside Git keeps "not a Git repository" instead of the failed command', async (t) => {
  const dir = outsideGit(t);
  const baseline = await GitBaseline.create(dir, 'HEAD');
  const reason = 'Cannot read baseline HEAD: not a Git repository; baseline comparison skipped';
  assert.equal(baseline.error, reason);
  // The source watcher asks again; Git answers the same way. The panel showed "Command failed: git -c ..." here.
  await baseline.checkForUpdate();
  assert.equal(baseline.available, false);
  assert.equal(baseline.error, reason);
  assert.doesNotMatch(baseline.error, /Command failed|rev-parse/);

  const note = baselineNote(baseline, { site: { markup: { baseline: 'HEAD' } } });
  assert.equal(note.kind, 'baseline');
  assert.match(note.reason, /^Your sources are not in a Git repository, so there is no baseline to compare with/);
  assert.match(note.reason, /Keep the sources in a Git checkout/);
  assert.equal(note.detail, reason, 'the Git message stays available to copy');

  // A repository without commits: the state is named, and later checks keep naming it.
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  assert.equal(init.status, 0, String(init.stderr));
  const unborn = await GitBaseline.create(dir, 'HEAD');
  await unborn.checkForUpdate();
  assert.equal(unborn.error, 'Cannot read baseline HEAD: the repository has no commits yet');
  assert.match(
    baselineNote(unborn, { site: { markup: {} } }).reason,
    /^The repository has no commits yet.*Commit the sources/,
  );
});

test('a repository created while Lense runs says it has no commits yet, not the failed command', async (t) => {
  const dir = outsideGit(t);
  const baseline = await GitBaseline.create(dir, 'HEAD');
  assert.equal(baseline.outsideRepository, true);
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  assert.equal(init.status, 0, String(init.stderr));
  // The same baseline object, asked again by the source watcher after `git init`.
  await baseline.checkForUpdate();
  assert.equal(baseline.outsideRepository, false);
  assert.equal(baseline.error, 'Cannot read baseline HEAD: the repository has no commits yet');
  assert.match(
    baselineNote(baseline, { site: { markup: { baseline: 'HEAD' } } }).reason,
    /^The repository has no commits yet.*Commit the sources/,
  );
});

test('a baseline ref that is not a commit tells which option chooses another one', () => {
  const note = baselineNote(
    { spec: 'release', error: 'Cannot read baseline release: Command failed: git rev-parse release' },
    { site: { markup: { baseline: 'release' } } },
  );
  assert.match(note.reason, /^"release" is not a commit in this repository/);
  assert.match(note.reason, /--baseline <ref>, or set markup\.baseline in the catalogue/);
  assert.doesNotMatch(note.reason, /Command failed/);
  assert.match(note.detail, /Command failed/);
});

test('a repository that gets its first commit stops being named as one without commits', async (t) => {
  const dir = outsideGit(t);
  const run = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, windowsHide: true });
    assert.equal(result.status, 0, String(result.stderr));
  };
  run('init', '-q');
  const baseline = await GitBaseline.create(dir, 'release');
  assert.equal(baseline.error, 'Cannot read baseline release: the repository has no commits yet');
  // A commit lands, but not on "release": that ref is now what is missing.
  run(
    '-c',
    'user.name=Invented',
    '-c',
    'user.email=invented@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'first',
  );
  await baseline.checkForUpdate();
  assert.equal(baseline.available, false);
  assert.doesNotMatch(baseline.error, /no commits yet/);
  assert.match(
    baselineNote(baseline, { site: { markup: { baseline: 'release' } } }).reason,
    /^"release" is not a commit/,
  );
});
