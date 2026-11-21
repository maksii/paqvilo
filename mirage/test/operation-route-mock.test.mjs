// @test-kind contract: mirage/docs/operations.md: the /_sim/ "Configured response" of a server logic (PATCH /_sim/api/operations/<key> with mode mock, status and body) is stored and listed, and DELETE ("Use source default") restores the source behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const LOGIC = 'c4700000-0000-4000-8000-0000000000a1';
const ROLE = 'c4700000-0000-4000-8000-0000000000a2';
const PORTAL = {
  'website.yml': 'adx_websiteid: site\nadx_name: Invented mock site',
  'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  'server-logic/invented-total.serverlogic.yml': `adx_name: invented-total\nadx_serverlogic_adx_webrole:\n- ${ROLE}\nadx_serverlogicid: ${LOGIC}\n`,
  'server-logic/invented-total.js': 'function get() { return JSON.stringify({ success: true, total: 1 }); }\n',
};

test('a server logic mock set through /_sim/api/operations/<key> is stored, and DELETE restores the source default', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'operation-route-mock-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(PORTAL)) {
    await fs.mkdir(path.dirname(path.join(root, 'portal', name)), { recursive: true });
    await fs.writeFile(path.join(root, 'portal', name), text);
  }
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    stateFile: path.join(root, 'state.json'),
    port: 0,
    watch: false,
  });
  ownedFixture(t).add(() => sim.close());
  const key = `server-logic:${LOGIC}`;
  const call = async (method, body) => {
    // The administration page sends this request to the admin address under /__sim/api.
    const response = await fetch(new URL(`/__sim/api/operations/${encodeURIComponent(key)}`, sim.adminUrl), {
      method,
      headers: { 'x-sim-csrf': sim.csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const mock = { mode: 'mock', status: 200, body: { success: true, total: 4242 } };
  const changed = await call('PATCH', mock);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.ok(changed.body.items.some((item) => item.key === key));
  assert.deepEqual(sim.store.state.simulator.operations[key], mock);

  const reset = await call('DELETE');
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(sim.store.state.simulator.operations[key], undefined);
});
