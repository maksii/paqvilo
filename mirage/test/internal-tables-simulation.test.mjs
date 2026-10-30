// The organization composes its internal tables (message bus queue rows, outbox entries, flow runs) at startup,
// independent of the simulation level: at level `simulation` the first send and the first outbox capture write rows
// without a schema change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { INTERNAL_TABLES } from '../lib/dataverse-organization.mjs';
import { QUEUE_MESSAGE_TABLE } from '../lib/message-bus.mjs';
import { OUTBOX_TABLE } from '../lib/outbox.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const ENTITY =
  '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>';

test('a standalone runtime at level simulation sends one message and captures one outbox entry without a schema diagnostic', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'internal-tables-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedInternal</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': ENTITY,
    'data.json': JSON.stringify({ items: [] }),
    'pack.mjs':
      "export default { id: 'fx-internal', name: 'Invented', description: 'Invented', matches: () => true, presets: () => ({})," +
      " dataFiles: [{ file: 'data.json', tables: { x_item: { path: ['items'], idColumn: 'x_itemid' } } }] };",
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  const diagnostics = [];
  const sim = await createSimulator({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    stateFile: path.join(root, 'state', 'state.json'),
    simulation: { level: 'simulation' },
    packs: [path.join(root, 'pack.mjs')],
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    diagnostic: (entry) => diagnostics.push(entry),
  });
  ownedFixture(t).add(() => sim.close());
  for (const name of [QUEUE_MESSAGE_TABLE, OUTBOX_TABLE]) {
    assert.ok(INTERNAL_TABLES.includes(name), `${name} is registered as an internal table`);
    assert.ok(sim.store.state.mappings[name], `${name} is composed at startup`);
  }
  const { messaging, outbox } = sim.organization.api.providers;
  await messaging.bus.send('x-invented-queue', { hello: 'invented' });
  await outbox.capture({ channel: 'email', to: ['someone@example.test'], subject: 'Invented', body: 'Invented body' });
  assert.equal(messaging.bus.peek('x-invented-queue').length, 1);
  assert.equal(outbox.list().length, 1);
  assert.equal(
    diagnostics.filter(
      (entry) => /Schema/i.test(String(entry.message ?? '')) || entry.code === 'SimulationSchemaDisabled',
    ).length,
    0,
  );

  const appId = '99999999-9999-4999-8999-999999999992';
  const registered = await fetch(`${sim.url}/_sim/api/dataverse/applications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
    body: JSON.stringify({ appId, displayName: 'Invented internal table test', roles: ['System Administrator'] }),
  });
  assert.equal(registered.status, 201);
  const { secret } = await registered.json();
  const issued = await fetch(`${sim.dataverse.authority}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: secret,
      scope: `${sim.dataverse.origin}/.default`,
    }),
  });
  assert.equal(issued.status, 200);
  const { access_token: accessToken } = await issued.json();
  const get = (suffix) =>
    fetch(`${sim.dataverse.origin}/api/data/v9.2/${suffix}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  const service = await get('');
  assert.equal(service.status, 200);
  const catalogue = (await service.json()).value.map((entry) => entry.name);
  assert.ok(catalogue.includes('x_items'), 'the exported business table remains discoverable');
  assert.ok(catalogue.includes('flowruns'), 'the standard flow-run table remains discoverable');
  const definitions = await get('EntityDefinitions?$select=LogicalName');
  assert.equal(definitions.status, 200);
  const names = (await definitions.json()).value.map((entry) => entry.LogicalName);
  const csdl = await get('$metadata');
  assert.equal(csdl.status, 200);
  const xml = await csdl.text();
  for (const [logical, set] of [
    [QUEUE_MESSAGE_TABLE, 'paqvilo_queuemessages'],
    [OUTBOX_TABLE, 'paqvilo_outboxentries'],
  ]) {
    assert.ok(!catalogue.includes(set), `${logical} is absent from the service catalogue`);
    assert.ok(!names.includes(logical), `${logical} is absent from EntityDefinitions`);
    assert.ok(!xml.includes(logical), `${logical} is absent from CSDL`);
    for (const path of [logical, set]) {
      const response = await get(path);
      await response.text();
      assert.equal(response.status, 404, `${path} cannot route to private runtime rows`);
    }
    assert.equal(sim.store.state.tables[logical].length, 1, 'private persisted rows remain available to the provider');
  }
  assert.equal(messaging.bus.peek('x-invented-queue').length, 1);
  assert.equal(outbox.list().length, 1);
});
