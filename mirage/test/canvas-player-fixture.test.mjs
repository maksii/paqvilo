import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canvasPlayerFixture } from './canvas-player-fixture.mjs';
import { ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';

test('Canvas player fixtures resolve linked temporary roots before creating sources', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-linked-temp-')));
  const physical = path.join(root, 'physical'),
    alias = path.join(root, 'alias');
  const hooks = [];
  const cleanup = ownedFixture(t);
  cleanup.remove(() => removeFixtureDirectory(root));
  cleanup.add(async () => {
    for (const hook of hooks) await hook();
  });
  await fs.mkdir(physical);
  await fs.symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.mock.method(os, 'tmpdir', () => alias);
  const sim = await canvasPlayerFixture({ after: (hook) => hooks.push(hook) }, 'directory');
  assert.equal(sim.fixtureRoot, await fs.realpath(sim.fixtureRoot));
  assert.equal(path.dirname(sim.fixtureRoot), await fs.realpath(physical));
});
