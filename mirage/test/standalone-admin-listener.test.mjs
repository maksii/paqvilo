// @test-kind security: the standalone administration listener is a second origin whose gate and token decide which browser requests reach the administration, so its verdicts and token scope are safety guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ADMIN_CSP } from '../lib/runtime-admin.mjs';
import { makeFixtureDirectory, send, startDryRunSimulator, writeFixtureFiles } from './support/origin-requests.mjs';

const TOKEN = /^[a-f0-9]{64}$/;

async function fixture(t) {
  const root = await makeFixtureDirectory(t, 'standalone-admin-listener-');
  await writeFixtureFiles(path.join(root, 'solution'), {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedAdmin</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml':
      '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
  });
  return startDryRunSimulator(t, root, { runtime: { kind: 'model-driven' } });
}

const codeOf = (response) => response.json?.error?.code;
const browserWrite = (origin, token, { target = '/_sim/api/trace/clear', headers = {} } = {}) => ({
  method: 'POST',
  target,
  headers: { origin, 'sec-fetch-site': 'same-origin', 'x-sim-csrf': token, ...headers },
});

test('the admin listener binds the main host literal on its own port and answers once it has listened', async (t) => {
  const sim = await fixture(t);
  const main = new URL(sim.url);
  const admin = new URL(sim.adminOrigin);
  assert.equal(admin.hostname, main.hostname);
  assert.notEqual(admin.port, main.port);
  assert.equal((await send(sim.adminOrigin, { target: '/_sim/' })).status, 200);
});

test('a header-less administration page is served on the admin origin under the admin content security policy', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.adminOrigin, { target: '/_sim/' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-security-policy'], ADMIN_CSP);
});

test('the admin token is the status and state token, and the apps token is a separate secret', async (t) => {
  const sim = await fixture(t);
  const status = await send(sim.adminOrigin, { target: '/_sim/api/status' });
  assert.equal(status.status, 200);
  assert.match(sim.csrf, TOKEN);
  assert.equal(status.json.csrf, sim.csrf);
  assert.match(sim.appsToken, TOKEN);
  assert.notEqual(sim.appsToken, sim.csrf);
});

test('the apps token from the shell meta is refused by the administration, and the shell carries no portal address', async (t) => {
  const sim = await fixture(t);
  const shell = await send(sim.url, { target: '/main.aspx' });
  assert.equal(shell.status, 200);
  const appsToken = /<meta name="mirage-csrf" content="([a-f0-9]{64})"/.exec(shell.text)?.[1];
  assert.equal(appsToken, sim.appsToken);
  assert.match(shell.text, /<meta name="mirage-portal" content=""/);
  const refused = await send(sim.adminOrigin, browserWrite(sim.adminOrigin, appsToken, { target: '/_sim/api/config' }));
  assert.equal(refused.status, 403);
});

test('the admin token is accepted on an apps write wherever the apps token is', async (t) => {
  const sim = await fixture(t);
  const write = (token) =>
    send(sim.url, { method: 'POST', target: '/_apps/api/unknown-route', headers: { 'x-sim-csrf': token } });
  const withApps = await write(sim.appsToken);
  const withAdmin = await write(sim.csrf);
  assert.equal(withAdmin.status, withApps.status);
  assert.notEqual(withAdmin.status, 403);
});

test('a browser write carrying the portal origin is refused by the admin listener', async (t) => {
  const sim = await fixture(t);
  const response = await send(
    sim.adminOrigin,
    browserWrite(sim.url, sim.csrf, { headers: { 'sec-fetch-site': 'same-site' } }),
  );
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'CrossOriginAdminRequest');
});

test('a cross-site read of the administration is refused by the admin listener', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.adminOrigin, {
    target: '/_sim/api/status',
    headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'CrossSiteAdminRequest');
});

test('a same-origin write without an Origin header is refused by the admin listener', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.adminOrigin, {
    method: 'POST',
    target: '/_sim/api/trace/clear',
    headers: { 'sec-fetch-site': 'same-origin', 'x-sim-csrf': sim.csrf },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'CrossOriginAdminRequest');
});

test('a same-origin write on the admin origin with the admin token is served', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.adminOrigin, browserWrite(sim.adminOrigin, sim.csrf));
  assert.equal(response.status, 200);
});

test('a navigation to the administration is served by the admin listener', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.adminOrigin, {
    target: '/_sim/',
    headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' },
  });
  assert.equal(response.status, 200);
});

test('a navigation to a portal path on the admin listener redirects to the portal with path and query', async (t) => {
  const sim = await fixture(t);
  const root = await send(sim.adminOrigin, {
    target: '/',
    headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' },
  });
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, `${sim.url}/`);
  const signIn = await send(sim.adminOrigin, { target: '/__sim/sign-in?persona=x' });
  assert.equal(signIn.status, 302);
  assert.equal(signIn.headers.location, `${sim.url}/__sim/sign-in?persona=x`);
});

test('a protocol-relative path on the admin listener redirects to a path on the portal host only', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.adminOrigin, { target: '//evil.example/x' });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.location);
  assert.equal(location.origin, sim.url);
  assert.equal(location.pathname, '/x');
});

test('a write to a portal path on the admin listener is refused with PortalOriginRequired', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.adminOrigin, { method: 'POST', target: '/_api/contacts' });
  assert.equal(response.status, 404);
  assert.equal(codeOf(response), 'PortalOriginRequired');
});

test('a Host header naming the portal is refused by the admin listener', async (t) => {
  const sim = await fixture(t);
  const response = await send(sim.adminOrigin, { target: '/_sim/', headers: { host: new URL(sim.url).host } });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'RuntimeRequestInvalid');
});

test('after close the admin listener refuses connections', async (t) => {
  const sim = await fixture(t);
  const admin = sim.adminOrigin;
  await sim.close();
  await assert.rejects(send(admin, { target: '/_sim/' }), { code: 'ECONNREFUSED' });
});
