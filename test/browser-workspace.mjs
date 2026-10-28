import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  makeTemporaryDirectory,
  ownedFixture,
  removeFixtureDirectory,
  assertTemporaryDirectory,
} from '../mirage/testing/owned-fixture.mjs';

export async function browserWorkspace(t) {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await makeTemporaryDirectory(path.join(parent, 'paq-browser-backport-'));
  ownedFixture(t).remove(async () =>
    removeFixtureDirectory(await assertTemporaryDirectory(directory, { parent, directChild: true })),
  );
  return directory;
}
