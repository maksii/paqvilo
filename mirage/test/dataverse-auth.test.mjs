import assert from 'node:assert/strict';
import {
  X509Certificate,
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { test } from 'node:test';
import {
  certificateThumbprints,
  createAuthority,
  hashSecret,
  newClientSecret,
  verifySecret,
} from '../lib/dataverse-auth.mjs';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';

const ORIGIN = 'https://127.0.0.1:9443';
const TENANT = '7e1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7';
const APP_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const PUBLIC_APP_ID = '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e';
const USER_OID = '0f1e2d3c-4b5a-4968-8778-6a5b4c3d2e1f';
const APP_USER_OID = '1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9';
const UNKNOWN_TENANT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TOKEN_V2 = `${ORIGIN}/${TENANT}/oauth2/v2.0/token`;
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const REDIRECT = 'https://app.example.test/callback';
const SCOPE = `${ORIGIN}/user_impersonation openid profile offline_access`;
const TEST_PASSWORD = 'invented-password-1';
const T0 = Date.parse('2026-10-19T10:00:00Z');
const SECRET = newClientSecret();
// Generated once: RSA key generation dominates this file's run time, and every fixture registers its own copy.
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLIENT_KEYS = rsa();
const FEDERATED_KEYS = rsa();
const STRANGER = rsa().privateKey;
const SECRET_RECORD = hashSecret(SECRET);

const TEST_USER = {
  systemuserid: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  azureactivedirectoryobjectid: USER_OID,
  fullname: 'Test User',
  domainname: 'test.user@example.test',
  firstname: 'Test',
  lastname: 'User',
  isdisabled: false,
};
const APP_USER = {
  systemuserid: '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a',
  applicationid: APP_ID,
  azureactivedirectoryobjectid: APP_USER_OID,
  fullname: 'Invented app user',
  domainname: `${APP_ID}@${TENANT}`,
  isdisabled: false,
};
// Rows the picker and every sign-in path must refuse.
const NON_INTERACTIVE_USER = {
  systemuserid: '4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b',
  azureactivedirectoryobjectid: '5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c',
  accessmode: 4,
  fullname: 'Invented non-interactive',
  domainname: 'noninteractive@example.test',
  isdisabled: false,
};
const DISABLED_USER = {
  systemuserid: '6a7b8c9d-0e1f-4a2b-8c3d-5e6f7a8b9c0d',
  azureactivedirectoryobjectid: '7b8c9d0e-1f2a-4b3c-9d4e-6f7a8b9c0d1e',
  fullname: 'Invented disabled',
  domainname: 'disabled@example.test',
  isdisabled: true,
};
const NO_OID_USER = {
  systemuserid: '8c9d0e1f-2a3b-4c4d-8e5f-7a8b9c0d1e2f',
  azureactivedirectoryobjectid: null,
  fullname: 'Invented without oid',
  domainname: 'no.oid@example.test',
  isdisabled: false,
};
const ALL_ROWS = [TEST_USER, APP_USER, NON_INTERACTIVE_USER, DISABLED_USER, NO_OID_USER];
const users = {
  byObjectId: (oid) => ALL_ROWS.find((row) => row.azureactivedirectoryobjectid === oid) ?? null,
  byDomainName: (name) => ALL_ROWS.find((row) => row.domainname === name) ?? null,
  list: () => ALL_ROWS,
  verifyPassword: (row, password) => row === TEST_USER && password === TEST_PASSWORD,
};

function fixture() {
  const state = { now: T0 };
  const applications = [
    {
      appId: APP_ID,
      displayName: 'Invented test app',
      secrets: [{ id: 's1', ...SECRET_RECORD, hint: SECRET.slice(-4), expiresOn: null }],
      certificates: [],
      publicClient: false,
      redirectUris: [REDIRECT],
    },
    {
      appId: PUBLIC_APP_ID,
      displayName: 'Invented public app',
      secrets: [],
      certificates: [],
      publicClient: true,
      redirectUris: [REDIRECT],
    },
  ];
  const auth = createAuthority({ tenantId: TENANT, applications: () => applications, users, clock: () => state.now });
  return { applications, state, auth };
}

const call = (auth, form, extra = {}) => auth.handleToken({ origin: ORIGIN, tenantSegment: TENANT, form, ...extra });
const ccForm = (extra = {}) => ({
  grant_type: 'client_credentials',
  client_id: APP_ID,
  client_secret: SECRET,
  scope: `${ORIGIN}/.default`,
  ...extra,
});
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

// No X.509 certificate exists in these fixtures, so the registered thumbprint is SHA-1 of the DER SPKI bytes,
// uppercase hex, and the assertion header x5t is that same digest base64url-encoded.
function registerCertificate(app) {
  const pair = CLIENT_KEYS;
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  const thumbprint = createHash('sha1').update(der).digest('hex').toUpperCase();
  app.certificates = [{ thumbprint, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) }];
  return { privateKey: pair.privateKey, x5t: Buffer.from(thumbprint, 'hex').toString('base64url') };
}

function clientAssertion(privateKey, x5t, nowMs) {
  const head = b64({ alg: 'RS256', typ: 'JWT', x5t });
  const body = b64({
    aud: TOKEN_V2,
    iss: APP_ID,
    sub: APP_ID,
    nbf: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + 300,
    jti: 'test-jti-1',
  });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}

// Any header and claims, signed RS256 or PS256 (32-byte salt) with the given private key.
function signedAssertion(privateKey, { alg = 'RS256', header = {}, claims }) {
  const head = b64({ alg, typ: 'JWT', ...header });
  const body = b64(claims);
  const options =
    alg === 'PS256' ? { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : privateKey;
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), options).toString('base64url')}`;
}

// Registers a certificate record with only its public key: the authority derives both thumbprints from it.
function registerKeyOnly(app) {
  const pair = CLIENT_KEYS;
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  app.certificates = [{ publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) }];
  return { privateKey: pair.privateKey, x5tS256: createHash('sha256').update(der).digest('base64url'), der };
}

const assertionForm = (assertion) => ({
  grant_type: 'client_credentials',
  client_id: APP_ID,
  client_assertion_type: ASSERTION_TYPE,
  client_assertion: assertion,
  scope: `${ORIGIN}/.default`,
});

test("JWKS publishes one RS256 key whose n and e verify the authority's tokens", () => {
  const { auth } = fixture();
  const { keys } = auth.jwks();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kty, 'RSA');
  assert.equal(keys[0].use, 'sig');
  assert.equal(keys[0].alg, 'RS256');
  const res = call(auth, ccForm());
  const [head, body, signature] = res.body.access_token.split('.');
  const publicKey = createPublicKey({ key: { kty: keys[0].kty, n: keys[0].n, e: keys[0].e }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url')), true);
  assert.equal(JSON.parse(Buffer.from(head, 'base64url').toString('utf8')).kid, keys[0].kid);
});

test('OIDC v2 and v1 documents list the endpoints built from origin and tenant', () => {
  const { auth } = fixture();
  const v2 = auth.openIdConfiguration(ORIGIN, 'v2.0');
  assert.equal(v2.issuer, `${ORIGIN}/${TENANT}/v2.0`);
  assert.equal(v2.authorization_endpoint, `${ORIGIN}/${TENANT}/oauth2/v2.0/authorize`);
  assert.equal(v2.token_endpoint, TOKEN_V2);
  assert.equal(v2.device_authorization_endpoint, `${ORIGIN}/${TENANT}/oauth2/v2.0/devicecode`);
  assert.equal(v2.jwks_uri, `${ORIGIN}/${TENANT}/discovery/v2.0/keys`);
  assert.equal(v2.end_session_endpoint, `${ORIGIN}/${TENANT}/oauth2/v2.0/logout`);
  assert.equal(v2.userinfo_endpoint, `${ORIGIN}/oidc/userinfo`);
  for (const field of [
    'response_modes_supported',
    'response_types_supported',
    'scopes_supported',
    'token_endpoint_auth_methods_supported',
    'claims_supported',
    'tenant_region_scope',
    'cloud_instance_name',
    'cloud_graph_host_name',
    'msgraph_host',
    'rbac_url',
  ]) {
    assert.ok(field in v2, `missing ${field}`);
  }
  const v1 = auth.openIdConfiguration(ORIGIN, 'v1.0');
  assert.equal(v1.issuer, `${ORIGIN}/${TENANT}/`);
  assert.equal(v1.authorization_endpoint, `${ORIGIN}/${TENANT}/oauth2/authorize`);
  assert.equal(v1.token_endpoint, `${ORIGIN}/${TENANT}/oauth2/token`);
  assert.equal(v1.jwks_uri, `${ORIGIN}/${TENANT}/discovery/keys`);
});

test('instance discovery names the tenant metadata and the origin host', () => {
  const { auth } = fixture();
  assert.deepEqual(auth.instanceDiscovery(ORIGIN), {
    tenant_discovery_endpoint: `${ORIGIN}/${TENANT}/v2.0/.well-known/openid-configuration`,
    'api-version': '1.1',
    metadata: [{ preferred_network: '127.0.0.1:9443', preferred_cache: '127.0.0.1:9443', aliases: ['127.0.0.1:9443'] }],
  });
});

test('client_credentials with the correct secret issues a v1-format app token', () => {
  const { auth } = fixture();
  const res = call(auth, ccForm());
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.pragma, 'no-cache');
  const { body } = res;
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.expires_in, 3599);
  assert.equal(body.ext_expires_in, 3599);
  const claims = claimsOf(body.access_token);
  assert.equal(claims.ver, '1.0');
  assert.equal(claims.appid, APP_ID);
  assert.equal(claims.appidacr, '1');
  assert.equal(claims.idtyp, 'app');
  assert.equal(claims.aud, ORIGIN);
  assert.equal(claims.iss, `${ORIGIN}/${TENANT}/`);
  assert.equal(claims.tid, TENANT);
  assert.equal(claims.exp - claims.iat, 3600);
});

test('client_credentials accepts HTTP Basic client authentication', () => {
  const { auth } = fixture();
  const form = ccForm({ client_id: undefined, client_secret: undefined });
  const authorization = `Basic ${Buffer.from(`${APP_ID}:${SECRET}`).toString('base64')}`;
  const res = call(auth, form, { headers: { authorization } });
  assert.equal(res.status, 200);
  assert.equal(claimsOf(res.body.access_token).appid, APP_ID);
});

test('a wrong client secret answers 401 invalid_client with AADSTS7000215', () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ client_secret: 'not-the-secret' }));
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_client');
  assert.deepEqual(res.body.error_codes, [7000215]);
  assert.match(res.body.error_description, /^AADSTS7000215: /);
  assert.match(
    res.body.error_description,
    / Trace ID: \S+ Correlation ID: \S+ Timestamp: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/,
  );
});

test('an unknown client answers 400 unauthorized_client with AADSTS700016', () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ client_id: '99999999-9999-4999-8999-999999999999' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unauthorized_client');
  assert.deepEqual(res.body.error_codes, [700016]);
  assert.match(res.body.error_description, /^AADSTS700016: /);
});

test('an unknown tenant answers 400 with AADSTS90002', () => {
  const { auth } = fixture();
  const res = auth.handleToken({ origin: ORIGIN, tenantSegment: UNKNOWN_TENANT, form: ccForm() });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_request');
  assert.deepEqual(res.body.error_codes, [90002]);
});

test('a missing grant_type answers 400 with AADSTS900144', () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ grant_type: undefined }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_request');
  assert.deepEqual(res.body.error_codes, [900144]);
});

test('a scope for another resource answers 400 invalid_scope with AADSTS70011', () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ scope: 'https://other.example.test/.default' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_scope');
  assert.deepEqual(res.body.error_codes, [70011]);
});

test('an unsupported grant type answers 400 unsupported_grant_type with AADSTS70003', () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ grant_type: 'foo' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unsupported_grant_type');
  assert.deepEqual(res.body.error_codes, [70003]);
  assert.match(res.body.error_description, /^AADSTS70003: /);
});

test('the v1 token endpoint takes resource= and answers v1 fields', () => {
  const { auth } = fixture();
  const res = call(
    auth,
    { grant_type: 'client_credentials', client_id: APP_ID, client_secret: SECRET, resource: ORIGIN },
    { version: 'v1.0' },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.resource, ORIGIN);
  assert.equal(typeof res.body.expires_on, 'string');
  assert.equal(typeof res.body.not_before, 'string');
  assert.equal(res.body.expires_in, '3599');
  assert.equal(claimsOf(res.body.access_token).aud, ORIGIN);
});

test('refresh tokens rotate: the presented token is spent on first use', () => {
  const { auth, state } = fixture();
  const seed = auth.issueRefreshToken({
    appId: APP_ID,
    userOid: USER_OID,
    resource: ORIGIN,
    scope: `openid offline_access ${ORIGIN}/.default`,
    now: state.now,
  });
  const refreshForm = (token) => ({
    grant_type: 'refresh_token',
    client_id: APP_ID,
    client_secret: SECRET,
    refresh_token: token,
  });
  const first = call(auth, refreshForm(seed));
  assert.equal(first.status, 200);
  assert.notEqual(first.body.refresh_token, seed);
  assert.equal(claimsOf(first.body.access_token).idtyp, 'user');
  assert.equal(claimsOf(first.body.access_token).upn, 'test.user@example.test');
  const replay = call(auth, refreshForm(seed));
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');
  assert.deepEqual(replay.body.error_codes, [9002313]);
  assert.equal(call(auth, refreshForm(first.body.refresh_token)).status, 200);
});

test('client_assertion with a registered certificate issues a token with appidacr 2', () => {
  const { auth, applications, state } = fixture();
  const { privateKey, x5t } = registerCertificate(applications[0]);
  const res = call(auth, {
    grant_type: 'client_credentials',
    client_id: APP_ID,
    client_assertion_type: ASSERTION_TYPE,
    client_assertion: clientAssertion(privateKey, x5t, state.now),
    scope: `${ORIGIN}/.default`,
  });
  assert.equal(res.status, 200);
  assert.equal(claimsOf(res.body.access_token).appidacr, '2');
});

test('a client_assertion with a bad signature answers invalid_client with AADSTS700027', () => {
  const { auth, applications, state } = fixture();
  const { x5t } = registerCertificate(applications[0]);
  const stranger = STRANGER;
  const res = call(auth, {
    grant_type: 'client_credentials',
    client_id: APP_ID,
    client_assertion_type: ASSERTION_TYPE,
    client_assertion: clientAssertion(stranger, x5t, state.now),
    scope: `${ORIGIN}/.default`,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_client');
  assert.deepEqual(res.body.error_codes, [700027]);
});

test('a PS256 assertion matched by x5t#S256 (no x5t, an x5c header ignored) issues appidacr 2 with string dates', () => {
  const { auth, applications, state } = fixture();
  const { privateKey, x5tS256, der } = registerKeyOnly(applications[0]);
  assert.equal(
    certificateThumbprints(applications[0].certificates[0].publicKeyPem).thumbprint256,
    createHash('sha256').update(der).digest('hex').toUpperCase(),
  );
  const sec = Math.floor(state.now / 1000);
  const assertion = signedAssertion(privateKey, {
    alg: 'PS256',
    header: { 'x5t#S256': x5tS256, x5c: 'invented-cert-der' },
    claims: { aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: String(sec), exp: String(sec + 300), jti: 'ps-jti-1' },
  });
  const res = call(auth, assertionForm(assertion));
  assert.equal(res.status, 200);
  assert.equal(claimsOf(res.body.access_token).appidacr, '2');
});

test("an X.509 certificate registered as its PEM is matched by the certificate's own fingerprints, not its key's", () => {
  const { auth, applications, state } = fixture();
  const { cert, key } = createSelfSignedCertificate({ commonName: 'Invented client certificate', hosts: [] });
  const x509 = new X509Certificate(cert);
  const stored = certificateThumbprints(cert);
  assert.equal(stored.thumbprint, x509.fingerprint.replaceAll(':', ''));
  assert.equal(stored.thumbprint256, x509.fingerprint256.replaceAll(':', ''));
  assert.notEqual(
    stored.thumbprint256,
    certificateThumbprints(x509.publicKey.export({ type: 'spki', format: 'pem' })).thumbprint256,
  );
  applications[0].certificates = [{ ...stored, publicKeyPem: cert }];
  const sec = Math.floor(state.now / 1000);
  const claims = { aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: sec, exp: sec + 600 };
  // MSAL.NET: PS256 with x5t#S256 of the certificate DER plus the x5c chain; msal-node: the SHA-256 thumbprint too.
  const x5tS256 = Buffer.from(stored.thumbprint256, 'hex').toString('base64url');
  const ps = call(
    auth,
    assertionForm(
      signedAssertion(key, {
        alg: 'PS256',
        header: { 'x5t#S256': x5tS256, x5c: [x509.raw.toString('base64')] },
        claims: { ...claims, jti: 'cert-jti-1' },
      }),
    ),
  );
  assert.equal(ps.status, 200, JSON.stringify(ps.body));
  assert.equal(claimsOf(ps.body.access_token).appidacr, '2');
  // The deprecated SHA-1 x5t (msal-node `thumbprint`) matches the same record.
  const x5t = Buffer.from(stored.thumbprint, 'hex').toString('base64url');
  const rs = call(
    auth,
    assertionForm(signedAssertion(key, { header: { x5t }, claims: { ...claims, jti: 'cert-jti-2' } })),
  );
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  // The same assertion with its claims altered after signing is refused as a bad signature.
  const [head, , signature] = signedAssertion(key, {
    alg: 'PS256',
    header: { 'x5t#S256': x5tS256 },
    claims: { ...claims, jti: 'cert-jti-3' },
  }).split('.');
  const tampered = call(
    auth,
    assertionForm(`${head}.${b64({ ...claims, sub: PUBLIC_APP_ID, jti: 'cert-jti-3' })}.${signature}`),
  );
  assert.equal(tampered.status, 400);
  assert.deepEqual([tampered.body.error, tampered.body.error_codes], ['invalid_client', [700027]]);
});

test('a 10-minute assertion issued from a rounded-up clock is accepted; one beyond the skew allowance is not', () => {
  const { auth, applications, state } = fixture();
  const { privateKey, x5t } = registerCertificate(applications[0]);
  state.now = T0 + 600; // 0.6 s into the second: msal-node's Math.round issue time is the next whole second
  const issued = Math.round(state.now / 1000);
  const claims = { aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: issued };
  const tenMinutes = call(
    auth,
    assertionForm(
      signedAssertion(privateKey, { header: { x5t }, claims: { ...claims, exp: issued + 600, jti: 'round-jti-1' } }),
    ),
  );
  assert.equal(tenMinutes.status, 200, JSON.stringify(tenMinutes.body));
  const tooLong = call(
    auth,
    assertionForm(
      signedAssertion(privateKey, {
        header: { x5t },
        claims: { ...claims, exp: issued + 600 + 301, jti: 'round-jti-2' },
      }),
    ),
  );
  assert.equal(tooLong.status, 400);
  assert.deepEqual(tooLong.body.error_codes, [700027]);
});

test('a PS256 assertion whose x5t#S256 matches no certificate answers 700027, as does a bad PS256 signature', () => {
  const { auth, applications, state } = fixture();
  const { privateKey } = registerKeyOnly(applications[0]);
  const sec = Math.floor(state.now / 1000);
  const claims = { aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: sec, exp: sec + 300, jti: 'ps-jti-2' };
  const wrongThumbprint = signedAssertion(privateKey, {
    alg: 'PS256',
    header: { 'x5t#S256': Buffer.alloc(32, 7).toString('base64url') },
    claims,
  });
  const unmatched = call(auth, assertionForm(wrongThumbprint));
  assert.equal(unmatched.status, 400);
  assert.deepEqual(unmatched.body.error_codes, [700027]);
  const stranger = STRANGER;
  const registeredS256 = Buffer.from(
    certificateThumbprints(applications[0].certificates[0].publicKeyPem).thumbprint256,
    'hex',
  ).toString('base64url');
  const forged = signedAssertion(stranger, {
    alg: 'PS256',
    header: { 'x5t#S256': registeredS256 },
    claims: { ...claims, jti: 'ps-jti-3' },
  });
  const badSignature = call(auth, assertionForm(forged));
  assert.deepEqual(badSignature.body.error_codes, [700027]);
  assert.match(badSignature.body.error_description, /signature is invalid/);
});

test("a client assertion's jti is single use: a replay answers invalid_grant AADSTS9002313", () => {
  const { auth, applications, state } = fixture();
  const { privateKey, x5t } = registerCertificate(applications[0]);
  const sec = Math.floor(state.now / 1000);
  const first = signedAssertion(privateKey, {
    header: { x5t },
    claims: { aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: sec, exp: sec + 300, jti: 'replay-jti' },
  });
  assert.equal(call(auth, assertionForm(first)).status, 200);
  const replay = call(auth, assertionForm(first));
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');
  assert.deepEqual(replay.body.error_codes, [9002313]);
  assert.match(replay.body.error_description, /Assertion replay detected/);
  const fresh = signedAssertion(privateKey, {
    header: { x5t },
    claims: { aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: sec, exp: sec + 300, jti: 'other-jti' },
  });
  assert.equal(call(auth, assertionForm(fresh)).status, 200);
  state.now += 600 * 1000;
  assert.equal(call(auth, assertionForm(first)).body.error_codes[0], 700027);
});

test('verifyBearer accepts a fresh token and reports each rejection reason', () => {
  const { auth, state } = fixture();
  const opts = { origin: ORIGIN, tenantId: TENANT };
  const access = call(auth, ccForm()).body.access_token;
  const ok = auth.verifyBearer(`Bearer ${access}`, opts);
  assert.equal(ok.ok, true);
  assert.equal(ok.claims.appid, APP_ID);

  assert.deepEqual(auth.verifyBearer(undefined, opts), { ok: false, reason: 'missing' });

  const [head, , signature] = access.split('.');
  const forged = b64({ ...claimsOf(access), tid: 'forged' });
  assert.deepEqual(auth.verifyBearer(`Bearer ${head}.${forged}.${signature}`, opts), {
    ok: false,
    reason: 'signature',
  });

  const wrongAudience = auth.issueAccessToken({
    origin: ORIGIN,
    appId: APP_ID,
    audience: 'https://other.example.test',
    now: state.now,
  });
  assert.deepEqual(auth.verifyBearer(`Bearer ${wrongAudience}`, opts), { ok: false, reason: 'audience' });

  state.now = T0 + (3600 + 301) * 1000;
  assert.deepEqual(auth.verifyBearer(`Bearer ${access}`, opts), { ok: false, reason: 'expired' });
});

test('verifyBearer tolerates five minutes of clock skew after expiry', () => {
  const { auth, state } = fixture();
  const access = call(auth, ccForm()).body.access_token;
  state.now = T0 + (3600 + 299) * 1000;
  assert.equal(auth.verifyBearer(`Bearer ${access}`, { origin: ORIGIN, tenantId: TENANT }).ok, true);
});

test('hashSecret and verifySecret round trip and reject a mismatch', () => {
  const stored = hashSecret('invented-secret');
  assert.match(stored.hash, /^scrypt\$/);
  assert.equal(verifySecret('invented-secret', stored), true);
  assert.equal(verifySecret('another-secret', stored), false);
  assert.equal(verifySecret('invented-secret', {}), false);
  assert.notEqual(hashSecret('invented-secret').hash, stored.hash);
});

test('secret verification accepts legacy local hashes and rejects malformed work factors', () => {
  // Historical salted SHA-256 fixture; literal bytes avoid introducing a weak hash writer.
  const legacy = { salt: 'aW52ZW50ZWQtc2FsdA', hash: 'dsuPwGAtfFyufBsFuG9HsfrkwmzU3sG4kDuzD1710d0' };
  assert.equal(verifySecret('invented-secret', legacy), true);
  assert.equal(verifySecret('wrong', legacy), false);
  for (const record of [
    { hash: 'scrypt$N=999999999', salt: legacy.salt },
    { hash: 'scrypt$!', salt: legacy.salt },
    { ...legacy, salt: 'a'.repeat(129) },
    { hash: {}, salt: legacy.salt },
  ]) {
    assert.equal(verifySecret('invented-secret', record), false);
  }
});

const DELEGATED_CLIENT = { client_id: APP_ID, client_secret: SECRET, scope: SCOPE };
const ROPC = {
  grant_type: 'password',
  ...DELEGATED_CLIENT,
  username: 'test.user@example.test',
  password: TEST_PASSWORD,
};
const authorizeUrl = (params = {}) =>
  new URL(`${ORIGIN}/${TENANT}/oauth2/v2.0/authorize?${new URLSearchParams(params)}`);
const postUrl = `${ORIGIN}/${TENANT}/oauth2/v2.0/authorize`;
const baseAuthorize = (extra = {}) => ({
  client_id: APP_ID,
  redirect_uri: REDIRECT,
  scope: SCOPE,
  state: 'st-1',
  nonce: 'n-1',
  response_type: 'code',
  response_mode: 'query',
  ...extra,
});
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
// The router's POST of the picker form: the posted fields carry the hidden echo and the chosen oid.
const submitAuthorize = (auth, params, oid = USER_OID) =>
  auth.handleAuthorize({
    origin: ORIGIN,
    tenantSegment: TENANT,
    url: new URL(postUrl),
    method: 'POST',
    form: { ...params, oid },
  });
const codeOf = (res) => new URL(res.headers.location).searchParams.get('code');
const deviceUrl = new URL(`${ORIGIN}/common/oauth2/deviceauth`);

test('authorization_code with PKCE: GET lists the interactive user, POST redirects with a code, exchange issues delegated tokens', () => {
  const { auth } = fixture();
  const { verifier, challenge } = pkce();
  const params = baseAuthorize({ code_challenge: challenge, code_challenge_method: 'S256' });
  const page = auth.handleAuthorize({
    origin: ORIGIN,
    tenantSegment: TENANT,
    url: authorizeUrl(params),
    method: 'GET',
  });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body, /<form method="post">/);
  assert.match(page.body, new RegExp(`value="${USER_OID}"`));
  assert.doesNotMatch(page.body, new RegExp(APP_USER_OID));
  assert.match(page.body, /name="state" value="st-1"/);
  assert.match(page.body, /name="nonce" value="n-1"/);

  const res = submitAuthorize(auth, params);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.location);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get('state'), 'st-1');
  assert.match(location.searchParams.get('session_state'), /^[0-9a-f-]{36}$/);
  const code = location.searchParams.get('code');
  assert.equal(code.length, 43);

  const exchange = (extra = {}) =>
    call(auth, {
      grant_type: 'authorization_code',
      ...DELEGATED_CLIENT,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      ...extra,
    });
  const token = exchange();
  assert.equal(token.status, 200);
  const access = claimsOf(token.body.access_token);
  assert.equal(access.upn, 'test.user@example.test');
  assert.equal(access.scp, 'user_impersonation');
  assert.equal(access.idtyp, 'user');
  assert.equal(access.oid, USER_OID);
  assert.equal(access.aud, ORIGIN);
  assert.ok(token.body.refresh_token);
  const id = claimsOf(token.body.id_token);
  assert.equal(id.nonce, 'n-1');
  assert.equal(id.aud, APP_ID);
  assert.equal(id.ver, '2.0');
  assert.equal(id.iss, `${ORIGIN}/${TENANT}/v2.0`);
  assert.equal(id.preferred_username, 'test.user@example.test');

  const replay = exchange();
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');
  assert.deepEqual(replay.body.error_codes, [54005]);
});

test('a public client redeems a code without a secret; a confidential client without one gets AADSTS7000218', () => {
  const { auth } = fixture();
  const { verifier, challenge } = pkce();
  const publicCode = codeOf(
    submitAuthorize(
      auth,
      baseAuthorize({ client_id: PUBLIC_APP_ID, code_challenge: challenge, code_challenge_method: 'S256' }),
    ),
  );
  const pub = call(auth, {
    grant_type: 'authorization_code',
    client_id: PUBLIC_APP_ID,
    code: publicCode,
    redirect_uri: REDIRECT,
    scope: SCOPE,
    code_verifier: verifier,
  });
  assert.equal(pub.status, 200);
  assert.equal(claimsOf(pub.body.access_token).appidacr, '0');

  const confidentialCode = codeOf(submitAuthorize(auth, baseAuthorize()));
  const missing = call(auth, {
    grant_type: 'authorization_code',
    client_id: APP_ID,
    code: confidentialCode,
    redirect_uri: REDIRECT,
    scope: SCOPE,
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.error_codes, [7000218]);
});

test('a wrong code_verifier or redirect_uri is invalid_grant and spends the code: the retry is AADSTS54005', () => {
  const { auth } = fixture();
  const { verifier, challenge } = pkce();
  const code = codeOf(
    submitAuthorize(auth, baseAuthorize({ code_challenge: challenge, code_challenge_method: 'S256' })),
  );
  const exchange = (extra) =>
    call(auth, { grant_type: 'authorization_code', ...DELEGATED_CLIENT, code, redirect_uri: REDIRECT, ...extra });
  const badVerifier = exchange({ code_verifier: 'not-the-verifier' });
  assert.equal(badVerifier.status, 400);
  assert.equal(badVerifier.body.error, 'invalid_grant');
  assert.deepEqual(badVerifier.body.error_codes, [9002313]);
  assert.deepEqual(exchange({ code_verifier: verifier }).body.error_codes, [54005]);

  const second = codeOf(
    submitAuthorize(auth, baseAuthorize({ code_challenge: challenge, code_challenge_method: 'S256' })),
  );
  const badRedirect = call(auth, {
    grant_type: 'authorization_code',
    ...DELEGATED_CLIENT,
    code: second,
    redirect_uri: 'https://app.example.test/other',
    code_verifier: verifier,
  });
  assert.equal(badRedirect.body.error, 'invalid_grant');
  assert.deepEqual(
    call(auth, {
      grant_type: 'authorization_code',
      ...DELEGATED_CLIENT,
      code: second,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }).body.error_codes,
    [54005],
  );
});

test('a public client must send code_challenge on authorize (AADSTS9002325), on the GET and on the POST', () => {
  const { auth } = fixture();
  const params = baseAuthorize({ client_id: PUBLIC_APP_ID });
  const page = auth.handleAuthorize({
    origin: ORIGIN,
    tenantSegment: TENANT,
    url: authorizeUrl(params),
    method: 'GET',
  });
  assert.equal(page.status, 400);
  assert.match(
    page.body,
    /AADSTS9002325: Proof Key for Code Exchange is required for cross-origin authorization code redemption\./,
  );
  const posted = submitAuthorize(auth, params);
  assert.equal(posted.status, 400);
  assert.match(posted.body, /AADSTS9002325/);
});

test('the picker and the device page offer only interactive users', () => {
  const { auth } = fixture();
  const page = auth.handleAuthorize({
    origin: ORIGIN,
    tenantSegment: TENANT,
    url: authorizeUrl(baseAuthorize()),
    method: 'GET',
  });
  assert.match(page.body, new RegExp(`value="${USER_OID}"`));
  for (const row of [APP_USER, NON_INTERACTIVE_USER, DISABLED_USER, NO_OID_USER]) {
    assert.equal(page.body.includes(row.fullname), false, row.fullname);
  }
  const device = auth.handleDeviceVerification({ origin: ORIGIN, url: deviceUrl, method: 'GET' });
  assert.equal(device.body.includes(NON_INTERACTIVE_USER.fullname), false);
  assert.match(device.body, new RegExp(`value="${USER_OID}"`));
  const refused = submitAuthorize(auth, baseAuthorize(), NON_INTERACTIVE_USER.azureactivedirectoryobjectid);
  assert.equal(refused.status, 400);
  assert.match(refused.body, /AADSTS50034/);
});

test('delegated responses carry client_info only when the form asks for it', () => {
  const { auth } = fixture();
  const withInfo = call(auth, { ...ROPC, client_info: '1' });
  assert.equal(withInfo.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(withInfo.body.client_info, 'base64url').toString('utf8')), {
    uid: USER_OID,
    utid: TENANT,
  });
  assert.equal('client_info' in call(auth, ROPC).body, false);
  assert.equal('client_info' in call(auth, ccForm({ client_info: '1' })).body, false);
});

test('error_uri is omitted for AADSTS70003, 7000014 and 50059 and kept for the rest', () => {
  const { auth } = fixture();
  assert.equal('error_uri' in call(auth, ccForm({ grant_type: 'foo' })).body, false);
  assert.equal(
    'error_uri' in call(auth, { grant_type: DEVICE_GRANT, ...DELEGATED_CLIENT, device_code: 'not-a-device-code' }).body,
    false,
  );
  assert.match(
    call(auth, ccForm({ scope: 'https://other.example.test/.default' })).body.error_uri,
    /\/error\?code=70011$/,
  );
  assert.match(
    auth.handleToken({ origin: ORIGIN, tenantSegment: UNKNOWN_TENANT, form: ccForm() }).body.error_uri,
    /\/error\?code=90002$/,
  );
});

test("an application's allowedGrants gates each grant, given as a name or as its URN", () => {
  const { auth, applications } = fixture();
  applications[0].allowedGrants = ['client_credentials', DEVICE_GRANT];
  assert.deepEqual(call(auth, { ...ROPC }).body.error_codes, [700016]);
  assert.deepEqual(
    call(auth, { grant_type: DEVICE_GRANT, ...DELEGATED_CLIENT, device_code: 'not-a-device-code' }).body.error_codes,
    [7000014],
  );
});

test('authorize answers an AADSTS error page for an unknown client or an unlisted redirect_uri', () => {
  const { auth } = fixture();
  const unknown = auth.handleAuthorize({
    origin: ORIGIN,
    tenantSegment: TENANT,
    url: authorizeUrl(baseAuthorize({ client_id: '99999999-9999-4999-8999-999999999999' })),
    method: 'GET',
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body, /AADSTS700016/);
  const unlisted = auth.handleAuthorize({
    origin: ORIGIN,
    tenantSegment: TENANT,
    url: authorizeUrl(baseAuthorize({ redirect_uri: 'https://app.example.test/elsewhere' })),
    method: 'GET',
  });
  assert.equal(unlisted.status, 400);
  assert.match(unlisted.body, /AADSTS50011/);
  // Loopback redirects are accepted for public clients only.
  const loopback = {
    client_id: PUBLIC_APP_ID,
    redirect_uri: 'http://localhost:5555/cb',
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
  };
  assert.equal(
    auth.handleAuthorize({
      origin: ORIGIN,
      tenantSegment: TENANT,
      url: authorizeUrl(baseAuthorize(loopback)),
      method: 'GET',
    }).status,
    200,
  );
  assert.match(
    auth.handleAuthorize({
      origin: ORIGIN,
      tenantSegment: TENANT,
      url: authorizeUrl(baseAuthorize({ ...loopback, client_id: APP_ID })),
      method: 'GET',
    }).body,
    /AADSTS50011/,
  );
});

test('device_code: pending, slow_down, verification approves, then tokens once', () => {
  const { auth, state } = fixture();
  const dc = auth.handleDeviceCode({
    origin: ORIGIN,
    tenantSegment: TENANT,
    form: { client_id: APP_ID, scope: SCOPE },
  });
  assert.equal(dc.status, 200);
  assert.match(dc.body.user_code, /^[A-HJ-NP-Z2-9]{9}$/);
  assert.equal(dc.body.verification_uri, `${ORIGIN}/common/oauth2/deviceauth`);
  assert.equal(dc.body.expires_in, 900);
  assert.equal(dc.body.interval, 5);
  assert.equal(
    dc.body.message,
    `To sign in, use a web browser to open the page ${dc.body.verification_uri} and enter the code ${dc.body.user_code} to authenticate.`,
  );
  const poll = (device_code = dc.body.device_code) =>
    call(auth, { grant_type: DEVICE_GRANT, ...DELEGATED_CLIENT, device_code });

  const pending = poll();
  assert.equal(pending.status, 400);
  assert.equal(pending.body.error, 'authorization_pending');
  assert.deepEqual(pending.body.error_codes, [70016]);
  assert.equal(poll().body.error, 'slow_down');
  assert.equal(poll('not-a-device-code').body.error, 'bad_verification_code');
  assert.deepEqual(poll('not-a-device-code').body.error_codes, [7000014]);

  state.now += 5000;
  assert.equal(poll().body.error, 'authorization_pending');
  const page = auth.handleDeviceVerification({ origin: ORIGIN, url: deviceUrl, method: 'GET' });
  assert.match(page.body, /name="otc"/);
  assert.match(page.body, new RegExp(`value="${USER_OID}"`));
  const unknown = auth.handleDeviceVerification({
    origin: ORIGIN,
    url: deviceUrl,
    method: 'POST',
    form: { otc: 'ZZZZZZZZZ', oid: USER_OID },
  });
  assert.equal(unknown.status, 400);
  const approved = auth.handleDeviceVerification({
    origin: ORIGIN,
    url: deviceUrl,
    method: 'POST',
    form: { otc: dc.body.user_code.toLowerCase(), oid: USER_OID },
  });
  assert.equal(approved.status, 200);

  state.now += 5000;
  const tokens = poll();
  assert.equal(tokens.status, 200);
  assert.equal(claimsOf(tokens.body.access_token).upn, 'test.user@example.test');
  assert.equal(claimsOf(tokens.body.access_token).idtyp, 'user');
  assert.equal(poll().body.error_codes[0], 7000014);
});

test('an unapproved device code expires after 900 seconds with AADSTS70019', () => {
  const { auth, state } = fixture();
  const dc = auth.handleDeviceCode({
    origin: ORIGIN,
    tenantSegment: TENANT,
    form: { client_id: APP_ID, scope: SCOPE },
  });
  state.now += 900 * 1000;
  const res = call(auth, { grant_type: DEVICE_GRANT, ...DELEGATED_CLIENT, device_code: dc.body.device_code });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'expired_token');
  assert.deepEqual(res.body.error_codes, [70019]);
});

test('password grant issues delegated tokens and rejects bad credentials and application users', () => {
  const { auth } = fixture();
  const ok = call(auth, ROPC);
  assert.equal(ok.status, 200);
  assert.equal(claimsOf(ok.body.access_token).upn, 'test.user@example.test');
  assert.equal(claimsOf(ok.body.access_token).idtyp, 'user');
  assert.ok(ok.body.refresh_token);
  const wrong = call(auth, { ...ROPC, password: 'not-the-password' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'invalid_grant');
  assert.deepEqual(wrong.body.error_codes, [50126]);
  assert.deepEqual(call(auth, { ...ROPC, username: 'nobody@example.test' }).body.error_codes, [50034]);
  assert.deepEqual(call(auth, { ...ROPC, username: APP_USER.domainname }).body.error_codes, [50034]);
});

test('on_behalf_of exchanges a user token for a delegated token and rejects app-only assertions', () => {
  const { auth } = fixture();
  // The assertion's audience must be the presenting app (its own api:// resource), so the exchange uses a token issued for APP_ID's API.
  const apiToken = call(auth, { ...ROPC, scope: `api://${APP_ID}/access_as_user` });
  assert.equal(apiToken.status, 200);
  assert.equal(claimsOf(apiToken.body.access_token).aud, `api://${APP_ID}`);
  const userToken = call(auth, ROPC).body.access_token;
  const obo = (form) =>
    call(auth, { grant_type: JWT_BEARER, ...DELEGATED_CLIENT, requested_token_use: 'on_behalf_of', ...form });
  const exchanged = obo({ assertion: apiToken.body.access_token, scope: `${ORIGIN}/user_impersonation` });
  assert.equal(exchanged.status, 200);
  // A Dataverse-audience user token is another resource's: Entra answers AADSTS50013.
  const dataverseAudience = obo({ assertion: userToken, scope: `${ORIGIN}/user_impersonation` });
  assert.equal(dataverseAudience.status, 400);
  assert.deepEqual(dataverseAudience.body.error_codes, [50013]);
  assert.match(dataverseAudience.body.error_description, /does not match the Client app/);
  // The API-audience token is not a Dataverse Web API bearer.
  assert.equal(
    auth.verifyBearer(`Bearer ${apiToken.body.access_token}`, { origin: ORIGIN, tenantId: TENANT }).reason,
    'audience',
  );
  const claims = claimsOf(exchanged.body.access_token);
  assert.equal(claims.upn, 'test.user@example.test');
  assert.equal(claims.idtyp, 'user');
  assert.equal(claims.appid, APP_ID);
  assert.equal(claims.aud, ORIGIN);

  const appOnly = call(auth, ccForm()).body.access_token;
  const rejected = obo({ assertion: appOnly, scope: `${ORIGIN}/user_impersonation` });
  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.body.error_codes, [9002313]);
  assert.match(rejected.body.error_description, /must be a user token/);
  assert.match(
    obo({ assertion: `${userToken}x`, scope: `${ORIGIN}/user_impersonation` }).body.error_description,
    /signature validation/,
  );

  const stranger = call(auth, {
    grant_type: JWT_BEARER,
    client_id: '99999999-9999-4999-8999-999999999999',
    client_secret: SECRET,
    requested_token_use: 'on_behalf_of',
    assertion: userToken,
    scope: `${ORIGIN}/user_impersonation`,
  });
  assert.deepEqual(stranger.body.error_codes, [65001]);
});

test('a public client without a secret is refused for client_credentials and on_behalf_of, and still gets a device-code token', () => {
  const { auth } = fixture();
  const cc = call(auth, { grant_type: 'client_credentials', client_id: PUBLIC_APP_ID, scope: `${ORIGIN}/.default` });
  assert.equal(cc.status, 400);
  assert.deepEqual(cc.body.error_codes, [7000218]);
  const userToken = call(auth, ROPC).body.access_token;
  const obo = call(auth, {
    grant_type: JWT_BEARER,
    client_id: PUBLIC_APP_ID,
    requested_token_use: 'on_behalf_of',
    assertion: userToken,
    scope: `${ORIGIN}/user_impersonation`,
  });
  assert.deepEqual(obo.body.error_codes, [7000218]);

  const dc = auth.handleDeviceCode({
    origin: ORIGIN,
    tenantSegment: TENANT,
    form: { client_id: PUBLIC_APP_ID, scope: SCOPE },
  });
  assert.equal(dc.status, 200);
  const approved = auth.handleDeviceVerification({
    origin: ORIGIN,
    url: deviceUrl,
    method: 'POST',
    form: { otc: dc.body.user_code, oid: USER_OID },
  });
  assert.equal(approved.status, 200);
  const done = call(auth, { grant_type: DEVICE_GRANT, client_id: PUBLIC_APP_ID, device_code: dc.body.device_code });
  assert.equal(done.status, 200);
  assert.equal(claimsOf(done.body.access_token).appidacr, '0');
});

test('a token or assertion whose nbf is beyond the skew allowance is not yet valid', () => {
  const { auth, state } = fixture();
  const opts = { origin: ORIGIN, tenantId: TENANT };
  const near = auth.issueAccessToken({ origin: ORIGIN, appId: APP_ID, audience: ORIGIN, now: state.now + 200_000 });
  assert.equal(auth.verifyBearer(`Bearer ${near}`, opts).ok, true);
  const future = auth.issueAccessToken({ origin: ORIGIN, appId: APP_ID, audience: ORIGIN, now: state.now + 600_000 });
  assert.deepEqual(auth.verifyBearer(`Bearer ${future}`, opts), { ok: false, reason: 'not-yet-valid' });
  const futureUser = auth.issueAccessToken({
    origin: ORIGIN,
    appId: APP_ID,
    audience: ORIGIN,
    user: TEST_USER,
    now: state.now + 600_000,
  });
  const exchanged = call(auth, {
    grant_type: JWT_BEARER,
    ...DELEGATED_CLIENT,
    requested_token_use: 'on_behalf_of',
    assertion: futureUser,
    scope: `${ORIGIN}/user_impersonation`,
  });
  assert.deepEqual(exchanged.body.error_codes, [9002313]);
  assert.match(exchanged.body.error_description, /The assertion is not yet valid\./);
});

test('authorize refuses a code_challenge_method other than S256 or plain', () => {
  const { auth } = fixture();
  const bad = auth.handleAuthorize({
    origin: ORIGIN,
    tenantSegment: TENANT,
    url: authorizeUrl(baseAuthorize({ code_challenge: 'abc', code_challenge_method: 'S512' })),
    method: 'GET',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /code_challenge_method must be S256 or plain/);
  const good = auth.handleAuthorize({
    origin: ORIGIN,
    tenantSegment: TENANT,
    url: authorizeUrl(baseAuthorize({ code_challenge: pkce().challenge, code_challenge_method: 'S256' })),
    method: 'GET',
  });
  assert.equal(good.status, 200);
});

test('the device code grant is refused for an application whose allowedGrants omit it', () => {
  const { auth, applications } = fixture();
  applications[0].allowedGrants = ['client_credentials'];
  const res = auth.handleDeviceCode({
    origin: ORIGIN,
    tenantSegment: TENANT,
    form: { client_id: APP_ID, scope: SCOPE },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error_codes, [700016]);
});

test('a certificate client assertion without a jti is refused with AADSTS700027, and one with a jti is accepted', () => {
  const { auth, applications, state } = fixture();
  const { privateKey, x5t } = registerCertificate(applications[0]);
  const sec = Math.floor(state.now / 1000);
  const noJti = signedAssertion(privateKey, {
    header: { x5t },
    claims: { aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: sec, exp: sec + 300 },
  });
  const refused = call(auth, assertionForm(noJti));
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.error_codes, [700027]);
  assert.match(refused.body.error_description, /must contain a jti claim/);
  const withJti = signedAssertion(privateKey, {
    header: { x5t },
    claims: { aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: sec, exp: sec + 300, jti: 'has-jti-1' },
  });
  assert.equal(call(auth, assertionForm(withJti)).status, 200);
});

test('a federated client assertion without a jti is refused with AADSTS700027', () => {
  const { auth, state, privateKey } = federatedFixture();
  const sec = Math.floor(state.now / 1000);
  const noJti = signedAssertion(privateKey, {
    header: { kid: 'ext-1' },
    claims: { iss: EXT_ISSUER, sub: EXT_SUBJECT, aud: AZURE_AUDIENCE, nbf: sec, exp: sec + 300 },
  });
  const res = call(auth, federatedForm(noJti));
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error_codes, [700027]);
});

test('a refresh token from a delegated grant keeps the user across rotation', () => {
  const { auth } = fixture();
  const first = call(auth, ROPC).body;
  const second = call(auth, { grant_type: 'refresh_token', ...DELEGATED_CLIENT, refresh_token: first.refresh_token });
  assert.equal(second.status, 200);
  assert.equal(claimsOf(second.body.access_token).upn, 'test.user@example.test');
  assert.equal(claimsOf(second.body.access_token).idtyp, 'user');
  assert.notEqual(second.body.refresh_token, first.refresh_token);
});

// Federated credentials, managed identities and the /common ROPC refusal.
const EXT_ISSUER = 'https://issuer.example.test';
const EXT_SUBJECT = 'invented-subject-1';
const AZURE_AUDIENCE = 'api://AzureADTokenExchange';

function federatedFixture() {
  const state = { now: T0 };
  const pair = FEDERATED_KEYS;
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'ext-1', alg: 'RS256', use: 'sig' };
  const applications = [
    {
      appId: APP_ID,
      displayName: 'Invented federated app',
      secrets: [],
      certificates: [],
      publicClient: false,
      redirectUris: [REDIRECT],
      federatedCredentials: [{ issuer: EXT_ISSUER, subject: EXT_SUBJECT, audiences: [AZURE_AUDIENCE] }],
    },
  ];
  const federatedIssuers = [{ issuer: EXT_ISSUER, jwks: { keys: [jwk] } }];
  const auth = createAuthority({
    tenantId: TENANT,
    applications: () => applications,
    users,
    federatedIssuers: () => federatedIssuers,
    clock: () => state.now,
  });
  return { auth, state, applications, federatedIssuers, privateKey: pair.privateKey };
}

const federatedForm = (assertion) => ({
  grant_type: 'client_credentials',
  client_id: APP_ID,
  client_assertion_type: ASSERTION_TYPE,
  client_assertion: assertion,
  scope: `${ORIGIN}/.default`,
});

test('a federated client assertion from a registered issuer authenticates with appidacr 2', () => {
  const { auth, state, privateKey } = federatedFixture();
  const sec = Math.floor(state.now / 1000);
  const assertion = signedAssertion(privateKey, {
    header: { kid: 'ext-1' },
    claims: { iss: EXT_ISSUER, sub: EXT_SUBJECT, aud: AZURE_AUDIENCE, nbf: sec, exp: sec + 300, jti: 'fed-jti-1' },
  });
  const res = call(auth, federatedForm(assertion));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(claimsOf(res.body.access_token).appidacr, '2');
  assert.equal(claimsOf(res.body.access_token).idtyp, 'app');
});

test('a federated assertion with no matching credential answers invalid_client AADSTS70021', () => {
  const { auth, state, privateKey } = federatedFixture();
  const sec = Math.floor(state.now / 1000);
  const base = { iss: EXT_ISSUER, sub: EXT_SUBJECT, aud: AZURE_AUDIENCE, nbf: sec, exp: sec + 300 };
  const wrongSubject = signedAssertion(privateKey, {
    header: { kid: 'ext-1' },
    claims: { ...base, sub: 'other-subject', jti: 'fed-jti-2' },
  });
  const wrongAudience = signedAssertion(privateKey, {
    header: { kid: 'ext-1' },
    claims: { ...base, aud: 'api://invented', jti: 'fed-jti-3' },
  });
  for (const assertion of [wrongSubject, wrongAudience]) {
    const res = call(auth, federatedForm(assertion));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_client');
    assert.deepEqual(res.body.error_codes, [70021]);
    assert.match(res.body.error_description, /No matching federated identity record found for presented assertion/);
  }
});

test("a federated assertion must verify against the issuer's registered JWKS, RS256 only", () => {
  const { auth, state, privateKey, federatedIssuers } = federatedFixture();
  const sec = Math.floor(state.now / 1000);
  const claims = { iss: EXT_ISSUER, sub: EXT_SUBJECT, aud: AZURE_AUDIENCE, nbf: sec, exp: sec + 300 };
  const stranger = STRANGER;
  const forged = call(
    auth,
    federatedForm(signedAssertion(stranger, { header: { kid: 'ext-1' }, claims: { ...claims, jti: 'fed-jti-4' } })),
  );
  assert.deepEqual([forged.status, forged.body.error_codes], [400, [700027]]);
  assert.match(forged.body.error_description, /signature is invalid/);
  const pss = call(
    auth,
    federatedForm(
      signedAssertion(privateKey, { alg: 'PS256', header: { kid: 'ext-1' }, claims: { ...claims, jti: 'fed-jti-5' } }),
    ),
  );
  assert.deepEqual(pss.body.error_codes, [700027]);
  federatedIssuers.length = 0; // issuer no longer registered: the signature cannot be checked
  const unknown = call(
    auth,
    federatedForm(signedAssertion(privateKey, { header: { kid: 'ext-1' }, claims: { ...claims, jti: 'fed-jti-6' } })),
  );
  assert.deepEqual(unknown.body.error_codes, [700027]);
});

test('a federated token may outlive 10 minutes but a replayed jti is still refused', () => {
  const { auth, state, privateKey } = federatedFixture();
  const sec = Math.floor(state.now / 1000);
  const hourLong = signedAssertion(privateKey, {
    header: { kid: 'ext-1' },
    claims: { iss: EXT_ISSUER, sub: EXT_SUBJECT, aud: AZURE_AUDIENCE, nbf: sec, exp: sec + 3600, jti: 'fed-long-1' },
  });
  assert.equal(call(auth, federatedForm(hourLong)).status, 200);
  const replay = call(auth, federatedForm(hourLong));
  assert.deepEqual(replay.body.error_codes, [9002313]);
  const expired = signedAssertion(privateKey, {
    header: { kid: 'ext-1' },
    claims: {
      iss: EXT_ISSUER,
      sub: EXT_SUBJECT,
      aud: AZURE_AUDIENCE,
      nbf: sec - 7200,
      exp: sec - 3600,
      jti: 'fed-old-1',
    },
  });
  assert.match(call(auth, federatedForm(expired)).body.error_description, /has expired/);
});

test('a certificate-matched assertion is still verified as a certificate when federated credentials exist', () => {
  const { auth, state, applications } = federatedFixture();
  const { privateKey, x5t } = registerCertificate(applications[0]);
  const stranger = STRANGER;
  const sec = Math.floor(state.now / 1000);
  const claims = { aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: sec, exp: sec + 300, jti: 'cert-fed-1' };
  const forged = call(auth, assertionForm(signedAssertion(stranger, { header: { x5t }, claims })));
  assert.deepEqual([forged.status, forged.body.error_codes], [400, [700027]]);
  const genuine = call(
    auth,
    assertionForm(signedAssertion(privateKey, { header: { x5t }, claims: { ...claims, jti: 'cert-fed-2' } })),
  );
  assert.equal(genuine.status, 200, JSON.stringify(genuine.body));
});

test('the password grant is refused on /common and /consumers with invalid_request, and allowed on the tenant', () => {
  const { auth } = fixture();
  for (const tenantSegment of ['common', 'consumers']) {
    const res = auth.handleToken({ origin: ORIGIN, tenantSegment, form: ROPC });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_request');
    assert.match(res.body.error_description, /\/common or \/consumers/);
  }
  assert.equal(call(auth, ROPC).status, 200);
});

test("the managed identity issuer returns an app-only token with epoch-string expiry, for this directory's resource only", () => {
  const { auth } = fixture();
  const issued = auth.issueManagedIdentityToken({
    origin: ORIGIN,
    clientId: APP_ID.toUpperCase(),
    resource: ORIGIN,
    now: T0,
  });
  const sec = Math.floor(T0 / 1000);
  assert.deepEqual(
    Object.keys(issued).sort(),
    ['client_id', 'expires_in', 'expires_on', 'not_before', 'resource', 'access_token', 'token_type'].sort(),
  );
  assert.equal(issued.token_type, 'Bearer');
  assert.equal(issued.client_id, APP_ID);
  assert.equal(issued.resource, ORIGIN);
  assert.equal(issued.expires_on, String(sec + 3600));
  assert.equal(issued.not_before, String(sec));
  const claims = claimsOf(issued.access_token);
  assert.deepEqual([claims.appid, claims.idtyp, claims.aud, claims.tid], [APP_ID, 'app', ORIGIN, TENANT]);
  assert.equal(auth.verifyBearer(`Bearer ${issued.access_token}`, { origin: ORIGIN, tenantId: TENANT }).ok, true);
  assert.equal(
    auth.issueManagedIdentityToken({
      origin: ORIGIN,
      clientId: APP_ID,
      resource: 'https://other.example.test',
      now: T0,
    }),
    null,
  );
});
