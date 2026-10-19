// Simulated Dataverse API wired into the Mirage server: admin endpoints under /_sim/api/dataverse,
// the token round trip and WhoAmI on the Dataverse origin, and isolation from the portal origin.
import test from "node:test";
import assert from "node:assert/strict";
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
