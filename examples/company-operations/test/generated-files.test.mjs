// @test-kind tooling: every committed generated file is byte-identical to its generator's output, so regeneration leaves no diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTemporaryDirectorySync } from 'paqvilo/mirage/testing/owned-fixture.mjs';

// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_GUARD_MS = 170_000;
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const [script, committed] of [
  ['prepare-schema.mjs', 'dataverse/manifest.json'],
  ['prepare-data.mjs', 'data/catalogue.json'],
  ['prepare-stress-data.mjs', 'data/stress-catalogue.json'],
  ['plugins/prepare-registration.mjs', 'plugins/registrations.json'],
])
  test(`${script} reproduces ${committed} byte for byte`, (t) => {
    const directory = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-generated-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, path.basename(committed));
    const result = spawnSync(process.execPath, [path.join(project, script), '--out', output], {
      cwd: project,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_HANG_GUARD_MS,
    });
    assert.equal(result.status, 0, result.stderr);
    // Compare text, not parsed JSON: a formatting-only difference is a diff in the checkout too.
    assert.equal(
      fs.readFileSync(output, 'utf8'),
      fs.readFileSync(path.join(project, committed), 'utf8'),
      `${committed} is stale: run ${script} and commit the result`,
    );
  });
