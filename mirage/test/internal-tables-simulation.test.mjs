// The organization composes its internal tables (message bus queue rows, outbox entries, flow runs) at startup,
// independent of the simulation level: at level `simulation` the first send and the first outbox capture write rows
// without a schema change. Invented x_ schema and pack only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { INTERNAL_TABLES } from '../lib/dataverse-organization.mjs';
import { QUEUE_MESSAGE_TABLE } from '../lib/message-bus.mjs';
import { OUTBOX_TABLE } from '../lib/outbox.mjs';

const ENTITY = '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>';

test('a standalone runtime at level simulation sends one message and captures one outbox entry without a schema diagnostic', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'internal-tables-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedInternal</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': ENTITY,
    'data.json': JSON.stringify({ items: [] }),
    'pack.mjs': "export default { id: 'fx-internal', name: 'Invented', description: 'Invented', matches: () => true, presets: () => ({}),"
      + " dataFiles: [{ file: 'data.json', tables: { x_item: { path: ['items'], idColumn: 'x_itemid' } } }] };",
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  const diagnostics = [];
  const sim = await createSimulator({ runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false,
    stateFile: path.join(root, 'state', 'state.json'), simulation: { level: 'simulation' }, packs: [path.join(root, 'pack.mjs')],
    dataverse: { enabled: true, tls: false, tds: { enabled: false } }, diagnostic: (entry) => diagnostics.push(entry) });
  t.after(() => sim.close());
  for (const name of [QUEUE_MESSAGE_TABLE, OUTBOX_TABLE]) {
    assert.ok(INTERNAL_TABLES.includes(name), `${name} is registered as an internal table`);
    assert.ok(sim.store.state.mappings[name], `${name} is composed at startup`);
  }
  const { messaging, outbox } = sim.organization.api.providers;
  await messaging.bus.send('x-invented-queue', { hello: 'invented' });
  await outbox.capture({ channel: 'email', to: ['someone@example.test'], subject: 'Invented', body: 'Invented body' });
  assert.equal(messaging.bus.peek('x-invented-queue').length, 1);
  assert.equal(outbox.list().length, 1);
  assert.equal(diagnostics.filter((entry) => /Schema/i.test(String(entry.message ?? '')) || entry.code === 'SimulationSchemaDisabled').length, 0);
});
