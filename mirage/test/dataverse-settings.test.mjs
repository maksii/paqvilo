import test from "node:test";
import assert from "node:assert/strict";
import { dataverseSettings, dataverseStatus } from "../lib/dataverse-settings.mjs";

const APP = "22222222-2222-2222-2222-222222222222";
const USER_OBJECT = "33333333-3333-3333-3333-333333333333";

test("absent and false disable the simulator; true enables defaults", () => {
  assert.deepEqual(dataverseSettings(undefined), { enabled: false });
  assert.deepEqual(dataverseSettings(false), { enabled: false });
  assert.deepEqual(dataverseSettings(true), {
    enabled: true, port: 0, tls: false, tlsPort: 0, tenantId: null, organizationId: null,
    uniqueName: "orgsim", friendlyName: "Simulated environment", version: "9.2.25041.00000",
    applications: [], users: [], serviceProtection: null,
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
  assert.deepEqual(settings.applications[0].roles, ["System Administrator"]);
  assert.equal(settings.applications[0].publicClient, false);
  assert.equal(settings.applications[0].allowedGrants.length, 6);
  assert.deepEqual(settings.users[0].roles, ["Basic User"]);
  assert.equal(settings.users[0].objectId, USER_OBJECT);
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

test("status exposes runtime and derived identity without secrets", () => {
  const settings = dataverseSettings({ enabled: true, uniqueName: "sim01" });
  assert.deepEqual(dataverseStatus(settings), {
    enabled: true, origin: null, tlsOrigin: null, authority: null, tenantId: null, organizationId: null,
    uniqueName: "sim01", version: "9.2.25041.00000",
  });
  assert.equal(dataverseStatus(dataverseSettings(undefined), { origin: "http://127.0.0.1:1" }).origin, "http://127.0.0.1:1");
});
