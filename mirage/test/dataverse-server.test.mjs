// Simulated Dataverse API wired into the Mirage server: admin endpoints under /_sim/api/dataverse,
// the token round trip and WhoAmI on the Dataverse origin, and isolation from the portal origin.
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { X509Certificate, createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSelfSignedCertificate } from "../lib/dataverse-tls.mjs";
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

test("enabling Dataverse leaves the portal Web API answers unchanged", async (t) => {
  const plain = await start(t);
  const withDataverse = await start(t, { dataverse: { enabled: true } });
  for (const route of ["/_api/systemusers?$select=fullname", "/_api/accounts?$select=name"]) {
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

test("the portal origin does not answer Dataverse Web API routes", async (t) => {
  const { app } = await start(t, { dataverse: { enabled: true } });
  const response = await fetch(`${app.url}/api/data/v9.2/WhoAmI`);
  const text = await response.text();
  assert.notEqual(response.status, 200);
  assert.equal(text.includes("UserId"), false);
});

test("disabled runtime reports disabled and refuses Dataverse admin routes", async (t) => {
  const { app, admin } = await start(t);
  assert.equal(app.state().dataverse.enabled, false);
  assert.equal(app.dataverse, null);
  const response = await admin("/dataverse");
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "DATAVERSE_DISABLED");
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
  const serialised = JSON.stringify(listing.body);
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
