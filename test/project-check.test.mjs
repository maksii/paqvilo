// @test-kind contract: the project check reads Git's list of project files whatever its size
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectProjectAdoption, scaffoldMarkers } from '../lense/project-check.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

test('completion and adoption read a Git file list larger than 4 MiB', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-project-check-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (args, input) =>
    spawnSync('git', ['-C', directory, ...args], { env, input, encoding: 'utf8', windowsHide: true });
  assert.equal(git(['init', '-q']).status, 0);
  await fs.writeFile(path.join(directory, 'notes.md'), 'TODO(paqvilo-init): finish\n');
  // Index entries only: Git lists them although none of these files exists on disk.
  const blob = git(['hash-object', '-w', '--stdin'], '').stdout.trim();
  const folder = Array.from({ length: 15 }, (_, index) => `${index}`.padEnd(200, 'x')).join('/');
  const entries = Array.from({ length: 2000 }, (_, index) => `100644 ${blob}\t${folder}/${index}.md\n`).join('');
  assert.ok(entries.length > 5 * 1024 * 1024);
  const added = git(['update-index', '--add', '--index-info'], entries);
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(
    scaffoldMarkers(directory).map((item) => item.file),
    ['notes.md'],
  );
  const adoption = inspectProjectAdoption(directory, { processEnv: {} });
  assert.ok(!adoption.diagnostics.some((item) => item.code === 'PRIVATE_INDEX_REVIEW'), JSON.stringify(adoption));
});
