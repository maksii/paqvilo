// @test-kind security: the standalone main listener refuses browser-shaped administration requests, so the administration is reached only on its own origin, and programmatic callers keep the admin token.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeFixtureDirectory, send, startDryRunSimulator, writeFixtureFiles } from './support/origin-requests.mjs';

async function fixture(t) {
  const root = await makeFixtureDirectory(t, 'standalone-admin-gate-');
  await writeFixtureFiles(path.join(root, 'solution'), {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedGate</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  });
  return startDryRunSimulator(t, root, {
    runtime: { kind: 'dataverse-api' },
    dataverse: { tls: false, tds: { enabled: false } },
  });
}

const codeOf = (response) => response.json?.error?.code;

test('a browser-shaped write to the administration on the main listener is refused with AdminOriginRequired', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.url, {
    method: 'POST',
    target: '/_sim/api/trace/clear',
    headers: { origin: sim.url, 'sec-fetch-site': 'same-origin', 'x-sim-csrf': sim.csrf },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'AdminOriginRequired');
});

test('a browser-shaped trace event stream on the main listener is refused with AdminOriginRequired', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.url, {
    target: '/_sim/events?channels=trace',
    headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'AdminOriginRequired');
});

test('a navigation to the administration on the main listener redirects to the admin origin with path and query', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.url, {
    target: '/_sim/?tab=trace',
    headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${sim.adminOrigin}/_sim/?tab=trace`);
});

test('the staff session is served to a browser-shaped request on the main listener', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.url, {
    target: '/_sim/api/dataverse/session',
    headers: { origin: sim.url, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(response.status, 200);
});

test('a header-less administration request on the main listener is served with the admin token', async (t) => {
  const sim = await fixture(t);
  const status = await send(sim.url, { target: '/_sim/api/status' });
  assert.equal(status.status, 200);
  assert.equal(status.json.csrf, sim.csrf);
  const clear = await send(sim.url, {
    method: 'POST',
    target: '/_sim/api/trace/clear',
    headers: { 'x-sim-csrf': sim.csrf },
  });
  assert.equal(clear.status, 200);
});

test('the admin URL and setup URL point at the admin origin, and the root redirects there without a model-driven app', async (t) => {
  const sim = await fixture(t);
  assert.equal(sim.adminUrl, `${sim.adminOrigin}/_sim/`);
  assert.equal(sim.setupUrl, `${sim.adminOrigin}/_setup/`);
  const status = await send(sim.url, { target: '/_sim/api/status' });
  assert.equal(status.json.adminUrl, `${sim.adminOrigin}/_sim/`);
  const root = await send(sim.url, { target: '/' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, `${sim.adminOrigin}/_sim/`);
});
