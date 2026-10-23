// /_sim/api/environment on the standalone host (sim-environment-routes.mjs, D11): definitions, local overrides that survive
// a source reload, the secret reference rule, CSRF, and deployment profiles answered as unsupported. Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

async function json(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
}

test('standalone environment routes edit local overrides and report deployment profiles as unsupported', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-environment-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  const files = {
    'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedEnvironment</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'environmentvariabledefinitions/x_flag/environmentvariabledefinition.xml': '<environmentvariabledefinition schemaname="x_flag"><displayname default="Flag"/><type>100000000</type><defaultvalue>no</defaultvalue></environmentvariabledefinition>',
    'environmentvariabledefinitions/x_apikey/environmentvariabledefinition.xml': '<environmentvariabledefinition schemaname="x_apikey"><displayname default="Api key"/><type>100000005</type></environmentvariabledefinition>',
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(solution, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const sim = await createSimulator({ runtime: { kind: 'dataverse-api' }, solutionRoots: [solution], projectRoot: root, port: 0, watch: false,
    stateFile: path.join(root, 'state.json'), dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  ownedFixture(t).add(() => sim.close());
  const headers = { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf };
  const variable = (name, method, body) => fetch(`${sim.url}/_sim/api/environment/variables/${name}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });

  const listing = await json(await fetch(`${sim.url}/_sim/api/environment`));
  assert.equal(listing.environmentVariables.available, true);
  assert.deepEqual(listing.environmentVariables.definitions.map(item => item.schemaName).sort(), ['x_apikey', 'x_flag']);
  assert.equal(listing.profileSelection.supported, false);
  // The standalone runtime loads deploymentProfiles too; without any configured, profile selection is unsupported.
  assert.match(listing.profileSelection.reason, /No deploymentProfiles are configured/);

  assert.equal((await json(await variable('x_flag', 'PUT', { value: 'yes' }))).effectiveValue, 'yes');
  await sim.reload();
  const reloaded = (await json(await fetch(`${sim.url}/_sim/api/environment`))).environmentVariables.definitions.find(item => item.schemaName === 'x_flag');
  assert.deepEqual([reloaded.effectiveValue, reloaded.overridden], ['yes', true], 'the override survives Solution re-seeding');
  const reset = await json(await variable('x_flag', 'DELETE'));
  assert.deepEqual([reset.effectiveValue, reset.overridden], ['no', false]);

  assert.equal((await variable('x_apikey', 'PUT', { value: 'plain-text' })).status, 400);
  assert.equal((await variable('x_flag', 'PUT', { value: 4 })).status, 400);
  assert.equal((await variable('x_missing', 'PUT', { value: 'x' })).status, 404);
  assert.equal((await variable('%', 'PUT', { value: 'x' })).status, 400);
  assert.equal((await fetch(`${sim.url}/_sim/api/environment/variables/x_flag`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"value":"x"}' })).status, 403);
  const profiles = await json(await fetch(`${sim.url}/_sim/api/environment/profiles`, { method: 'PUT', headers, body: JSON.stringify({ profile: 'x' }) }), 501);
  assert.equal(profiles.supported, false);
});
