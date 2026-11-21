// @test-kind contract: a portal write refused for its verification token says whether the token is missing or not valid for this session, with the same 403 status and code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('a portal write names a missing verification token apart from one that is not valid for this session', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-token-refusal-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented token site');
  await fs.writeFile(
    path.join(root, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  );
  const sim = await createSimulator({
    sourceDir: root,
    stateFile: path.join(root, 'state.json'),
    port: 0,
    watch: false,
  });
  ownedFixture(t).add(() => sim.close());
  const submit = async (headers) => {
    const response = await fetch(`${sim.url}/__sim/forms/entityform/invented/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: '{}',
    });
    return { status: response.status, error: (await response.json()).error };
  };
  assert.deepEqual(await submit({}), {
    status: 403,
    error: { code: 'INVALID_REQUEST', message: 'Missing portal verification token.' },
  });
  assert.deepEqual(await submit({ __RequestVerificationToken: 'invented-token' }), {
    status: 403,
    error: { code: 'INVALID_REQUEST', message: 'The portal verification token is not valid for this session.' },
  });
});
