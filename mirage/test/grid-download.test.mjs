import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import { model, parentId } from "./fixtures/subgrid.mjs";
import { signInHeaders } from "../testing/session.mjs";

// Synthetic subgrid export and local rows only. Downloads take page 1 of up to
// Grid/Download/MaximumResults records (default 5000), whatever page and pageSize the
// request carries (docs/platform-internals-reference.md, download routes).
async function downloadFixture(t, { rows, maximumResults } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grid-download-"));
  const { state, settings } = model();
  for (let index = 0; index < rows; index++)
    state.tables.child.push({
      childkey: `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      parentlookup: parentId,
      name: `Download child ${String(index).padStart(5, "0")}`,
      status: 2,
    });
  const files = {
    "website.yml": "adx_websiteid: site\nadx_name: Test",
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    "Main.pagetemplate.yml": "adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true",
    "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "Main.webtemplate.source.html": '{% entityform name: "Parent" %}',
    "Parent.basicform.yml": "adx_entityformid: parent\nadx_name: Parent\nadx_entityname: parent\nadx_mode: 100000001",
    "Notify.basicform.yml": "adx_entityformid: notify\nadx_name: Notify\nadx_entityname: child\nadx_mode: 100000001",
    "Parent.basicform.basicformmetadata.yml": `adx_entityform: parent\nadx_subgrid_name: Children\nadx_subgrid_settings: ${JSON.stringify(JSON.stringify(settings))}`,
    "Add.webpage.yml": "adx_webpageid: add\nadx_name: Add\nadx_partialurl: add\nadx_parentpageid: home\nadx_pagetemplateid: template",
    ...(maximumResults ? { "sitesetting.yml": `- adx_sitesettingid: s1\n  adx_name: Grid/Download/MaximumResults\n  adx_value: "${maximumResults}"` } : {}),
  };
  for (const [name, contents] of Object.entries(files)) await fs.writeFile(path.join(directory, name), contents);
  const app = await createSimulator({ sourceDir: directory, stateFile: path.join(directory, "state.json"), initial: state, watch: false });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const session = signInHeaders(app, "editor", { roles: ["Editor"] });
  const html = await (await fetch(`${app.url}/?id=${parentId}`, { headers: session })).text();
  const start = html.indexOf('class="entity-grid subgrid');
  const layouts = JSON.parse(Buffer.from(/data-view-layouts="([^"]*)"/.exec(html.slice(start))[1], "base64").toString("utf8"));
  const download = async (body) => {
    const response = await fetch(`${app.url}/_services/download-as-csv/site`, {
      method: "POST",
      headers: { "content-type": "application/json", __RequestVerificationToken: app.state().csrf, ...session },
      body: JSON.stringify({ base64SecureConfiguration: layouts[0].Base64SecureConfiguration, columns: [{ LogicalName: "name", Name: "Child name", Type: 0 }], viewName: "Children", ...body }),
    });
    assert.equal(response.status, 200);
    const { sessionKey } = await response.json();
    const file = await fetch(`${app.url}/_services/download-as-csv/site?key=${encodeURIComponent(sessionKey)}`, { headers: session });
    return Buffer.from(await file.arrayBuffer()).subarray(3).toString("utf8").split("\r\n").slice(1);
  };
  return { download };
}

test("a list download ignores the request's paging and returns up to 5000 records by default", async (t) => {
  const { download } = await downloadFixture(t, { rows: 120 });
  // A grid page shows 50 records at most; the download has every record of the view (the
  // 120 added rows and the fixture's two children of the parent).
  const lines = await download({ page: 3, pageSize: 10 });
  assert.equal(lines.length, 122);
  assert.ok(lines.includes("Download child 00119"));
  assert.ok(lines.includes("Pending child") && lines.includes("Accepted child"));
  assert.ok(!lines.includes("Foreign child"));
});

test("Grid/Download/MaximumResults bounds a download, including beyond one 5000-record fetch page", async (t) => {
  const bounded = await downloadFixture(t, { rows: 120, maximumResults: 60 });
  assert.equal((await bounded.download({ page: 1, pageSize: 50 })).length, 60);
  const paged = await downloadFixture(t, { rows: 5003, maximumResults: 5002 });
  const lines = await paged.download({});
  assert.equal(lines.length, 5002);
  assert.equal(new Set(lines).size, 5002);
});
