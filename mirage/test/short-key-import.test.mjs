import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { importPortal } from "../lib/importer.mjs";
import { buildSiteTables } from "../lib/site-tables.mjs";
import { loadProjectConfig, bootstrapProject } from "../lib/project-config.mjs";
import { serverLogicName } from "../lib/server-logic.mjs";
import { createSimulator } from "../server.mjs";

// The short-key .powerpages-site dialect imports like any other export (ecosystem review
// docs/runtime-evidence.md, X1): the synthetic code site
// test-browser/fixtures/code-site (NOTICE.md) follows the layout of the MIT-licensed
// microsoft/power-pages-samples code sites.

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(here, "..", "..", "test-browser", "fixtures", "code-site");
const SITE = path.join(PROJECT, ".powerpages-site");
const CLI = path.join(here, "..", "cli.mjs");
const execFileAsync = promisify(execFile);
const g = (n) => `5c0de51e-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = { wlEn: g(4), wlFr: g(5), home: g(10), about: g(13), roleAuth: g(60) };

test("a .powerpages-site export imports like any other: IDs from id:, language folders, per-folder web files and .portalconfig language codes", async () => {
  // The code-site project folder is read through its .powerpages-site/ folder.
  const portal = await importPortal(PROJECT);
  assert.equal(portal.sourceDir, await fs.realpath(SITE));
  assert.equal(portal.source.dialect, "short-key-yaml");
  assert.ok(portal.diagnostics.some((item) => item.code === "CODE_SITE_PROJECT_SOURCE"));
  assert.deepEqual(portal.records.filter((record) => !record.id).map((record) => record._file), [], "every record has its id: as ID");
  // Pages: root records build the tree; content-pages/<language>/ hold the language copies.
  assert.deepEqual(portal.pages.map((page) => [page.id, page.url]).sort(), [[ID.home, "/"], [ID.about, "/about/"]].sort());
  const home = portal.pages.find((page) => page.id === ID.home);
  assert.match(home.html, /Welcome to the synthetic code site/);
  assert.match(home.css, /rebeccapurple/);
  assert.match(home.translations[ID.wlFr].html, /Bienvenue sur le site synthétique/);
  assert.equal(home.translations[ID.wlFr].title, "Accueil synthétique");
  // Web files: one folder per file.
  assert.deepEqual(portal.webFiles.map((file) => [file.url, path.relative(SITE, file.file).split(path.sep).join("/")]).sort(), [["/app.js", "web-files/app.js/app.js"], ["/theme.css", "web-files/theme.css/theme.css"]]);
  assert.equal(new Set(Object.values(portal.templates)).size, 3);
  assert.equal(portal.snippets["Site Name"], "Synthetic site");
  assert.equal(portal.snippetTranslations[ID.wlFr]["Site Name"], "Site synthétique");
  assert.equal(portal.settings["CodeSite/Enabled"], "true");
  // Language codes come from .portalconfig: "Synthetic French" is no catalogue language name.
  assert.deepEqual(portal.websiteLanguages.map((language) => [language.name, language.code, language.lcid, language.isDefault]), [["English", "en-US", 1033, true], ["Synthetic French", "fr-CA", 3084, false]]);
  assert.deepEqual(portal.portalLanguages.map((language) => language.code), ["en-US", "fr-CA"]);
  assert.equal(portal.language.code, "en-US");
  // The data model is not recorded: enhanced is assumed, with a diagnostic.
  assert.deepEqual([portal.format, portal.dataModel, portal.dataModelSource], ["enhanced", "enhanced", "assumed"]);
  assert.match(portal.diagnostics.find((item) => item.code === "DATA_MODEL_ASSUMED").message, /set dataModel: standard/);
  const typeOf = (kind) => [...new Set(portal.records.filter((record) => record.kind === kind).map((record) => record.powerpagecomponenttype))];
  assert.deepEqual([typeOf("webpage"), typeOf("webfile"), typeOf("botconsumer"), typeOf("cloudflowconsumer"), typeOf("serverlogic"), typeOf("webpageaccesscontrolrule")], [[2], [3], [27], [33], [35], [10]]);
  assert.deepEqual([typeOf("website"), typeOf("websitelanguage"), typeOf("sourcefile")], [[undefined], [undefined], [undefined]]);
  // Server logic: the record, its roles and its code file.
  assert.deepEqual(portal.serverLogics.map((item) => [item.name, item.displayName, item.roleIds, path.basename(item.file)]), [["order-summary", "Order summary", [ID.roleAuth], "order-summary.js"]]);
  // On the enhanced data model the components are powerpagecomponent rows; other tables are not.
  const { tables } = buildSiteTables(portal, { tables: {}, mappings: {}, simulator: {} });
  const rows = tables.powerpagecomponent.rows;
  assert.equal(rows.length, portal.records.filter((record) => Number.isInteger(record.powerpagecomponenttype)).length);
  assert.ok(rows.some((row) => row.powerpagecomponenttype === 35 && row.name === "order-summary"));
  assert.ok(!rows.some((row) => row.name === "Synthetic Code Site" || row.name === "main.js"));
});

test("the data model of a YAML source can be set: standard turns the short-key site into adx_ tables, and invalid values are refused", async () => {
  const portal = await importPortal(SITE, { dataModel: "standard" });
  assert.deepEqual([portal.format, portal.dataModel, portal.dataModelSource], ["standard", "standard", "configured"]);
  assert.ok(!portal.diagnostics.some((item) => item.code === "DATA_MODEL_ASSUMED"));
  assert.ok(portal.records.every((record) => record.powerpagecomponenttype === undefined));
  const { tables } = buildSiteTables(portal, { tables: {}, mappings: {}, simulator: {} });
  assert.deepEqual(tables.adx_webrole.rows.map((row) => row.adx_name).sort(), ["Administrators", "Anonymous Users", "Authenticated Users"]);
  assert.equal((await importPortal(SITE, { dataModel: "enhanced" })).dataModelSource, "configured");
  await assert.rejects(importPortal(SITE, { dataModel: "classic" }), /dataModel must be standard or enhanced/);
});

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-component-types-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  return root;
}
const component = (id, type, name, content, extra = "") =>
  `<powerpagecomponent powerpagecomponentid="${id}"><content>${JSON.stringify(content).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</content>${extra}<name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>0</statecode><statuscode>1</statuscode></powerpagecomponent>`;

test("component types 24, 26, 27, 31, 33, 34 and 35 import from an unpacked Solution, server logic with its code file", async (t) => {
  // Content keys as in the public fixtures: PowerPagesCodeMagazine (24, 26), contoso-real-estate
  // (27, 33), WorkmateProSWA (34) and the power-pages-samples server-logic Solutions (35).
  const c = (n) => `c0a1e5ce-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const files = {
    "Assets/powerpagesites.xml": `<powerpagesites><powerpagesite powerpagesiteid="${c(1)}"><content>{}</content><name>Types</name></powerpagesite></powerpagesites>`,
    [`powerpagecomponents/${c(2)}/powerpagecomponent.xml`]: component(c(2), 2, "Home", { partialurl: "/", isroot: true, pagetemplateid: c(3) }),
    [`powerpagecomponents/${c(24)}/powerpagecomponent.xml`]: component(c(24), 24, "Sidebar", { adx_pollplacement_poll: [c(240)] }),
    [`powerpagecomponents/${c(26)}/powerpagecomponent.xml`]: component(c(26), 26, "Sidebar Bottom", { adx_adplacement_ad: [c(260)] }),
    [`powerpagecomponents/${c(27)}/powerpagecomponent.xml`]: component(c(27), 27, "Bot Consumer", { botschemaname: "synthetic_bot", configjson: "{}" }),
    [`powerpagecomponents/${c(31)}/powerpagecomponent.xml`]: component(c(31), 31, "Draft to Published", { fromstate: c(310), tostate: c(311) }),
    [`powerpagecomponents/${c(33)}/powerpagecomponent.xml`]: component(c(33), 33, "Checkout", { adx_flowapiurl: `/_api/cloudflow/v1.0/trigger/${c(330)}`, adx_CloudFlowConsumer_adx_webrole: [c(9)] }),
    [`powerpagecomponents/${c(34)}/powerpagecomponent.xml`]: component(c(34), 34, "Active Courses", { componentid: c(34), componenttype: 34, uxcomponenttype: "CardGallery", params: "{}" }),
    [`powerpagecomponents/${c(35)}/powerpagecomponent.xml`]: component(c(35), 35, "captcha-service", { adx_serverlogic_adx_webrole: [c(9), c(8)], display_name: "Captcha service", description: "" }, '<filecontent mimetype="application/octet-stream">captcha-service.sl</filecontent>'),
    [`powerpagecomponents/${c(35)}/filecontent/captcha-service.sl`]: "function post() { return '{}'; }\n",
  };
  const portal = await importPortal(await tree(t, files));
  const kinds = Object.fromEntries(portal.records.filter((record) => record.powerpagecomponenttype > 21).map((record) => [record.powerpagecomponenttype, record.kind]));
  assert.deepEqual(kinds, { 24: "pollplacement", 26: "adplacement", 27: "botconsumer", 31: "publishingstatetransitionrule", 33: "cloudflowconsumer", 34: "uxcomponent", 35: "serverlogic" });
  assert.ok(!portal.records.some((record) => /^component:/.test(record.kind)));
  assert.deepEqual(portal.serverLogics.map((item) => [item.name, item.displayName, item.roleIds.length, path.basename(item.file)]), [["captcha-service", "Captcha service", 2, "captcha-service.sl"]]);
  // A server logic record without its code file is reported.
  const missing = await importPortal(await tree(t, Object.fromEntries(Object.entries(files).filter(([name]) => !name.endsWith(".sl")))));
  assert.equal(missing.serverLogics[0].file, null);
  assert.ok(missing.diagnostics.some((item) => item.code === "SERVER_LOGIC_CODE_MISSING" && item.name === "captcha-service"));
});

test("server logic paths are recognised by name", () => {
  assert.equal(serverLogicName("/_api/serverlogics/order-summary"), "order-summary");
  assert.equal(serverLogicName("/_api/serverlogics/order%20summary/"), "order summary");
  assert.equal(serverLogicName("/_api/serverlogics"), null);
  assert.equal(serverLogicName("/_api/serverlogics/a/b"), null);
  assert.equal(serverLogicName("/_api/contacts"), null);
});

test("serve treats a code site like any export, and discovered server logic enforces roles and verification before simulation", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-code-site-serve-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const liveBridge = {
    origin: "https://portal.example.test",
    configure() {},
    status: () => ({ connected: true }),
    async close() {},
    async request(url, options) {
      calls.push(`${options?.method ?? "GET"} ${url}`);
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
    },
  };
  const app = await createSimulator({ sourceDir: PROJECT, stateFile: path.join(dir, "state.json"), port: 0, watch: false, requirePortalSource: true, liveBridge });
  t.after(() => app.close());
  const home = await fetch(app.url + "/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /<header id="site-name">Synthetic site<\/header>/);
  assert.match(html, /<h1 id="welcome">Welcome to the synthetic code site<\/h1>/);
  assert.match(html, /<footer id="site-footer">Synthetic Code Site<\/footer>/);
  // The short-key page rule restricts About to authenticated users.
  const about = await fetch(app.url + "/about/", { redirect: "manual" });
  assert.equal(about.status, 302);
  assert.match(about.headers.get("location"), /signin\?ReturnUrl=%2Fabout%2F/i);
  assert.equal(await (await fetch(app.url + "/app.js")).text(), "window.syntheticApp = 'from the web file';\n");
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(app.url + "/_api/serverlogics/order-summary", { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(response.status, 403, method);
    assert.equal(response.headers.get("x-sim-route"), "server-logic-local");
    const body = await response.json();
    assert.deepEqual([body.success, body.serverLogicName, body.data, body.error.code], [false, "order-summary", null, "Forbidden"]);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  }
  const unknown = await fetch(app.url + "/_api/serverlogics/missing");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "ServerLogicNotFound");
  // Never forwarded, also in live data mode.
  const { csrf } = await (await fetch(app.url + "/__sim/api/state?summary=1")).json();
  const patch = (body) => fetch(app.url + "/__sim/api/config", { method: "PATCH", headers: { "content-type": "application/json", "x-sim-csrf": csrf }, body: JSON.stringify(body) });
  assert.equal((await patch({ mode: "live", live: { origin: "https://portal.example.test" } })).status, 200);
  assert.equal((await fetch(app.url + "/_api/serverlogics/order-summary")).status, 501);
  assert.deepEqual(calls.filter((call) => call.includes("serverlogics")), []);
  assert.equal((await patch({ mode: "local" })).status, 200);
  // A /_sim endpoint for the path mocks the response.
  const added = await fetch(app.url + "/__sim/api/endpoints/order-summary-mock", { method: "POST", headers: { "content-type": "application/json", "x-sim-csrf": csrf }, body: JSON.stringify({ path: "/_api/serverlogics/order-summary", method: "GET", status: 200, body: { success: true, data: "{}" }, enabled: true }) });
  assert.equal(added.status, 201);
  const mocked = await fetch(app.url + "/_api/serverlogics/order-summary");
  assert.deepEqual([mocked.status, (await mocked.json()).success], [200, true]);
  const status = await (await fetch(app.url + "/__sim/api/status")).json();
  assert.equal(status.format, "enhanced");
  assert.ok(status.diagnostics.byCode.Forbidden >= 5);
  assert.equal(status.diagnostics.byCode.DATA_MODEL_ASSUMED, 1);
  const { status: full } = await (await fetch(app.url + "/__sim/api/state?summary=1")).json();
  assert.deepEqual([full.bootstrap.sourceLayout.dialect, full.bootstrap.dataModel, full.bootstrap.dataModelSource], ["short-key-yaml", "enhanced", "assumed"]);
});

test("inspect and project files carry the data model; --data-model is validated and refused with --project", async (t) => {
  const run = (args) => execFileAsync(process.execPath, [CLI, ...args], { timeout: 120000 }).then((result) => ({ code: 0, ...result }), (error) => error);
  const inspected = await run(["inspect", "--source", PROJECT, "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const report = JSON.parse(inspected.stdout);
  assert.deepEqual([report.layout, report.dataModel, report.dataModelSource, report.serverLogics, report.pages.length], ["short-key-yaml", "enhanced", "assumed", ["order-summary"], 2]);
  const standard = JSON.parse((await run(["inspect", "--source", SITE, "--data-model", "standard", "--json"])).stdout);
  assert.deepEqual([standard.format, standard.dataModelSource], ["standard", "configured"]);
  const invalid = await run(["inspect", "--source", SITE, "--data-model", "classic", "--json"]);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /--data-model must be standard or enhanced/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-code-site-project-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "mirage.project.yml");
  await fs.writeFile(file, `version: 1\nportals:\n  - id: code\n    path: ${JSON.stringify(PROJECT)}\n    dataModel: standard\nsolutions: []\n`);
  const project = await loadProjectConfig(file);
  assert.equal(project.portals[0].dataModel, "standard");
  const bootstrapped = await bootstrapProject(project);
  assert.deepEqual([bootstrapped.portals[0].portal.dataModel, bootstrapped.portals[0].portal.dataModelSource], ["standard", "configured"]);
  const refused = await run(["inspect", "--project", file, "--data-model", "enhanced", "--json"]);
  assert.match(refused.stderr, /--data-model is supplied by the project configuration/);
  await fs.writeFile(file, `version: 1\nportals:\n  - id: code\n    path: ${JSON.stringify(PROJECT)}\n    dataModel: classic\nsolutions: []\n`);
  await assert.rejects(loadProjectConfig(file), /portals\[0\]\.dataModel must be standard or enhanced/);
});

test("the serverlogic Liquid tag gives its output an unsuccessful result instead of running the code", async () => {
  const { createPortalRenderer } = await import("../lib/liquid.mjs");
  const renderer = createPortalRenderer(await importPortal(SITE));
  const rendered = await renderer.renderString(
    "{% assign inputData = '{}' %}{% serverlogic name: 'order-summary', operation: 'getSummary', input: inputData, output: result %}[{{ result.success }}|{{ result.status_code }}|{{ result.data }}]{% if result.success %}ok{% else %}fallback{% endif %}",
    {},
  );
  assert.equal(rendered, "[false|501|]fallback");
});

test("cloud flows import with their trigger, flow and roles; source operations deny anonymous callers and explicit endpoints can mock them", async (t) => {
  const portal = await importPortal(SITE);
  assert.deepEqual(portal.cloudFlows.map((flow) => [flow.name, flow.path, flow.processId, flow.roleIds]), [["Request Callback", `/_api/cloudflow/v1.0/trigger/${g(82)}`, g(82), [ID.roleAuth]]]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-cloud-flow-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = await createSimulator({ sourceDir: PROJECT, stateFile: path.join(dir, "state.json"), port: 0, watch: false });
  t.after(() => app.close());
  const token = /value="([^"]+)"/.exec(await (await fetch(app.url + "/_layout/tokenhtml")).text())[1];
  const trigger = () => fetch(`${app.url}/_api/cloudflow/v1.0/trigger/${g(82)}`, { method: "POST", headers: { "content-type": "application/json", __requestverificationtoken: token }, body: JSON.stringify({ eventData: "{}" }) });
  const unsupported = await trigger();
  assert.deepEqual([unsupported.status, (await unsupported.json()).error.code], [403, "Forbidden"]);
  const { csrf } = await (await fetch(app.url + "/__sim/api/state?summary=1")).json();
  const added = await fetch(app.url + "/__sim/api/endpoints/request-callback", { method: "POST", headers: { "content-type": "application/json", "x-sim-csrf": csrf }, body: JSON.stringify({ path: `/_api/cloudflow/v1.0/trigger/${g(82)}`, method: "POST", status: 202, body: {}, enabled: true }) });
  assert.equal(added.status, 201);
  assert.equal((await trigger()).status, 202);
});
