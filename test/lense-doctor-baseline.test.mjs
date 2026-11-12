// @test-kind contract: doctor's baseline readiness follows docs/project-scaffold.md: a project before its first commit is ready with a note, while a missing baseline blocks markup patches
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFixture, SITE, tempDirSync } from './fixture.mjs';
import { inspectCheckout } from '../lense/commands/doctor.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner

// Git variables from a hook would point these commands at this worktree's repository instead of the temporary export.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd,
    env,
    stdio: 'ignore',
    windowsHide: true,
    timeout: CLI_HANG_GUARD_MS,
  });

test('doctor baseline readiness: a non-repository is blocked, an unborn repository is a note unless changed scope needs a baseline, a commit is ready', (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  const dir = tempDirSync('paqvilo-baseline-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  fs.cpSync(fx.dir, dir, { recursive: true, filter: (source) => path.basename(source) !== '.git' });
  const site = (overrides = {}) => ({ ...structuredClone(SITE), ...overrides });
  const check = (siteOverrides) =>
    inspectCheckout({
      siteName: 'test',
      envName: 'dev',
      origin: 'https://portal.example',
      sourceDir: dir,
      site: site(siteOverrides),
    });
  const baselineNote = (report) => report.warnings.filter((warning) => /Baseline "HEAD"/.test(warning));

  // (a) not a Git repository, markup enabled: the baseline is unavailable and blocks readiness.
  assert.equal(SITE.markup.enabled, true);
  const outsideGit = check();
  assert.equal(outsideGit.ready, false);
  assert.ok(
    outsideGit.errors.some((error) => /Baseline "HEAD" is unavailable/.test(error)),
    JSON.stringify(outsideGit.errors),
  );

  // (b) git init only, markup enabled, default scope: ready, with the no-commits note.
  git(dir, 'init', '-q');
  const unborn = check();
  assert.equal(unborn.ready, true, JSON.stringify(unborn.errors));
  assert.ok(
    unborn.warnings.some((warning) => /has no commits yet/.test(warning)),
    JSON.stringify(unborn.warnings),
  );

  // (c) git init only with changed scope: the baseline is required, so not ready.
  const changed = check({ scope: 'changed' });
  assert.equal(changed.ready, false);
  assert.ok(
    changed.errors.some((error) => /Baseline "HEAD" is unavailable/.test(error)),
    JSON.stringify(changed.errors),
  );

  // (d) one commit: ready, and no baseline note.
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'baseline');
  const committed = check();
  assert.equal(committed.ready, true, JSON.stringify(committed.errors));
  assert.deepEqual(committed.errors, []);
  assert.deepEqual(baselineNote(committed), []);
});
