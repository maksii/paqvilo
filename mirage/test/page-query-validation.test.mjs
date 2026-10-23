import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import { observedConfig } from "../lib/project-config.mjs";
import { observedPageQueryValidation } from "../lib/page-query-validation.mjs";
import { ownedFixture } from "../testing/owned-fixture.mjs";

const observed = { requestValidation: "aspnet-query", evidence: "invented-loopback/query-rejection.json" };

test("the explicit query scanner follows reference character boundaries and decodes once", () => {
  for (const value of ["left<right", "<B>", "<!comment", "</x>", "<?xml", "&#60;"]) {
    const failure = observedPageQueryValidation(new URL("http://127.0.0.1/?probe=" + encodeURIComponent(value)), observed);
    assert.equal(failure.status, 500);
    assert.equal(failure.code, "PAGE_QUERY_REQUEST_VALIDATION");
    assert.equal(failure.message.includes(value), false);
  }
  for (const value of ["terminal<", "1<2", "left< right", "&lt;b&gt;", "%3Cb%3E", "quote\"&plain", "{\"key\":1}"]) {
    assert.equal(observedPageQueryValidation(new URL("http://127.0.0.1/?probe=" + encodeURIComponent(value)), observed), null);
  }
  assert.equal(observedPageQueryValidation(new URL("http://127.0.0.1/?probe=%3Cb%3E")), null);
  assert.equal(observedPageQueryValidation(new URL("http://127.0.0.1/?probe=%3Cb%3E"), { requestValidation: "diagnostic" }), null);
  assert.equal(observedPageQueryValidation(new URL("http://127.0.0.1/?probe=%3Cb%3E&probe=safe"), observed).status, 500);
});

test("query validation configuration requires site evidence and a known mode", () => {
  assert.equal(observedConfig(observed).requestValidation, "aspnet-query");
  assert.throws(() => observedConfig({ requestValidation: "aspnet-query" }), /evidence/);
  assert.throws(() => observedConfig({ requestValidation: "all-input", evidence: "invented" }), /requestValidation/);
});

async function start(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mirage-query-validation-"));
  ownedFixture(t).remove(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const files = {
    "website.yml": "adx_websiteid: query-site\nadx_name: Invented query site",
    "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template",
    "page-templates/Template.pagetemplate.yml": "adx_pagetemplateid: template\nadx_name: Template\nadx_webtemplateid: source\nadx_usewebsiteheaderandfooter: false",
    "web-templates/source/Source.webtemplate.yml": "adx_webtemplateid: source\nadx_name: Source",
    "web-templates/source/Source.webtemplate.source.html": "PAGE-LIQUID-RENDERED:[{{ request.params.probe | escape }}]",
    "sitesetting.yml": "- adx_name: Webapi/validationwidget/enabled\n  adx_value: 'true'\n- adx_name: Webapi/validationwidget/fields\n  adx_value: 'title'",
    "Entry.basicform.yml": "adx_entityformid: entry\nadx_name: Entry\nadx_entityname: validationwidget\nadx_mode: 100000000",
  };
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  const simulator = await createSimulator({ sourceDir: directory, watch: false, ...options,
    initial: { mappings: { validationwidget: { entitySet: "validationwidgets", idColumn: "validationwidgetid", nameColumn: "title", fields: { title: { dataverseType: "nvarchar", maxLength: 1000 } } } }, tables: { validationwidget: [] }, settings: { permissionMode: "permissive" }, simulator: { mode: "local", pageMode: "local", identityScope: "configured", identity: { id: "invented-local-persona", roles: [] }, live: {}, endpoints: [], componentSchemas: { entry: { entity: "validationwidget", fields: [{ name: "title", required: true }] } } } },
  });
  ownedFixture(t).add(() => simulator.close());
  return simulator;
}

test("observed page rejection precedes Liquid rendering, retains safe queries and checks duplicate values", async t => {
  const app = await start(t, { observed });
  for (const query of ["?probe=%3Cb%3Eowned%3C%2Fb%3E", "?probe=left%3Cright", "?probe=%3Cb%3Efirst&probe=safe"]) {
    const response = await fetch(app.url + "/" + query);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.match(body, /A potentially dangerous Request\.QueryString value was detected from the client/);
    assert.doesNotMatch(body, /PAGE-LIQUID-RENDERED|owned|left&lt;right/);
  }
  const safe = await fetch(app.url + "/?probe=a%26b%22c");
  assert.equal(safe.status, 200);
  assert.match(await safe.text(), /PAGE-LIQUID-RENDERED:\[a&amp;b&quot;c\]/);
  assert.deepEqual(app.store.snapshot().tables.validationwidget, []);
});

test("the default retains page rendering and observed validation does not scan Web API JSON or filters", async t => {
  const normal = await start(t);
  const response = await fetch(normal.url + "/?probe=%3Cb%3Eowned%3C%2Fb%3E");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /PAGE-LIQUID-RENDERED:\[&lt;b&gt;owned&lt;\/b&gt;\]/);
  const app = await start(t, { observed });
  const title = '<b>API-only string</b><script>invented()</script>';
  const created = await fetch(app.url + "/_api/validationwidgets", { method: "POST", headers: { "content-type": "application/json", __RequestVerificationToken: app.state().csrf }, body: JSON.stringify({ title }) });
  assert.equal(created.status, 204);
  const filtered = await fetch(app.url + "/_api/validationwidgets?$select=title&$filter=" + encodeURIComponent("contains(title,'<b>')"), { headers: { __RequestVerificationToken: app.state().csrf } });
  assert.equal(filtered.status, 200, await filtered.clone().text());
  assert.equal((await filtered.json()).value[0].title, title);
});

test("GET-only query validation preserves page POST rendering and native form submission", async t => {
  const app = await start(t, { observed });
  const query = "?probe=%3Cb%3Eowned%3C%2Fb%3E";
  const postedPage = await fetch(app.url + "/" + query, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "unused=synthetic",
  });
  assert.equal(postedPage.status, 200);
  assert.match(await postedPage.text(), /PAGE-LIQUID-RENDERED:\[&lt;b&gt;owned&lt;\/b&gt;\]/);
  assert.equal((await fetch(app.url + "/" + query)).status, 500);

  const submitted = await fetch(app.url + "/__sim/forms/entityform/entry/submit" + query, {
    method: "POST",
    headers: { "content-type": "application/json", __RequestVerificationToken: app.state().csrf },
    body: JSON.stringify({ values: { title: "Accepted form write" }, pageUrl: "/" + query }),
  });
  assert.equal(submitted.status, 201, await submitted.clone().text());
  const result = await submitted.json();
  const rows = app.store.snapshot().tables.validationwidget;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].validationwidgetid, result.recordId);
  assert.equal(rows[0].title, "Accepted form write");
});
