import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const CLIENT = '99999999-9999-4999-8999-999999999999'; // application user

async function solutionFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-standalone-overrides-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  const files = {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedOverrides</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml':
      '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(solution, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const sim = await createSimulator({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [solution],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

async function json(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
}

test('an admin request-limit override applies to the standalone Web API', async (t) => {
  const sim = await solutionFixture(t);
  const registration = await json(
    await fetch(sim.url + '/_sim/api/dataverse/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({ appId: CLIENT, displayName: 'Invented client', roles: ['System Administrator'] }),
    }),
    201,
  );
  const token = await json(
    await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT,
        client_secret: registration.secret,
        scope: sim.dataverse.origin + '/.default',
      }),
    }),
    200,
  );
  const read = () =>
    fetch(sim.dataverse.origin + '/api/data/v9.2/x_items?$top=1', {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10000),
    });
  const setEnvironment = (body) =>
    fetch(sim.url + '/_sim/api/dataverse/environment', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify(body),
    });

  assert.equal((await read()).status, 200);
  assert.equal((await read()).status, 200);
  const shown = await json(await setEnvironment({ requestsPer300s: 1 }), 200);
  assert.equal(shown.requestsPer300s, 1);
  // The two earlier requests already fill the window of one: the override must be enforced on the next call.
  const limited = await read();
  assert.equal(limited.status, 429, await limited.text());
  assert.ok(Number(limited.headers.get('retry-after')) > 0, 'a 429 carries a positive Retry-After');
  await json(await setEnvironment({ requestsPer300s: null }), 200);
  assert.equal((await read()).status, 200, 'clearing the override turns the limit off');
});
