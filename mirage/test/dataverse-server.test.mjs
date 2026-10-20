// Simulated Dataverse API wired into the Mirage server: admin endpoints under /_sim/api/dataverse,
// the token round trip and WhoAmI on the Dataverse origin, and isolation from the portal origin.
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import tls from "node:tls";
import { once } from "node:events";
import { X509Certificate, createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSelfSignedCertificate } from "../lib/dataverse-tls.mjs";
import { TDS, createMessageReader, encodePrelogin, writeMessage } from "../lib/dataverse-tds-framing.mjs";
import { GRANT_TYPES } from "../lib/dataverse-settings.mjs";
import { createSimulator } from "../server.mjs";

const APP_ID = "44444444-4444-4444-8444-444444444444";
const OBJECT_ID = "33333333-3333-4333-8333-333333333333";

async function start(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-dataverse-server-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: Dataverse server\n");
  const app = await createSimulator({ sourceDir: directory, watch: false, ...options });
  t.after(() => app.close());
  const admin = async (route, { method = "GET", body } = {}) => {
    const response = await fetch(`${app.url}/_sim/api${route}`, {
      method,
      headers: { "x-sim-csrf": app.state().csrf, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { app, admin };
}

async function createApplication(admin) {
  const created = await admin("/dataverse/applications", {
    method: "POST",
    body: { appId: APP_ID, displayName: "Integration client", roles: ["System Administrator"] },
  });
  assert.equal(created.status, 201);
  return created.body;
}

async function clientCredentials(dataverse, secret) {
  const response = await fetch(`${dataverse.authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: secret, scope: `${dataverse.origin}/.default` }),
  });
  return { status: response.status, body: await response.json() };
}

test("enabled runtime exposes the Dataverse origin separately from the portal", async (t) => {
  const { app } = await start(t, { dataverse: { enabled: true } });
  assert.equal(app.state().dataverse.enabled, true);
  assert.notEqual(app.state().dataverse.origin, app.url);
  assert.equal(app.dataverse.origin, app.state().dataverse.origin);
});

test("admin listing shows roles and the SYSTEM user", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  const listing = await admin("/dataverse");
  assert.equal(listing.status, 200);
  assert.ok(listing.body.roles.some((role) => role.name === "System Administrator"));
  assert.ok(listing.body.users.some((user) => user.fullname === "SYSTEM"));
});

test("an application secret is returned once and never listed", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  const created = await createApplication(admin);
  assert.ok(created.secret);
  const listing = await admin("/dataverse");
  const entry = listing.body.applications.find((item) => item.appId === APP_ID);
  assert.ok(entry);
  assert.equal(entry.secrets[0].hint, created.secret.slice(0, 3));
  assert.doesNotMatch(JSON.stringify(listing.body), /"(hash|salt)"/);
  assert.equal(JSON.stringify(listing.body).includes(created.secret), false);
});

test("a client-credentials token authenticates WhoAmI as the created application user", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  const created = await createApplication(admin);
  const issued = await clientCredentials(app.dataverse, created.secret);
  assert.equal(issued.status, 200);
  const whoami = await fetch(`${app.dataverse.origin}/api/data/v9.2/WhoAmI`, {
    headers: { authorization: `Bearer ${issued.body.access_token}` },
  });
  assert.equal(whoami.status, 200);
  assert.equal((await whoami.json()).UserId, created.systemuserid);
});

test("the request log records WhoAmI without authorization material", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  const created = await createApplication(admin);
  const issued = await clientCredentials(app.dataverse, created.secret);
  await fetch(`${app.dataverse.origin}/api/data/v9.2/WhoAmI`, { headers: { authorization: `Bearer ${issued.body.access_token}` } });
  const { body } = await admin("/dataverse/requests");
  assert.ok(body.requests.some((entry) => entry.path.endsWith("WhoAmI")));
  for (const entry of body.requests) assert.equal(Object.keys(entry).some((key) => key.toLowerCase() === "authorization"), false);
});

test("users can be created, disabled and given new roles", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  const created = await admin("/dataverse/users", {
    method: "POST",
    body: { fullname: "Maker User", domainname: "maker@example.test", objectId: OBJECT_ID, roles: ["System Customizer"] },
  });
  assert.equal(created.status, 201);
  const patched = await admin(`/dataverse/users/${created.body.systemuserid}`, {
    method: "PATCH",
    body: { isdisabled: true, roles: ["Basic User"] },
  });
  assert.equal(patched.status, 200);
  const listing = await admin("/dataverse");
  const user = listing.body.users.find((item) => item.systemuserid === created.body.systemuserid);
  assert.equal(user.isdisabled, true);
  assert.deepEqual(user.roles, ["Basic User"]);
});

test("reset keeps application registrations", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  await createApplication(admin);
  const reset = await fetch(`${app.url}/_sim/api/reset`, { method: "POST", headers: { "x-sim-csrf": app.state().csrf } });
  assert.equal(reset.status, 200);
  const listing = await admin("/dataverse");
  assert.ok(listing.body.applications.some((item) => item.appId === APP_ID));
});

test("reset re-seeds the security rows so an application created before it still authenticates", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  const created = await createApplication(admin);
  const reset = await fetch(`${app.url}/_sim/api/reset`, { method: "POST", headers: { "x-sim-csrf": app.state().csrf } });
  assert.equal(reset.status, 200);
  const issued = await clientCredentials(app.dataverse, created.secret);
  assert.equal(issued.status, 200);
  const whoami = await fetch(`${app.dataverse.origin}/api/data/v9.2/WhoAmI`, {
    headers: { authorization: `Bearer ${issued.body.access_token}` },
  });
  assert.equal(whoami.status, 200);
  assert.equal((await whoami.json()).UserId, created.systemuserid);
  const listing = await admin("/dataverse");
  assert.equal(listing.body.users.filter((user) => user.fullname === "SYSTEM").length, 1);
  assert.equal(listing.body.roles.length, 3);
});

test("a registered certificate reports its SHA-1 and SHA-256 thumbprints", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  await createApplication(admin);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const created = await admin(`/dataverse/applications/${APP_ID}/certificates`, {
    method: "POST",
    body: { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.thumbprint, createHash("sha1").update(der).digest("hex").toUpperCase());
  assert.equal(created.body.thumbprint256, createHash("sha256").update(der).digest("hex").toUpperCase());
  const listing = await admin("/dataverse");
  const entry = listing.body.applications.find((item) => item.appId === APP_ID);
  assert.deepEqual(entry.certificates, [{ thumbprint: created.body.thumbprint, thumbprint256: created.body.thumbprint256 }]);
});

test("a registered certificate PEM keeps the certificate's fingerprints as its thumbprints", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  await createApplication(admin);
  const { cert } = createSelfSignedCertificate({ commonName: "Invented client certificate", hosts: [] });
  const x509 = new X509Certificate(cert);
  const created = await admin(`/dataverse/applications/${APP_ID}/certificates`, { method: "POST", body: { certificatePem: cert } });
  assert.equal(created.status, 201);
  assert.equal(created.body.thumbprint, x509.fingerprint.replaceAll(":", ""));
  assert.equal(created.body.thumbprint256, x509.fingerprint256.replaceAll(":", ""));
  const rejected = await admin(`/dataverse/applications/${APP_ID}/certificates`, { method: "POST", body: { certificatePem: "not a pem" } });
  assert.equal(rejected.status, 400);
});

test("enabling Dataverse leaves the portal Web API answers for an unrelated table unchanged", async (t) => {
  const plain = await start(t);
  const withDataverse = await start(t, { dataverse: { enabled: true } });
  // A standard table (accounts) is seeded on Dataverse sites and answers 404 9004010C there; see dataverse-standard-portal.test.mjs.
  for (const route of ["/_api/invented_things?$select=name"]) {
    const answers = [];
    for (const { app } of [plain, withDataverse]) {
      const response = await fetch(`${app.url}${route}`);
      const body = await response.json().catch(() => null);
      answers.push({ status: response.status, code: body?.error?.code ?? null });
    }
    assert.deepEqual(answers[1], answers[0], route);
    assert.notEqual(answers[0].code, null, route);
  }
});

test("Dataverse tables follow the portal's site settings and table permissions", async (t) => {
  const ME = "00000000-0000-0000-0000-0000000000aa";
  const initial = (permissions) => ({
    mappings: { contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" } },
    tables: { contact: [{ contactid: ME, fullname: "Me", statecode: 0 }] },
    permissions,
    settings: { permissionMode: "enforce" },
    simulator: { mode: "local", pageMode: "local", identityScope: "configured", identity: { id: ME, contactId: ME, roles: ["Authenticated Users"] }, live: {}, endpoints: [] },
  });
  const portal = async (settings, permissions) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-dataverse-gating-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: Gating\n");
    if (settings)
      await fs.writeFile(
        path.join(directory, "sitesetting.yml"),
        "- adx_name: Webapi/systemuser/enabled\n  adx_value: 'true'\n- adx_name: Webapi/systemuser/fields\n  adx_value: 'fullname,businessunitid'\n",
      );
    const app = await createSimulator({ sourceDir: directory, watch: false, dataverse: { enabled: true }, initial: initial(permissions) });
    t.after(() => app.close());
    return async (route) => {
      const response = await fetch(app.url + route);
      return { status: response.status, body: await response.json() };
    };
  };
  const read = [{ id: "su", entity: "systemuser", scope: "global", roles: ["Authenticated Users"], operations: ["read"] }];
  // Not enabled: a known table, 404 9004010C (not the 400 of a set that names no table).
  let get = await portal(false, read);
  assert.deepEqual((await get("/_api/systemusers?$select=fullname")).body.error, { code: "9004010C", message: "Resource not found for the segment systemuser." });
  assert.equal((await get("/_api/nosuchthings")).status, 400);
  // Enabled without a grant: 403 90040120.
  get = await portal(true, []);
  assert.deepEqual((await get("/_api/systemusers?$select=fullname")).body.error, { code: "90040120", message: "You don't have permission to read the systemuser table." });
  // Enabled with a grant: seeded rows, and the lookup alias of an allowed lookup column.
  get = await portal(true, read);
  const users = await get("/_api/systemusers?$select=fullname,_businessunitid_value");
  assert.equal(users.status, 200);
  assert.ok(users.body.value.some((row) => row.fullname === "SYSTEM" && row._businessunitid_value));
});

test("the portal origin does not answer Dataverse Web API routes", async (t) => {
  const { app } = await start(t, { dataverse: { enabled: true } });
  const response = await fetch(`${app.url}/api/data/v9.2/WhoAmI`);
  const text = await response.text();
  assert.notEqual(response.status, 200);
  assert.equal(text.includes("UserId"), false);
});

test("disabled HTTP transport keeps the headless organization available to local administration", async (t) => {
  const { app, admin } = await start(t);
  assert.equal(app.state().dataverse.enabled, false);
  assert.equal(app.dataverse, null);
  const response = await admin("/dataverse");
  assert.equal(response.status, 200);
  assert.equal(response.body.enabled, false);
  assert.equal(response.body.organizationAvailable, true);
  assert.ok(response.body.users.some(user => user.fullname === 'SYSTEM'));
  assert.ok(response.body.roles.some(role => role.name === 'System Administrator'));
});

test("close stops the Dataverse listener", async (t) => {
  const { app } = await start(t, { dataverse: { enabled: true } });
  const origin = app.dataverse.origin;
  await app.close();
  await assert.rejects(fetch(`${origin}/api/data/v9.2/WhoAmI`));
});

// Minimal https client that trusts only the runtime's certificate file.
function httpsRequest(url, { ca, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, ca, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function certificatePath(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-dataverse-tls-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "dataverse-ca.pem");
}

test("the https listener serves discovery, token and WhoAmI with the certificate file", async (t) => {
  const certificateFile = await certificatePath(t);
  const { app, admin } = await start(t, { dataverse: { enabled: true, tls: true }, dataverseCertificateFile: certificateFile });
  const { tlsOrigin, certificateFile: reported, certificateFingerprint } = app.state().dataverse;
  assert.match(tlsOrigin, /^https:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(reported, certificateFile);
  assert.match(certificateFingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2})+$/i);
  await fs.stat(certificateFile);
  const ca = await fs.readFile(certificateFile);
  const discovery = await httpsRequest(`${tlsOrigin}/${app.dataverse.tenantId}/v2.0/.well-known/openid-configuration`, { ca });
  assert.equal(discovery.status, 200);
  assert.ok(JSON.parse(discovery.body).token_endpoint.startsWith(`${tlsOrigin}/`));
  const created = await createApplication(admin);
  const issued = await httpsRequest(`${tlsOrigin}/${app.dataverse.tenantId}/oauth2/v2.0/token`, {
    ca,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: created.secret, scope: `${tlsOrigin}/.default` }).toString(),
  });
  assert.equal(issued.status, 200);
  const whoami = await httpsRequest(`${tlsOrigin}/api/data/v9.2/WhoAmI`, { ca, headers: { authorization: `Bearer ${JSON.parse(issued.body).access_token}` } });
  assert.equal(whoami.status, 200);
  assert.equal(JSON.parse(whoami.body).UserId, created.systemuserid);
});

test("a second runtime reuses the certificate file", async (t) => {
  const certificateFile = await certificatePath(t);
  const first = await start(t, { dataverse: { enabled: true, tls: true }, dataverseCertificateFile: certificateFile });
  const second = await start(t, { dataverse: { enabled: true, tls: true }, dataverseCertificateFile: certificateFile });
  assert.ok(first.app.state().dataverse.certificateFingerprint);
  assert.equal(second.app.state().dataverse.certificateFingerprint, first.app.state().dataverse.certificateFingerprint);
});

test("passwords are hashed, reported as passwordSet and never echoed", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  const password = "correct horse battery";
  const created = await admin("/dataverse/users", {
    method: "POST",
    body: { fullname: "Password User", domainname: "password@example.test", objectId: OBJECT_ID, roles: ["Basic User"], password },
  });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes(password), false);
  const plain = await admin("/dataverse/users", { method: "POST", body: { fullname: "Plain User", domainname: "plain@example.test", roles: ["Basic User"] } });
  assert.equal(plain.status, 201);
  const refused = await admin("/dataverse/users", { method: "POST", body: { fullname: "Short", domainname: "short@example.test", password: "short" } });
  assert.equal(refused.status, 400);
  const listing = await admin("/dataverse");
  const passwordUser = listing.body.users.find((item) => item.systemuserid === created.body.systemuserid);
  const plainUser = listing.body.users.find((item) => item.systemuserid === plain.body.systemuserid);
  assert.equal(passwordUser.passwordSet, true);
  assert.equal(plainUser.passwordSet, false);
  // grantTypes names the "password" grant as a value; the check is about keys and secret text.
  const serialised = JSON.stringify({ ...listing.body, grantTypes: undefined });
  assert.equal(serialised.includes(password), false);
  assert.doesNotMatch(serialised, /"(password|hash|salt)"/);
  const patched = await admin(`/dataverse/users/${plain.body.systemuserid}`, { method: "PATCH", body: { password: "another password" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.passwordSet, true);
  assert.equal(JSON.stringify(patched.body).includes("another password"), false);
});

test("close also stops the https listener", async (t) => {
  const certificateFile = await certificatePath(t);
  const { app } = await start(t, { dataverse: { enabled: true, tls: true }, dataverseCertificateFile: certificateFile });
  const { tlsOrigin } = app.state().dataverse;
  const ca = await fs.readFile(certificateFile);
  await app.close();
  await assert.rejects(httpsRequest(`${tlsOrigin}/api/data/v9.2/WhoAmI`, { ca }));
  await assert.rejects(fetch(`${app.dataverse.origin}/api/data/v9.2/WhoAmI`));
});

test("without a state file the https listener keeps its CA in memory", async (t) => {
  const { app } = await start(t, { dataverse: { enabled: true, tls: true } });
  assert.match(app.state().dataverse.tlsOrigin, /^https:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(!app.state().dataverse.certificateFile);
});

test("state export carries no password hashes and only the hint and expiry of each secret", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  await createApplication(admin);
  const user = await admin("/dataverse/users", {
    method: "POST",
    body: { fullname: "Export User", domainname: "export@example.test", objectId: OBJECT_ID, roles: ["Basic User"], password: "export password" },
  });
  assert.equal(user.status, 201);
  const exported = await admin("/state/export");
  assert.equal(exported.status, 200);
  const app = exported.body.dataverse.applications.find((item) => item.appId === APP_ID);
  assert.deepEqual(Object.keys(app.secrets[0]).sort(), ["expiresOn", "hint", "id"]);
  assert.equal(exported.body.dataverse.passwords, undefined);
  assert.equal(JSON.stringify(exported.body).includes("export password"), false);
  assert.doesNotMatch(JSON.stringify(exported.body), /"(hash|salt)"/);
});

test("registration refuses non-http redirect URIs and unknown grants, and stores nothing for them", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  for (const extra of [{ redirectUris: ["javascript:alert(1)"] }, { allowedGrants: ["teleport"] }]) {
    const refused = await admin("/dataverse/applications", { method: "POST", body: { appId: APP_ID, displayName: "Strict client", ...extra } });
    assert.equal(refused.status, 400);
  }
  const accepted = await admin("/dataverse/applications", {
    method: "POST",
    body: { appId: APP_ID, displayName: "Strict client", redirectUris: ["https://client.example.test/callback"], allowedGrants: ["client_credentials", GRANT_TYPES.on_behalf_of] },
  });
  assert.equal(accepted.status, 201);
});

test("user accessmode must be an integer when it is set", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  const refused = await admin("/dataverse/users", { method: "POST", body: { fullname: "Mode User", domainname: "mode@example.test", roles: ["Basic User"], accessmode: "read-write" } });
  assert.equal(refused.status, 400);
  const accepted = await admin("/dataverse/users", { method: "POST", body: { fullname: "Mode User", domainname: "mode@example.test", roles: ["Basic User"], accessmode: 0 } });
  assert.equal(accepted.status, 201);
});

test("importing a state re-seeds security rows, even when it has no Dataverse section, and a missing grants list shows every grant", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  const exported = (await admin("/state/export")).body;
  exported.dataverse = { applications: [{ appId: APP_ID, displayName: "Legacy client", secrets: [], certificates: [], publicClient: false, redirectUris: [] }] };
  const legacy = await admin("/state/import", { method: "POST", body: exported });
  assert.equal(legacy.status, 200);
  const listing = await admin("/dataverse");
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.applications.find((item) => item.appId === APP_ID).allowedGrants, Object.keys(GRANT_TYPES));
  assert.ok(listing.body.users.some((user) => user.fullname === "SYSTEM"));

  delete exported.dataverse;
  const bare = await admin("/state/import", { method: "POST", body: exported });
  assert.equal(bare.status, 200);
  const after = await admin("/dataverse");
  assert.equal(after.status, 200);
  assert.ok(after.body.users.some((user) => user.fullname === "SYSTEM"));
});

const ISSUER = "https://issuer.test/tenant";
const SUBJECT = "repo:sample:ref:refs/heads/main";
const AUDIENCE = "api://AzureADTokenExchange";
const PUBLIC_JWKS = { keys: [{ kty: "RSA", kid: "k1", n: "AQAB", e: "AQAB" }] };
const MI_CLIENT_ID = "55555555-5555-4555-8555-555555555555";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("federated credentials keep the issuer's public keys and are removed by issuer and subject", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  await createApplication(admin);
  const route = `/dataverse/applications/${APP_ID}/federated-credentials`;
  const body = { issuer: ISSUER, subject: SUBJECT, audiences: [AUDIENCE], jwks: PUBLIC_JWKS };

  const created = await admin(route, { method: "POST", body });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { issuer: ISSUER, subject: SUBJECT, audiences: [AUDIENCE] });
  assert.equal((await admin(route, { method: "POST", body })).status, 409);
  const privateKey = await admin(route, { method: "POST", body: { ...body, subject: "repo:other", jwks: { keys: [{ kty: "RSA", d: "secret", n: "AQAB", e: "AQAB" }] } } });
  assert.equal(privateKey.status, 400);
  assert.match(privateKey.body.error.message, /public keys only/);
  const twoAudiences = await admin(route, { method: "POST", body: { ...body, subject: "repo:two", audiences: [AUDIENCE, "api://other"] } });
  assert.equal(twoAudiences.status, 400);
  assert.equal((await admin(`/dataverse/applications/${MI_CLIENT_ID}/federated-credentials`, { method: "POST", body })).status, 404);

  const exported = (await admin("/state/export")).body.dataverse;
  assert.deepEqual(exported.federatedIssuers, [{ issuer: ISSUER, jwks: PUBLIC_JWKS }]);
  assert.deepEqual(exported.applications.find((item) => item.appId === APP_ID).federatedCredentials, [created.body]);

  const removed = await admin(route, { method: "DELETE", body: { issuer: ISSUER, subject: SUBJECT } });
  assert.equal(removed.status, 204);
  assert.equal((await admin(route, { method: "DELETE", body: { issuer: ISSUER, subject: SUBJECT } })).status, 404);
  assert.equal(app.state().dataverse.enabled, true);
});

test("a managed identity becomes an application user with the default role and is listed with its clientId", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  const created = await admin("/dataverse/managed-identities", { method: "POST", body: { clientId: MI_CLIENT_ID, displayName: "Sample app service" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.clientId, MI_CLIENT_ID);
  assert.match(created.body.systemuserid, GUID);
  const listing = await admin("/dataverse");
  const user = listing.body.users.find((item) => item.systemuserid === created.body.systemuserid);
  assert.equal(user.applicationid, MI_CLIENT_ID);
  assert.deepEqual(user.roles, ["Basic User"]);

  assert.equal((await admin("/dataverse/managed-identities", { method: "POST", body: { clientId: MI_CLIENT_ID, displayName: "Again" } })).status, 409);
  assert.equal((await admin("/dataverse/managed-identities", { method: "POST", body: { clientId: "not-a-guid", displayName: "Bad" } })).status, 400);
  const badRole = await admin("/dataverse/managed-identities", { method: "POST", body: { clientId: "66666666-6666-4666-8666-666666666666", displayName: "Role", roles: ["No such role"] } });
  assert.equal(badRole.status, 400);
  assert.equal(badRole.body.error.code, "DATAVERSE_ROLE_NOT_FOUND");
});

test("the managed identity endpoint is reported and its header is shown once by the admin status read", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  const first = await admin("/dataverse");
  assert.equal(first.body.managedIdentity.endpoint, `${app.dataverse.origin}/msi/token`);
  assert.match(first.body.managedIdentity.header, /^[0-9a-f]{48}$/);
  assert.equal((await admin("/dataverse")).body.managedIdentity.header, null);
  assert.equal(app.state().dataverse.managedIdentity.header, null);
});

test("the arc mode reports the IMDS origin without a header, and an unknown mode is refused", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true, managedIdentity: { mode: "arc" } } });
  const listing = await admin("/dataverse");
  assert.equal(listing.body.managedIdentity.endpoint, app.dataverse.origin);
  assert.equal(listing.body.managedIdentity.header, null);
  await assert.rejects(start(t, { dataverse: { enabled: true, managedIdentity: { mode: "ssh" } } }), /managedIdentity\.mode/);
});

test("Solution custom APIs are seeded into the customapi tables and re-seeded after a reset", async (t) => {
  const solution = await fs.mkdtemp(path.join(os.tmpdir(), "pp-dataverse-solution-"));
  t.after(() => fs.rm(solution, { recursive: true, force: true }));
  await fs.mkdir(path.join(solution, "Other"), { recursive: true });
  await fs.writeFile(path.join(solution, "Other", "Solution.xml"), "<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName><Version>1.0</Version></SolutionManifest></ImportExportXml>");
  const api = path.join(solution, "customapis", "sample_Unbound");
  await fs.mkdir(api, { recursive: true });
  await fs.writeFile(path.join(api, "customapi.xml"), '<customapi uniquename="sample_Unbound"><name>sample_Unbound</name><bindingtype>0</bindingtype><isfunction>1</isfunction></customapi>');
  const { app, admin } = await start(t, { dataverse: { enabled: true }, solutionRoots: [solution] });

  const seeded = (await admin("/state/export")).body;
  assert.deepEqual(seeded.tables.customapi.map((row) => row.uniquename), ["sample_Unbound"]);
  assert.equal(seeded.mappings.customapi.dataverseOnly, true);

  const reset = await fetch(`${app.url}/_sim/api/reset`, { method: "POST", headers: { "x-sim-csrf": app.state().csrf } });
  assert.equal(reset.status, 200);
  const after = (await admin("/state/export")).body;
  assert.deepEqual(after.tables.customapi.map((row) => row.uniquename), ["sample_Unbound"]);
  assert.equal(after.mappings.customapi.dataverseOnly, true);
});

const MISSING_APP_ID = "99999999-9999-4999-8999-999999999999";
const PRINCIPAL_ID = "66666666-6666-4666-8666-666666666666";
const SETTINGS_IDENTITY_ID = "77777777-7777-4777-8777-777777777777";

test("registration keeps grants, the client type and redirect URIs; PATCH edits them with the same validation", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  const created = await admin("/dataverse/applications", {
    method: "POST",
    body: { appId: APP_ID, displayName: "Invented client", roles: ["System Administrator"], allowedGrants: ["authorization_code", "refresh_token"], publicClient: true, redirectUris: ["https://client.test/callback"] },
  });
  assert.equal(created.status, 201);
  const entryOf = async () => (await admin("/dataverse")).body.applications.find((item) => item.appId === APP_ID);
  let entry = await entryOf();
  assert.deepEqual(entry.allowedGrants, ["authorization_code", "refresh_token"]);
  assert.equal(entry.publicClient, true);
  assert.deepEqual(entry.redirectUris, ["https://client.test/callback"]);

  const edited = await admin(`/dataverse/applications/${APP_ID}`, { method: "PATCH", body: { displayName: "Renamed client", allowedGrants: ["client_credentials"], redirectUris: [], publicClient: false } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.displayName, "Renamed client");
  entry = await entryOf();
  assert.equal(entry.displayName, "Renamed client");
  assert.deepEqual(entry.allowedGrants, ["client_credentials"]);
  assert.equal(entry.publicClient, false);
  assert.deepEqual(entry.redirectUris, []);
  const listing = await admin("/dataverse");
  assert.equal(listing.body.users.find((user) => user.applicationid === APP_ID).fullname, "Renamed client");

  const unknownGrant = await admin(`/dataverse/applications/${APP_ID}`, { method: "PATCH", body: { allowedGrants: ["implicit"] } });
  assert.equal(unknownGrant.status, 400);
  assert.equal(unknownGrant.body.error.message, "allowedGrants must name known grant types.");
  const badRedirect = await admin(`/dataverse/applications/${APP_ID}`, { method: "PATCH", body: { redirectUris: ["javascript:alert(1)"] } });
  assert.equal(badRedirect.status, 400);
  assert.equal(badRedirect.body.error.message, "redirectUris must be http(s) URLs.");
  assert.equal((await admin(`/dataverse/applications/${APP_ID}`, { method: "PATCH", body: { publicClient: "yes" } })).status, 400);
  assert.equal((await admin(`/dataverse/applications/${MISSING_APP_ID}`, { method: "PATCH", body: { displayName: "Nobody" } })).status, 404);
  assert.equal((await admin("/dataverse/applications", { method: "POST", body: { appId: "88888888-8888-4888-8888-888888888888", displayName: "Bad grant", allowedGrants: ["implicit"] } })).status, 400);
  assert.equal((await entryOf()).displayName, "Renamed client");
});

test("the admin payload lists grant names, federated credentials and the Connect values, never a secret hash or salt", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  const created = await createApplication(admin);
  const credential = { issuer: ISSUER, subject: SUBJECT, audiences: [AUDIENCE], jwks: PUBLIC_JWKS };
  assert.equal((await admin(`/dataverse/applications/${APP_ID}/federated-credentials`, { method: "POST", body: credential })).status, 201);
  const listing = await admin("/dataverse");
  assert.deepEqual(listing.body.grantTypes, Object.keys(GRANT_TYPES));
  assert.deepEqual(listing.body.applications.find((item) => item.appId === APP_ID).federatedCredentials, [{ issuer: ISSUER, subject: SUBJECT, audiences: [AUDIENCE] }]);
  assert.equal(listing.body.origin, app.dataverse.origin);
  assert.equal(listing.body.authority, app.dataverse.authority);
  assert.ok("tdsPort" in listing.body);
  const text = JSON.stringify(listing.body);
  assert.doesNotMatch(text, /"(hash|salt|jwks)"/);
  assert.equal(text.includes(created.secret), false);
});

test("federated credentials are listed per application and removed by issuer and subject", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  await createApplication(admin);
  const route = `/dataverse/applications/${APP_ID}/federated-credentials`;
  await admin(route, { method: "POST", body: { issuer: ISSUER, subject: SUBJECT, audiences: [AUDIENCE], jwks: PUBLIC_JWKS } });
  await admin(route, { method: "POST", body: { issuer: ISSUER, subject: "repo:second", jwks: PUBLIC_JWKS } });
  const listed = (await admin("/dataverse")).body.applications.find((item) => item.appId === APP_ID).federatedCredentials;
  assert.deepEqual(listed.map((item) => item.subject), [SUBJECT, "repo:second"]);
  assert.deepEqual(listed[1].audiences, [AUDIENCE], "the default audience applies");

  assert.equal((await admin(route, { method: "DELETE", body: { issuer: ISSUER, subject: SUBJECT } })).status, 204);
  const after = (await admin("/dataverse")).body.applications.find((item) => item.appId === APP_ID).federatedCredentials;
  assert.deepEqual(after.map((item) => item.subject), ["repo:second"]);
});

test("a managed identity added here is listed as runtime, removed with its application user, and settings identities are refused", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true, managedIdentities: [{ clientId: SETTINGS_IDENTITY_ID, principalId: PRINCIPAL_ID, displayName: "Settings identity" }] } });
  const created = await admin("/dataverse/managed-identities", { method: "POST", body: { clientId: MI_CLIENT_ID, principalId: PRINCIPAL_ID, displayName: "Sample app service", roles: ["System Customizer"] } });
  assert.equal(created.status, 201);
  let listing = await admin("/dataverse");
  assert.deepEqual(listing.body.managedIdentities.find((item) => item.clientId === MI_CLIENT_ID), {
    clientId: MI_CLIENT_ID, principalId: PRINCIPAL_ID, displayName: "Sample app service", roles: ["System Customizer"], source: "runtime",
  });
  assert.equal(listing.body.managedIdentities.find((item) => item.clientId === SETTINGS_IDENTITY_ID).source, "settings");
  let exported = (await admin("/state/export")).body;
  assert.ok(exported.tables.managedidentity.some((row) => row.applicationid === MI_CLIENT_ID));

  const settings = await admin(`/dataverse/managed-identities/${SETTINGS_IDENTITY_ID}`, { method: "DELETE" });
  assert.equal(settings.status, 409);
  assert.equal(settings.body.error.code, "DATAVERSE_MANAGED_IDENTITY_CONFIGURED");
  assert.equal((await admin(`/dataverse/managed-identities/${MISSING_APP_ID}`, { method: "DELETE" })).status, 404);

  assert.equal((await admin(`/dataverse/managed-identities/${MI_CLIENT_ID}`, { method: "DELETE" })).status, 204);
  listing = await admin("/dataverse");
  assert.equal(listing.body.managedIdentities.some((item) => item.clientId === MI_CLIENT_ID), false);
  assert.equal(listing.body.users.some((user) => user.applicationid === MI_CLIENT_ID), false);
  exported = (await admin("/state/export")).body;
  assert.equal(exported.tables.managedidentity.some((row) => row.applicationid === MI_CLIENT_ID), false);
});

test("a certificate is removed by its SHA-1 or SHA-256 thumbprint", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  await createApplication(admin);
  const first = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
  const second = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
  const one = (await admin(`/dataverse/applications/${APP_ID}/certificates`, { method: "POST", body: { publicKeyPem: first } })).body;
  const two = (await admin(`/dataverse/applications/${APP_ID}/certificates`, { method: "POST", body: { publicKeyPem: second } })).body;
  assert.equal((await admin(`/dataverse/applications/${APP_ID}/certificates/ABCDEF0123456789ABCDEF0123456789ABCDEF01`, { method: "DELETE" })).status, 404);

  assert.equal((await admin(`/dataverse/applications/${APP_ID}/certificates/${one.thumbprint}`, { method: "DELETE" })).status, 204);
  assert.equal((await admin(`/dataverse/applications/${APP_ID}/certificates/${one.thumbprint}`, { method: "DELETE" })).status, 404);
  assert.equal((await admin(`/dataverse/applications/${APP_ID}/certificates/${two.thumbprint256}`, { method: "DELETE" })).status, 204);
  const entry = (await admin("/dataverse")).body.applications.find((item) => item.appId === APP_ID);
  assert.deepEqual(entry.certificates, []);
});

// Runtime environment settings and user passwords (admin PATCH routes), each checked for its effect on the API.
const PUBLIC_APP_ID = "55555555-5555-4555-8555-555555555555";
const SIGN_IN_PASSWORD = "correct horse battery";
const TDS_DISABLED = Buffer.from("TDS protocol endpoint is disabled for this organization.", "utf16le");
const ERROR_TOKEN = 0xaa;

async function passwordGrant(dataverse, username, password) {
  const response = await fetch(`${dataverse.authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: PUBLIC_APP_ID, username, password, scope: `${dataverse.origin}/.default` }),
  });
  return { status: response.status, body: await response.json() };
}

test("a user password is set and cleared by PATCH, and a cleared password no longer signs in", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  const created = await admin("/dataverse/users", {
    method: "POST",
    body: { fullname: "Sign-in User", domainname: "signin@example.test", objectId: OBJECT_ID, roles: ["Basic User"] },
  });
  assert.equal(created.status, 201);
  const publicApp = await admin("/dataverse/applications", {
    method: "POST",
    body: { appId: PUBLIC_APP_ID, displayName: "Public client", publicClient: true, allowedGrants: ["password"] },
  });
  assert.equal(publicApp.status, 201);
  const userId = created.body.systemuserid;
  const passwordSet = async () => (await admin("/dataverse")).body.users.find((item) => item.systemuserid === userId).passwordSet;

  const set = await admin(`/dataverse/users/${userId}`, { method: "PATCH", body: { password: SIGN_IN_PASSWORD } });
  assert.equal(set.status, 200);
  assert.equal(set.body.passwordSet, true);
  assert.equal(JSON.stringify(set.body).includes(SIGN_IN_PASSWORD), false);
  assert.equal((await passwordGrant(app.dataverse, "signin@example.test", SIGN_IN_PASSWORD)).status, 200);
  assert.notEqual((await passwordGrant(app.dataverse, "signin@example.test", "wrong password")).status, 200);

  const refused = await admin(`/dataverse/users/${userId}`, { method: "PATCH", body: { password: "short" } });
  assert.equal(refused.status, 400);
  assert.equal(await passwordSet(), true, "a refused password leaves the stored one alone");

  const cleared = await admin(`/dataverse/users/${userId}`, { method: "PATCH", body: { password: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.passwordSet, false);
  assert.notEqual((await passwordGrant(app.dataverse, "signin@example.test", SIGN_IN_PASSWORD)).status, 200);
});

test("the environment settings are listed with the restart-only values, and PATCH validates each field before writing", async (t) => {
  const { admin } = await start(t, { dataverse: { enabled: true } });
  const listing = (await admin("/dataverse")).body;
  assert.deepEqual(listing.environment, {
    auditing: false,
    duplicateDetection: true,
    tdsEnabled: true,
    pluginTimeoutSeconds: 120,
    requestsPer300s: null,
    restartRequired: { port: 0, tls: false, tenantId: listing.tenantId, organizationId: listing.organizationId, localeId: 1033, currencyCode: "USD" },
  });

  for (const body of [{ auditing: "yes" }, { duplicateDetection: 1 }, { tdsEnabled: "false" }, { pluginTimeoutSeconds: 0 }, { pluginTimeoutSeconds: 3601 }, { pluginTimeoutSeconds: 1.5 }, { requestsPer300s: 0 }, { requestsPer300s: "5" }]) {
    const refused = await admin("/dataverse/environment", { method: "PATCH", body });
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  // One bad field refuses the whole PATCH: the valid auditing flag is not written.
  assert.equal((await admin("/dataverse/environment", { method: "PATCH", body: { auditing: true, pluginTimeoutSeconds: 0 } })).status, 400);
  assert.equal((await admin("/dataverse")).body.environment.auditing, false);

  const accepted = await admin("/dataverse/environment", { method: "PATCH", body: { auditing: true, pluginTimeoutSeconds: 30, requestsPer300s: 5 } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(
    { auditing: accepted.body.auditing, pluginTimeoutSeconds: accepted.body.pluginTimeoutSeconds, requestsPer300s: accepted.body.requestsPer300s },
    { auditing: true, pluginTimeoutSeconds: 30, requestsPer300s: 5 },
  );
  const off = await admin("/dataverse/environment", { method: "PATCH", body: { requestsPer300s: null } });
  assert.equal(off.body.requestsPer300s, null, "null turns the request limit off");
});

test("switching auditing off in the environment stops audit rows for writes", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  // An audited table comes from the state: the mapping says so, as a solution's metadata would.
  const state = (await admin("/state/export")).body;
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    dataverseMetadata: { IsAuditEnabled: { Value: true } }, relationships: {}, fields: { name: { dataverseType: "nvarchar" } },
  };
  state.tables.widget = [];
  assert.equal((await admin("/state/import", { method: "POST", body: state })).status, 200);
  const created = await createApplication(admin);
  const { access_token: token } = (await clientCredentials(app.dataverse, created.secret)).body;
  const create = (name) =>
    fetch(`${app.dataverse.origin}/api/data/v9.2/widgets`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  const auditRows = async () => ((await admin("/state/export")).body.tables.audit ?? []).length;

  assert.equal((await admin("/dataverse/environment", { method: "PATCH", body: { auditing: true } })).status, 200);
  assert.equal((await create("On")).status, 204);
  assert.equal(await auditRows(), 1, "a write with auditing on adds an audit row");
  assert.equal((await admin("/dataverse/environment", { method: "PATCH", body: { auditing: false } })).status, 200);
  assert.equal((await create("Off")).status, 204);
  assert.equal(await auditRows(), 1, "a write with auditing off adds no audit row");
});

// Same login path as dataverse-tds-integration.test.mjs: TLS with ALPN tds/8.0, PRELOGIN, then LOGIN7 with a FEDAUTH token.
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
function tdsLogin7(token) {
  const fixed = Buffer.alloc(94);
  fixed.writeUInt32LE(0x74000004, 4);
  fixed.writeUInt32LE(4096, 8);
  fixed.writeUInt8(0x10, 27);
  const variable = [];
  let at = 94;
  const put = (slot, value) => {
    const data = Buffer.from(value, "utf16le");
    fixed.writeUInt16LE(at, slot);
    fixed.writeUInt16LE(value.length, slot + 2);
    variable.push(data);
    at += data.length;
  };
  put(36, "client-host");
  put(40, "tester");
  put(48, "tds-server-test");
  put(52, "mirage");
  put(60, "tds-server-test-lib");
  put(68, "org");
  const tokenBytes = Buffer.from(token, "utf16le");
  const fedAuthData = Buffer.concat([Buffer.from([0x03]), u32(tokenBytes.length), tokenBytes]);
  const feature = Buffer.concat([Buffer.from([0x02]), u32(fedAuthData.length), fedAuthData, Buffer.from([0xff])]);
  fixed.writeUInt16LE(at, 56);
  variable.push(u32(at + 4), feature);
  const body = Buffer.concat([fixed, ...variable]);
  body.writeUInt32LE(body.length, 0);
  return body;
}
async function tdsLogin(port, token = "not-a-token") {
  const socket = tls.connect({ host: "127.0.0.1", port, ALPNProtocols: ["tds/8.0"], rejectUnauthorized: false });
  socket.on("error", () => {});
  await once(socket, "secureConnect");
  const replies = [];
  const waiting = [];
  socket.on("data", createMessageReader((type, payload) => {
    const resume = waiting.shift();
    if (resume) resume(payload);
    else replies.push(payload);
  }));
  const next = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve) => waiting.push(resolve)));
  writeMessage(socket, TDS.PRELOGIN, encodePrelogin({ version: Buffer.from([12, 0, 0, 0, 0, 0]), encryption: 0x01, fedAuthRequired: 0x01 }));
  await next();
  writeMessage(socket, TDS.LOGIN7, tdsLogin7(token));
  const reply = await next();
  socket.destroy();
  return reply;
}

test("the TDS endpoint refuses logins while the environment turns it off, and accepts the sign-in check again when it is on", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  const port = app.dataverse.tdsPort;
  assert.ok(Number.isInteger(port) && port > 0);
  assert.equal((await admin("/dataverse/environment", { method: "PATCH", body: { tdsEnabled: false } })).status, 200);
  const refused = await tdsLogin(port);
  assert.equal(refused[0], ERROR_TOKEN);
  assert.ok(refused.indexOf(TDS_DISABLED) > 0, "the refusal names the disabled endpoint");

  assert.equal((await admin("/dataverse/environment", { method: "PATCH", body: { tdsEnabled: true } })).status, 200);
  const answered = await tdsLogin(port);
  assert.equal(answered[0], ERROR_TOKEN);
  assert.equal(answered.indexOf(TDS_DISABLED), -1, "an enabled endpoint no longer refuses for being disabled");
});

test("a requests-per-300-seconds limit set in the environment answers the next Web API request with 429, and null lifts it", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  const created = await createApplication(admin);
  const { access_token: token } = (await clientCredentials(app.dataverse, created.secret)).body;
  const whoami = () => fetch(`${app.dataverse.origin}/api/data/v9.2/WhoAmI`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await admin("/dataverse/environment", { method: "PATCH", body: { requestsPer300s: 1 } })).status, 200);
  assert.equal((await whoami()).status, 200);
  const limited = await whoami();
  assert.equal(limited.status, 429);
  assert.equal((await admin("/dataverse/environment", { method: "PATCH", body: { requestsPer300s: null } })).status, 200);
  assert.equal((await whoami()).status, 200);
});

test("switching duplicate detection off in the environment lets a duplicate through, and on again refuses it", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  // A published rule that matches a widget by code, with one existing widget: the state carries both, as a solution would.
  const WIDGET_ID = "66666666-6666-4666-8666-666666666661";
  const RULE_ID = "66666666-6666-4666-8666-666666666662";
  const state = (await admin("/state/export")).body;
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    fields: { name: { dataverseType: "nvarchar" }, code: { dataverseType: "nvarchar" }, statecode: { dataverseType: "int" } },
  };
  state.tables.widget = [{ widgetid: WIDGET_ID, name: "Existing", code: "A1", statecode: 0 }];
  state.tables.duplicaterule = [{ duplicateruleid: RULE_ID, name: "rule", baseentityname: "widget", matchingentityname: "widget", excludeinactiverecords: false, iscasesensitive: false, statecode: 1, statuscode: 2 }];
  state.tables.duplicaterulecondition = [{ duplicateruleconditionid: "66666666-6666-4666-8666-666666666663", regardingobjectid: RULE_ID, baseattributename: "code", matchingattributename: "code", operatorcode: "ExactMatch", operatorparam: null, ignoreblankvalues: false }];
  assert.equal((await admin("/state/import", { method: "POST", body: state })).status, 200);
  const created = await createApplication(admin);
  const { access_token: token } = (await clientCredentials(app.dataverse, created.secret)).body;
  const create = () =>
    fetch(`${app.dataverse.origin}/api/data/v9.2/widgets`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "mscrm.suppressduplicatedetection": "false" },
      body: JSON.stringify({ code: "A1" }),
    });

  assert.equal((await create()).status, 412, "the duplicate is refused while detection is on");
  assert.equal((await admin("/dataverse/environment", { method: "PATCH", body: { duplicateDetection: false } })).status, 200);
  assert.equal((await create()).status, 204, "the same duplicate goes through with detection off");
  assert.equal((await admin("/dataverse/environment", { method: "PATCH", body: { duplicateDetection: true } })).status, 200);
  assert.equal((await create()).status, 412, "detection on again refuses the duplicate");
});

test("a classic workflow's run mode is listed and set through the admin route, and the next run follows it", async (t) => {
  const { app, admin } = await start(t, { dataverse: { enabled: true } });
  const created = await createApplication(admin);
  const token = (await clientCredentials(app.dataverse, created.secret)).body.access_token;
  // An activated on-demand classic workflow on systemuser (invented): it has no pack handler, so its default run is a placeholder.
  const WORKFLOW = "bbbbbbbb-0000-0000-0000-000000000077";
  app.store.transact(() => {
    (app.store.state.tables.workflow ??= []).push({
      workflowid: WORKFLOW, name: "Invented admin run", uniquename: "Invented_Admin_Run", category: 0, type: 1, mode: 0, scope: 4,
      ondemand: true, subprocess: false, triggeroncreate: false, triggerondelete: false, primaryentity: "systemuser", statecode: 1, statuscode: 2,
      runas: 0, istransacted: true, asyncautodelete: false, syncworkflowlogonfailure: false,
    });
  });
  const entry = (await admin("/dataverse")).body.workflows.find((row) => row.workflowid === WORKFLOW);
  assert.equal(entry.override, null);
  assert.equal(entry.processMode, "background");

  // Runs ExecuteWorkflow and returns the job row once it has finished.
  async function run() {
    const response = await fetch(`${app.dataverse.origin}/api/data/v9.2/workflows(${WORKFLOW})/Microsoft.Dynamics.CRM.ExecuteWorkflow`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ EntityId: created.systemuserid }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const { asyncoperationid } = await response.json();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = app.store.tableRows("asyncoperation").find((item) => item.asyncoperationid === asyncoperationid);
      if (job?.statecode === 3) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the job did not finish");
  }
  const patch = (body) => admin(`/dataverse/workflows/${WORKFLOW}`, { method: "PATCH", body });

  const mocked = await patch({ mode: "mock", mock: { status: 31, message: "Invented failure" } });
  assert.equal(mocked.status, 200);
  assert.deepEqual(mocked.body.override, { mode: "mock", status: 31, message: "Invented failure" });
  const failed = await run();
  assert.equal(failed.statuscode, 31);
  assert.equal(failed.message, "Invented failure");

  assert.equal((await patch({ mode: "disabled" })).status, 200);
  const disabled = await run();
  assert.equal(disabled.statuscode, 32);
  assert.match(disabled.message, /disabled/);

  assert.equal((await patch({ mode: "placeholder" })).status, 200);
  assert.match((await run()).message, /classic workflow XAML is not executed/);

  const cleared = await patch({ mode: "handler" });
  assert.equal(cleared.body.override, null);
  assert.equal(app.store.state.dataverse.workflowOverrides[WORKFLOW], undefined);

  assert.equal((await patch({ mode: "bogus" })).status, 400);
  assert.equal((await patch({ mode: "mock", mock: { status: 32 } })).status, 400);
  assert.equal((await admin("/dataverse/workflows/cccccccc-0000-0000-0000-000000000001", { method: "PATCH", body: { mode: "placeholder" } })).status, 404);
});
