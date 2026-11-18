// @test-kind contract: mirage/docs/operations.md (Activation): PATCH and DELETE /_sim/api/operations/<key> change one operation's override on the standalone host as on the Power Pages host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const FLOW = '77777777-7777-4777-8777-0000000000f1';
const KEY = `cloud-flow:${FLOW}`;
const DEF = {
  properties: {
    definition: {
      triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } },
      actions: { Note: { type: 'Compose', runAfter: {}, inputs: 'route' } },
    },
  },
};
const files = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedRoute</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'Workflows/route.json': JSON.stringify(DEF),
  'Workflows/route.json.data.xml': `<Workflow WorkflowId="{${FLOW}}" Name="Invented route flow"><Category>5</Category><StateCode>1</StateCode></Workflow>`,
};

// A standalone dataverse-api runtime over the invented Solution, closed and removed after the test.
async function start(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'standalone-operation-route-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(solution, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const sim = await createSimulator({
    projectRoot: root,
    solutionRoots: [solution],
    runtime: { kind: 'dataverse-api' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    simulation: { level: 'dry-run' },
    watch: false,
    port: 0,
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

test('the standalone host changes and resets one operation through /_sim/api/operations/<key>', async (t) => {
  const sim = await start(t);
  const simApi = async (method, suffix, payload, csrf = sim.csrf) => {
    const response = await fetch(sim.url + '/_sim/api' + suffix, {
      method,
      headers: { ...(csrf ? { 'x-sim-csrf': csrf } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const route = `/operations/${encodeURIComponent(KEY)}`;
  const override = { mode: 'exported', activation: 'local-enabled' };
  assert.equal((await simApi('PATCH', route, override, null)).status, 403);
  const unknown = await simApi('PATCH', `/operations/${encodeURIComponent('cloud-flow:unknown')}`, override);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.message, 'This operation is not in the current source exports.');
  assert.equal((await simApi('PATCH', route, { mode: 'invented' })).status, 400);

  const changed = await simApi('PATCH', route, override);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.ok(changed.body.items.some((item) => item.key === KEY));
  assert.deepEqual(sim.store.state.simulator.operations, { [KEY]: override });

  const reset = await simApi('DELETE', route);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.deepEqual(sim.store.state.simulator.operations, {});
});

// @test-kind contract: mirage/docs/sim-administration.md (Routes): an unknown /_sim/api path answers 404 `Admin endpoint not found.` and a non-boolean ?summary or ?strict answers 400 InvalidQueryParameter on the standalone host as on the Power Pages host.
test('the standalone host refuses unknown administration paths and non-boolean query flags like the Power Pages host', async (t) => {
  const sim = await start(t);
  const call = async (method, suffix) => {
    const response = await fetch(sim.url + '/_sim/api' + suffix, { method, headers: { 'x-sim-csrf': sim.csrf } });
    return { status: response.status, body: await response.json() };
  };
  for (const [method, suffix] of [
    ['GET', '/bogus'],
    ['POST', '/bogus'],
    ['GET', '/state/extra'],
  ]) {
    const { status, body } = await call(method, suffix);
    assert.equal(status, 404, `${method} ${suffix}`);
    assert.deepEqual(
      body.error,
      { code: 'INVALID_REQUEST', message: 'Admin endpoint not found.' },
      `${method} ${suffix}`,
    );
  }
  for (const suffix of ['/state?summary=maybe', '/preflight?strict=maybe']) {
    const { status, body } = await call('GET', suffix);
    assert.equal(status, 400, suffix);
    assert.equal(body.error.code, 'InvalidQueryParameter', suffix);
    assert.equal(body.error.parameter, suffix.includes('summary') ? 'summary' : 'strict', suffix);
  }
  assert.equal((await call('GET', '/state?summary=1')).status, 200);
});

// @test-kind contract: mirage/docs/dataverse-api.md (Connect an SDK): a refused token request is logged as a DATAVERSE_API finding in /_sim/api/diagnostics on the standalone host as on the Power Pages host.
test('the standalone host records a refused Dataverse token request as a DATAVERSE_API finding', async (t) => {
  const sim = await start(t);
  const refused = await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: '77777777-7777-4777-8777-0000000000f9',
      client_secret: 'invented',
      scope: sim.dataverse.origin + '/.default',
    }),
  });
  assert.match(await refused.text(), /AADSTS700016/);
  const { diagnostics } = await (await fetch(sim.url + '/_sim/api/diagnostics')).json();
  const logged = diagnostics.filter((item) => item.code === 'DATAVERSE_API').map((item) => item.message);
  assert.ok(logged.includes('dataverse token refused: unknown application'), JSON.stringify(logged));
});
