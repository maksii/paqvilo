// composeHostDescription (organization-host.mjs): the listener-free composition the offline preflight shares with the running
// hosts. For one configuration it lists the same capability records and provider rows as GET /_sim/api/preflight.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { loadOrganizationSources } from '../lib/solution-runtime-source.mjs';
import { composeHostDescription, activeDeploymentProfile } from '../lib/organization-host.mjs';
import '../lib/provider-modules.mjs';

const CUSTOMIZATIONS = '<ImportExportXml><Entities/><connectionreferences><connectionreference connectionreferencelogicalname="x_fxref">'
  + '<connectionreferencedisplayname>Invented reference</connectionreferencedisplayname><connectorid>/providers/Microsoft.PowerApps/apis/shared_fx</connectorid>'
  + '</connectionreference></connectionreferences></ImportExportXml>';
const SCENARIO = { id: 'fx-scenario', requires: ['connector:fixture', 'outbox:local', 'connectionreference:*'] };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-description-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries({
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedDescription</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Other/Customizations.xml': CUSTOMIZATIONS,
    'profiles/dev.json': JSON.stringify({ ConnectionReferences: [{ LogicalName: 'x_fxref', ConnectionId: 'fx-connection', ConnectorId: '/providers/Microsoft.PowerApps/apis/shared_fx' }] }),
  })) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  const options = { runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    connections: { 'fx-conn': { connector: 'shared_fx', provider: 'fixture' } },
    deploymentProfiles: { default: 'dev', profiles: { dev: { connectionReferences: 'profiles/dev.json' } } },
    providers: { storage: { emulator: { kind: 'azurite', connectionString: 'env:FX_UNSET_AZURITE' } }, messaging: { sb: { kind: 'servicebus-emulator', connectionString: 'env:FX_UNSET_SB' } } } };
  return { root, options };
}

async function describe(options) {
  const sources = await loadOrganizationSources({ solutionRoots: options.solutionRoots, projectRoot: options.projectRoot });
  return composeHostDescription({ sources, runtime: options.runtime, simulation: options.simulation, projectRoot: options.projectRoot,
    deploymentProfile: await activeDeploymentProfile({ deploymentProfiles: options.deploymentProfiles, projectRoot: options.projectRoot }),
    config: { connections: options.connections, providers: options.providers, dataverse: options.dataverse } });
}

const rows = (report, kind) => report.requirements.filter(row => !kind || row.kind === kind).map(row => `${row.id}:${row.status}`).sort();

test('offline description and the running standalone host report the same modules, providers and scenario rows', async t => {
  const { root, options } = await fixture(t);
  const before = (await fs.readdir(root, { recursive: true })).sort();
  const description = await describe(options);
  const offline = await description.preflight({ scenario: SCENARIO, env: {} });
  await description.close();
  assert.deepEqual((await fs.readdir(root, { recursive: true })).sort(), before, 'the description writes no file');

  const sim = await createSimulator({ ...options, port: 0, watch: false });
  t.after(() => sim.close());
  const live = await sim.preflight({ scenario: SCENARIO });
  assert.deepEqual(offline.modules.map(record => record.name).sort(), live.modules.map(record => record.name).sort());
  assert.deepEqual(rows(offline, 'provider'), rows(live, 'provider'));
  assert.deepEqual(rows(offline, 'provider'), ['provider:messaging/sb:missing', 'provider:storage/emulator:missing', 'provider:storage/local:satisfied']);
  const scenario = report => report.requirements.filter(row => row.inScope).map(row => `${row.id}:${row.status}:${row.blocking}`).sort();
  assert.deepEqual(scenario(offline), scenario(live));
  assert.ok(scenario(live).includes('connector:fixture:satisfied:false'));
  assert.ok(scenario(live).includes('outbox:local:satisfied:false'));
  assert.equal(offline.summary.blocking, live.summary.blocking);
});

test('the standalone preflight honours deployment-profile connection references', async t => {
  const { options } = await fixture(t);
  const sim = await createSimulator({ ...options, port: 0, watch: false });
  t.after(() => sim.close());
  const live = await sim.preflight();
  assert.deepEqual(rows(live, 'connectionreference'), ['connectionreference:x_fxref:satisfied']);
  const description = await describe(options);
  t.after(() => description.close());
  assert.deepEqual(rows(await description.preflight({ env: {} }), 'connectionreference'), ['connectionreference:x_fxref:satisfied']);
  // The profile binding also reaches the seeded connection reference row, as on the Power Pages host.
  assert.equal(sim.store.state.tables.connectionreference.find(row => row.connectionreferencelogicalname === 'x_fxref').connectionid, 'fx-connection');
});

test('a pack factory that throws rejects the description with PROVIDER_FACTORY_FAILED', async t => {
  const { options } = await fixture(t);
  const sources = await loadOrganizationSources({ solutionRoots: options.solutionRoots, projectRoot: options.projectRoot });
  const pack = { id: 'fx-broken', storageProviders: { blob: () => { throw new Error('invented failure'); } } };
  await assert.rejects(composeHostDescription({ sources, runtime: options.runtime, packs: [pack], config: { providers: { storage: { blob: { kind: 'pack:fx-broken/blob' } } } } }),
    { code: 'PROVIDER_FACTORY_FAILED', pack: 'fx-broken' });
});

test('status lists the mounted /_sim/api routes and imported model-driven apps; Power Pages state carries docs', async t => {
  const { root, options } = await fixture(t);
  const sim = await createSimulator({ ...options, port: 0, watch: false });
  t.after(() => sim.close());
  const status = await (await fetch(sim.url + '/_sim/api/status')).json();
  assert.ok(['/dashboard', '/environment', '/preflight', '/messages', '/flow-runs'].every(route => status.routes.includes(route)));
  assert.equal(status.routes.includes('/personas'), false, 'personas belong to the Power Pages host');
  assert.deepEqual(status.modelDrivenApps, []);

  await fs.mkdir(path.join(root, 'portal'), { recursive: true });
  await fs.writeFile(path.join(root, 'portal', 'website.yml'), 'adx_websiteid: fixture\nadx_name: Invented site');
  await fs.writeFile(path.join(root, 'portal', 'Home.webpage.yml'), 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true');
  const portal = await createSimulator({ sourceDir: path.join(root, 'portal'), solutionRoots: options.solutionRoots, projectRoot: root, port: 0, watch: false, simulation: { level: 'dry-run' } });
  t.after(() => portal.close());
  const portalStatus = await (await fetch(portal.url + '/_sim/api/status')).json();
  assert.ok(portalStatus.routes.includes('/personas') && portalStatus.routes.includes('/dashboard'));
  assert.ok(Array.isArray(portalStatus.modelDrivenApps));
  assert.ok((await (await fetch(portal.url + '/_sim/api/state')).json()).docs);
  await fetch(portal.url + '/');
  const dashboard = await (await fetch(portal.url + '/_sim/api/dashboard')).json();
  const recent = dashboard.activity.requests.recent;
  assert.ok(recent.length && recent.every(entry => entry.at === null || !Number.isNaN(Date.parse(entry.at)) && typeof entry.at === 'string'));
});

// RA1-04: the offline description installs the organization modules over its in-memory store, so every module and operation
// level equals the running host's (both hosts), not only the module names.
const levels = report => Object.fromEntries(report.modules.map(record => [record.name,
  [record.level, ...(record.operations ?? []).map(operation => `${operation.name}=${operation.level}`).sort()].join(' ')]));

test('offline preflight and both running hosts report the same module and operation levels', async t => {
  const { root, options } = await fixture(t);
  await fs.mkdir(path.join(root, 'portal'), { recursive: true });
  await fs.writeFile(path.join(root, 'portal', 'website.yml'), 'adx_websiteid: fixture\nadx_name: Invented site');
  await fs.writeFile(path.join(root, 'portal', 'Home.webpage.yml'), 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true');
  const { preflight } = await import('../lib/capability-report.mjs');
  const { runtime, ...shared } = options;
  for (const hostOptions of [options, { ...shared, sourceDir: path.join(root, 'portal') }]) {
    const offline = await preflight({ ...hostOptions, env: {} });
    const sim = await createSimulator({ ...hostOptions, port: 0, watch: false });
    try {
      const live = await sim.preflight();
      assert.deepEqual(levels(offline), levels(live), hostOptions.sourceDir ? 'power-pages' : 'standalone');
      assert.equal(levels(live)['dataverse-storage-routing'].split(' ')[0], 'behaviour');
    } finally { await sim.close(); }
  }
});
