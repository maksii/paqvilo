// @test-kind contract: Paqvilo admin API design: a refused query names its parameter, HEAD mirrors GET, and status links name the Dataverse authority (mirage/docs/sim-administration.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulator } from '../api.mjs';
import { profileFixture } from './fixtures/deployment-profiles.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

async function start(t) {
  const fixture = await profileFixture({ after: (fn) => ownedFixture(t).remove(fn) });
  const sim = await createSimulator({
    sourceDir: fixture.sourceDir,
    solutionRoots: fixture.solutionRoots,
    projectRoot: fixture.root,
    deploymentProfiles: fixture.deploymentProfiles,
    stateFile: fixture.stateFile,
    port: 0,
    watch: false,
    dataverse: { enabled: true, port: 0, tls: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

test('admin API refusals name the refused query parameter', async (t) => {
  const sim = await start(t);
  for (const [query, parameter] of [
    ['/_sim/api/logs?limit=0', 'limit'],
    ['/_sim/api/logs?since=x', 'since'],
    ['/_sim/api/logs?type=BAD!', 'type'],
    ['/_sim/api/render-sources', 'refs'],
    ['/_sim/api/audit?afterSequence=x', 'afterSequence'],
    ['/_sim/api/verification-witness', 'tables'],
    ['/_sim/api/verification-witness?tables=x_absent', 'tables'],
    ['/_sim/api/preflight?strict=maybe', 'strict'],
    ['/_sim/api/state?summary=maybe', 'summary'],
  ]) {
    const response = await fetch(sim.url + query);
    const body = await response.json();
    assert.equal(response.status, 400, query);
    assert.equal(body.error.parameter, parameter, `${query}: ${JSON.stringify(body)}`);
  }
});

test('the JSON refusal of the sign-in shortcut without a persona names the persona parameter', async (t) => {
  const sim = await start(t);
  for (const route of ['/__sim/sign-in', '/_sim/sign-in?persona=%20']) {
    const response = await fetch(sim.url + route, { headers: { accept: 'application/json' } });
    const body = await response.json();
    assert.equal(response.status, 400, route);
    assert.equal(body.error.code, 'PersonaParameterRequired', `${route}: ${JSON.stringify(body)}`);
    assert.equal(body.error.parameter, 'persona', `${route}: ${JSON.stringify(body)}`);
  }
});

test('HEAD answers every GET-only admin and sign-in route as GET does, without a body', async (t) => {
  const sim = await start(t);
  for (const route of ['/__sim/sign-in?persona=reader', '/__sim/sign-in', '/_sim/api/logs', '/_sim/api/personas']) {
    const get = await fetch(sim.url + route, { redirect: 'manual' });
    await get.arrayBuffer();
    const head = await fetch(sim.url + route, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, get.status, route);
    assert.notEqual(head.status, 405, route);
    assert.equal((await head.arrayBuffer()).byteLength, 0, route);
  }
});

test('runtime status links name the Dataverse token authority beside the Dataverse API', async (t) => {
  const sim = await start(t);
  const { links } = await (await fetch(sim.url + '/_sim/api/status')).json();
  assert.equal(links.dataverseApi, sim.dataverse.origin);
  assert.equal(links.dataverseAuthority, sim.dataverse.authority);
});

test('a preset apply refuses a non-boolean applyConfiguration naming it', async (t) => {
  const sim = await start(t);
  const response = await fetch(sim.url + '/_sim/api/presets/none/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
    body: JSON.stringify({ applyConfiguration: 'yes' }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.parameter, 'applyConfiguration', JSON.stringify(body));
});

test('a pack endpoint refusal is a JSON envelope, and a missing simulator asset is plain text', async (t) => {
  const fixture = await profileFixture({ after: (fn) => ownedFixture(t).remove(fn) });
  const pack = {
    id: 'invented-endpoint',
    name: 'Invented endpoint',
    description: 'Invented read endpoint',
    matches: () => true,
    presets: () => ({}),
    endpoints: [
      { id: 'read', methods: ['GET'], pattern: /^\/__sim\/invented-read$/, handle: ({ res }) => res.end('ok') },
    ],
  };
  const sim = await createSimulator({ sourceDir: fixture.sourceDir, port: 0, watch: false, packs: [pack] });
  ownedFixture(t).add(() => sim.close());
  for (const accept of ['application/json', '*/*']) {
    const refused = await fetch(`${sim.url}/_sim/invented-read`, { method: 'POST', headers: { accept } });
    assert.equal(refused.status, 405, accept);
    assert.match(refused.headers.get('content-type'), /^application\/json/, accept);
    assert.match((await refused.json()).error.message, /requires GET/, accept);
  }
  const asset = await fetch(`${sim.url}/_sim/invented-missing.mjs`);
  assert.equal(asset.status, 404);
  assert.match(asset.headers.get('content-type'), /^text\/plain/);
  assert.doesNotMatch(await asset.text(), /<html/i);
  const scripted = await fetch(`${sim.url}/_sim/invented-missing`, { headers: { accept: 'application/json' } });
  assert.equal(scripted.status, 404);
  assert.equal(typeof (await scripted.json()).error.code, 'string');
});
