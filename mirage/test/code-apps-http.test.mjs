import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCodeAppsHandler, authorityTokenIssuer } from '../lib/code-apps-http.mjs';
import { createAuthority } from '../lib/dataverse-auth.mjs';
import { sequentialIds } from '../lib/runtime-clock.mjs';

const STAFF = '77777777-7777-4777-8777-777777777777';
const SYSTEM = '66666666-6666-4666-8666-666666666666';
const TENANT = '55555555-5555-4555-8555-555555555555';
const APP_ID = '44444444-4444-4444-8444-444444444444';
const DATAVERSE = 'http://127.0.0.1:47001';
const CSRF = 'invented-csrf';
const row = { systemuserid: STAFF, fullname: 'Avery Invented', azureactivedirectoryobjectid: '33333333-3333-4333-8333-333333333333', domainname: 'avery@invented.example.test' };

// Fake staff resolver with the createStaffSessions().resolve contract: no persona → local-admin; invalid → throws 401.
const sessions = { resolve(req) {
  const id = req.headers['x-test-staff'];
  if (id === undefined) return { principalId: SYSTEM, kind: 'local-admin' };
  if (id !== STAFF) throw Object.assign(new Error('The selected staff user is unavailable or disabled.'), { status: 401, code: 'StaffPrincipalUnavailable' });
  return { principalId: STAFF, kind: 'staff' };
} };

async function fixture(t, { apps, connectors, ids } = {}) {
  const calls = { dataverse: [], connectors: [], tokens: [], diagnostics: [] };
  const handler = createCodeAppsHandler({
    apps: () => apps ?? [
      { name: 'invented', appId: APP_ID, environmentId: 'env-invented', localAppUrl: 'http://localhost:3000/',
        connectionReferences: [{ key: 'ref-one', apiId: 'shared_fx_invented', dataSources: ['FxInvented'] }] },
      { name: 'bare', appId: APP_ID, connectionReferences: [] },
    ],
    sessions, user: id => id === STAFF ? row : null,
    organization: { origin: DATAVERSE, organizationId: 'org-invented', environmentId: 'env-org', tenantId: TENANT },
    issueToken: ({ resource, user, app }) => { calls.tokens.push({ resource, user: user.systemuserid, app: app.name }); return { access_token: 'token-value', expires_on: 1999999999 }; },
    dataverse: async request => {
      calls.dataverse.push(request);
      if (request.method === 'DELETE') return { status: 204 };
      return { status: request.method === 'POST' ? 201 : 200, headers: { 'odata-version': '4.0' }, body: { echoed: request.body ?? null } };
    },
    connectors: connectors && (async input => { calls.connectors.push(input); return connectors(input); }),
    csrf: () => CSRF,
    diagnostic: record => calls.diagnostics.push(record),
    ids,
  });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res))) { res.writeHead(418); res.end('fallthrough'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = 'GET', staff = STAFF, csrf, body, headers = {} } = {}) => fetch(url + path, { method, redirect: 'manual',
    headers: { ...(staff ? { 'x-test-staff': staff } : {}), ...(csrf ? { 'x-sim-csrf': csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { url, request, calls };
}

async function json(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
}

test('context returns the documented IContext shape from the staff session', async t => {
  const { url, request } = await fixture(t);
  const response = await request('/_apps/code/invented/context?recordId=42&mode=edit');
  const context = await json(response, 200);
  assert.equal(response.headers.get('x-sim-csrf'), CSRF);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(context).sort(), ['app', 'host', 'user']);
  assert.deepEqual(context.app, { appId: APP_ID, environmentId: 'env-invented', queryParams: { recordId: '42', mode: 'edit' }, dataverseOrgUrl: DATAVERSE, appUrl: `${url}/_apps/code/invented/` });
  assert.deepEqual(context.user, { fullName: 'Avery Invented', objectId: row.azureactivedirectoryobjectid, systemUserId: STAFF, tenantId: TENANT, userPrincipalName: row.domainname });
  assert.match(context.host.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal((await json(await request('/_apps/code/bare/context'), 200)).app.environmentId, 'env-org');
});

test('context answers 401 without a staff persona or with an unavailable one', async t => {
  const { request } = await fixture(t);
  assert.equal((await json(await request('/_apps/code/invented/context', { staff: null }), 401)).error.code, 'StaffSessionRequired');
  assert.equal((await json(await request('/_apps/code/invented/context', { staff: 'invalid' }), 401)).error.code, 'StaffPrincipalUnavailable');
});

test('token audience is the local Dataverse origin only, with CSRF, and carries expiry', async t => {
  const { request, calls } = await fixture(t);
  assert.equal((await json(await request('/_apps/code/invented/token', { method: 'POST', body: { resource: DATAVERSE } }), 403)).error.code, 'CsrfRequired');
  for (const resource of [DATAVERSE, DATAVERSE + '/', DATAVERSE + '/.default']) {
    const token = await json(await request('/_apps/code/invented/token', { method: 'POST', csrf: CSRF, body: { resource } }), 200);
    assert.deepEqual(token, { access_token: 'token-value', expires_on: 1999999999 });
  }
  assert.deepEqual(calls.tokens[0], { resource: DATAVERSE, user: STAFF, app: 'invented' });
  for (const resource of ['https://graph.example.test', 'http://127.0.0.1:1', DATAVERSE + '/api', 'not a url', undefined])
    assert.equal((await json(await request('/_apps/code/invented/token', { method: 'POST', csrf: CSRF, body: { resource } }), 400)).error.code, 'InvalidResource');
  assert.equal(calls.tokens.length, 3);
  assert.equal(calls.diagnostics.filter(d => d.code === 'CODEAPP_TOKEN_REFUSED').length, 5);
  assert.ok(!JSON.stringify(calls.diagnostics).includes('token-value'));
});

test('authorityTokenIssuer mints a token the Dataverse authority accepts for its origin', () => {
  const authority = createAuthority({ tenantId: TENANT, applications: () => [], users: { byObjectId: () => null } });
  const issue = authorityTokenIssuer({ issueAccessToken: authority.issueAccessToken, origin: DATAVERSE });
  const { access_token, expires_on } = issue({ resource: DATAVERSE, user: row, app: { appId: APP_ID } });
  assert.ok(expires_on > Date.now() / 1000);
  const verdict = authority.verifyBearer(`Bearer ${access_token}`, { origin: DATAVERSE });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.claims.oid, row.azureactivedirectoryobjectid);
  assert.equal(verdict.claims.appid, APP_ID);
  assert.equal(authority.verifyBearer(`Bearer ${access_token}`, { origin: 'http://127.0.0.1:1' }).ok, false);
});

test('dataverse proxy forwards method, path, query and body as the staff principal and enforces CSRF on every method', async t => {
  const { request, calls } = await fixture(t);
  // Dataverse functions are GET and some write (CalculateRollupField), so GET needs the token too.
  assert.equal((await json(await request('/_apps/code/invented/dataverse/x_items?$select=x_name', { headers: { prefer: 'odata.maxpagesize=5' } }), 403)).error.code, 'CsrfRequired');
  assert.equal(calls.dataverse.length, 0);
  const read = await request('/_apps/code/invented/dataverse/x_items?$select=x_name', { csrf: CSRF, headers: { prefer: 'odata.maxpagesize=5', cookie: 'not-forwarded=1' } });
  assert.equal(read.headers.get('odata-version'), '4.0');
  await json(read, 200);
  assert.deepEqual(calls.dataverse[0], { method: 'GET', path: '/api/data/v9.2/x_items', search: '?$select=x_name', headers: { accept: '*/*', prefer: 'odata.maxpagesize=5' }, body: undefined, principal: { principalId: STAFF, kind: 'staff' } });

  assert.equal((await json(await request('/_apps/code/invented/dataverse/x_items', { method: 'POST', body: { x_name: 'One' } }), 403)).error.code, 'CsrfRequired');
  assert.equal(calls.dataverse.length, 1);
  assert.deepEqual(await json(await request('/_apps/code/invented/dataverse/x_items', { method: 'POST', csrf: CSRF, body: { x_name: 'One' } }), 201), { echoed: { x_name: 'One' } });
  await json(await request(`/_apps/code/invented/dataverse/x_items(${STAFF})`, { method: 'PATCH', csrf: CSRF, body: { x_name: 'Two' }, headers: { 'if-match': '*' } }), 200);
  assert.deepEqual([calls.dataverse[2].method, calls.dataverse[2].path, calls.dataverse[2].headers['if-match']], ['PATCH', `/api/data/v9.2/x_items(${STAFF})`, '*']);
  assert.equal((await request(`/_apps/code/invented/dataverse/x_items(${STAFF})`, { method: 'DELETE', csrf: CSRF })).status, 204);
  assert.equal((await json(await request('/_apps/code/invented/dataverse/x_items', { method: 'POST', csrf: CSRF, body: undefined, headers: { 'content-type': 'application/json' } }), 201)).echoed, null);
  assert.equal((await json(await request('/_apps/code/invented/dataverse/x_items', { staff: null, csrf: CSRF }), 401)).error.code, 'StaffSessionRequired');
});

test('connector calls answer 501 ConnectorNotSimulated by default and use an injected hook', async t => {
  const plain = await fixture(t);
  const refused = await json(await plain.request('/_apps/code/invented/connectors/ref-one/GetInvented', { method: 'POST', csrf: CSRF, body: {} }), 501);
  assert.equal(refused.error.code, 'ConnectorNotSimulated');
  assert.match(refused.error.message, /GetInvented/);
  assert.equal(plain.calls.diagnostics[0].code, 'CODEAPP_CONNECTOR_NOT_SIMULATED');
  assert.equal((await json(await plain.request('/_apps/code/invented/connectors/ref-missing/GetInvented', { method: 'POST', csrf: CSRF, body: {} }), 404)).error.code, 'ConnectionReferenceNotFound');
  assert.equal((await json(await plain.request('/_apps/code/invented/connectors/%E0%A4%A/op', { method: 'POST', csrf: CSRF, body: {} }), 404)).error.code, 'ConnectionReferenceNotFound');
  assert.equal((await json(await plain.request('/_apps/code/invented/connectors/ref-one/%E0%A4%A', { method: 'POST', csrf: CSRF, body: {} }), 404)).error.code, 'ConnectionReferenceNotFound');
  assert.equal((await json(await plain.request('/_apps/code/invented/connectors/ref-one/GetInvented', { method: 'POST', body: {} }), 403)).error.code, 'CsrfRequired');

  const hooked = await fixture(t, { connectors: ({ operationId, body }) => operationId === 'Echo' ? { echoed: body } : undefined });
  assert.deepEqual(await json(await hooked.request('/_apps/code/invented/connectors/FxInvented/Echo', { method: 'POST', csrf: CSRF, body: { a: 1 } }), 200), { echoed: { a: 1 } });
  const input = hooked.calls.connectors[0];
  assert.deepEqual([input.app.name, input.reference.key, input.operationId, input.principal], ['invented', 'ref-one', 'Echo', { principalId: STAFF, kind: 'staff' }]);
  assert.equal((await hooked.request('/_apps/code/invented/connectors/ref-one/Other', { method: 'POST', csrf: CSRF, body: {} })).status, 501);
});

test('host sessionId comes from the injected ids seam, so sequentialIds makes it deterministic', async t => {
  const { request } = await fixture(t, { ids: sequentialIds() });
  const context = await json(await request('/_apps/code/invented/context', { csrf: CSRF }), 200);
  assert.equal(context.host.sessionId, sequentialIds().uuid());
  assert.equal(context.host.sessionId, (await json(await request('/_apps/code/bare/context', { csrf: CSRF }), 200)).host.sessionId);
});

test('unknown apps and resources are 404 and other paths fall through', async t => {
  const { request } = await fixture(t);
  assert.equal((await json(await request('/_apps/code/missing/context'), 404)).error.code, 'CodeAppNotFound');
  assert.equal((await json(await request('/_apps/code/invented/unknown'), 404)).error.code, 'CodeAppResourceNotFound');
  assert.equal((await request('/_apps/canvas/x')).status, 418);
  assert.equal((await request('/_apps/codex/invented/')).status, 418);
  const redirect = await request('/_apps/code/invented?x=1');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/_apps/code/invented/?x=1');
});

test('loader frames localAppUrl with locked-down headers and escapes untrusted text', async t => {
  const { request } = await fixture(t, { apps: [
    { name: 'framed', localAppUrl: 'http://localhost:3000/start?q="><script>', connectionReferences: [] },
    { name: 'x<script>alert(1)</script>', connectionReferences: [] },
  ] });
  const framed = await request('/_apps/code/framed/?mode=edit&v="<b>', { staff: null });
  const html = await framed.text();
  assert.equal(framed.status, 200);
  assert.equal(framed.headers.get('cache-control'), 'no-store');
  assert.equal(framed.headers.get('x-content-type-options'), 'nosniff');
  assert.match(framed.headers.get('content-security-policy'), /default-src 'self'; script-src 'self'.*frame-src http:\/\/localhost:3000$/);
  assert.match(html, /<iframe src="http:\/\/localhost:3000\/start\?q=/);
  assert.match(html, /mode=edit/);
  assert.doesNotMatch(html, /<script|"><b>/);

  const unset = await request('/_apps/code/' + encodeURIComponent('x<script>alert(1)</script>') + '/', { staff: null });
  const text = await unset.text();
  assert.equal(unset.status, 200);
  assert.match(text, /No localAppUrl is configured/);
  assert.match(text, /x&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(text, /<script>/);
  assert.doesNotMatch(unset.headers.get('content-security-policy'), /frame-src/);
});

test('browser shim calls the endpoints with the CSRF header from context', async t => {
  const { url, calls } = await fixture(t);
  const original = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => original(input, { ...init, headers: { ...init.headers, 'x-test-staff': STAFF } });
  t.after(() => { globalThis.fetch = original; });
  const shim = await import('../lib/code-apps-client.js');
  await assert.rejects(shim.getContext(), /configure/);
  shim.configure({ app: 'invented', origin: url });
  assert.equal((await shim.getContext()).user.systemUserId, STAFF);
  assert.equal((await shim.getToken(DATAVERSE)).expires_on, 1999999999);
  assert.deepEqual(await shim.dataClient.create('x_items', { x_name: 'One' }), { data: { echoed: { x_name: 'One' } } });
  await shim.dataClient.getAll('x_items', { select: ['x_name'], top: 2, filter: "x_name eq 'One'" });
  await shim.dataClient.update('x_items', `{${STAFF}}`, { x_name: 'Two' });
  assert.deepEqual(await shim.dataClient.delete('x_items', STAFF), { data: undefined });
  assert.deepEqual(calls.dataverse.map(c => [c.method, c.path, c.search]), [
    ['POST', '/api/data/v9.2/x_items', ''],
    ['GET', '/api/data/v9.2/x_items', "?%24select=x_name&%24filter=x_name+eq+%27One%27&%24top=2"],
    ['PATCH', `/api/data/v9.2/x_items(${STAFF})`, ''],
    ['DELETE', `/api/data/v9.2/x_items(${STAFF})`, ''],
  ]);
  await assert.rejects(shim.dataClient.execute('ref-one', 'GetInvented', {}), error => error.status === 501 && error.code === 'ConnectorNotSimulated');
});
