// @test-kind contract: the example keeps a local write across a restart with the preset mode from its config.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createSimulator } from 'paqvilo/mirage/server.mjs';
import { signInHeaders } from 'paqvilo/mirage/testing/session.mjs';
import { makeTemporaryDirectory, ownedFixture } from 'paqvilo/mirage/testing/owned-fixture.mjs';

const file = (name) => fileURLToPath(new URL('../' + name, import.meta.url));
const contact = 'a4300000-0000-4000-8000-000000002001',
  account = 'a4300000-0000-4000-8000-000000001001';

async function startExample(stateFile, presetMode) {
  return createSimulator({
    sourceDir: file('portal'),
    solutionRoots: [file('metadata'), file('code-solution'), file('solution')],
    solutionOrder: 'explicit',
    dataPacks: [{ module: file('pack/pack.mjs') }],
    preset: 'example-demo',
    presetMode,
    stateFile,
    port: 0,
    watch: false,
  });
}

test('a write survives a restart when the example config keeps local state', async (t) => {
  const config = YAML.parse(await fs.readFile(file('paqvilo.config.yml'), 'utf8'));
  const presetMode = config.sites.example.mirage.presetMode;
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-example-local-state-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const name = 'Renamed across restart';

  const first = await startExample(stateFile, presetMode);
  try {
    const patched = await fetch(first.url + '/_api/accounts(' + account + ')', {
      method: 'PATCH',
      headers: {
        ...signInHeaders(first, contact),
        'Content-Type': 'application/json',
        __RequestVerificationToken: first.state().csrf,
      },
      body: JSON.stringify({ name }),
    });
    assert.equal(patched.status, 204, await patched.text());
  } finally {
    await first.close();
  }

  const second = await startExample(stateFile, presetMode);
  ownedFixture(t).add(() => second.close());
  const read = await fetch(second.url + '/_api/accounts(' + account + ')?$select=name', {
    headers: signInHeaders(second, contact),
  });
  assert.equal(read.status, 200, await read.clone().text());
  assert.equal((await read.json()).name, name);
});
