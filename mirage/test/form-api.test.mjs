import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSimulator } from "../server.mjs";
import { signInHeaders } from "../testing/session.mjs";

async function fixture(t, { mode = "local", liveBridge, allowLiveWrites = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-form-http-"));
  await fs.writeFile(
    path.join(directory, "Home.webpage.yml"),
    "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n",
  );
  await fs.writeFile(
    path.join(directory, "Create.basicform.yml"),
    "adx_entityformid: create\nadx_name: Create contact\nadx_entityname: contact\nadx_mode: 100000000\n",
  );
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: "contacts", idColumn: "contactid" } },
    tables: { contact: [] },
    permissions: [
      {
        id: "editor",
        entity: "contact",
        scope: "global",
        roles: ["Editor"],
        operations: ["create", "read", "update"],
      },
    ],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode,
      pageMode: "local",
      identity: { id: "local-editor", roles: ["Editor"] },
      live: { origin: "https://portal.example.test", allowWrites: false },
      endpoints: [],
      componentSchemas: {
        create: {
          entity: "contact",
          fields: [{ name: "fullname", required: true }],
        },
      },
    },
  };
  const app = await createSimulator({
    sourceDir: directory,
    stateFile: path.join(directory, "state.json"),
    initial,
    liveBridge,
    // Live saves need the runtime permission (cli --allow-live-writes).
    allowLiveWrites,
    watch: false,
  });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Form posts are portal requests: signed in explicitly as the Editor persona.
  const persona = { session: signInHeaders(app, "local-editor", { roles: ["Editor"] }) };
  const submit = (
    values,
    headers = { __RequestVerificationToken: app.state().csrf },
  ) =>
    fetch(app.url + "/__sim/forms/entityform/create/submit", {
      method: "POST",
      headers: { "content-type": "application/json", ...persona.session, ...headers },
      body: JSON.stringify({ values }),
    });
  const signInAs = (contactId, roles) => {
    persona.session = signInHeaders(app, contactId, { roles });
  };
  return { app, submit, signInAs };
}

test("HTTP native forms require CSRF, bound fields and table grants independently of disabled Web API", async (t) => {
  const { app, submit, signInAs } = await fixture(t);
  assert.equal((await fetch(app.url + "/_api/contacts")).status, 404);
  assert.equal((await submit({ fullname: "No token" }, {})).status, 403);
  let response = await submit({
    fullname: "Injected",
    privatecolumn: "forbidden",
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "FormFieldNotBound");
  assert.equal(app.store.snapshot().tables.contact.length, 0);
  response = await submit({ fullname: "Native form contact" });
  assert.equal(response.status, 201);
  const row = await response.json();
  assert.equal(response.headers.get("entityid"), row.recordId);
  assert.equal(row.recordId, app.store.snapshot().tables.contact[0].contactid);
  // Default basic form success: display the native success message and hide the form.
  assert.deepEqual(row.outcome, {
    type: "message",
    message: "Submission completed successfully.",
    hideForm: true,
  });
  assert.equal(
    app.store.snapshot().tables.contact[0].fullname,
    "Native form contact",
  );
  // A persona without the granting web role is denied.
  signInAs("no-role", []);
  response = await submit({ fullname: "Forbidden role" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "PermissionDenied");
  assert.equal(app.store.snapshot().tables.contact.length, 1);
});

test("HTTP native forms use the selected live provider and never silently save live-mode forms locally", async (t) => {
  const calls = [];
  let allow = false;
  const liveBridge = {
    origin: "https://portal.example.test",
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request(url, options) {
      calls.push({ url, options });
      if (!allow)
        throw Object.assign(new Error("Live writes are disabled"), {
          status: 403,
          code: "LIVE_WRITE_DISABLED",
        });
      return {
        status: 201,
        headers: { entityid: "online-contact" },
        body: Buffer.from(
          JSON.stringify({
            contactid: "online-contact",
            fullname: "Forwarded contact",
          }),
        ),
      };
    },
  };
  const { app, submit } = await fixture(t, { mode: "live", liveBridge, allowLiveWrites: true });
  let response = await submit({ fullname: "Forwarded contact" });
  assert.equal(response.status, 403);
  assert.equal(app.store.snapshot().tables.contact.length, 0);
  allow = true;
  response = await submit({ fullname: "Forwarded contact" });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).recordId, "online-contact");
  assert.equal(calls.at(-1).url, "/_api/contacts");
  assert.equal(calls.at(-1).options.method, "POST");
  assert.equal(app.store.snapshot().tables.contact.length, 0);
});
