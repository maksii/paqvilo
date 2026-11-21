// @test-kind contract: Mirage's loopback listeners leave closing an idle connection to the client and to close(); a timed close resets the request a client writes on that pooled connection after a busy stretch. No native behaviour is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startIdentityProvider } from '../lib/identity-provider.mjs';
import { createSharePointFixtureServer } from '../lib/sharepoint-contract.mjs';
import { startAzuriteFake } from '../testing/azurite-fake.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import {
  emptyLocalState,
  makeFixtureDirectory,
  startDryRunSimulator,
  startLocalSimulator,
  writeFixtureFiles,
} from './support/origin-requests.mjs';

// Node announces a timed idle close as `Keep-Alive: timeout=N` on every kept-alive answer; whatever the status, a
// listener that keeps its idle connections answers keep-alive without it.
async function assertKeepsIdleConnections(url) {
  const response = await fetch(url, { redirect: 'manual' });
  await response.arrayBuffer();
  assert.equal(response.headers.get('connection'), 'keep-alive', url);
  assert.equal(response.headers.get('keep-alive'), null, url);
}

test('the portal runtime keeps idle connections on its portal, administration and apps listeners', async (t) => {
  const dir = await makeFixtureDirectory(t, 'idle-connections-portal-');
  await writeFixtureFiles(dir, { 'website.yml': 'adx_websiteid: site\nadx_name: Idle\n' });
  const sim = await startLocalSimulator(t, dir, emptyLocalState());
  const origins = [sim.url, sim.adminOrigin, sim.appsOrigin];
  assert.equal(new Set(origins.map((origin) => new URL(origin).port)).size, 3);
  for (const origin of origins) await assertKeepsIdleConnections(`${origin}/`);
});

test('the standalone runtime keeps idle connections on its main and administration listeners', async (t) => {
  const root = await makeFixtureDirectory(t, 'idle-connections-standalone-');
  await writeFixtureFiles(path.join(root, 'solution'), {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedIdle</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  });
  const sim = await startDryRunSimulator(t, root, { runtime: { kind: 'model-driven' } });
  assert.notEqual(new URL(sim.adminOrigin).port, new URL(sim.url).port);
  for (const origin of [sim.url, sim.adminOrigin]) await assertKeepsIdleConnections(`${origin}/_sim/`);
});

test('the identity provider, SharePoint fixture and Azurite fake listeners keep idle connections', async (t) => {
  const idp = await startIdentityProvider({ providers: () => [], users: () => [] });
  ownedFixture(t).add(() => idp.close());
  await assertKeepsIdleConnections(`${idp.origin}/`);
  const sharePoint = await createSharePointFixtureServer({ fixtures: { sites: {}, drives: {}, items: [] } });
  ownedFixture(t).add(() => sharePoint.close());
  await assertKeepsIdleConnections(`${sharePoint.url}/`);
  const azurite = await startAzuriteFake();
  ownedFixture(t).add(() => azurite.close());
  await assertKeepsIdleConnections(azurite.blobEndpoint);
});
