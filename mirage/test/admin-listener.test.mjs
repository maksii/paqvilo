// @test-kind security: the Power Pages admin listener is a second origin whose gate decides which browser requests reach the administration, so its verdicts, redirects and shutdown are safety guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_CSP } from '../lib/runtime-admin.mjs';
import { emptyLocalState, makeFixtureDirectory, send, startLocalSimulator } from './support/origin-requests.mjs';

async function fixture(t) {
  const dir = await makeFixtureDirectory(t, 'admin-listener-');
  return startLocalSimulator(t, dir, emptyLocalState());
}

const codeOf = (response) => response.json?.error?.code;
const navigation = { 'sec-fetch-mode': 'navigate' };

test('the admin listener binds the portal host literal on its own port and is announced once it listens', async (t) => {
  const app = await fixture(t);
  assert.match(app.adminOrigin, /^http:\/\/[^/]+:\d+$/);
  const portal = new URL(app.url);
  const admin = new URL(app.adminOrigin);
  assert.equal(admin.hostname, portal.hostname);
  assert.notEqual(admin.port, portal.port);
});

test('a header-less administration page is served on the admin origin under the admin content security policy', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, { target: '/_sim/' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-security-policy'], ADMIN_CSP);
});

test('a header-less status request is served on the admin origin', async (t) => {
  const app = await fixture(t);
  assert.equal((await send(app.adminOrigin, { target: '/__sim/api/status' })).status, 200);
});

test('a browser write whose Origin is the portal is refused by the admin origin gate', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, {
    method: 'POST',
    target: '/__sim/api/trace/clear',
    headers: { origin: app.url, 'sec-fetch-site': 'same-site', 'x-sim-csrf': app.csrf },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'CrossOriginAdminRequest');
});

test('a cross-site browser read of the admin API is refused by the admin origin gate', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, {
    target: '/__sim/api/status',
    headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'CrossSiteAdminRequest');
});

test('a same-origin browser write without an Origin header is refused by the admin origin gate', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, {
    method: 'POST',
    target: '/_sim/api/trace/clear',
    headers: { 'sec-fetch-site': 'same-origin', 'x-sim-csrf': app.csrf },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'CrossOriginAdminRequest');
});

test('a same-origin browser write from the admin origin with the token is served', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, {
    method: 'POST',
    target: '/_sim/api/trace/clear',
    headers: { origin: app.adminOrigin, 'sec-fetch-site': 'same-origin', 'x-sim-csrf': app.csrf },
  });
  assert.equal(response.status, 200);
});

test('a same-site navigation to the administration page is served', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, {
    target: '/_sim/',
    headers: { 'sec-fetch-site': 'same-site', ...navigation },
  });
  assert.equal(response.status, 200);
});

test('a navigation to the admin origin root is sent back to the portal root', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, { target: '/', headers: navigation });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${app.url}/`);
});

test('a sign-in page request on the admin origin is sent back to the portal with its query', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, { target: '/__sim/sign-in?persona=x', headers: navigation });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${app.url}/__sim/sign-in?persona=x`);
});

test('a network-path request target on the admin origin stays a path on the portal host', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, { target: '//evil.example/x', headers: navigation });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${app.url}//evil.example/x`);
});

test('a portal API write on the admin origin is refused with the portal origin code', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, { method: 'POST', target: '/_api/contacts' });
  assert.equal(response.status, 404);
  assert.equal(codeOf(response), 'PortalOriginRequired');
});

test('a request whose Host is the portal host is refused on the admin origin', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, {
    target: '/__sim/api/status',
    headers: { host: new URL(app.url).host },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'INVALID_REQUEST');
  assert.equal(response.json?.error?.message, 'Invalid Host header.');
});

test('a foreign Host on a path the admin origin does not serve is refused before any redirect', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, {
    target: '/anything',
    headers: { ...navigation, host: 'evil.invalid' },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'INVALID_REQUEST');
  assert.equal(response.json?.error?.message, 'Invalid Host header.');
  assert.equal(response.headers.location, undefined);
});

test('a foreign Host with a foreign Origin is refused with the Host answer on the admin origin', async (t) => {
  const app = await fixture(t);
  const response = await send(app.adminOrigin, {
    target: '/__sim/api/state',
    headers: { host: 'evil.invalid', origin: 'http://evil.invalid', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'INVALID_REQUEST');
  assert.equal(response.json?.error?.message, 'Invalid Host header.');
});

test('after close the admin origin refuses connections', async (t) => {
  const app = await fixture(t);
  const adminOrigin = app.adminOrigin;
  await app.close();
  await assert.rejects(send(adminOrigin, { target: '/_sim/' }), { code: 'ECONNREFUSED' });
});
