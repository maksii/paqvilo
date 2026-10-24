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

// The offline description installs the organization modules over its in-memory store, so every module and operation
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

test('the offline preflight applies the startup preset, so a step whose service endpoint the preset seeds resolves as on the host', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-description-preset-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ENDPOINT = '77777777-7777-4777-8777-0000000000f1', STEP = '77777777-7777-4777-8777-0000000000f2';
  const files = {
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedPreset</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Other/Customizations.xml': '<ImportExportXml><Entities/></ImportExportXml>',
    [`solution/SdkMessageProcessingSteps/{${STEP}}.xml`]: `<SdkMessageProcessingStep Name="x_item Create" SdkMessageProcessingStepId="{${STEP}}"><SdkMessageId>9ebdbb1b-ea3e-db11-86a7-000a3a5473e8</SdkMessageId>`
      + `<EventHandler>${ENDPOINT}</EventHandler><PrimaryEntity>x_item</PrimaryEntity><Mode>1</Mode><Rank>1</Rank><Stage>40</Stage><SupportedDeployment>0</SupportedDeployment><StateCode>0</StateCode></SdkMessageProcessingStep>`,
    'pack/pack.mjs': `export default { id: 'fx', name: 'I', description: 'I', matches: () => true,
      presets: () => ({ seed: { name: 'S', description: 'x', load: () => ({ tables: { serviceendpoint: [{ serviceendpointid: '${ENDPOINT}', name: 'x-hook', contract: 8, url: 'http://127.0.0.1:9/x' }] } }) } }) };`,
  };
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  const { preflight } = await import('../lib/capability-report.mjs');
  const options = { runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } }, packs: [path.join(root, 'pack', 'pack.mjs')] };
  const status = report => report.requirements.find(row => row.id === `plugin-step:${STEP}`)?.status;
  assert.equal(status(await preflight({ ...options, env: {} })), 'unsupported', 'without the preset the handler is unresolved');
  const offline = await preflight({ ...options, preset: 'seed', env: {} });
  const sim = await createSimulator({ ...options, preset: 'seed', port: 0, watch: false });
  t.after(() => sim.close());
  assert.equal(status(offline), status(await sim.preflight()));
  assert.equal(status(offline), 'satisfied');
});
