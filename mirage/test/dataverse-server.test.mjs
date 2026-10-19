// Simulated Dataverse API wired into the Mirage server: admin endpoints under /_sim/api/dataverse,
// the token round trip and WhoAmI on the Dataverse origin, and isolation from the portal origin.
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
