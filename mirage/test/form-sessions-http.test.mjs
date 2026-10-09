import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSimulator } from "../server.mjs";
import { signInHeaders } from "../testing/session.mjs";

// Synthetic exports and local state only; no portal is contacted.
const wizardSchema = {
  initialStepId: "create",
  steps: [
    { stepId: "create", nextStepId: "edit", entity: "contact", title: "Create contact", mode: 100000000, fields: [{ name: "fullname", label: "Name", required: true }] },
    { stepId: "edit", entity: "contact", title: "Edit contact", mode: 100000001, fields: [{ name: "fullname", label: "Name", required: true }, { name: "jobtitle", label: "Job title" }] },
  ],
};

async function fixture(t, { formYaml = "", mode = "local", liveBridge, forms = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-form-sessions-"));
  const files = {
    "website.yml": "adx_websiteid: website\nadx_name: Test",
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Wizard\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    "Main.pagetemplate.yml": "adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true",
    "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "Main.webtemplate.source.html": '{% webform name: "Contact wizard" %}',
    "Wizard.advancedform.yml": `adx_webformid: wizard\nadx_name: Contact wizard\n${formYaml}`,
    ...forms,
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const app = await createSimulator({
    sourceDir: root,
    stateFile: path.join(root, "state.json"),
    initial: {
      mappings: {
        contact: { entitySet: "contacts", idColumn: "contactid" },
        annotation: { entitySet: "annotations", idColumn: "annotationid" },
      },
      tables: { contact: [{ contactid: "c0000000-0000-4000-8000-000000000001", fullname: "Signed in contact", statecode: 0 }], annotation: [] },
      permissions: [],
      settings: { permissionMode: "permissive" },
      presets: {},
      simulator: {
        mode,
        pageMode: "local",
        identity: { roles: [] },
        live: { origin: "https://portal.example.test", allowWrites: true },
        endpoints: [],
        componentSchemas: { wizard: wizardSchema, notes: { entity: "contact", fields: [{ name: "fullname", required: true }] } },
      },
    },
    liveBridge,
    // Live submissions need the runtime's live-write permission (cli --allow-live-writes).
    allowLiveWrites: true,
    watch: false,
  });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const submit = (kind, id, body, headers = {}) =>
    fetch(`${app.url}/__sim/forms/${kind}/${id}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", __RequestVerificationToken: app.state().csrf, ...headers },
      body: JSON.stringify(body),
    });
  return { app, submit };
}

test("an anonymous visitor's advanced form session belongs to its browser session", async (t) => {
  const { app, submit } = await fixture(t);
  const response = await submit("webform", "wizard", { stepId: "create", values: { fullname: "Visitor" }, pageUrl: "/" });
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie");
  const port = new URL(app.url).port;
  assert.match(cookie, new RegExp(`^paqvilo-mirage-visitor-${port}=[0-9a-f-]{36}; Path=/; HttpOnly; SameSite=Lax$`));
  const visitor = { cookie: cookie.split(";")[0] };
  const result = await response.json();
  assert.equal(result.outcome.url, "/?stepid=edit");
  // The visitor continues on the edit step with its record. Another browser opening the same
  // step URL has no session record: the step reports the missing record instead of the form.
  const own = await (await fetch(app.url + result.outcome.url, { headers: visitor })).text();
  assert.match(own, /id="jobtitle"/);
  const other = await (await fetch(app.url + result.outcome.url)).text();
  assert.doesNotMatch(other, /id="jobtitle"/);
  assert.match(other, /id="MessageLabel"/);
  const start = await (await fetch(app.url + "/")).text();
  assert.match(start, /id="fullname"/);
  // Another browser cannot submit the visitor's step; the visitor can.
  const taken = await submit("webform", "wizard", { stepId: "edit", recordId: result.recordId, values: { fullname: "Taken over" }, pageUrl: "/" });
  assert.equal(taken.status, 400);
  assert.equal((await taken.json()).error.code, "InvalidFormStep");
  const done = await submit("webform", "wizard", { stepId: "edit", recordId: result.recordId, values: { fullname: "Visitor done" }, pageUrl: "/" }, visitor);
  assert.equal(done.status, 200);
  assert.equal(done.headers.get("set-cookie"), null);
  assert.deepEqual(app.store.snapshot().tables.contact.map((row) => row.fullname).sort(), ["Signed in contact", "Visitor done"]);
});

test("Authentication Required sends anonymous visitors to sign in and back, and refuses their submissions", async (t) => {
  const { app, submit } = await fixture(t, { formYaml: "adx_authenticationrequired: true" });
  const anonymous = await fetch(app.url + "/?ref=1", { redirect: "manual" });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get("location"), "/signin?ReturnUrl=%2F%3Fref%3D1");
  const refused = await submit("webform", "wizard", { stepId: "create", values: { fullname: "Anonymous" }, pageUrl: "/" });
  assert.equal(refused.status, 401);
  assert.equal((await refused.json()).error.code, "FormAuthenticationRequired");
  assert.equal(app.store.snapshot().tables.contact.length, 1);
  const signedIn = signInHeaders(app, "c0000000-0000-4000-8000-000000000001");
  const page = await fetch(app.url + "/", { headers: signedIn, redirect: "manual" });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="fullname"/);
});

test("a live submission whose note fails deletes the record it created", async (t) => {
  const calls = [];
  const liveBridge = {
    origin: "https://portal.example.test",
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request(url, options) {
      calls.push(`${options.method} ${url}`);
      if (options.method === "POST" && url === "/_api/contacts")
        return { status: 201, headers: {}, body: Buffer.from(JSON.stringify({ contactid: "online-contact", fullname: "Online" })) };
      if (options.method === "POST" && url === "/_api/annotations") return { status: 403, headers: {}, body: Buffer.from("{}") };
      if (options.method === "DELETE") return { status: 204, headers: {}, body: Buffer.alloc(0) };
      return { status: 404, headers: {}, body: Buffer.from("{}") };
    },
  };
  const { submit } = await fixture(t, {
    mode: "live",
    liveBridge,
    forms: { "Notes.basicform.yml": "adx_entityformid: notes\nadx_name: Notes\nadx_entityname: contact\nadx_mode: 100000000\nadx_attachfile: true" },
  });
  const response = await submit("entityform", "notes", { values: { fullname: "Online" }, attachments: [{ name: "a.txt", type: "text/plain", content: Buffer.from("note").toString("base64") }], pageUrl: "/" });
  assert.equal(response.status, 403);
  assert.deepEqual(calls, ["POST /_api/contacts", "POST /_api/annotations", "DELETE /_api/contacts(online-contact)"]);
});
