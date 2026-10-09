// _sim administration features against a disposable loopback simulator. A synthetic live
// bridge stands in for a reference browser; nothing contacts a portal environment.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

const FILES = {
  "website.yml": "adx_websiteid: site\nadx_name: Workspace fixture",
  "webrole.yml": "- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: editor\n  adx_name: Editor",
  "webpagerule.yml": "- adx_webpageaccesscontrolruleid: members-only\n  adx_name: Members only\n  adx_webpageid: secure\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member",
  "sitesetting.yml": "- adx_sitesettingid: s1\n  adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_sitesettingid: s2\n  adx_name: Webapi/contact/fields\n  adx_value: '*'",
  "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main",
  "web-pages/secure/Secure.webpage.yml": "adx_webpageid: secure\nadx_name: Secure\nadx_partialurl: secure\nadx_parentpageid: home\nadx_pagetemplateid: main",
  "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
  "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
  "web-templates/Main.webtemplate.source.html": "<!doctype html><html><head><title>Workspace</title></head><body><h1 id=\"who\">{{ user.fullname | default: 'Anonymous' }}</h1><p>{{ snippets['Greeting'] }}</p>{% fetchxml rows %}<fetch><entity name=\"contact\"><attribute name=\"fullname\"/></entity></fetch>{% endfetchxml %}<p id=\"count\">{{ rows.results.entities.size }}</p></body></html>",
  "content-snippets/Greeting.contentsnippet.yml": "adx_contentsnippetid: greeting\nadx_name: Greeting",
  "content-snippets/Greeting.contentsnippet.value.html": "Hello",
  // The platform renders the pages behind the "Page Not Found" and "Access Denied" site
  // markers for unknown routes and for signed-in visitors without page access.
  "web-pages/not-found/Page-Not-Found.webpage.yml": "adx_webpageid: notfound\nadx_name: Page Not Found\nadx_partialurl: page-not-found\nadx_parentpageid: home\nadx_pagetemplateid: main",
  "web-pages/denied/Access-Denied.webpage.yml": "adx_webpageid: denied\nadx_name: Access Denied\nadx_partialurl: access-denied\nadx_parentpageid: home\nadx_pagetemplateid: main",
  "sitemarker.yml": "- adx_sitemarkerid: m-404\n  adx_name: Page Not Found\n  adx_pageid: notfound\n- adx_sitemarkerid: m-403\n  adx_name: Access Denied\n  adx_pageid: denied",
};

const initial = () => ({
  version: 1,
  mappings: {
    contact: { entitySet: "contacts", idColumn: "contactid" },
    item: { entitySet: "items", idColumn: "itemid" },
    environmentvariabledefinition: { entitySet: "environmentvariabledefinitions", idColumn: "environmentvariabledefinitionid" },
    environmentvariablevalue: { entitySet: "environmentvariablevalues", idColumn: "environmentvariablevalueid" },
  },
  tables: {
    contact: [
      { contactid: "alex", firstname: "Alex", lastname: "Local", fullname: "Alex Local" },
      { contactid: "blair", firstname: "Blair", lastname: "Local", fullname: "Blair Local" },
    ],
    item: [{ itemid: "local-item", name: "Local item" }],
    environmentvariabledefinition: [{ environmentvariabledefinitionid: "def-api", schemaname: "sample_ApiUrl", displayname: "API URL", type: 100000000, defaultvalue: "https://default.example.test" }],
    environmentvariablevalue: [],
  },
  permissions: [{ id: "members-read", name: "Members read contacts", entity: "contact", roles: ["Member"], operations: ["read"], scope: "global" }],
  plugins: [],
  presets: { "only-alex": { name: "Only Alex", userConfigured: true, tables: { contact: [{ contactid: "alex", firstname: "Alex", lastname: "Local", fullname: "Alex Local" }] } } },
  settings: { permissionMode: "enforce" },
  simulator: { mode: "local", pageMode: "local", permissionSource: "configured", identity: { roles: [] }, contactRoles: [{ contactId: "alex", roleId: "member" }], live: {}, endpoints: [] },
});

async function fixture(t, { liveBridge, project, observed, allowLiveWrites } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-admin-workspace-"));
  for (const [name, body] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), body);
  }
  const app = await createSimulator({ sourceDir: directory, stateFile: path.join(directory, "state", "state.json"), watch: false, initial: initial(), ...(liveBridge ? { liveBridge } : {}), ...(project ? { project } : {}), ...(observed ? { observed } : {}), ...(allowLiveWrites ? { allowLiveWrites } : {}) });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(async () => {
    await browser.close();
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: true, viewport: { width: 1360, height: 900 } });
  await context.route("**/*", (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  const page = await context.newPage();
  // Generous: these end-to-end flows share the machine with other browser suites.
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const notice = (text) => page.locator("#notification").getByText(text, { exact: true }).waitFor();
  // Optional review screenshots (PAQVILO_MIRAGE_EVIDENCE_DIR); synthetic fixture data only.
  const evidence = async (name) => {
    if (!process.env.PAQVILO_MIRAGE_EVIDENCE_DIR) return;
    await fs.mkdir(process.env.PAQVILO_MIRAGE_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PAQVILO_MIRAGE_EVIDENCE_DIR, `${name}.png`), fullPage: true });
  };
  return { app, context, page, errors, notice, directory, evidence };
}

test("deep links open records and portal items; access rules, personas and diagnostics links work through the admin", { timeout: 180_000 }, async (t) => {
  const { app, context, page, errors, notice, evidence } = await fixture(t);
  // Requests through the browser context carry its session cookie; plain fetch() has none.
  const asBrowser = (route) => context.request.get(`${app.url}${route}`, { maxRedirects: 0 });
  const browserSession = async () => (await context.request.get(`${app.url}/_sim/api/session`)).json();
  await page.goto(`${app.url}/_sim/#records?entity=contact&id=blair`);
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.match(await page.locator("#editor-json").inputValue(), /Blair Local/);
  await page.locator("#editor-cancel").click();
  await page.goto(`${app.url}/_sim/#records?entity=contact&id=nobody`);
  await page.getByText("No contact record has ID nobody", { exact: false }).waitFor();
  await page.goto(`${app.url}/_sim/#portal?kind=snippets&name=Greeting`);
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.match(await page.locator("#editor-json").inputValue(), /"value": "Hello"/);
  await page.locator("#editor-cancel").click();

  // Page access rules: a local override changes who may open the page; reset restores the export.
  await page.goto(`${app.url}/_sim/#access`);
  await page.getByText("Anonymous: this browser is not signed in", { exact: true }).waitFor();
  // The admin runs the portal's own sign-in (here the local sign-in page: the fixture has no
  // external provider) and comes back to this view.
  await page.getByText("Local sign-in page", { exact: false }).first().waitFor();
  await page.getByLabel("Persona for this browser", { exact: true }).selectOption("alex");
  await page.getByRole("button", { name: "Sign in as Alex Local", exact: true }).click();
  await page.getByText("Signed in as Alex Local", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, "#access", "the sign-in comes back to this view");
  assert.equal(app.state().config.identity.contactId ?? null, null, "the sign-in page default is unchanged");
  assert.equal((await asBrowser("/secure/")).status(), 200);
  assert.equal((await fetch(`${app.url}/secure/`, { redirect: "manual" })).status, 302, "a request without the session cookie is anonymous");
  await page.goto(`${app.url}/_sim/#portal`);
  const rule = page.locator("tr").filter({ hasText: "Members only" });
  await rule.getByText("Restrict read · all content", { exact: true }).waitFor();
  await rule.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#editor-json").fill(JSON.stringify({ id: "members-only", value: { name: "Editors only", webPageId: "secure", right: 2, scope: 1, roleIds: ["editor"] } }));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.locator("tr").filter({ hasText: "Editors only" }).getByText("Local override", { exact: true }).waitFor();
  await evidence("admin-page-access-rules");
  assert.equal((await asBrowser("/secure/")).status(), 403);
  await page.locator("tr").filter({ hasText: "Editors only" }).getByRole("button", { name: "Reset", exact: true }).click();
  await page.locator("#confirm-submit").click();
  await page.locator("tr").filter({ hasText: "Members only" }).getByText("Exported source", { exact: true }).waitFor();
  assert.equal((await asBrowser("/secure/")).status(), 200);

  // Create a persona with a role and sign this browser in; then sign out to an anonymous visitor.
  await page.goto(`${app.url}/_sim/#access`);
  await page.getByText("Create a persona", { exact: true }).click();
  await page.getByLabel("First name", { exact: true }).fill("Casey");
  await page.getByLabel("Last name", { exact: true }).fill("Editor");
  await page.getByRole("group", { name: "New persona web roles", exact: true }).getByLabel("Editor", { exact: true }).check();
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await page.getByText("Signed in as Casey Editor", { exact: true }).waitFor();
  const casey = await browserSession();
  assert.deepEqual([casey.signedIn, casey.name, casey.roles], [true, "Casey Editor", ["Editor"]]);
  assert.ok(app.state().config.contactRoles.some((row) => row.contactId === casey.contactId && row.roleId === "editor"));
  // The simulation override changes the roles of this signed-in session only.
  await page.getByText("Simulation override", { exact: true }).click();
  await page.getByLabel("Web roles for Casey Editor", { exact: true }).fill("Member");
  await page.getByRole("button", { name: "Apply override", exact: true }).click();
  await notice("Simulation override: Casey Editor has Member in this browser.");
  assert.deepEqual([(await browserSession()).roles, (await browserSession()).roleSource], [["Member"], "override"]);
  await page.getByRole("button", { name: "Clear override", exact: true }).click();
  await notice("The simulation override is cleared: the session uses the contact's web roles again.");
  assert.deepEqual((await browserSession()).roles, ["Editor"]);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByText("Anonymous: this browser is not signed in", { exact: true }).waitFor();
  assert.equal((await browserSession()).signedIn, false);
  // Without a session the override is not offered: it never signs in by itself.
  await page.getByText("Simulation override", { exact: true }).click();
  await page.getByText("Sign this browser in through the portal first.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Apply override", exact: true }).isDisabled(), true);

  // Diagnostics link to the page and to its requests.
  const missing = await fetch(`${app.url}/missing-page/`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /<title>Workspace<\/title>/, "the Page Not Found page renders through its template");
  await page.goto(`${app.url}/_sim/#evidence`);
  await page.locator(".diagnostic-group").filter({ hasText: "PAGE_NOT_FOUND" }).locator("summary").click();
  await page.getByRole("link", { name: "Requests for this path", exact: true }).first().click();
  await page.getByRole("heading", { name: "Request audit", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Filter audit by path", { exact: true }).inputValue(), "/missing-page/");
  // The rendered 404 page may add correlated Liquid reads; every listed request is for this path.
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll("tbody tr")];
    return rows.length >= 1 && rows.every((row) => row.textContent.includes("/missing-page/"));
  });
  assert.deepEqual(errors, []);
});

test("scenarios, environment variables, references, enrichment, state transfer and plugin errors are administered end to end", { timeout: 180_000 }, async (t) => {
  const reads = [];
  const bridge = {
    origin: "https://reference.example.test",
    configure() {},
    status() { return { connected: true, origin: this.origin, allowWrites: false }; },
    async connect() { return this.status(); },
    async close() {},
    async request() { throw new Error("no live requests in this test"); },
    async fetchXml(xml) {
      reads.push(xml);
      return { entities: [{ itemid: "reference-item", name: "Reference item" }], more_records: false };
    },
  };
  // A loaded Mirage project lists the reference environments (status.project.references).
  const project = { configFile: "C:/project/mirage.project.yml", portals: [{ id: "portal" }], solutions: [], references: [{ id: "reference", name: "Reference environment", origin: "https://reference.example.test" }, { id: "other", origin: "https://other.example.test" }], dataPacks: [] };
  const observed = { headers: { page: { "x-content-type-options": "nosniff" }, webFile: { "x-content-type-options": "nosniff", "access-control-allow-origin": "https://embed.synthetic.invalid" } }, evidence: "synthetic fixture" };
  const { app, context, page, errors, notice, evidence } = await fixture(t, { liveBridge: bridge, project, observed });
  // Saved scenario: preset + persona + permission mode, applied in one change.
  await page.goto(`${app.url}/_sim/#scenarios`);
  await page.getByLabel("Scenario name", { exact: true }).fill("Alex in sandbox");
  await page.getByLabel("Preset", { exact: true }).selectOption("only-alex");
  await page.getByLabel("Persona", { exact: true }).selectOption("alex");
  await page.getByLabel("Permission enforcement", { exact: true }).selectOption("permissive");
  await page.getByRole("button", { name: "Save scenario", exact: true }).click();
  await notice("Scenario saved.");
  assert.deepEqual(app.state().config.scenarios, [{ id: "alex-in-sandbox", name: "Alex in sandbox", preset: "only-alex", persona: { contactId: "alex" }, permissionMode: "permissive" }]);
  const revision = app.state().status.revision;
  await page.locator("tr").filter({ hasText: "Alex in sandbox" }).getByRole("button", { name: "Apply", exact: true }).click();
  // The scenario persona becomes the sign-in page default; this browser then signs in as it
  // through the portal's sign-in and comes back to this view.
  const back = page.waitForNavigation({ url: (url) => url.pathname === "/_sim/" && url.hash === "#scenarios", waitUntil: "load" });
  await page.locator("#confirm").getByRole("button", { name: "Apply scenario", exact: true }).click();
  await back;
  assert.equal(app.state().status.revision, revision + 1);
  assert.equal(app.state().config.identity.contactId, "alex");
  assert.deepEqual(await (await context.request.get(`${app.url}/_sim/api/session`)).json().then((session) => [session.signedIn, session.contactId]), [true, "alex"]);
  assert.equal(app.state().config.permissionMode, "permissive");
  assert.equal(app.state().data.contact.length, 1);
  await page.getByText("Active scenario:", { exact: false }).waitFor();
  await evidence("admin-scenarios");
  await page.getByRole("button", { name: "Reset to imported defaults", exact: true }).click();
  await page.locator("#confirm").getByRole("button", { name: "Reset workspace", exact: true }).click();
  await notice("Workspace reset to imported defaults.");
  assert.equal(app.state().data.contact.length, 2);
  assert.equal(app.state().config.scenarios.length, 1, "scenario definitions survive a reset");

  // Environment: variables are edited locally; a configured reference becomes the live origin.
  assert.deepEqual(app.state().status.project.references.map((reference) => reference.id), ["reference", "other"]);
  await page.goto(`${app.url}/_sim/#environment`);
  const variable = page.locator("tr").filter({ hasText: "sample_ApiUrl" });
  await variable.getByText("https://default.example.test", { exact: true }).first().waitFor();
  await variable.getByRole("button", { name: "Edit value", exact: true }).click();
  await page.locator("#editor-json").fill(JSON.stringify({ value: "https://local.example.test" }));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await notice("Environment variable saved.");
  await variable.getByText("https://local.example.test", { exact: true }).first().waitFor();
  await variable.getByText("Local override", { exact: true }).waitFor();
  await variable.getByRole("button", { name: "Reset local value", exact: true }).click();
  await notice("Local value removed; the Solution value or definition default applies.");
  assert.equal(app.store.snapshot().tables.environmentvariablevalue.length, 0);
  await page.locator("tr").filter({ hasText: "other.example.test" }).getByRole("button", { name: "Use for live routing", exact: true }).click();
  await notice("Reference origin selected for live routing. Connect its signed-in browser to read from it.");
  assert.equal(app.state().config.live.origin, "https://other.example.test");

  // Enrichment: validation reads nothing; running imports complete pages through the bridge.
  const plan = [{ entity: "item", fetchXml: '<fetch><entity name="item"><attribute name="name"/></entity></fetch>', pageSize: 10, maxPages: 1 }];
  await page.getByLabel("Enrichment plan (JSON array)", { exact: true }).fill(JSON.stringify([{ ...plan[0], mode: "invalid" }]));
  await page.getByRole("button", { name: "Validate plan", exact: true }).click();
  await page.locator("#enrichment-report").getByText("mode", { exact: false }).waitFor();
  await page.getByLabel("Enrichment plan (JSON array)", { exact: true }).fill(JSON.stringify(plan));
  await page.getByRole("button", { name: "Validate plan", exact: true }).click();
  await notice("The plan is valid. No reference reads were made.");
  assert.equal(reads.length, 0);
  await page.getByRole("button", { name: "Run plan", exact: true }).click();
  await page.locator("#confirm").getByRole("button", { name: "Run plan", exact: true }).click();
  await notice("Reference records imported into local state.");
  assert.equal(reads.length, 1);
  assert.deepEqual(app.store.snapshot().tables.item.map((row) => row.itemid).sort(), ["local-item", "reference-item"]);
  await evidence("admin-environment");

  // Runtime state: export, then import the export to roll the reference rows back.
  await page.goto(`${app.url}/_sim/#runtime`);
  await page.getByRole("heading", { name: "Fingerprints", exact: true }).waitFor();
  // Bootstrap facts come from status.bootstrap; this fixture loads no Solution layers.
  const fact = (title) => page.locator(".row").filter({ has: page.getByText(title, { exact: true }) }).locator(".row-detail");
  assert.equal(await fact("Solution layers").innerText(), "None");
  assert.equal(await fact("Environment variable definitions").innerText(), "0");
  // No LoginPath setting and no observed one: the platform default sign-in path. The observed
  // headers are listed per response kind with their evidence.
  assert.equal(await fact("Sign-in page").innerText(), "/signin (platform default)");
  assert.equal(await fact("Observed platform behaviour").innerText(), "headers (page x-content-type-options=nosniff; webFile x-content-type-options=nosniff, access-control-allow-origin=https://embed.synthetic.invalid) (evidence: synthetic fixture)");
  assert.match(await fact("Startup").innerText(), /^\d+ ms/);
  assert.equal(await fact("Last source reload").innerText(), "None since start");
  await evidence("admin-runtime-state");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export state JSON", exact: true }).click();
  const exported = await download;
  assert.equal(exported.suggestedFilename(), "simulator-state.json");
  const snapshot = JSON.parse(await fs.readFile(await exported.path(), "utf8"));
  snapshot.tables.item = snapshot.tables.item.filter((row) => row.itemid === "local-item");
  await page.locator("#state-import-file").setInputFiles({ name: "rolled-back.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(snapshot)) });
  await page.locator("#confirm").getByRole("button", { name: "Import state", exact: true }).click();
  await notice("State imported.");
  assert.deepEqual(app.store.snapshot().tables.item.map((row) => row.itemid), ["local-item"]);
  await page.getByRole("button", { name: "Reload sources", exact: true }).click();
  await notice("Sources reloaded.");
  await fact("Last source reload").filter({ hasText: / ms · 0 changed files$/ }).waitFor();

  // Plugin editor validation failures stay visible in the editor.
  await page.goto(`${app.url}/_sim/#plugins`);
  await page.getByRole("button", { name: "Add plugin", exact: true }).first().click();
  await page.locator("#editor-json").fill(JSON.stringify({ id: "broken", entity: "contact", operations: ["create"], set: { fullname: { op: "teleport", args: [] } } }));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.locator("#editor-error").getByText("teleport", { exact: false }).waitFor();
  assert.equal(app.state().config.plugins.length, 0);
  assert.deepEqual(errors, []);
});

test("live logs stream requests and Liquid reads with type/text filters, pause, copy and audit correlation", { timeout: 180_000 }, async (t) => {
  const { app, context, page, errors, evidence } = await fixture(t);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: app.url });
  await page.goto(`${app.url}/_sim/#logs`);
  await page.locator("#log-status").getByText("Streaming", { exact: false }).waitFor();
  const portal = await context.newPage();
  await portal.goto(`${app.url}/`);
  await page.locator(".log-row").filter({ hasText: "GET / → 200" }).first().waitFor();
  await page.locator(".log-row").filter({ hasText: "liquid" }).first().waitFor();
  await page.getByLabel("Log type", { exact: true }).selectOption("liquid");
  await page.waitForFunction(() => [...document.querySelectorAll(".log-row")].every((row) => row.textContent.includes("liquid")), null, { polling: 100 });
  await page.getByLabel("Log type", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const before = await page.locator(".log-row").count();
  await portal.goto(`${app.url}/secure/`);
  await page.getByText("new entries waiting", { exact: false }).waitFor();
  assert.equal(await page.locator(".log-row").count(), before, "paused logs do not move");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.locator(".log-row").filter({ hasText: "GET /secure/" }).first().waitFor();
  await evidence("admin-live-logs");
  await page.getByLabel("Filter live logs", { exact: true }).fill("/secure/");
  await page.getByRole("button", { name: "Copy filtered JSON", exact: true }).click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.ok(copied.length > 0 && copied.every((entry) => JSON.stringify(entry).includes("/secure/")));
  await page.locator(".log-row").filter({ hasText: "GET /secure/" }).first().getByRole("button", { name: "Inspect", exact: true }).click();
  await page.getByRole("button", { name: "Show correlated requests", exact: true }).click();
  await page.getByRole("heading", { name: "Request audit", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Correlation / }).waitFor();
  await page.waitForFunction(() => document.querySelector("tbody")?.textContent.includes("/secure/"));
  // An anonymous visitor is redirected to the local sign-in page.
  await page.locator('[data-audit-filter="status"]').selectOption("3xx");
  await page.waitForFunction(() => document.querySelector("tbody").textContent.includes("/secure/") && document.querySelectorAll("tbody tr").length === 1);
  assert.deepEqual(errors, []);
});

test("page confinement groups its exceptions under one toggle that is saved with the routing form", { timeout: 180_000 }, async (t) => {
  const { app, page, errors, notice, evidence } = await fixture(t);
  await page.goto(`${app.url}/_sim/#connection`);
  const toggle = page.getByLabel(/Confine local pages to loopback/);
  const assets = page.locator("#external-assets");
  const frames = page.locator("#external-frame-origins");
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), false, "local pages are not confined by default");
  assert.deepEqual([await assets.isDisabled(), await frames.isDisabled()], [true, true]);
  assert.match(await page.locator("#confinement-options").getAttribute("class"), /is-off/);
  await page.getByText("These apply only while local pages are confined to loopback.", { exact: true }).waitFor();

  await toggle.check();
  assert.deepEqual([await assets.isDisabled(), await frames.isDisabled()], [false, false]);
  await assets.check();
  await frames.fill("https://embed.example.test");
  await evidence("admin-page-confinement");
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await notice("Configuration saved.");
  assert.deepEqual([app.state().config.confinePortalPages, app.state().config.externalAssets, app.state().config.externalFrameOrigins], [true, true, ["https://embed.example.test"]]);
  const status = await (await fetch(`${app.url}/_sim/api/status`)).json();
  assert.deepEqual([status.confinePortalPages, status.externalAssets, status.externalFrameOrigins], [true, true, 1]);

  // Turning confinement off keeps the exceptions, shown disabled, and they take no effect.
  await page.reload();
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await assets.isDisabled(), false);
  await toggle.uncheck();
  assert.equal(await assets.isDisabled(), true);
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await notice("Configuration saved.");
  assert.deepEqual([app.state().config.confinePortalPages, app.state().config.externalAssets, app.state().config.externalFrameOrigins], [false, true, ["https://embed.example.test"]]);
  assert.deepEqual(errors, []);
});

test("the live-writes switch is disabled, with the reason, unless the runtime was started with --allow-live-writes", { timeout: 180_000 }, async (t) => {
  // Started without the flag (the default): the switch cannot be turned on, and saving the
  // routing form keeps live writes off.
  const locked = await fixture(t);
  await locked.page.goto(`${locked.app.url}/_sim/#connection`);
  const writes = locked.page.locator("#live-writes");
  await writes.waitFor();
  assert.deepEqual([await writes.isDisabled(), await writes.isChecked()], [true, false]);
  await locked.page.getByText("Disabled for this runtime: start the Mirage with --allow-live-writes (mirage dev and start pass it through) to allow it.", { exact: true }).waitFor();
  assert.equal((await (await fetch(`${locked.app.url}/_sim/api/status`)).json()).liveWrites, "disabled");
  await locked.page.getByRole("button", { name: "Save routing", exact: true }).click();
  await locked.notice("Configuration saved.");
  assert.equal(locked.app.state().config.live.allowWrites, false);
  assert.deepEqual(locked.errors, []);

  // Started with the flag: the switch is available, and turning it on is saved.
  const allowed = await fixture(t, { allowLiveWrites: true });
  await allowed.page.goto(`${allowed.app.url}/_sim/#connection`);
  const toggle = allowed.page.locator("#live-writes");
  await toggle.waitFor();
  assert.equal(await toggle.isDisabled(), false);
  assert.equal(await allowed.page.locator("#live-writes-disabled").count(), 0);
  assert.equal((await (await fetch(`${allowed.app.url}/_sim/api/status`)).json()).liveWrites, "off");
  await toggle.check();
  await allowed.page.getByRole("button", { name: "Save routing", exact: true }).click();
  await allowed.notice("Configuration saved.");
  assert.equal(allowed.app.state().config.live.allowWrites, true);
  assert.equal((await (await fetch(`${allowed.app.url}/_sim/api/status`)).json()).liveWrites, "enabled");
  assert.deepEqual(allowed.errors, []);
});
