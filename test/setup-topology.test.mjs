import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { SetupStore } from '../lense/setup/store.mjs';
import { setupTemplates } from '../lense/setup/templates.mjs';
import { plannedTopology } from '../lense/setup/topology.mjs';

async function snapshotOf(t, kind, document) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-setup-topology-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = path.join(directory, kind === 'project' ? 'mirage.project.yml' : 'paqvilo.config.yml');
  await fs.writeFile(file, YAML.stringify(document));
  return new SetupStore({ directory, ...(kind === 'project' ? { project: file } : {}), processEnv: {} }).snapshot();
}
const template = (kind, id) => setupTemplates(kind).find(item => item.id === id).document;

test('full-stack configuration plans every declared piece with dashboard node ids', async t => {
  const { nodes, edges } = plannedTopology(await snapshotOf(t, 'catalogue', template('catalogue', 'full-stack')));
  const byId = Object.fromEntries(nodes.map(item => [item.id, item]));
  for (const id of ['client:browser', 'client:api', 'client:lense', 'host:portal', 'host:dataverse-api', 'host:identity-provider', 'host:setup', 'host:admin',
    'org:store', 'org:flows', 'provider:storage', 'provider:storage-route:dataverseFiles', 'provider:storage-route:annotations', 'provider:messaging',
    'provider:messaging-endpoint:x_invented_queue', 'provider:outbox', 'provider:connectors', 'connection:invented-fixture', 'provider:secrets',
    'provider:local-service:invented-api', 'persona-runtime:invented-portal']) assert.equal(byId[id]?.status, 'planned', id);
  assert.equal(byId['host:model-driven'].status, 'disabled');
  assert.equal(byId['provider:secrets'].detail.references, 1);
  assert.doesNotMatch(JSON.stringify(nodes), /INVENTED_API_KEY/);
  assert.equal(byId['persona-runtime:invented-portal'].detail.maxInstances, 4);
  for (const item of nodes) assert.equal(item.kind, item.id.split(':')[0]);
  for (const item of edges) assert.ok(byId[item.from] && byId[item.to] && ['planned', 'disabled'].includes(item.status), JSON.stringify(item));
  assert.equal(edges.find(item => item.from === 'client:api').status, 'planned');
});

test('configuration that turns a surface off marks it disabled and packs become org nodes', async t => {
  const document = template('project', 'dataverse-api');
  document.dataverse.enabled = false;
  document.dataPacks = [{ id: 'invented-pack', module: './pack/pack.mjs' }];
  const { nodes, edges } = plannedTopology(await snapshotOf(t, 'project', document));
  const byId = Object.fromEntries(nodes.map(item => [item.id, item]));
  assert.equal(byId['host:dataverse-api'].status, 'disabled');
  assert.equal(byId['host:portal'].status, 'disabled');
  assert.equal(byId['client:lense'], undefined);
  assert.equal(byId['org:pack:invented-pack'].kind, 'org');
  assert.equal(byId['org:pack:invented-pack'].status, 'missing');
  assert.equal(edges.find(item => item.from === 'client:api' && item.to === 'host:dataverse-api').status, 'disabled');
  assert.equal(byId['provider:storage'], undefined);
});

test('configuration summary lists packs, solution layers, setting names and ports without values', async t => {
  const document = template('catalogue', 'full-stack');
  const site = document.sites['invented-portal'];
  site.mirage.dataPacks = [{ id: 'invented-pack', module: './pack/pack.mjs' }];
  site.mirage.solutionRoots = ['./solutions/x_core'];
  site.mirage.dataverse = { enabled: true, port: 5555, tls: true, tlsPort: 0, tds: { enabled: true, port: 1433 } };
  site.mirage.port = 8787;
  const { configuration } = plannedTopology(await snapshotOf(t, 'catalogue', document));
  assert.deepEqual(configuration.packs, [{ id: 'invented-pack', module: 'pack/pack.mjs' }]);
  assert.deepEqual(configuration.solutionLayers, ['solutions/x_core']);
  for (const key of ['providers', 'secrets', 'connections', 'localServices', 'dataverse', 'port', 'dataPacks', 'source', 'environments']) assert.ok(configuration.settingsKeys.includes(key), key);
  assert.deepEqual(configuration.ports, { portal: 8787, dataverseApi: 5555, dataverseTls: 0, tds: 1433, identityProvider: 8787 });
  assert.doesNotMatch(JSON.stringify(configuration), /INVENTED_API_KEY|example\.test|127\.0\.0\.1/);

  const api = plannedTopology(await snapshotOf(t, 'project', template('project', 'dataverse-api'))).configuration;
  assert.deepEqual(api.ports, { portal: null, dataverseApi: 0, dataverseTls: null, tds: 0, identityProvider: null });
  assert.deepEqual(api.solutionLayers, ['solutions/x_core']);
  assert.deepEqual(api.packs, []);
  assert.ok(api.settingsKeys.includes('dataverse') && api.settingsKeys.includes('simulation'));
});
