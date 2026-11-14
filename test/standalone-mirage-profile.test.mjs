// @test-kind contract: the --profile option selects the dev browser profile of a standalone project
import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { standaloneMirageConfiguration } from '../lense/standalone-mirage.mjs';
import { browserProfileInfo } from '../lense/browser-profile.mjs';

test('the --profile option selects the dev browser profile of a standalone project', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-profile-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = { configFile: path.join(directory, 'project.json') };
  // Shell settings would otherwise choose the profile under test; they are restored when the test ends.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PAQVILO_')));
  try {
    for (const key of Object.keys(inherited)) delete process.env[key];
    // Neither the option nor the environment variable: the legacy profile kept under the project.
    const legacy = browserProfileInfo(standaloneMirageConfiguration(project, {}));
    assert.equal(legacy.kind, 'legacy');
    assert.equal(legacy.name, 'project-local');
    assert.equal(legacy.userDataDir, path.join(directory, '.paqvilo', 'profiles', 'project-local'));
    const named = browserProfileInfo(standaloneMirageConfiguration(project, { profile: 'Work' }));
    assert.equal(named.kind, 'named');
    assert.equal(named.name, 'work');
    // The option wins over PAQVILO_PROFILE.
    process.env.PAQVILO_PROFILE = 'Other';
    const explicit = browserProfileInfo(standaloneMirageConfiguration(project, { profile: 'Work' }));
    assert.equal(explicit.kind, 'named');
    assert.equal(explicit.name, 'work');
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith('PAQVILO_')) delete process.env[key];
    Object.assign(process.env, inherited);
  }
});
