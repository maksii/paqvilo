import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  makeTemporaryDirectory,
  ownedFixture,
  removeFixtureDirectory,
  assertTemporaryDirectory,
  drainFixture,
} from '../mirage/testing/owned-fixture.mjs';

test('actual browser workspace initializes and cleans up from a fresh checkout without local state', async (t) => {
  const checkout = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-browser-fresh-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(checkout));
  for (const relative of ['test/browser-workspace.mjs', 'mirage/testing/owned-fixture.mjs']) {
    const destination = path.join(checkout, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(new URL('../' + relative, import.meta.url), destination);
  }
  const state = path.join(checkout, '.paqvilo');
  await assert.rejects(fs.access(state), { code: 'ENOENT' });
  const { browserWorkspace } = await import(pathToFileURL(path.join(checkout, 'test/browser-workspace.mjs')).href);
  const cleanups = [];
  let workspace;
  try {
    workspace = await browserWorkspace({ after: (cleanup) => cleanups.push(cleanup) });
    assert.equal(workspace, await fs.realpath(workspace), 'the workspace has physical filesystem identity');
    assert.equal(
      await assertTemporaryDirectory(workspace, { directChild: true }),
      workspace,
      'the workspace belongs directly to the physical temporary parent',
    );
    await assert.rejects(fs.access(state), { code: 'ENOENT' }, 'fixture setup must not create checkout state');
    await fs.writeFile(path.join(workspace, 'owned-probe.mjs'), 'export const invented = true;');
    assert.equal(await fs.readFile(path.join(workspace, 'owned-probe.mjs'), 'utf8'), 'export const invented = true;');
  } finally {
    await drainFixture(cleanups);
  }
  await assert.rejects(fs.access(workspace), { code: 'ENOENT' }, 'the owned workspace closes with its fixture');
  await assert.rejects(fs.access(state), { code: 'ENOENT' }, 'cleanup must not create checkout state');
});
