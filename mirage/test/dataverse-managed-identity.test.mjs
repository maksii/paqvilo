import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAuthority } from '../lib/dataverse-auth.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { createManagedIdentityEndpoints, seedManagedIdentityRows } from '../lib/dataverse-managed-identity.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createSimulator } from '../server.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const ORIGIN = 'https://127.0.0.1:9443';
const TENANT = '7e1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7';
const APP_CLIENT = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const APP_PRINCIPAL = '4d5e6f70-8b9c-4d0e-9f1a-2b3c4d5e6f70';
const OTHER_CLIENT = '5e6f7081-9c0d-4e1f-8a2b-3c4d5e6f7081';
const OTHER_PRINCIPAL = '6f708192-0d1e-4f2a-9b3c-4d5e6f708192';
const ORG = '0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const SETTINGS = {
  managedIdentities: [
    { clientId: APP_CLIENT, principalId: APP_PRINCIPAL, displayName: 'first', roles: ['Basic User'] },
    { clientId: OTHER_CLIENT, principalId: OTHER_PRINCIPAL, displayName: 'second', roles: ['Basic User'] },
  ],
};

const authority = () =>
  createAuthority({ tenantId: TENANT, applications: () => [], users: { byObjectId: () => null, list: () => [] } });
const query = (params) => new URLSearchParams(params);
const get = (endpoints, path, params, headers = {}) =>
  endpoints.handle({ method: 'GET', pathname: path, searchParams: query(params), headers });
const appService = (endpoints, params, headers = {}) =>
  get(
    endpoints,
    '/msi/token',
    { 'api-version': '2019-08-01', ...params },
    { 'x-identity-header': endpoints.env().IDENTITY_HEADER, ...headers },
  );
const IMDS = '/metadata/identity/oauth2/token';
const imds = (endpoints, params, headers = { metadata: 'true' }) =>
  get(endpoints, IMDS, { 'api-version': '2018-02-01', ...params }, headers);

test('App Service: token for the selected identity, with the documented fields', () => {
  const endpoints = createManagedIdentityEndpoints({ authority: authority(), settings: SETTINGS, origin: ORIGIN });
  const res = appService(endpoints, { resource: ORIGIN, 'api-version': '2019-08-01' });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['access_token', 'client_id', 'expires_on', 'resource', 'token_type']);
  assert.equal(res.body.client_id, APP_CLIENT);
  assert.equal(res.body.resource, ORIGIN);
  assert.equal(res.body.token_type, 'Bearer');
  assert.match(res.body.expires_on, /^\d+$/);
  assert.ok(res.body.access_token.length > 0);
});

test('App Service: client_id, principal_id, object_id (alias) select; several selectors or an unknown identity fail', () => {
  const endpoints = createManagedIdentityEndpoints({ authority: authority(), settings: SETTINGS, origin: ORIGIN });
  assert.equal(appService(endpoints, { resource: ORIGIN, client_id: OTHER_CLIENT }).body.client_id, OTHER_CLIENT);
  assert.equal(appService(endpoints, { resource: ORIGIN, principal_id: OTHER_PRINCIPAL }).body.client_id, OTHER_CLIENT);
  assert.equal(
    appService(endpoints, { resource: ORIGIN, object_id: OTHER_PRINCIPAL.toUpperCase() }).body.client_id,
    OTHER_CLIENT,
  );
  assert.equal(
    appService(endpoints, { resource: ORIGIN, client_id: OTHER_CLIENT, principal_id: OTHER_PRINCIPAL }).status,
    400,
  );
  const unknown = appService(endpoints, { resource: ORIGIN, client_id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, 'unauthorized_client');
  assert.equal(
    appService(endpoints, { resource: ORIGIN, mi_res_id: '/subscriptions/x' }).body.error,
    'unauthorized_client',
  ); // settings carry no ARM resource ids
});

test('App Service: wrong or missing X-IDENTITY-HEADER is refused; a foreign resource is invalid_resource', () => {
  const endpoints = createManagedIdentityEndpoints({ authority: authority(), settings: SETTINGS, origin: ORIGIN });
  assert.equal(get(endpoints, '/msi/token', { resource: ORIGIN }, {}).status, 401);
  assert.equal(get(endpoints, '/msi/token', { resource: ORIGIN }, { 'x-identity-header': 'wrong' }).status, 401);
  const foreign = appService(endpoints, { resource: 'https://vault.example.test' });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.error, 'invalid_resource');
  assert.equal(appService(endpoints, {}).body.error, 'invalid_request');
});

test('App Service: no identities configured means no token', () => {
  const endpoints = createManagedIdentityEndpoints({ authority: authority(), settings: {}, origin: ORIGIN });
  assert.equal(appService(endpoints, { resource: ORIGIN }).status, 401);
});

test('IMDS: a missing or differently cased Metadata header is a 400', () => {
  const endpoints = createManagedIdentityEndpoints({ authority: authority(), settings: SETTINGS, origin: ORIGIN });
  const missing = imds(endpoints, { resource: ORIGIN }, {});
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, {
    error: 'invalid_request',
    error_description: 'Required metadata header not specified',
  });
  assert.equal(imds(endpoints, { resource: ORIGIN }, { metadata: 'True' }).status, 400);
});

test('IMDS: string-valued token body with an empty refresh token and selectors msi_res_id / object_id', () => {
  const endpoints = createManagedIdentityEndpoints({ authority: authority(), settings: SETTINGS, origin: ORIGIN });
  const res = imds(endpoints, { resource: ORIGIN, object_id: APP_PRINCIPAL });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'access_token',
    'expires_in',
    'expires_on',
    'not_before',
    'refresh_token',
    'resource',
    'token_type',
  ]);
  for (const key of Object.keys(res.body)) assert.equal(typeof res.body[key], 'string', key);
  assert.equal(res.body.refresh_token, '');
  assert.equal(res.body.expires_in, '3599');
  assert.equal(res.body.resource, ORIGIN);
  assert.equal(imds(endpoints, { resource: ORIGIN, client_id: OTHER_CLIENT }).status, 200);
  assert.equal(imds(endpoints, { resource: ORIGIN, msi_res_id: '/subscriptions/x' }).body.error, 'unauthorized_client');
  assert.equal(imds(endpoints, { resource: ORIGIN, client_id: APP_CLIENT, object_id: APP_PRINCIPAL }).status, 400);
});

test('IMDS: a missing resource is invalid_request', () => {
  const endpoints = createManagedIdentityEndpoints({ authority: authority(), settings: SETTINGS, origin: ORIGIN });
  assert.equal(imds(endpoints, {}).body.error, 'invalid_request');
});

test('Arc: the first call is challenged with a single-use secret file; the re-call with its contents succeeds once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paqvilo-mi-'));
  try {
    const endpoints = createManagedIdentityEndpoints({
      authority: authority(),
      settings: SETTINGS,
      origin: ORIGIN,
      secretFile: dir,
    });
    const challenged = imds(endpoints, { resource: ORIGIN });
    assert.equal(challenged.status, 401);
    const realm = /^Basic realm=(.+)$/.exec(challenged.headers['www-authenticate'])?.[1];
    assert.ok(realm, 'challenge names the secret file');
    assert.equal(realm.startsWith(dir), true);
    const secret = readFileSync(realm, 'utf8');
    const ok = imds(endpoints, { resource: ORIGIN }, { metadata: 'true', authorization: `Basic ${secret}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.resource, ORIGIN);
    assert.equal(existsSync(realm), false, 'the secret file is removed after use');
    const reused = imds(endpoints, { resource: ORIGIN }, { metadata: 'true', authorization: `Basic ${secret}` });
    assert.equal(reused.status, 401, 'a used secret is refused and a fresh challenge is issued');
    assert.match(reused.headers['www-authenticate'], /^Basic realm=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handle() returns null for other paths and other verbs; env() publishes the endpoint and the header', () => {
  const endpoints = createManagedIdentityEndpoints({ authority: authority(), settings: SETTINGS, origin: ORIGIN });
  assert.equal(
    endpoints.handle({ method: 'GET', pathname: '/api/data/v9.2/accounts', searchParams: query({}), headers: {} }),
    null,
  );
  assert.equal(
    endpoints.handle({ method: 'POST', pathname: '/msi/token', searchParams: query({}), headers: {} }),
    null,
  );
  const env = endpoints.env();
  assert.equal(env.IDENTITY_ENDPOINT, `${ORIGIN}/msi/token`);
  assert.match(env.IDENTITY_HEADER, /^[0-9a-f]{48}$/);
  assert.equal(env.IMDS_ENDPOINT, ORIGIN);
});

test('IMDS and App Service refuse a request without api-version before any side effect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paqvilo-mi-'));
  try {
    const endpoints = createManagedIdentityEndpoints({
      authority: authority(),
      settings: SETTINGS,
      origin: ORIGIN,
      secretFile: dir,
    });
    const noVersion = get(endpoints, IMDS, { resource: ORIGIN }, { metadata: 'true' });
    assert.equal(noVersion.status, 400);
    assert.equal(noVersion.body.error, 'invalid_request');
    assert.match(noVersion.body.error_description, /api-version/);
    assert.deepEqual(readdirSync(dir), [], 'no Arc challenge file is written for an invalid request');
    assert.equal(
      get(endpoints, '/msi/token', { resource: ORIGIN }, { 'x-identity-header': endpoints.env().IDENTITY_HEADER }).body
        .error,
      'invalid_request',
    );
    assert.equal(
      imds(endpoints, { resource: ORIGIN }).status,
      401,
      'with api-version the Arc challenge is issued as before',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unauthenticated Arc calls keep at most 16 unused challenge files; the oldest is removed and the newest still redeems', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paqvilo-mi-'));
  try {
    const endpoints = createManagedIdentityEndpoints({
      authority: authority(),
      settings: SETTINGS,
      origin: ORIGIN,
      secretFile: dir,
    });
    const challenges = [];
    for (let i = 0; i < 20; i++)
      challenges.push(/^Basic realm=(.+)$/.exec(imds(endpoints, { resource: ORIGIN }).headers['www-authenticate'])[1]);
    const files = readdirSync(dir).filter((name) => /^identity-.+\.key$/.test(name));
    assert.equal(files.length, 16);
    assert.equal(existsSync(challenges[0]), false, 'the first challenge was evicted');
    assert.equal(existsSync(challenges[19]), true);
    const redeemed = imds(
      endpoints,
      { resource: ORIGIN },
      { metadata: 'true', authorization: `Basic ${readFileSync(challenges[19], 'utf8')}` },
    );
    assert.equal(redeemed.status, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Dataverse-side helpers: a router over the identities, and the same identities' token issuer.
const dataverseFor = (identities) =>
  dataverseSettings({ enabled: true, organizationId: ORG, managedIdentities: identities });
const startWithIdentities = async (identities) => {
  const store = await new DataStore({ state: emptyState() }).init();
  const settings = dataverseFor(identities);
  const router = await startDataverseApi({ store, settings, log: () => {} });
  const endpoints = createManagedIdentityEndpoints({
    authority: { issueManagedIdentityToken: router.issueManagedIdentityToken },
    settings,
    origin: router.origin,
  });
  return { store, router, endpoints };
};

test('a settings managed identity is an application user with a managedidentity row; its App Service token reaches WhoAmI and $metadata lists the set', async () => {
  const { store, router, endpoints } = await startWithIdentities([
    { clientId: APP_CLIENT, principalId: APP_PRINCIPAL, displayName: 'first', roles: ['System Administrator'] },
  ]);
  try {
    const token = endpoints.handle({
      method: 'GET',
      pathname: '/msi/token',
      searchParams: query({ resource: router.origin, client_id: APP_CLIENT, 'api-version': '2019-08-01' }),
      headers: { 'x-identity-header': endpoints.env().IDENTITY_HEADER },
    }).body.access_token;
    const who = await fetch(`${router.origin}/api/data/v9.2/WhoAmI`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    assert.equal(who.status, 200);
    assert.equal((await who.json()).UserId, uuidV5(router.organizationId, `systemuser:app:${APP_CLIENT}`));

    const mapping = store.state.mappings.managedidentity;
    assert.equal(mapping.entitySet, 'managedidentities');
    assert.equal(mapping.idColumn, 'managedidentityid');
    assert.equal(mapping.dataverseOnly, true);
    const [row] = store.state.tables.managedidentity;
    assert.equal(row.managedidentityid, uuidV5(router.tenantId, `managedidentity:${APP_CLIENT}`));
    assert.equal(row.applicationid, APP_CLIENT);
    assert.equal(row.name, 'first');
    assert.equal(row.tenantid, router.tenantId);
    assert.equal(row.statecode, 0);

    const metadata = await fetch(`${router.origin}/api/data/v9.2/$metadata`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(metadata.status, 200);
    assert.match(await metadata.text(), /EntitySet Name="managedidentities"/);
  } finally {
    await router.close();
  }
});

test('seedManagedIdentityRows upserts by clientId and drops rows of identities no longer configured', async () => {
  const store = await new DataStore({ state: emptyState() }).init();
  const tenantId = TENANT;
  const both = [
    { clientId: APP_CLIENT, displayName: 'first' },
    { clientId: OTHER_CLIENT, displayName: 'second' },
  ];
  await store.transact(() => seedManagedIdentityRows(store, { tenantId, identities: both }));
  await store.transact(() => seedManagedIdentityRows(store, { tenantId, identities: both }));
  assert.equal(store.state.tables.managedidentity.length, 2, 'a second registration adds no duplicates');
  await store.transact(() =>
    seedManagedIdentityRows(store, {
      tenantId,
      identities: [{ clientId: OTHER_CLIENT.toUpperCase(), displayName: 'renamed' }],
    }),
  );
  assert.deepEqual(
    store.state.tables.managedidentity.map((row) => [row.applicationid, row.name]),
    [[OTHER_CLIENT, 'renamed']],
  );
});

test('an identity added through the runtime route gets a managedidentity row and its token passes WhoAmI', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pp-runtime-mi-'));
  ownedFixture(t).remove(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'website.yml'), 'adx_websiteid: site\nadx_name: Runtime identity\n');
  const app = await createSimulator({ sourceDir: directory, watch: false, dataverse: { enabled: true } });
  ownedFixture(t).add(() => app.close());
  const origin = app.dataverse.origin;
  const admin = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`${app.url}/_sim/api${route}`, {
      method,
      headers: { 'x-sim-csrf': app.csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  // The identity header is shown by the first admin status read after start.
  const header = (await admin('/dataverse')).body.managedIdentity.header;
  const clientId = '77777777-7777-4777-8777-777777777777';
  const created = await admin('/dataverse/managed-identities', {
    method: 'POST',
    body: { clientId, displayName: 'Runtime app', roles: ['System Administrator'] },
  });
  assert.equal(created.status, 201);
  const token = (
    await (
      await fetch(
        `${origin}/msi/token?resource=${encodeURIComponent(origin)}&client_id=${clientId}&api-version=2019-08-01`,
        {
          headers: { 'x-identity-header': header },
        },
      )
    ).json()
  ).access_token;
  const who = await fetch(`${origin}/api/data/v9.2/WhoAmI`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  assert.equal(who.status, 200);
  assert.equal((await who.json()).UserId, created.body.systemuserid);
  // The runtime identity has its managedidentity row, as the configured ones do.
  const rows = await fetch(`${origin}/api/data/v9.2/managedidentities`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  assert.equal(rows.status, 200);
  const row = (await rows.json()).value.find((item) => item.applicationid === clientId);
  assert.ok(row, 'the runtime identity has a managedidentity row');
  assert.equal(row.name, 'Runtime app');
  assert.equal(row.statecode, 0);
});
