import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommitMessage } from '../scripts/conventional-commit.mjs';
import { classifyChanges } from '../.github/scripts/change-scope.mjs';

test('commit gates accept Conventional Commits and reject malformed subjects/bodies', () => {
  for (const message of ['feat: add preview', 'fix(lense)!: change contract\n\nBREAKING CHANGE: explicit identity required', 'revert: undo change', 'perf(mirage): speed up rendering']) assert.doesNotThrow(() => validateCommitMessage(message));
  for (const message of ['', 'fix bug', 'fix: ', 'fix(scope) change', 'feat: change\nbody without blank line', ' fix: change']) assert.throws(() => validateCommitMessage(message));
});

test('secondary edits skip runtime jobs but packaged documentation retains release checks', () => {
  assert.deepEqual(classifyChanges(['docs/coverage.md', 'README.md']), { runtime: false, package: true, dependencies: false });
  assert.deepEqual(classifyChanges(['site/index.html', '.github/ISSUE_TEMPLATE/bug.yml']), { runtime: false, package: false, dependencies: false });
  for (const file of ['lense/cli.mjs', 'mirage/lib/server.mjs', 'test/cli.test.mjs', '.github/workflows/ci.yml', '.github/scripts/change-scope.mjs', 'new-runtime/index.mjs', '.env.example']) assert.equal(classifyChanges([file]).runtime, true, file);
  assert.equal(classifyChanges(['mirage/package-lock.json']).dependencies, true);
});
