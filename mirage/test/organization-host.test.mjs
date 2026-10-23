// Shared host composition (lib/organization-host.mjs): both hosts compose through it. A runtime switch of a plug-in step to
// clr in the standalone host now prepares the CLR runtime before the choice is stored (01-B4), close runs in one order and
// the operation catalogue is memoised while the store revision and the sources are unchanged. Invented sources only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { loadOrganizationSources } from '../lib/solution-runtime-source.mjs';
import { composeOrganizationHost } from '../lib/organization-host.mjs';
import { assemblyXml, stepXml, pluginId } from './plugin-fixture.mjs';
import { fixedClock, sequentialIds } from '../testing.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const GUID = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;

test('a standalone runtime switch to clr prepares the CLR runtime and stores nothing when preparation fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'organization-host-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedPlugins</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/fx_widget/Entity.xml': '<Entity><Name>fx_widget</Name><EntityInfo><entity Name="fx_widget"><EntitySetName>fx_widgets</EntitySetName><PrimaryIdAttribute>fx_widgetid</PrimaryIdAttribute><PrimaryNameAttribute>fx_title</PrimaryNameAttribute><attributes><attribute PhysicalName="fx_widgetid"><Name>fx_widgetid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="fx_title"><Name>fx_title</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
    'solution/PluginAssemblies/Invented.WidgetRules/Invented.WidgetRules.xml': assemblyXml,
    [`solution/SdkMessageProcessingSteps/${pluginId(3)}.xml`]: stepXml(3),
  };
  for (const [name, body] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), body); }
  // A trusted descriptor for the exact step and type whose assembly does not exist: preparing it must fail.
  const descriptor = { trust: 'execute-local-assembly', root, assembly: 'Invented.Missing.dll', typeName: 'Invented.WidgetRules.Validate',
    sdkRoot: root, sdkAssembly: 'Invented.Sdk.dll', cacheRoot: path.join(root, 'cache'), timeoutMs: 1000,
    context: { initiatingUserId: GUID(1), organizationId: GUID(2), businessUnitId: GUID(3) } };
  const pack = { id: 'invented-clr', name: 'Invented CLR', description: 'Invented', matches: () => true, presets: () => ({}), pluginRuntimes: { [pluginId(3)]: descriptor } };
  const sim = await createSimulator({ runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false,
    packs: [pack], simulation: { level: 'dry-run' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  ownedFixture(t).add(() => sim.close());
  const key = `plugin-step:${pluginId(3)}`;
  const items = await (await fetch(`${sim.url}/_sim/api/operations`)).json();
  assert.equal(items.items.find((item) => item.key === key)?.clrAvailable, true, 'the step has its trusted descriptor');
  const response = await fetch(`${sim.url}/_sim/api/config`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf },
    body: JSON.stringify({ operations: { [key]: { mode: 'clr' } } }) });
  const answer = await response.text();
  assert.notEqual(response.status, 200, answer);
  assert.equal(sim.store.state.simulator.operations?.[key], undefined, 'nothing is stored when preparation fails');
});

async function composed(t) {
  const store = await new DataStore({ state: emptyState() }).init();
  const sources = await loadOrganizationSources({ solutionRoots: [] });
  const notes = [];
  const host = await composeOrganizationHost({ store, sources: { plugins: () => sources.metadata.plugins, workflows: () => sources.workflows, layers: () => [] },
    sourcesKey: () => sources, overrides: () => store.state.simulator?.operations ?? null, diagnostic: (entry) => notes.push(entry) });
  t.after(() => host.close());
  return { store, host, notes };
}

test('close runs backend, organization, Dataverse API and managed identity in that order', async (t) => {
  const { store, host } = await composed(t);
  await host.createBackend();
  const organization = await host.createOrganization({ settings: dataverseSettings({ enabled: true, tds: { enabled: false } }), change: (fn) => fn() });
  await host.startApi({ host: '127.0.0.1' });
  assert.equal(organization.api.providers.connectors, host.connectors, "the organization api carries the host providers");
  assert.equal(organization.api.secrets, null);
  assert.equal(typeof organization.api.packExport, 'function');
  const order = [];
  const spy = (name, target) => { const close = target.close; target.close = (...args) => { order.push(name); return close.apply(target, args); }; };
  spy('backend', host.backend);
  spy('organization', organization);
  spy('api', host.dataverse);
  spy('managed-identity', host.managedIdentity);
  await host.close();
  assert.deepEqual(order, ['backend', 'organization', 'api', 'managed-identity']);
  assert.ok(store);
});

test('the operation catalogue is memoised on an unchanged store revision and rebuilt after a commit', async (t) => {
  const { store, host } = await composed(t);
  const first = host.operations();
  assert.equal(host.operations(), first, 'an unchanged revision returns the same catalogue');
  assert.equal(host.pluginSteps(), host.pluginSteps());
  await store.transact(() => { (store.state.simulator ??= {}).operations = {}; });
  assert.notEqual(host.operations(), first, 'a commit rebuilds the catalogue');
});

test('host clock and ids reach the store and the organization in the standalone host', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'organization-host-clock-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'solution', 'Other'), { recursive: true });
  await fs.writeFile(path.join(root, 'solution', 'Other', 'Solution.xml'), '<ImportExportXml><SolutionManifest><UniqueName>InventedClock</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>');
  const start = Date.parse('2026-03-01T00:00:00.000Z');
  const clock = fixedClock(start), ids = sequentialIds();
  const sim = await createSimulator({ runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false,
    clock, ids, simulation: { level: 'dry-run' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  ownedFixture(t).add(() => sim.close());
  assert.equal(sim.store.clock, clock);
  assert.equal(sim.store.ids, ids);
  assert.equal(sim.organization.clock(), start);
  clock.advance(1000);
  assert.equal(sim.organization.clock(), start + 1000);
});
