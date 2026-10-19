import test from "node:test";
import assert from "node:assert/strict";
import { GRANT_TYPES, dataverseSettings, dataverseStatus, grantAllowed } from "../lib/dataverse-settings.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";
test("grantAllowed maps short grant names onto OAuth grant_type values and accepts both spellings", () => {
  assert.equal(grantAllowed({}, "client_credentials"), true, "unset allows every grant");
  assert.equal(grantAllowed({ allowedGrants: ["client_credentials"] }, "client_credentials"), true);
  assert.equal(grantAllowed({ allowedGrants: ["client_credentials"] }, "password"), false);
  assert.equal(grantAllowed({ allowedGrants: ["device_code"] }, "urn:ietf:params:oauth:grant-type:device_code"), true);
  assert.equal(grantAllowed({ allowedGrants: ["on_behalf_of"] }, "urn:ietf:params:oauth:grant-type:jwt-bearer"), true);
  assert.equal(grantAllowed({ allowedGrants: ["urn:ietf:params:oauth:grant-type:device_code"] }, "urn:ietf:params:oauth:grant-type:device_code"), true);
  assert.equal(grantAllowed({ allowedGrants: [] }, "client_credentials"), false);
});

const APP = "22222222-2222-2222-2222-222222222222";
const USER_OBJECT = "33333333-3333-3333-3333-333333333333";

test("absent and false disable the simulator; true enables defaults", () => {
  assert.deepEqual(dataverseSettings(undefined), { enabled: false });
  assert.deepEqual(dataverseSettings(false), { enabled: false });
  assert.deepEqual(dataverseSettings(true), {
    enabled: true, port: 0, tls: false, tlsPort: 0, tenantId: null, organizationId: null,
    uniqueName: "orgsim", friendlyName: "Simulated environment", version: "9.2.25041.00000",
    applications: [], users: [], serviceProtection: null, managedIdentities: [], federatedIssuers: [], auditing: false, tds: { enabled: false, port: 0 },
  });
  assert.deepEqual(dataverseSettings({}), dataverseSettings(true));
});

test("normalizes GUIDs to lowercase and fills application and user defaults", () => {
  const settings = dataverseSettings({
    tenantId: "AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB",
    applications: [{ appId: APP.toUpperCase(), displayName: "Integration client", secretEnvironmentVariable: "PAQVILO_SIM_CLIENT_SECRET" }],
    users: [{ domainname: "maker@example.test", fullname: "Maker User", objectId: USER_OBJECT.toUpperCase() }],
  });
  assert.equal(settings.tenantId, "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb");
  assert.equal(settings.applications[0].appId, APP);
  assert.deepEqual(settings.applications[0].roles, []);
  assert.equal(settings.applications[0].publicClient, false);
  assert.equal(settings.applications[0].allowedGrants.length, 6);
  assert.deepEqual(settings.users[0].roles, ["Basic User"]);
  assert.equal(settings.users[0].objectId, USER_OBJECT);
});

test("an application keeps only the roles it declares; by default it has none", () => {
  const declared = dataverseSettings({ applications: [{ appId: APP, displayName: "x", roles: ["System Administrator"] }] }).applications[0];
  assert.deepEqual(declared.roles, ["System Administrator"]);
  assert.deepEqual(dataverseSettings({ applications: [{ appId: APP, displayName: "x", roles: [] }] }).applications[0].roles, []);
});

test("rejects invalid values with precise messages", () => {
  const cases = [
    [{ port: 70000 }, /dataverse\.port must be an integer from 0 to 65535/],
    [{ tlsPort: 1.5 }, /dataverse\.tlsPort must be an integer/],
    [{ tls: "yes" }, /dataverse\.tls must be true or false/],
    [{ tenantId: "not-a-guid" }, /dataverse\.tenantId must be a GUID/],
    [{ organizationId: 5 }, /dataverse\.organizationId must be a GUID/],
    [{ uniqueName: "Bad-Name" }, /dataverse\.uniqueName must match/],
    [{ friendlyName: "  " }, /dataverse\.friendlyName must be non-empty text/],
    [{ version: "9.2" }, /dataverse\.version must match/],
    [{ applications: {} }, /dataverse\.applications must be an array/],
    [{ applications: [{ displayName: "x" }] }, /dataverse\.applications\[0\]\.appId is required/],
    [{ applications: [{ appId: APP }] }, /dataverse\.applications\[0\]\.displayName is required/],
    [{ applications: [{ appId: APP, displayName: "x", secretEnvironmentVariable: "lower" }] }, /dataverse\.applications\[0\]\.secretEnvironmentVariable must match/],
    [{ applications: [{ appId: APP, displayName: "x", roles: [""] }] }, /dataverse\.applications\[0\]\.roles must be an array of non-empty text/],
    [{ applications: [{ appId: APP, displayName: "x", redirectUris: ["ftp://example.test"] }] }, /dataverse\.applications\[0\]\.redirectUris\[0\] must be an http\(s\) URL/],
    [{ applications: [{ appId: APP, displayName: "x", allowedGrants: ["implicit"] }] }, /dataverse\.applications\[0\]\.allowedGrants must be a subset/],
    [{ users: [{ domainname: "no-at-sign", fullname: "x" }] }, /dataverse\.users\[0\]\.domainname must match/],
    [{ users: [{ domainname: "a@example.test" }] }, /dataverse\.users\[0\]\.fullname is required/],
    [{ serviceProtection: { requestsPer300s: 0 } }, /dataverse\.serviceProtection\.requestsPer300s must be an integer from 1/],
    [{ serviceProtection: { requestsPer300s: 10, extra: 1 } }, /dataverse\.serviceProtection\.extra is not a supported setting/],
  ];
  for (const [value, pattern] of cases) assert.throws(() => dataverseSettings(value), pattern, JSON.stringify(value));
});

test("unknown top-level keys are rejected", () => {
  assert.throws(() => dataverseSettings({ portt: 80 }), /dataverse\.portt is not a supported setting/);
  assert.throws(() => dataverseSettings({ portt: 80 }, "mirage.dataverse"), /mirage\.dataverse\.portt is not a supported setting/);
});

test("application secrets are never accepted from configuration", () => {
  assert.throws(
    () => dataverseSettings({ applications: [{ appId: APP, displayName: "x", secret: "abc" }] }),
    /dataverse\.applications\[0\]\.secret: secrets must come from secretEnvironmentVariable, never from configuration$/,
  );
  assert.throws(() => dataverseSettings({ applications: [{ appId: APP, displayName: "x", clientSecret: "abc" }] }), /secrets must come from secretEnvironmentVariable/);
});

test("a user without objectId gets a deterministic UUID v5 from its lowercased domain name", () => {
  const upper = dataverseSettings({ users: [{ domainname: "Maker@Example.test", fullname: "Maker" }] }).users[0].objectId;
  const lower = dataverseSettings({ users: [{ domainname: "maker@example.test", fullname: "Renamed" }] }).users[0].objectId;
  assert.equal(upper, lower);
  assert.equal(upper, uuidV5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "paqvilo-dataverse-user:maker@example.test"));
  assert.match(upper, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const [first, second] = dataverseSettings({ users: [{ domainname: "a@example.test", fullname: "A" }, { domainname: "b@example.test", fullname: "B" }] }).users;
  assert.notEqual(first.objectId, second.objectId);
  assert.equal(dataverseSettings({ users: [{ domainname: "a@example.test", fullname: "A", objectId: USER_OBJECT }] }).users[0].objectId, USER_OBJECT);
});

test("allowedGrants accept names and URN forms and normalise to names, without duplicates", () => {
  const settings = dataverseSettings({
    applications: [{ appId: APP, displayName: "x", allowedGrants: ["client_credentials", "urn:ietf:params:oauth:grant-type:device_code", "urn:ietf:params:oauth:grant-type:jwt-bearer", "device_code", "refresh_token"] }],
  });
  assert.deepEqual(settings.applications[0].allowedGrants, ["client_credentials", "device_code", "on_behalf_of", "refresh_token"]);
  assert.throws(
    () => dataverseSettings({ applications: [{ appId: APP, displayName: "x", allowedGrants: ["urn:ietf:params:oauth:grant-type:saml2-bearer"] }] }),
    /allowedGrants must be a subset of client_credentials, authorization_code, device_code, refresh_token, password, on_behalf_of/,
  );
});

test("GRANT_TYPES maps setting names to their token endpoint forms", () => {
  assert.deepEqual(GRANT_TYPES, {
    client_credentials: "client_credentials",
    authorization_code: "authorization_code",
    device_code: "urn:ietf:params:oauth:grant-type:device_code",
    refresh_token: "refresh_token",
    password: "password",
    on_behalf_of: "urn:ietf:params:oauth:grant-type:jwt-bearer",
  });
});

test("grantAllowed matches names and URN forms; a missing list allows every grant", () => {
  const app = dataverseSettings({ applications: [{ appId: APP, displayName: "x", allowedGrants: ["device_code", "on_behalf_of"] }] }).applications[0];
  assert.equal(grantAllowed(app, GRANT_TYPES.device_code), true);
  assert.equal(grantAllowed(app, "device_code"), true);
  assert.equal(grantAllowed(app, GRANT_TYPES.on_behalf_of), true);
  assert.equal(grantAllowed(app, "password"), false);
  assert.equal(grantAllowed(app, "urn:ietf:params:oauth:grant-type:unknown"), false);
  assert.equal(grantAllowed({ allowedGrants: [GRANT_TYPES.device_code] }, "device_code"), true);
  assert.equal(grantAllowed({}, "password"), true);
});

test("status exposes runtime and derived identity without secrets", () => {
  const settings = dataverseSettings({ enabled: true, uniqueName: "sim01" });
  assert.deepEqual(dataverseStatus(settings), {
    enabled: true, origin: null, tlsOrigin: null, authority: null, tenantId: null, organizationId: null,
    uniqueName: "sim01", version: "9.2.25041.00000",
  });
  assert.equal(dataverseStatus(dataverseSettings(undefined), { origin: "http://127.0.0.1:1" }).origin, "http://127.0.0.1:1");
});

const MI_CLIENT = "44444444-4444-4444-4444-444444444444";
const ISSUER = "https://issuer.example.test";

test("serviceProtection keeps the limiter's key names; executionTimeMsPer300s is an alias", () => {
  const limits = dataverseSettings({ serviceProtection: { requestsPer300s: 100, executionTimeMsPer300s: 60000, concurrentRequests: 4 } }).serviceProtection;
  assert.deepEqual(limits, { requestsPer300s: 100, executionMsPer300s: 60000, concurrentRequests: 4 });
  assert.deepEqual(dataverseSettings({ serviceProtection: { executionMsPer300s: 5 } }).serviceProtection, { requestsPer300s: null, executionMsPer300s: 5, concurrentRequests: null });
  assert.deepEqual(dataverseSettings({ serviceProtection: { executionMsPer300s: 5, executionTimeMsPer300s: 5 } }).serviceProtection.executionMsPer300s, 5);
  assert.throws(() => dataverseSettings({ serviceProtection: { executionMsPer300s: 5, executionTimeMsPer300s: 6 } }), /executionTimeMsPer300s must equal executionMsPer300s/);
  assert.throws(() => dataverseSettings({ serviceProtection: { executionTimeMsPer300s: 0 } }), /dataverse\.serviceProtection\.executionTimeMsPer300s must be an integer from 1/);
  assert.throws(() => dataverseSettings({ serviceProtection: { concurrentRequests: 1.5 } }), /dataverse\.serviceProtection\.concurrentRequests must be an integer/);
});

test("federatedCredentials default to the token-exchange audience and need exactly one audience", () => {
  const app = dataverseSettings({ applications: [{ appId: APP, displayName: "x", federatedCredentials: [{ issuer: ISSUER, subject: "repo:invented" }] }] }).applications[0];
  assert.deepEqual(app.federatedCredentials, [{ issuer: ISSUER, subject: "repo:invented", audiences: ["api://AzureADTokenExchange"] }]);
  assert.deepEqual(dataverseSettings({ applications: [{ appId: APP, displayName: "x" }] }).applications[0].federatedCredentials, []);
  const bad = (federatedCredentials) => dataverseSettings({ applications: [{ appId: APP, displayName: "x", federatedCredentials }] });
  assert.throws(() => bad([{ issuer: ISSUER, subject: "s", audiences: ["a", "b"] }]), /federatedCredentials\[0\]\.audiences must contain exactly one audience/);
  assert.throws(() => bad([{ issuer: "not a url", subject: "s" }]), /federatedCredentials\[0\]\.issuer must be an http\(s\) URL/);
  assert.throws(() => bad([{ issuer: ISSUER, subject: "s", extra: 1 }]), /federatedCredentials\[0\]\.extra is not a supported setting/);
  assert.throws(() => bad({}), /federatedCredentials must be an array/);
});

test("managedIdentities normalise the client id and default principalId to null", () => {
  const [mi] = dataverseSettings({ managedIdentities: [{ clientId: MI_CLIENT.toUpperCase(), displayName: "Integration identity" }] }).managedIdentities;
  assert.deepEqual(mi, { clientId: MI_CLIENT, principalId: null, displayName: "Integration identity", roles: ["Basic User"] });
  assert.throws(() => dataverseSettings({ managedIdentities: [{ displayName: "x" }] }), /managedIdentities\[0\]\.clientId is required/);
  assert.throws(() => dataverseSettings({ managedIdentities: [{ clientId: MI_CLIENT, displayName: "x", principalId: "nope" }] }), /managedIdentities\[0\]\.principalId must be a GUID/);
});

test("federatedIssuers hold public JWKS only; auditing and tds validate", () => {
  const settings = dataverseSettings({
    federatedIssuers: [{ issuer: ISSUER, jwks: { keys: [{ kty: "RSA", kid: "k1", n: "AQAB", e: "AQAB" }] } }],
    auditing: true,
    tds: { enabled: true, port: 15432 },
  });
  assert.deepEqual(settings.federatedIssuers, [{ issuer: ISSUER, jwks: { keys: [{ kty: "RSA", kid: "k1", n: "AQAB", e: "AQAB" }] } }]);
  assert.equal(settings.auditing, true);
  assert.deepEqual(settings.tds, { enabled: true, port: 15432 });
  assert.throws(() => dataverseSettings({ federatedIssuers: [{ issuer: ISSUER, jwks: { keys: [{ kty: "RSA", d: "secret" }] } }] }), /must hold public keys only/);
  assert.throws(() => dataverseSettings({ federatedIssuers: [{ issuer: ISSUER, jwks: { keys: "x" } }] }), /jwks\.keys must be an array of JSON Web Keys/);
  assert.throws(() => dataverseSettings({ auditing: "yes" }), /dataverse\.auditing must be true or false/);
  assert.throws(() => dataverseSettings({ tds: { port: 70000 } }), /dataverse\.tds\.port must be an integer from 0 to 65535/);
  assert.throws(() => dataverseSettings({ tds: { enabled: true, host: "x" } }), /dataverse\.tds\.host is not a supported setting/);
});
