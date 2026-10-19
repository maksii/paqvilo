import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { test } from "node:test";
import { createAuthority, handleAuthorize, hashSecret, newClientSecret, verifySecret } from "../lib/dataverse-auth.mjs";

// Invented identifiers and a loopback origin only.
const ORIGIN = "https://127.0.0.1:9443";
const TENANT = "7e1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";
const APP_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const USER_OID = "0f1e2d3c-4b5a-4968-8778-6a5b4c3d2e1f";
const UNKNOWN_TENANT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const TOKEN_V2 = `${ORIGIN}/${TENANT}/oauth2/v2.0/token`;
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const T0 = Date.parse("2026-10-19T10:00:00Z");
const SECRET = newClientSecret();

const users = {
  byObjectId: (oid) => (oid === USER_OID ? { azureactivedirectoryobjectid: USER_OID, fullname: "Test User", domainname: "test.user@example.test", firstname: "Test", lastname: "User" } : null),
  byDomainName: () => null,
  verifyPassword: () => false,
};

function fixture() {
  const state = { now: T0 };
  const applications = [{
    appId: APP_ID,
    displayName: "Invented test app",
    secrets: [{ id: "s1", ...hashSecret(SECRET), hint: SECRET.slice(-4), expiresOn: null }],
    certificates: [],
    publicClient: false,
    allowedGrants: ["client_credentials", "refresh_token"],
  }];
  const auth = createAuthority({ tenantId: TENANT, applications: () => applications, users, clock: () => state.now });
  return { applications, state, auth };
}

const call = (auth, form, extra = {}) => auth.handleToken({ origin: ORIGIN, tenantSegment: TENANT, form, ...extra });
const ccForm = (extra = {}) => ({ grant_type: "client_credentials", client_id: APP_ID, client_secret: SECRET, scope: `${ORIGIN}/.default`, ...extra });
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

// No X.509 certificate exists in these fixtures, so the registered thumbprint is SHA-1 of the DER SPKI bytes,
// uppercase hex, and the assertion header x5t is that same digest base64url-encoded.
function registerCertificate(app) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  const thumbprint = createHash("sha1").update(der).digest("hex").toUpperCase();
  app.certificates = [{ thumbprint, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }) }];
  return { privateKey: pair.privateKey, x5t: Buffer.from(thumbprint, "hex").toString("base64url") };
}

function clientAssertion(privateKey, x5t, nowMs) {
  const head = b64({ alg: "RS256", typ: "JWT", x5t });
  const body = b64({ aud: TOKEN_V2, iss: APP_ID, sub: APP_ID, nbf: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + 300, jti: "test-jti-1" });
  return `${head}.${body}.${sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

test("JWKS publishes one RS256 key whose n and e verify the authority's tokens", () => {
  const { auth } = fixture();
  const { keys } = auth.jwks();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kty, "RSA");
  assert.equal(keys[0].use, "sig");
  assert.equal(keys[0].alg, "RS256");
  const res = call(auth, ccForm());
  const [head, body, signature] = res.body.access_token.split(".");
  const publicKey = createPublicKey({ key: { kty: keys[0].kty, n: keys[0].n, e: keys[0].e }, format: "jwk" });
  assert.equal(verify("sha256", Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, "base64url")), true);
  assert.equal(JSON.parse(Buffer.from(head, "base64url").toString("utf8")).kid, keys[0].kid);
});

test("OIDC v2 and v1 documents list the endpoints built from origin and tenant", () => {
  const { auth } = fixture();
  const v2 = auth.openIdConfiguration(ORIGIN, "v2.0");
  assert.equal(v2.issuer, `${ORIGIN}/${TENANT}/v2.0`);
  assert.equal(v2.authorization_endpoint, `${ORIGIN}/${TENANT}/oauth2/v2.0/authorize`);
  assert.equal(v2.token_endpoint, TOKEN_V2);
  assert.equal(v2.device_authorization_endpoint, `${ORIGIN}/${TENANT}/oauth2/v2.0/devicecode`);
  assert.equal(v2.jwks_uri, `${ORIGIN}/${TENANT}/discovery/v2.0/keys`);
  assert.equal(v2.end_session_endpoint, `${ORIGIN}/${TENANT}/oauth2/v2.0/logout`);
  assert.equal(v2.userinfo_endpoint, `${ORIGIN}/oidc/userinfo`);
  for (const field of ["response_modes_supported", "response_types_supported", "scopes_supported", "token_endpoint_auth_methods_supported", "claims_supported", "tenant_region_scope", "cloud_instance_name", "cloud_graph_host_name", "msgraph_host", "rbac_url"]) {
    assert.ok(field in v2, `missing ${field}`);
  }
  const v1 = auth.openIdConfiguration(ORIGIN, "v1.0");
  assert.equal(v1.issuer, `${ORIGIN}/${TENANT}/`);
  assert.equal(v1.authorization_endpoint, `${ORIGIN}/${TENANT}/oauth2/authorize`);
  assert.equal(v1.token_endpoint, `${ORIGIN}/${TENANT}/oauth2/token`);
  assert.equal(v1.jwks_uri, `${ORIGIN}/${TENANT}/discovery/keys`);
});

test("instance discovery names the tenant metadata and the origin host", () => {
  const { auth } = fixture();
  assert.deepEqual(auth.instanceDiscovery(ORIGIN), {
    tenant_discovery_endpoint: `${ORIGIN}/${TENANT}/v2.0/.well-known/openid-configuration`,
    "api-version": "1.1",
    metadata: [{ preferred_network: "127.0.0.1:9443", preferred_cache: "127.0.0.1:9443", aliases: ["127.0.0.1:9443"] }],
  });
});

test("client_credentials with the correct secret issues a v1-format app token", () => {
  const { auth } = fixture();
  const res = call(auth, ccForm());
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers.pragma, "no-cache");
  const { body } = res;
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 3600);
  assert.equal(body.ext_expires_in, 3600);
  const claims = claimsOf(body.access_token);
  assert.equal(claims.ver, "1.0");
  assert.equal(claims.appid, APP_ID);
  assert.equal(claims.appidacr, "1");
  assert.equal(claims.idtyp, "app");
  assert.equal(claims.aud, ORIGIN);
  assert.equal(claims.iss, `${ORIGIN}/${TENANT}/`);
  assert.equal(claims.tid, TENANT);
  assert.equal(claims.exp - claims.iat, 3600);
});

test("client_credentials accepts HTTP Basic client authentication", () => {
  const { auth } = fixture();
  const form = ccForm({ client_id: undefined, client_secret: undefined });
  const authorization = `Basic ${Buffer.from(`${APP_ID}:${SECRET}`).toString("base64")}`;
  const res = call(auth, form, { headers: { authorization } });
  assert.equal(res.status, 200);
  assert.equal(claimsOf(res.body.access_token).appid, APP_ID);
});

test("a wrong client secret answers 401 invalid_client with AADSTS7000215", () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ client_secret: "not-the-secret" }));
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "invalid_client");
  assert.deepEqual(res.body.error_codes, [7000215]);
  assert.match(res.body.error_description, /^AADSTS7000215: /);
  assert.match(res.body.error_description, / Trace ID: \S+ Correlation ID: \S+ Timestamp: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
});

test("an unknown client answers 400 unauthorized_client with AADSTS700016", () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ client_id: "99999999-9999-4999-8999-999999999999" }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "unauthorized_client");
  assert.deepEqual(res.body.error_codes, [700016]);
  assert.match(res.body.error_description, /^AADSTS700016: /);
});

test("an unknown tenant answers 400 with AADSTS90002", () => {
  const { auth } = fixture();
  const res = auth.handleToken({ origin: ORIGIN, tenantSegment: UNKNOWN_TENANT, form: ccForm() });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_request");
  assert.deepEqual(res.body.error_codes, [90002]);
});

test("a missing grant_type answers 400 with AADSTS900144", () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ grant_type: undefined }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_request");
  assert.deepEqual(res.body.error_codes, [900144]);
});

test("a scope for another resource answers 400 invalid_scope with AADSTS70011", () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ scope: "https://other.example.test/.default" }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_scope");
  assert.deepEqual(res.body.error_codes, [70011]);
});

test("an unsupported grant type answers 400 unsupported_grant_type with AADSTS70003", () => {
  const { auth } = fixture();
  const res = call(auth, ccForm({ grant_type: "foo" }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "unsupported_grant_type");
  assert.deepEqual(res.body.error_codes, [70003]);
  assert.match(res.body.error_description, /^AADSTS70003: /);
});

test("the v1 token endpoint takes resource= and answers v1 fields", () => {
  const { auth } = fixture();
  const res = call(auth, { grant_type: "client_credentials", client_id: APP_ID, client_secret: SECRET, resource: ORIGIN }, { version: "v1.0" });
  assert.equal(res.status, 200);
  assert.equal(res.body.resource, ORIGIN);
  assert.equal(typeof res.body.expires_on, "string");
  assert.equal(typeof res.body.not_before, "string");
  assert.equal(res.body.expires_in, "3600");
  assert.equal(claimsOf(res.body.access_token).aud, ORIGIN);
});

test("refresh tokens rotate: the presented token is spent on first use", () => {
  const { auth, state } = fixture();
  const seed = auth.issueRefreshToken({ appId: APP_ID, oid: USER_OID, resource: ORIGIN, scope: `openid offline_access ${ORIGIN}/.default`, now: state.now });
  const refreshForm = (token) => ({ grant_type: "refresh_token", client_id: APP_ID, client_secret: SECRET, refresh_token: token });
  const first = call(auth, refreshForm(seed));
  assert.equal(first.status, 200);
  assert.notEqual(first.body.refresh_token, seed);
  assert.equal(claimsOf(first.body.access_token).idtyp, "user");
  assert.equal(claimsOf(first.body.access_token).upn, "test.user@example.test");
  const replay = call(auth, refreshForm(seed));
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");
  assert.deepEqual(replay.body.error_codes, [9002313]);
  assert.equal(call(auth, refreshForm(first.body.refresh_token)).status, 200);
});

test("client_assertion with a registered certificate issues a token with appidacr 2", () => {
  const { auth, applications, state } = fixture();
  const { privateKey, x5t } = registerCertificate(applications[0]);
  const res = call(auth, { grant_type: "client_credentials", client_id: APP_ID, client_assertion_type: ASSERTION_TYPE, client_assertion: clientAssertion(privateKey, x5t, state.now), scope: `${ORIGIN}/.default` });
  assert.equal(res.status, 200);
  assert.equal(claimsOf(res.body.access_token).appidacr, "2");
});

test("a client_assertion with a bad signature answers invalid_client with AADSTS700027", () => {
  const { auth, applications, state } = fixture();
  const { x5t } = registerCertificate(applications[0]);
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const res = call(auth, { grant_type: "client_credentials", client_id: APP_ID, client_assertion_type: ASSERTION_TYPE, client_assertion: clientAssertion(stranger, x5t, state.now), scope: `${ORIGIN}/.default` });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_client");
  assert.deepEqual(res.body.error_codes, [700027]);
});

test("verifyBearer accepts a fresh token and reports each rejection reason", () => {
  const { auth, state } = fixture();
  const opts = { origin: ORIGIN, tenantId: TENANT };
  const access = call(auth, ccForm()).body.access_token;
  const ok = auth.verifyBearer(`Bearer ${access}`, opts);
  assert.equal(ok.ok, true);
  assert.equal(ok.claims.appid, APP_ID);

  assert.deepEqual(auth.verifyBearer(undefined, opts), { ok: false, reason: "missing" });

  const [head, body, signature] = access.split(".");
  const forged = b64({ ...claimsOf(access), tid: "forged" });
  assert.deepEqual(auth.verifyBearer(`Bearer ${head}.${forged}.${signature}`, opts), { ok: false, reason: "signature" });

  const wrongAudience = auth.issueAccessToken({ origin: ORIGIN, appId: APP_ID, audience: "https://other.example.test", now: state.now });
  assert.deepEqual(auth.verifyBearer(`Bearer ${wrongAudience}`, opts), { ok: false, reason: "audience" });

  state.now = T0 + (3600 + 301) * 1000;
  assert.deepEqual(auth.verifyBearer(`Bearer ${access}`, opts), { ok: false, reason: "expired" });
});

test("verifyBearer tolerates five minutes of clock skew after expiry", () => {
  const { auth, state } = fixture();
  const access = call(auth, ccForm()).body.access_token;
  state.now = T0 + (3600 + 299) * 1000;
  assert.equal(auth.verifyBearer(`Bearer ${access}`, { origin: ORIGIN, tenantId: TENANT }).ok, true);
});

test("hashSecret and verifySecret round trip and reject a mismatch", () => {
  const stored = hashSecret("invented-secret");
  assert.equal(verifySecret("invented-secret", stored), true);
  assert.equal(verifySecret("another-secret", stored), false);
  assert.equal(verifySecret("invented-secret", {}), false);
  assert.notEqual(hashSecret("invented-secret").hash, stored.hash);
});

test("the milestone 1 interactive endpoints answer 501", () => {
  const res = handleAuthorize();
  assert.equal(res.status, 501);
  assert.equal(res.body, "Not implemented in this milestone");
  assert.equal(res.headers["content-type"], "text/plain");
});
