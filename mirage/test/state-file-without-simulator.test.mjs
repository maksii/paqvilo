// @test-kind contract: a persisted state file is only required to hold the business sections; a hand-written or older file without the simulator block starts with the block a new state gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('a state file without the simulator block starts with the default simulator configuration', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'state-without-simulator-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'portal'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'portal', 'website.yml'),
    'adx_websiteid: 77777777-7777-4777-8777-0000000000f6\nadx_name: Invented',
  );
  const stateFile = path.join(root, 'state.json');
  await fs.writeFile(
    stateFile,
    JSON.stringify({ version: 1, mappings: {}, tables: {}, settings: { permissionMode: 'enforce' } }),
  );
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    projectRoot: root,
    stateFile,
    port: 0,
    watch: false,
  });
  ownedFixture(t).add(() => sim.close());
  const { mode, pageMode, identity } = sim.store.state.simulator;
  assert.deepEqual({ mode, pageMode, anonymous: identity.id }, { mode: 'local', pageMode: 'local', anonymous: null });
  assert.equal((await fetch(sim.url + '/_sim/api/state')).status, 200);
});
