import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import { runAcceptance } from "../acceptance.mjs";
import { signInContext } from "../testing/session.mjs";

test(
  "acceptance records actual role refresh, create/edit persistence, screenshots and failed assertions",
  { timeout: 45000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-flow-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(directory, "Home.webpage.yml"),
      "adx_webpageid: home\nadx_name: Flows\nadx_partialurl: /\n",
    );
    // The script reads user.roles; after a native save postback (success message shown)
    // it schedules a delayed refresh request that the runner must record as finished.
    await fs.writeFile(
      path.join(directory, "Home.webpage.copy.html"),
      '<h1>Portal flows</h1><input id="async-default"><button id="initialize-default" type="button" onclick="setTimeout(() => document.getElementById(&quot;async-default&quot;).value = &quot;Initialized&quot;, 200)">Initialize default</button><input id="userroles" type="hidden" value="{{user.roles | join: \'|\'}}"><div id="script-roles"></div><script>document.getElementById("script-roles").textContent=document.getElementById("userroles").value;document.addEventListener("DOMContentLoaded",()=>setTimeout(()=>{if(document.getElementById("MessageLabel"))fetch("/save-followup").then(r=>r.json());},150));</script>{% if request.params.id %}{% entityform name: "Contact edit form" %}{% else %}{% entityform name: "Contact form" %}{% endif %}',
    );
    await fs.writeFile(
      path.join(directory, "Contact.basicform.yml"),
      "adx_entityformid: contact-form\nadx_name: Contact form\nadx_entityname: contact\nadx_mode: 100000000\nadx_submitbuttontext: Save\nadx_successmessage: Saved\nadx_hideformonsuccess: false\n",
    );
    // Native basic forms: Insert mode creates; Edit mode takes the record ID from the query
    // string (Allow Create If Null applies to Record Associated to Current Portal User only).
    await fs.writeFile(
      path.join(directory, "ContactEdit.basicform.yml"),
      "adx_entityformid: contact-edit-form\nadx_name: Contact edit form\nadx_entityname: contact\nadx_mode: 100000001\nadx_submitbuttontext: Save\nadx_successmessage: Saved\nadx_hideformonsuccess: false\n",
    );
    const app = await createSimulator({
      sourceDir: directory,
      stateFile: path.join(directory, "state.json"),
      watch: false,
      initial: {
        version: 1,
        mappings: { contact: { entitySet: "contacts", idColumn: "contactid" } },
        tables: { contact: [] },
        settings: { permissionMode: "permissive" },
        simulator: {
          mode: "local",
          pageMode: "local",
          identity: { id: "tester", roles: [] },
          live: { allowWrites: false },
          endpoints: [
            {
              id: "save-followup",
              path: "/save-followup",
              method: "GET",
              mode: "local",
              body: { complete: true },
            },
          ],
          componentSchemas: {
            "Contact form": {
              entity: "contact",
              mode: 100000000,
              fields: [{ name: "fullname", label: "Name", required: true }],
              submitLabel: "Save",
            },
            "Contact edit form": {
              entity: "contact",
              mode: 100000001,
              fields: [{ name: "fullname", label: "Name", required: true }],
              submitLabel: "Save",
            },
          },
        },
      },
    });
    t.after(() => app.close());
    const flows = [
      {
        name: "Role switching reaches portal scripts without manual reload",
        steps: [
          { action: "navigate", path: "/" },
          { action: "click", selector: "#initialize-default" },
          { action: "value", selector: "#async-default", value: "Initialized" },
          { action: "identity", roles: ["Reviewer"] },
          { action: "text", selector: "#script-roles", value: "Reviewer" },
          { action: "value", selector: "#userroles", value: "Reviewer" },
        ],
      },
      {
        name: "Create and edit through exported form",
        steps: [
          { action: "navigate", path: "/" },
          { action: "fill", selector: "#fullname", value: "Flow record" },
          { action: "click", role: "button", name: "Save", mutation: true },
          { action: "text", selector: "#MessageLabel", value: "Saved" },
          {
            action: "rememberRecord",
            entity: "contact",
            fields: { fullname: "Flow record" },
            variable: "contactId",
          },
          { action: "navigate", path: "/?id={{contactId}}" },
          { action: "value", selector: "#fullname", value: "Flow record" },
          {
            action: "fill",
            selector: "#fullname",
            value: "Edited flow record",
          },
          { action: "click", role: "button", name: "Save", mutation: true },
          { action: "text", selector: "#MessageLabel", value: "Saved" },
          {
            action: "record",
            entity: "contact",
            fields: { fullname: "Edited flow record" },
            count: 1,
          },
        ],
      },
    ];
    // Portal routes take their identity from the paqvilo-mirage-auth session only, so the runner's
    // browser context signs in as the "tester" contact with no web roles before the flows.
    const prepareContext = (context) => signInContext(context, app, "tester", { roles: [] });
    const result = await runAcceptance({
      localUrl: app.url,
      prepareContext,
      flows,
      outputDir: path.join(directory, "evidence"),
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.flows.length, 2);
    assert.equal(
      result.flows[1].resources.filter(
        (resource) =>
          resource.url === app.url + "/save-followup" && resource.finished,
      ).length,
      2,
      "Scheduled post-save refreshes finish before navigation and final evidence",
    );
    assert.equal(app.state().data.contact.length, 1);
    assert.equal(app.state().data.contact[0].fullname, "Edited flow record");
    assert.equal(
      result.flows[1].writes.filter(
        (request) =>
          request.method === "POST" &&
          ["contact-form", "contact-edit-form"].some((id) => request.url.includes(`/__sim/forms/entityform/${id}/submit`)),
      ).length,
      2,
    );
    for (const flow of result.flows)
      for (const image of flow.screenshots)
        assert.ok((await fs.stat(image)).size > 0);
    const failed = await runAcceptance({
      localUrl: app.url,
      prepareContext,
      flows: [
        {
          name: "Incorrect control expectation",
          steps: [
            { action: "navigate", path: "/" },
            { action: "value", selector: "#userroles", value: "Wrong role" },
          ],
        },
      ],
      outputDir: path.join(directory, "failed-evidence"),
      timeout: 2000,
    });
    assert.equal(failed.passed, false);
    assert.match(failed.flows[0].error, /expected field value/i);
    assert.ok(failed.flows[0].screenshots.length);
    assert.equal(app.state().data.contact.length, 1);
  },
);

test(
  "default navigation proceeds at DOM readiness and retains a slow request failure",
  { timeout: 30000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-ready-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const state = {
      config: { mode: "local", pageMode: "local", live: { allowWrites: false }, endpoints: [] },
      status: { sourceFingerprint: "fixture-source", implementationFingerprint: "fixture-implementation" },
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/__sim/api/state") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(state));
      }
      if (url.pathname === "/__sim/api/audit/export") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ events: [] }));
      }
      if (url.pathname === "/never-finishes.png") {
        res.setHeader("content-type", "image/png");
        res.write(Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64"));
        return setTimeout(() => res.end(), 2500);
      }
      res.setHeader("content-type", "text/html");
      res.end('<h1 id="ready">DOM is ready</h1><img src="/never-finishes.png">');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const result = await runAcceptance({
      localUrl: `http://127.0.0.1:${server.address().port}`,
      flows: [
        {
          name: "DOM ready with outstanding image request",
          steps: [
            { action: "navigate", path: "/" },
            { action: "visible", selector: "#ready" },
            { action: "settle" },
          ],
        },
      ],
      outputDir: path.join(directory, "evidence"),
      timeout: 1000,
    });
    assert.equal(result.flows[0].steps[0].passed, true, JSON.stringify(result.flows[0]));
    assert.equal(result.flows[0].steps[1].passed, true);
    assert.equal(result.flows[0].passed, false);
    assert.match(result.flows[0].error, /Portal requests did not settle/);
    assert.ok(result.flows[0].pendingRequests.some((request) => request.url.endsWith("/never-finishes.png")));
    assert.ok(
      result.flows[0].resources.some(
        (resource) => resource.url.endsWith("/never-finishes.png"),
      ),
      "the slow image remains visible in the request report",
    );
  },
);
