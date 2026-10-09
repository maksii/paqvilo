// Admin workspace API: inspection, personas, scenarios, access rules, environment, state
// transfer and the live log stream. Synthetic loopback fixtures only; no portal requests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";

const FILES = {
  "website.yml": "adx_websiteid: site\nadx_name: Admin API fixture\nadx_headerwebtemplateid: header",
  "publishingstate.yml": "- adx_publishingstateid: published\n  adx_name: Published\n  adx_isvisible: true",
  "webrole.yml": "- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: editor\n  adx_name: Editor",
  "webpagerule.yml": "- adx_webpageaccesscontrolruleid: members-only\n  adx_name: Members only\n  adx_webpageid: secure\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member",
  "sitesetting.yml": "- adx_sitesettingid: s1\n  adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_sitesettingid: s2\n  adx_name: Webapi/contact/fields\n  adx_value: '*'\n- adx_sitesettingid: s3\n  adx_name: Feature/Banner\n  adx_value: on",
  "sitemarker.yml": "- adx_sitemarkerid: m1\n  adx_name: Secure area\n  adx_pageid: secure",
  "redirect.yml": "- adx_redirectid: r1\n  adx_name: Old secure\n  adx_inboundurl: old-secure\n  adx_statuscode: 301\n  adx_webpageid: secure",
  "weblink-sets/primary/Primary.weblinkset.yml": "adx_weblinksetid: primary\nadx_name: Primary Navigation",
  "weblink-sets/primary/Primary.weblinkset.weblink.yml": "- adx_weblinkid: w1\n  adx_name: Secure link\n  adx_pageid: secure\n  adx_weblinksetid: primary\n  adx_displayorder: 2",
  "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\nadx_publishingstateid: published",
  "web-pages/secure/Secure.webpage.yml": "adx_webpageid: secure\nadx_name: Secure\nadx_partialurl: secure\nadx_parentpageid: home\nadx_pagetemplateid: main\nadx_publishingstateid: published",
  "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
  "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
  "web-templates/Main.webtemplate.source.html": "<!doctype html><html><body>{% include 'Partial' %}<h1>{{ snippets['Greeting'] }} {{ user.fullname }}</h1>{% fetchxml rows %}<fetch><entity name=\"contact\"><attribute name=\"fullname\"/></entity></fetch>{% endfetchxml %}<p id=\"count\">{{ rows.results.entities.size }}</p>{{ settings['Feature/Banner'] }}</body></html>",
  "web-templates/Partial.webtemplate.yml": "adx_webtemplateid: partial\nadx_name: Partial",
  "web-templates/Partial.webtemplate.source.html": "<nav>{% editable snippets 'Footer/Text' type: 'html' %}</nav>",
  "web-templates/Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
  "web-templates/Header.webtemplate.source.html": "<header>Header</header>",
  "content-snippets/Greeting.contentsnippet.yml": "adx_contentsnippetid: greeting\nadx_name: Greeting",
  "content-snippets/Greeting.contentsnippet.value.html": "Hello",
  "content-snippets/Footer.contentsnippet.yml": "adx_contentsnippetid: footer\nadx_name: Footer/Text",
  "content-snippets/Footer.contentsnippet.value.html": "Footer text",
};

const initial = () => ({
  version: 1,
  mappings: {
    contact: { entitySet: "contacts", idColumn: "contactid" },
    account: { entitySet: "accounts", idColumn: "accountid" },
    item: { entitySet: "items", idColumn: "itemid" },
    environmentvariabledefinition: { entitySet: "environmentvariabledefinitions", idColumn: "environmentvariabledefinitionid" },
    environmentvariablevalue: { entitySet: "environmentvariablevalues", idColumn: "environmentvariablevalueid" },
  },
  tables: {
    contact: [{ contactid: "alex", firstname: "Alex", lastname: "Local", fullname: "Alex Local" }],
    account: [],
    item: [{ itemid: "local-item", name: "Local item" }],
    environmentvariabledefinition: [
      { environmentvariabledefinitionid: "def-api", schemaname: "sample_ApiUrl", displayname: "API URL", type: 100000000, defaultvalue: "https://default.example.test" },
      { environmentvariabledefinitionid: "def-flag", schemaname: "sample_Flag", displayname: "Feature flag", type: 100000002, defaultvalue: "no" },
    ],
    environmentvariablevalue: [{ environmentvariablevalueid: "val-flag", schemaname: "sample_Flag", value: "yes", environmentvariabledefinitionid: { id: "def-flag", logical_name: "environmentvariabledefinition" } }],
  },
  permissions: [
    { id: "members-read", name: "Members read contacts", entity: "contact", roles: ["Member"], operations: ["read"], scope: "global" },
    { id: "members-own", name: "Members update themselves", entity: "contact", roles: ["Member"], operations: ["update"], scope: "self" },
  ],
  plugins: [{ id: "require-lastname", entity: "contact", operations: ["create"], validate: [{ field: "lastname", required: true, message: "Last name is required." }] }],
  presets: {
    "two-contacts": { name: "Two contacts", userConfigured: true, tables: { contact: [{ contactid: "alex", fullname: "Alex Local" }, { contactid: "blair", fullname: "Blair Local" }] } },
  },
  settings: { permissionMode: "enforce" },
  simulator: { mode: "local", pageMode: "local", permissionSource: "configured", identity: { roles: [] }, contactRoles: [{ contactId: "alex", roleId: "member" }], live: {}, endpoints: [] },
});

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-admin-api-"));
  for (const [name, body] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  // The contact field list is the wildcard, which hosted sites reject unless exempt.
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state", "state.json"), watch: false, initial: initial(), observed: { webApiWildcard: "exempt", evidence: "synthetic fixture with a wildcard field list" }, ...options });
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const csrf = app.state().csrf;
  const call = async (route, method = "GET", body, headers = {}) => {
    const response = await fetch(app.url + route, {
      method,
      headers: { "content-type": "application/json", "x-sim-csrf": csrf, ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text, headers: response.headers };
  };
  // A browser session for the contact (the paqvilo-mirage-auth cookie as a Cookie header value).
  const signIn = async (contactId) => {
    const response = await call(contactId ? "/__sim/api/session/sign-in" : "/__sim/api/session/sign-out", "POST", contactId ? { contactId } : {});
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  return { app, call, dir, signIn };
}

test("status is cheap, carries CSRF, revision, diagnostics, presets and the effective identity", async (t) => {
  const { app, call } = await setup(t);
  const { status, json } = await call("/__sim/api/status");
  assert.equal(status, 200);
  assert.equal(json.csrf, app.state().csrf);
  assert.equal(typeof json.revision, "number");
  assert.equal(json.sourceFingerprint, app.state().status.sourceFingerprint);
  assert.equal(json.permissionMode, "enforce");
  assert.ok(json.presets.some((preset) => preset.id === "two-contacts"));
  assert.equal(json.identity.roleSource, "override");
  assert.equal(typeof json.diagnostics.total, "number");
  assert.equal(json.adminUrl, `${app.url}/_sim/`);
  assert.deepEqual([json.confinePortalPages, json.externalAssets, json.externalFrameOrigins], [false, false, 0], "local pages are not confined by default");
  assert.equal((await call("/_sim/api/status")).status, 200, "the short admin alias serves the same API");
});

test("page inspection explains access rules, publishing state, permissions, values, chain and related metadata", async (t) => {
  const { call, signIn } = await setup(t);
  let report = (await call("/__sim/api/page-resources?path=/secure/")).json;
  assert.equal(report.page.publishingState.name, "Published");
  assert.equal(report.page.parent.url, "/");
  assert.equal(report.page.access.allowed, false);
  assert.deepEqual(report.page.access.rules.map((rule) => [rule.name, rule.rightLabel, rule.matches]), [["Members only", "Restrict read", false]]);
  assert.deepEqual(report.templateChain.map((row) => `${row.depth}:${row.kind}:${row.name}`).slice(0, 4), ["0:page-template:Main", "1:web-template:Main", "2:web-template:Partial", "3:content-snippet:Footer/Text"]);
  assert.ok(report.usages.some((usage) => usage.kind === "editable" && usage.reference === "Footer/Text"));
  assert.ok(report.usages.some((usage) => usage.kind === "fetchxml" && usage.reference === "contact"));
  const contact = report.tables.find((table) => table.logicalName === "contact");
  assert.equal(contact.entitySet, "contacts");
  assert.equal(contact.permissions.mode, "enforce");
  assert.equal(contact.permissions.operations.read.allowed, false);
  assert.match(contact.permissions.operations.read.reason, /current roles/);
  assert.equal(report.snippets.find((snippet) => snippet.name === "Greeting").value, "Hello");
  assert.equal(report.siteSettings.find((setting) => setting.name === "Feature/Banner").value, "on");
  assert.deepEqual(report.related.weblinks.map((link) => [link.name, link.set]), [["Secure link", "Primary Navigation"]]);
  assert.deepEqual(report.related.sitemarkers.map((marker) => marker.name), ["Secure area"]);
  assert.deepEqual(report.related.redirects.map((redirect) => [redirect.inboundUrl, redirect.statusCode]), [["old-secure", 301]]);
  // A browser session as the member persona passes the restriction and gets scoped and global
  // grants explained.
  const member = { cookie: await signIn("alex") };
  await call("/__sim/api/portal-snippets/Greeting", "PATCH", { value: "Local hello" });
  report = (await call("/__sim/api/page-resources?path=/secure/", "GET", undefined, member)).json;
  assert.equal(report.page.access.allowed, true);
  assert.equal(report.page.access.rules[0].matches, true);
  const read = report.tables.find((table) => table.logicalName === "contact").permissions.operations;
  assert.equal(read.read.allowed, true);
  assert.equal(read.read.scoped, false);
  assert.equal(read.update.scoped, true);
  assert.match(read.update.reason, /self scope/);
  assert.equal(read.delete.allowed, false);
  const greeting = report.snippets.find((snippet) => snippet.name === "Greeting");
  assert.deepEqual([greeting.value, greeting.sourceValue, greeting.overridden], ["Local hello", "Hello", true]);
  await call("/__sim/api/config", "PATCH", { permissionMode: "permissive" });
  report = (await call("/__sim/api/page-resources?path=/secure/", "GET", undefined, member)).json;
  assert.equal(report.tables.find((table) => table.logicalName === "contact").permissions.operations.delete.allowed, true);
  assert.equal((await call("/__sim/api/page-resources?path=//elsewhere")).status, 400);
});

test("personas are listed, created with memberships and selected, with validation", async (t) => {
  const { app, call } = await setup(t);
  let personas = (await call("/__sim/api/personas")).json;
  assert.deepEqual(personas.personas.map((persona) => persona.contactId), ["alex"]);
  assert.deepEqual(personas.webRoles.map((role) => role.name), ["Editor", "Member"]);
  const rejected = await call("/__sim/api/personas", "POST", { firstname: "No", roleIds: ["member"] });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.error.message, /Last name is required/);
  assert.equal((await call("/__sim/api/personas", "POST", { lastname: "Unknown", roleIds: ["nope"] })).status, 400);
  const created = await call("/__sim/api/personas", "POST", { firstname: "Casey", lastname: "Editor", emailaddress1: "casey@example.test", roleIds: ["editor"], select: true });
  assert.equal(created.status, 201);
  const contactId = created.json.contact.contactid;
  assert.equal(created.json.identity.contactId, contactId);
  assert.deepEqual(created.json.identity.roles, ["Editor"]);
  assert.ok(app.state().config.contactRoles.some((row) => row.contactId === contactId && row.roleId === "editor"));
  const anonymous = await call("/__sim/api/personas/select", "POST", { contactId: null });
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.json.identity.contactId, null);
  assert.equal((await call("/__sim/api/personas/select", "POST", { contactId: "missing" })).status, 404);
  personas = (await call("/__sim/api/personas")).json;
  assert.equal(personas.personas.length, 2);
});

test("scenarios combine preset, persona and permissions in one state change and survive reset", async (t) => {
  const { app, call } = await setup(t);
  assert.equal((await call("/__sim/api/scenarios", "POST", { id: "bad id", name: "x", preset: "two-contacts" })).status, 400);
  assert.equal((await call("/__sim/api/scenarios", "POST", { id: "empty", name: "Nothing" })).status, 400);
  assert.equal((await call("/__sim/api/scenarios", "POST", { id: "ghost", name: "Ghost", preset: "missing-preset" })).status, 400);
  const revision = app.state().status.revision;
  const created = await call("/__sim/api/scenarios", "POST", { id: "blair-open", name: "Blair in sandbox", preset: "two-contacts", persona: { contactId: "blair" }, permissionMode: "permissive" });
  assert.equal(created.status, 201);
  assert.equal(app.state().status.revision, revision, "saving a definition does not reload portal pages");
  assert.equal((await call("/__sim/api/scenarios", "POST", { id: "blair-open", name: "Duplicate", permissionMode: "enforce" })).status, 409);
  const applied = await call("/__sim/api/scenarios/blair-open/apply", "POST", {});
  assert.equal(applied.status, 200);
  assert.equal(app.state().status.revision, revision + 1, "preset, persona and permissions apply as one reload");
  assert.equal(app.state().config.identity.contactId, "blair");
  assert.equal(app.state().config.permissionMode, "permissive");
  assert.equal(app.state().data.contact.length, 2);
  assert.equal(applied.json.activeScenario.id, "blair-open");
  await call("/__sim/api/scenarios", "POST", { id: "missing-persona", name: "Missing", persona: { contactId: "nobody" } });
  const failed = await call("/__sim/api/scenarios/missing-persona/apply", "POST", {});
  assert.equal(failed.status, 409);
  assert.equal(app.state().config.identity.contactId, "blair", "a failed scenario changes nothing");
  assert.equal((await call("/__sim/api/scenarios/blair-open", "PATCH", { description: "Edited" })).json.scenarios.find((item) => item.id === "blair-open").description, "Edited");
  assert.equal((await call("/__sim/api/reset", "POST", {})).status, 200);
  assert.deepEqual(app.state().config.scenarios.map((item) => item.id), ["blair-open", "missing-persona"]);
  assert.equal(app.state().config.activeScenario, undefined);
  assert.equal((await call("/__sim/api/scenarios/missing-persona", "DELETE")).status, 200);
  assert.deepEqual((await call("/__sim/api/scenarios")).json.scenarios.map((item) => item.id), ["blair-open"]);
});

test("page access rules can be overridden, added and reset locally and change page access", async (t) => {
  const { app, call, signIn } = await setup(t);
  const member = { cookie: await signIn("alex") };
  const secure = async () => (await fetch(app.url + "/secure/", { headers: member, redirect: "manual" })).status;
  assert.equal(await secure(), 200);
  const rules = (await call("/__sim/api/portal-access-rules")).json;
  assert.deepEqual(rules.map((rule) => [rule.id, rule.value.right, rule.value.roleIds]), [["members-only", 2, ["member"]]]);
  assert.equal((await call("/__sim/api/portal-access-rules/members-only", "PATCH", { value: { name: "Editors only", webPageId: "secure", right: 2, scope: 1, roleIds: ["missing"] } })).status, 400);
  assert.equal((await call("/__sim/api/portal-access-rules/members-only", "PATCH", { value: { name: "Editors only", webPageId: "nowhere", right: 2, scope: 1, roleIds: ["editor"] } })).status, 400);
  const changed = await call("/__sim/api/portal-access-rules/members-only", "PATCH", { value: { name: "Editors only", webPageId: "SECURE", right: 2, scope: 1, roleIds: ["EDITOR"] } });
  assert.equal(changed.status, 200);
  assert.deepEqual([changed.json.overridden, changed.json.value.webPageId, changed.json.value.roleIds], [true, "secure", ["editor"]]);
  assert.equal(await secure(), 403);
  const added = await call("/__sim/api/portal-access-rules", "POST", { id: "local-grant", value: { name: "Members change everything", webPageId: "home", right: 1, scope: 1, roleIds: ["member"] } });
  assert.equal(added.status, 201);
  assert.equal(await secure(), 200, "a grant-change rule on an ancestor wins");
  assert.equal((await call("/__sim/api/portal-access-rules/local-grant", "DELETE")).status, 200);
  assert.equal((await call("/__sim/api/portal-access-rules/members-only", "DELETE")).status, 200);
  assert.equal(await secure(), 200);
  assert.equal((await call("/__sim/api/portal-access-rules")).json[0].overridden, false);
});

test("environment view joins variable definitions and values, edits values and selects a reference origin", async (t) => {
  const { app, call } = await setup(t);
  let environment = (await call("/__sim/api/environment")).json;
  assert.equal(environment.environmentVariables.available, true);
  const byName = Object.fromEntries(environment.environmentVariables.definitions.map((item) => [item.schemaName, item]));
  assert.equal(byName.sample_Flag.effectiveValue, "yes");
  assert.equal(byName.sample_ApiUrl.effectiveValue, "https://default.example.test");
  assert.equal((await call("/__sim/api/environment/variables/sample_ApiUrl", "PUT", { value: "https://local.example.test" })).json.effectiveValue, "https://local.example.test");
  assert.equal((await call("/__sim/api/environment/variables/sample_Flag", "PUT", { value: null })).json.effectiveValue, "no");
  assert.equal((await call("/__sim/api/environment/variables/missing", "PUT", { value: "x" })).status, 404);
  assert.equal((await call("/__sim/api/environment/variables/sample_Flag", "PUT", { value: 4 })).status, 400);
  assert.equal(app.store.snapshot().tables.environmentvariablevalue.length, 1);
  assert.equal((await call("/__sim/api/environment/reference", "POST", { origin: "http://insecure.example.test" })).status, 400);
  const selected = await call("/__sim/api/environment/reference", "POST", { origin: "https://reference.example.test" });
  assert.equal(selected.status, 200);
  assert.equal(selected.json.live.origin, "https://reference.example.test");
  assert.equal(selected.json.live.connected, false, "selecting a reference never connects to it");
  environment = (await call("/__sim/api/environment")).json;
  assert.deepEqual(environment.deploymentProfiles, []);
});

test("enrichment plans validate without reads and run through the connected bridge into local state", async (t) => {
  const reads = [];
  const bridge = {
    origin: "https://reference.example.test",
    connected: false,
    configure() {},
    status() { return { connected: this.connected, origin: this.origin }; },
    async connect() { this.connected = true; return this.status(); },
    async close() {},
    async request() { throw new Error("no live requests in this test"); },
    async fetchXml(xml) {
      reads.push(xml);
      return { entities: [{ itemid: "reference-item", name: "Reference item" }], more_records: false };
    },
  };
  const { app, call } = await setup(t, { liveBridge: bridge });
  const plan = [{ entity: "item", fetchXml: '<fetch><entity name="item"><attribute name="name"/></entity></fetch>', pageSize: 10, maxPages: 1 }];
  const invalid = await call("/__sim/api/reference/enrich/validate", "POST", { plan: [{ ...plan[0], mode: "bad" }] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error.message, /mode/);
  const valid = await call("/__sim/api/reference/enrich/validate", "POST", { plan });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.json.entries, [{ entity: "item", idColumn: "itemid", mode: "merge", pageSize: 10, maxPages: 1 }]);
  assert.equal(reads.length, 0, "validation performs no reference reads");
  assert.equal((await call("/__sim/api/reference/enrich", "POST", { plan })).status, 409, "a disconnected bridge is refused");
  bridge.connected = true;
  const revision = app.state().status.revision;
  const run = await call("/__sim/api/reference/enrich", "POST", { plan });
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.applied, true);
  assert.equal(reads.length, 1);
  assert.deepEqual(app.store.snapshot().tables.item.map((row) => row.itemid).sort(), ["local-item", "reference-item"]);
  assert.equal(app.state().status.revision, revision + 1, "the runtime reloads once with the imported rows");
  assert.equal(app.state().config.referenceImports.at(-1).tables[0].entity, "item");
});

test("state exports and imports round-trip, rejecting invalid imports without changes", async (t) => {
  const { app, call } = await setup(t);
  const exported = await call("/__sim/api/state/export");
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), /simulator-state\.json/);
  await call("/__sim/api/records/item", "POST", { itemid: "added", name: "Added later" });
  await call("/__sim/api/scenarios", "POST", { id: "kept", name: "Kept", permissionMode: "permissive" });
  assert.equal((await call("/__sim/api/state/import", "POST", "{not json")).status, 400);
  assert.equal((await call("/__sim/api/state/import", "POST", [])).status, 400);
  assert.equal((await call("/__sim/api/state/import", "POST", { ...exported.json, simulator: { ...exported.json.simulator, mode: "sideways" } })).status, 400);
  assert.equal(app.store.snapshot().tables.item.length, 2, "failed imports leave state untouched");
  const imported = await call("/__sim/api/state/import", "POST", exported.json);
  assert.equal(imported.status, 200, imported.text);
  assert.deepEqual(app.store.snapshot().tables.item.map((row) => row.itemid), ["local-item"]);
  assert.deepEqual(app.state().config.scenarios.map((item) => item.id), ["kept"], "scenario definitions survive an import");
});

test("the log channel streams requests, Liquid reads, plugin evaluations and diagnostics only to subscribers", async (t) => {
  const { app, call } = await setup(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(app.url + "/__sim/events?channels=logs", { signal: controller.signal });
  const reader = stream.body.getReader();
  const events = [];
  let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += Buffer.from(value).toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type === "log") events.push(JSON.parse(data));
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (events.some(predicate)) return events.find(predicate);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No ${label} log event: ${JSON.stringify(events.map((event) => event.type))}`);
  };
  await waitFor((event) => event.type === "connected", "connected");
  await call("/__sim/api/personas/select", "POST", { contactId: "alex" });
  await fetch(app.url + "/");
  await waitFor((event) => event.type === "request" && event.entry.path === "/", "page request");
  await waitFor((event) => event.type === "liquid" && event.entry.entity === "contact", "Liquid FetchXML");
  const rejected = await fetch(app.url + "/_api/contacts", { method: "POST", headers: { "content-type": "application/json", __RequestVerificationToken: app.state().csrf }, body: JSON.stringify({ firstname: "No last name" }) });
  assert.equal(rejected.status, 403, "members cannot create contacts");
  await call("/__sim/api/config", "PATCH", { permissionMode: "permissive" });
  await fetch(app.url + "/_api/contacts", { method: "POST", headers: { "content-type": "application/json", __RequestVerificationToken: app.state().csrf }, body: JSON.stringify({ firstname: "No last name" }) });
  const plugin = await waitFor((event) => event.type === "plugin" && event.outcome === "rejected", "plugin rejection");
  assert.deepEqual(plugin.plugins, ["require-lastname"]);
  assert.match(plugin.error.message, /Last name is required/);
  await fetch(app.url + "/no-such-page/");
  await waitFor((event) => event.type === "diagnostic" && event.diagnostic.code === "UNMAPPED_RESOURCE", "diagnostic");
  assert.ok(events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence));
  // Portal pages subscribe without the logs channel and receive no log events.
  const portal = await fetch(app.url + "/__sim/events", { signal: controller.signal });
  const first = await portal.body.getReader().read();
  assert.doesNotMatch(Buffer.from(first.value).toString("utf8"), /event: log/);
  controller.abort();
  await pump;
});

test("administration calls through /_sim are not audited as portal pages and their errors are not runtime diagnostics", async (t) => {
  const { app, call } = await setup(t);
  const before = app.state().diagnostics.length;
  for (let n = 0; n < 3; n++) assert.equal((await call("/_sim/api/status")).status, 200);
  assert.equal((await call("/_sim/api/page-resources?path=/")).status, 200);
  assert.equal((await call("/_sim/api/no-such-endpoint")).status, 404);
  assert.equal((await call("/__sim/api/scenarios", "POST", { id: "bad id" })).status, 400);
  const audit = (await call("/__sim/api/audit?pageSize=100")).json;
  assert.deepEqual(audit.items.filter((item) => /^\/_{1,2}sim\//.test(item.path)), []);
  assert.equal(app.state().diagnostics.length, before, "admin errors are answered, not recorded as portal diagnostics");
  await fetch(`${app.url}/missing-page/`);
  assert.ok(app.state().diagnostics.some((item) => item.code === "UNMAPPED_RESOURCE"), "portal errors remain diagnostics");
});

test("local environment variable values persist over Solution re-seeding until reset", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-admin-envvars-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const portal = path.join(dir, "portal"), solution = path.join(dir, "solution");
  for (const [name, body] of Object.entries({
    "website.yml": "adx_websiteid: site\nadx_name: Variables",
    "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /",
  })) {
    await fs.mkdir(path.dirname(path.join(portal, name)), { recursive: true });
    await fs.writeFile(path.join(portal, name), body);
  }
  const variable = path.join(solution, "environmentvariabledefinitions", "sample_Seeded");
  await fs.mkdir(variable, { recursive: true });
  await fs.writeFile(path.join(variable, "environmentvariabledefinition.xml"), '<environmentvariabledefinition schemaname="sample_Seeded"><defaultvalue>default</defaultvalue><displayname default="Seeded"><label description="Seeded" languagecode="1033" /></displayname><type>100000000</type></environmentvariabledefinition>');
  await fs.writeFile(path.join(variable, "environmentvariablevalues.json"), JSON.stringify({ environmentvariablevalues: { environmentvariablevalue: [{ schemaname: "sample_Seeded", value: "solution" }] } }));
  const app = await createSimulator({ sourceDir: portal, stateFile: path.join(dir, "state", "state.json"), watch: false, solutionRoots: [solution] });
  t.after(() => app.close());
  const csrf = app.state().csrf;
  const call = async (route, method = "GET", body) => {
    const response = await fetch(app.url + route, { method, headers: { "content-type": "application/json", "x-sim-csrf": csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const seeded = async () => (await call("/__sim/api/environment")).json.environmentVariables.definitions.find((item) => item.schemaName === "sample_Seeded");
  assert.deepEqual([(await seeded()).effectiveValue, (await seeded()).overridden], ["solution", false]);
  const edited = await call("/__sim/api/environment/variables/sample_Seeded", "PUT", { value: "local" });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.json.effectiveValue, edited.json.overridden], ["local", true]);
  assert.equal((await call("/__sim/api/config", "PATCH", { permissionMode: "permissive" })).status, 200);
  assert.equal((await seeded()).effectiveValue, "local", "an unrelated state change re-seeds Solution rows without losing the local value");
  const reset = await call("/__sim/api/environment/variables/sample_Seeded", "PUT", { value: null });
  assert.deepEqual([reset.json.effectiveValue, reset.json.overridden], ["solution", false]);
  assert.deepEqual(app.state().config.environmentVariables, {});
});

test("page inspection summaries carry counts, the access verdict and table names only", async (t) => {
  const { call } = await setup(t);
  const summary = (await call("/__sim/api/page-resources?path=/secure/&view=summary")).json;
  const full = (await call("/__sim/api/page-resources?path=/secure/")).json;
  assert.equal(summary.view, "summary");
  assert.equal(summary.page.access.allowed, false);
  assert.deepEqual(summary.tables, full.tables.map((table) => table.logicalName));
  assert.equal(summary.counts.snippets, full.snippets.length);
  assert.equal(summary.counts.accessRules, full.page.access.rules.length);
  assert.equal(summary.webTemplates, undefined);
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 2);
});

test("page inspection answers with the identity a portal request with the same cookies and headers gets", async (t) => {
  const { app, call, signIn } = await setup(t);
  // The configured persona is a member: whether it applies to cookie-less clients is the
  // portal's rule, and inspection must agree with what the portal serves.
  assert.equal((await call("/__sim/api/personas/select", "POST", { contactId: "alex" })).status, 200);
  const signedIn = await signIn("alex");
  const signedOut = await signIn(null);
  const browser = { "sec-fetch-site": "same-origin" };
  const cases = [
    ["a client without a session", {}],
    ["a browser without a session", browser],
    ["a signed-out session", { cookie: signedOut }],
    ["a signed-in browser", { cookie: signedIn, ...browser }],
    ["a signed-in client", { cookie: signedIn }],
  ];
  const verdicts = {};
  for (const [label, headers] of cases) {
    const inspected = (await (await fetch(`${app.url}/__sim/api/page-resources?path=/secure/&view=summary`, { headers })).json()).page.access.allowed;
    const served = (await fetch(`${app.url}/secure/`, { headers, redirect: "manual" })).status === 200;
    assert.equal(inspected, served, label);
    verdicts[label] = inspected;
  }
  assert.deepEqual(Object.values(verdicts), [false, false, false, true, true], "portal requests take their identity from the session only");
});
