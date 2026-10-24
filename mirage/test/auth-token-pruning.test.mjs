import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createAuthority, hashSecret, newClientSecret } from '../lib/dataverse-auth.mjs';

// The clock is controlled through state.now.
const ORIGIN = 'https://127.0.0.1:9443';
const TENANT = '7e1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7';
const APP_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const USER_OID = '0f1e2d3c-4b5a-4968-8778-6a5b4c3d2e1f';
const REDIRECT = 'https://app.example.test/callback';
const SCOPE = `${ORIGIN}/user_impersonation openid profile offline_access`;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const DEVICE_LIFETIME_MS = 900 * 1000;
const T0 = Date.parse('2026-10-19T10:00:00Z');
const SECRET = newClientSecret();
const TEST_USER = { systemuserid: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', azureactivedirectoryobjectid: USER_OID, fullname: 'Test User', domainname: 'test.user@example.test', firstname: 'Test', lastname: 'User', isdisabled: false };
const users = { byObjectId: (oid) => (oid === USER_OID ? TEST_USER : null), byDomainName: () => null, list: () => [TEST_USER], verifyPassword: () => false };
const DELEGATED_CLIENT = { client_id: APP_ID, client_secret: SECRET, scope: SCOPE };
const postUrl = `${ORIGIN}/${TENANT}/oauth2/v2.0/authorize`;
const baseAuthorize = (extra = {}) => ({ client_id: APP_ID, redirect_uri: REDIRECT, scope: SCOPE, state: 'st-1', nonce: 'n-1', response_type: 'code', response_mode: 'query', ...extra });

function fixture() {
  const state = { now: T0 };
  const applications = [{
    appId: APP_ID,
    displayName: 'Invented test app',
    secrets: [{ id: 's1', ...hashSecret(SECRET), hint: SECRET.slice(-4), expiresOn: null }],
    certificates: [],
    publicClient: false,
    redirectUris: [REDIRECT],
  }];
  const auth = createAuthority({ tenantId: TENANT, applications: () => applications, users, clock: () => state.now });
  return { state, auth, applications };
}

const call = (auth, form) => auth.handleToken({ origin: ORIGIN, tenantSegment: TENANT, form });
const refreshForm = (token) => ({ grant_type: 'refresh_token', client_id: APP_ID, client_secret: SECRET, refresh_token: token });
const submitAuthorize = (auth, params) => auth.handleAuthorize({ origin: ORIGIN, tenantSegment: TENANT, url: new URL(postUrl), method: 'POST', form: { ...params, oid: USER_OID } });
const codeOf = (res) => new URL(res.headers.location).searchParams.get('code');
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

test('an expired refresh token stays expired (700082) after other tokens are issued; pruning waits for the cap', () => {
  const { auth, state } = fixture();
  const old = auth.issueRefreshToken({ appId: APP_ID, userOid: USER_OID, resource: ORIGIN, scope: SCOPE, now: state.now });
  state.now += REFRESH_LIFETIME_MS + 1;
  const fresh = auth.issueRefreshToken({ appId: APP_ID, userOid: USER_OID, resource: ORIGIN, scope: SCOPE, now: state.now });
  assert.deepEqual(call(auth, refreshForm(old)).body.error_codes, [700082]);
  assert.equal(call(auth, refreshForm(fresh)).status, 200);
});

test('a full map drops its expired refresh tokens before it evicts a live one', () => {
  const { auth, state } = fixture();
  const issue = () => auth.issueRefreshToken({ appId: APP_ID, userOid: USER_OID, resource: ORIGIN, scope: SCOPE, now: state.now });
  const expired = issue();
  state.now += REFRESH_LIFETIME_MS / 2;
  const live = Array.from({ length: 999 }, issue);
  state.now += REFRESH_LIFETIME_MS / 2 + 1;
  const next = issue();
  assert.deepEqual(call(auth, refreshForm(expired)).body.error_codes, [9002313], 'pruned at the cap');
  assert.equal(call(auth, refreshForm(live[0])).status, 200, 'no live token was evicted');
  assert.equal(call(auth, refreshForm(next)).status, 200);
});

test('refresh tokens are capped at 1000 live entries and the oldest is evicted first', () => {
  const { auth, state } = fixture();
  const issued = Array.from({ length: 1001 }, () => auth.issueRefreshToken({ appId: APP_ID, userOid: USER_OID, resource: ORIGIN, scope: SCOPE, now: state.now }));
  assert.deepEqual(call(auth, refreshForm(issued[0])).body.error_codes, [9002313]);
  assert.equal(call(auth, refreshForm(issued[1])).status, 200);
  assert.equal(call(auth, refreshForm(issued[1000])).status, 200);
});

test('an expired authorization code is answered as expired after another code is issued', () => {
  const { auth, state } = fixture();
  const { verifier, challenge } = pkce();
  const params = baseAuthorize({ code_challenge: challenge, code_challenge_method: 'S256' });
  const old = codeOf(submitAuthorize(auth, params));
  const exchange = (code) => call(auth, { grant_type: 'authorization_code', ...DELEGATED_CLIENT, code, redirect_uri: REDIRECT, code_verifier: verifier });
  state.now += CODE_LIFETIME_MS + 1;
  const fresh = codeOf(submitAuthorize(auth, params));
  assert.deepEqual(exchange(old).body.error_codes, [70008]);
  assert.equal(exchange(fresh).status, 200);
});

test('an expired device code is answered as expired after another device code is issued', () => {
  const { auth, state } = fixture();
  const device = () => auth.handleDeviceCode({ origin: ORIGIN, tenantSegment: TENANT, form: { client_id: APP_ID, scope: SCOPE } });
  const old = device().body.device_code;
  state.now += DEVICE_LIFETIME_MS + 1;
  device();
  const poll = call(auth, { grant_type: DEVICE_GRANT, ...DELEGATED_CLIENT, device_code: old });
  assert.deepEqual(poll.body.error_codes, [70019]);
});

test('client assertion ids are capped at 1000 like the other maps', () => {
  const { auth, state, applications } = fixture();
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  const thumbprint = createHash('sha1').update(der).digest('hex').toUpperCase();
  applications[0].certificates = [{ thumbprint, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) }];
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT', x5t: Buffer.from(thumbprint, 'hex').toString('base64url') });
  const seconds = Math.floor(state.now / 1000);
  const assertion = jti => { const body = b64({ aud: `${ORIGIN}/${TENANT}/oauth2/v2.0/token`, iss: APP_ID, sub: APP_ID, nbf: seconds, exp: seconds + 300, jti });
    return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`; };
  const present = jti => call(auth, { grant_type: 'client_credentials', client_id: APP_ID, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion(jti), scope: `${ORIGIN}/.default` });
  for (let n = 0; n <= 1000; n++) assert.equal(present(`jti-${n}`).status, 200);
  assert.deepEqual(present('jti-1000').body.error_codes, [9002313], 'a remembered id is a replay');
  // The documented ceiling: the oldest id was evicted to keep the map at 1000 entries.
  assert.equal(present('jti-0').status, 200);
});
