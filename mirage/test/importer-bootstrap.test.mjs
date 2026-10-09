import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { importPortal, chooseRecordCopy, normalizePortalPath, guidOrderKey } from "../lib/importer.mjs";
import { initialState } from "../lib/bootstrap.mjs";
import { importSolutionData } from "../lib/solution-data.mjs";
import { createSimulator } from "../server.mjs";
import { bootstrapReport, resolveReportInputs } from "../bootstrap-report.mjs";
import { SolutionFileCache } from "../lib/solution-cache.mjs";
import { portalWebRoles, resolvePortalIdentity } from "../lib/permissions.mjs";
import { languageRoute, deniedPageRoute } from "../lib/redirects.mjs";

async function write(root, files) {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
}
async function temp(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
}
const portalFiles = {
  "website.yml": "adx_name: Bootstrap\nadx_websiteid: site\nadx_defaultlanguage: en",
  "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\nadx_publishingstateid: published",
  "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
  "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
  "web-templates/Main.webtemplate.source.html":
    '<!doctype html><title>Home</title>{% fetchxml rows %}<fetch><entity name="sample_item"><attribute name="sample_name"/></entity></fetch>{% endfetchxml %}<p>{{ rows.results.entities.size }}</p>',
  "sitesetting.yml":
    "- adx_sitesettingid: s1\n  adx_name: Webapi/sample_item/enabled\n  adx_value: true\n- adx_sitesettingid: s2\n  adx_name: Webapi/sample_item/fields\n  adx_value: sample_name\n- adx_sitesettingid: s1\n  adx_name: Webapi/sample_item/enabled\n  adx_value: true\n- adx_sitesettingid: s3\n  adx_name: Webapi/category/enabled\n  adx_value: true",
  "webrole.yml": "- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true",
  "table-permissions/Items.tablepermission.yml":
    "adx_entitypermissionid: items\nadx_entityname: Items\nadx_entitylogicalname: sample_item\nadx_scope: 756150000\nadx_read: true\nadx_entitypermission_webrole:\n- member",
  "publishingstate.yml":
    "- adx_publishingstateid: draft\n  adx_name: Draft\n  adx_isvisible: false\n- adx_publishingstateid: published\n  adx_name: Published\n  adx_isvisible: true\n  adx_isdefault: true\n  statecode: 1",
  "websiteaccess.yml":
    "- adx_websiteaccessid: preview\n  adx_name: Preview\n  adx_previewunpublishedentities: true\n  adx_websiteaccess_webrole:\n  - member",
  "websitelanguage.yml": "- adx_websitelanguageid: en\n  adx_name: English\n  adx_publishingstate: published",
  "sitemarker.yml":
    "- adx_sitemarkerid: m1\n  adx_name: Home\n  adx_pageid: home\n- adx_sitemarkerid: m2\n  adx_name: Home\n  adx_pageid: other",
  "redirect.yml": "- adx_redirectid: r1\n  adx_name: Old\n  adx_inboundurl: old\n  adx_webpageid: home\n  statecode: 1",
  "urlhistory.yml":
    "- adx_urlhistoryid: h1\n  adx_name: ~/legacy\n  adx_webpageid: home\n  adx_changeddate: 2020-01-01T00:00:00Z\n- adx_urlhistoryid: h2\n  adx_name: ~/inactive\n  adx_webpageid: home\n  statecode: 1",
};
const entity = (set, extra = "") =>
  `<Entity><Name>sample_item</Name><EntityInfo><entity Name="sample_item"><attributes><attribute PhysicalName="sample_itemId"><Type>primarykey</Type><LogicalName>sample_itemid</LogicalName></attribute><attribute PhysicalName="sample_name"><Type>nvarchar</Type><LogicalName>sample_name</LogicalName><DisplayMask>PrimaryName</DisplayMask><MaxLength>100</MaxLength></attribute>${["createdon", "createdby", "modifiedon", "modifiedby", "statecode", "statuscode"].map((name) => `<attribute PhysicalName="${name}"><Type>${name === "statecode" ? "state" : name === "statuscode" ? "status" : "nvarchar"}</Type><LogicalName>${name}</LogicalName></attribute>`).join("")}${extra}</attributes><EntitySetName>${set}</EntitySetName></entity></EntityInfo></Entity>`;

test("the importer models routing, publishing and language records and handles duplicate exports", async (t) => {
  const dir = await temp(t, "pp-import-");
  await write(dir, portalFiles);
  const portal = await importPortal(dir);
  assert.deepEqual(portal.publishingStates.map((s) => [s.name, s.isVisible, s.active]), [["Draft", false, true], ["Published", true, false]]);
  assert.deepEqual(portal.websiteAccess, [{ id: "preview", name: "Preview", roleIds: ["member"], manageContentSnippets: false, manageSiteMarkers: false, manageWebLinkSets: false, previewUnpublishedEntities: true }]);
  // The URL language code comes from the documented portal-language catalogue.
  assert.deepEqual(portal.language, { id: "en", name: "English", portalLanguageId: null, publishingStateId: "published", published: true, isDefault: true, code: "en-US", lcid: 1033 });
  assert.equal(portal.redirects[0].active, false);
  assert.equal(portal.redirects[0].inboundUrl, "old");
  assert.deepEqual(portal.urlHistory.map((row) => row.path), ["~/legacy"]);
  // Site markers: first active record with the name wins.
  assert.equal(portal.sitemarkers.Home.id, "home");
  assert.ok(portal.diagnostics.some((d) => d.code === "SITE_MARKER_DUPLICATE"));
  // The same record exported twice with identical content becomes one record.
  assert.equal(portal.records.filter((r) => r.kind === "sitesetting" && r.id === "s1").length, 1);
  assert.ok(portal.diagnostics.some((d) => d.code === "DUPLICATE_RECORD_IDENTICAL" && d.id === "s1"));
  await write(dir, { "sitesetting.yml": portalFiles["sitesetting.yml"].replace(/(adx_value: true)(?![\s\S]*adx_name: Webapi\/sample_item\/fields)/, "adx_value: false") });
  const conflicting = await importPortal(dir);
  // Differing copies resolve to one record: both are in sitesetting.yml (same name, commit
  // and modification time), so the first copy in export order is used and named.
  const kept = conflicting.records.filter((r) => r.kind === "sitesetting" && r.id === "s1");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].adx_value, true);
  const resolved = conflicting.diagnostics.filter((d) => d.code === "DUPLICATE_RECORD_RESOLVED");
  assert.deepEqual(resolved.map((d) => [d.kind, d.id, path.basename(d.file), path.basename(d.usedFile), d.reason]), [["sitesetting", "s1", "sitesetting.yml", "sitesetting.yml", "it is the first copy in export order"]]);
  assert.ok(!conflicting.diagnostics.some((d) => d.code === "DUPLICATE_RECORD_CONFLICT"));
});

test("page titles come from the language content page and language codes from the catalogue", async (t) => {
  const dir = await temp(t, "pp-import-titles-");
  await write(dir, {
    ...portalFiles,
    "website.yml": "adx_name: Bootstrap\nadx_websiteid: site\nadx_defaultlanguage: en\nadx_website_language: 1033",
    "websitelanguage.yml": "- adx_websitelanguageid: en\n  adx_name: English\n  adx_publishingstate: published\n- adx_websitelanguageid: custom\n  adx_name: Local dialect\n  adx_publishingstate: published",
    "web-pages/kb/KB.webpage.yml": "adx_webpageid: kb\nadx_name: Knowledge Base-Home-Site\nadx_partialurl: kb\nadx_parentpageid: home\nadx_pagetemplateid: main\nadx_isroot: true",
    "web-pages/kb/content-pages/KB.en-US.webpage.yml": "adx_webpageid: kb-en\nadx_name: Knowledge Base\nadx_partialurl: kb\nadx_rootwebpageid: kb\nadx_webpagelanguageid: en\nadx_isroot: false\nadx_pagetemplateid: main",
    "web-pages/faq/FAQ.webpage.yml": "adx_webpageid: faq\nadx_name: FAQ root\nadx_partialurl: faq\nadx_parentpageid: home\nadx_pagetemplateid: main\nadx_isroot: true",
    "web-pages/faq/content-pages/FAQ.en-US.webpage.yml": "adx_webpageid: faq-en\nadx_name: FAQ\nadx_title: Frequently asked questions\nadx_partialurl: faq\nadx_rootwebpageid: faq\nadx_webpagelanguageid: en\nadx_isroot: false\nadx_pagetemplateid: main",
  });
  const portal = await importPortal(dir);
  const title = (url) => portal.pages.find((page) => page.url === url).title;
  // adx_title, else adx_name, of the content page (sandbox: "Knowledge Base", not the root page name).
  assert.equal(title("/kb/"), "Knowledge Base");
  assert.equal(title("/faq/"), "Frequently asked questions");
  assert.equal(title("/"), "Home");
  assert.equal(portal.pages.find((page) => page.url === "/kb/").name, "Knowledge Base-Home-Site");
  assert.deepEqual(portal.websiteLanguages.map((language) => language.code ?? null), ["en-US", null]);
  assert.ok(portal.diagnostics.some((d) => d.code === "WEBSITE_LANGUAGE_CODE_UNKNOWN" && d.id === "custom"));
});

test("unflagged special web roles fall back to the documented role names in an enhanced export", async (t) => {
  const xmlText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const role = (id, name, content = {}) => [
    `powerpagecomponents/${id}/powerpagecomponent.xml`,
    `<powerpagecomponent powerpagecomponentid="${id}"><content>${xmlText(JSON.stringify(content))}</content><name>${name}</name><powerpagecomponenttype>11</powerpagecomponenttype><statecode>0</statecode></powerpagecomponent>`,
  ];
  const home = [
    "powerpagecomponents/home/powerpagecomponent.xml",
    `<powerpagecomponent powerpagecomponentid="home"><content>${xmlText(JSON.stringify({ partialurl: "/" }))}</content><name>Home</name><powerpagecomponenttype>2</powerpagecomponenttype><statecode>0</statecode></powerpagecomponent>`,
  ];
  // As in Example: no role carries the Authenticated/Anonymous Users Role flag.
  const unflagged = await temp(t, "pp-enhanced-roles-");
  await write(unflagged, Object.fromEntries([home, role("auth", "Authenticated Users", { authenticatedusersrole: false, anonymoususersrole: false }), role("anon", "Anonymous Users"), role("member", "Member")]));
  const portal = await importPortal(unflagged);
  assert.equal(portal.format, "enhanced");
  const flags = Object.fromEntries(portalWebRoles(portal).map((entry) => [entry.name, [entry.authenticated, entry.anonymous]]));
  assert.deepEqual(flags, { "Anonymous Users": [false, true], "Authenticated Users": [true, false], Member: [false, false] });
  assert.deepEqual(
    portal.diagnostics.filter((d) => d.code === "WEB_ROLE_FLAG_INFERRED").map((d) => [d.flag, d.name]),
    [["authenticatedusersrole", "Authenticated Users"], ["anonymoususersrole", "Anonymous Users"]],
  );
  // A signed-in contact receives the inferred Authenticated Users role.
  const state = { mappings: { contact: { entitySet: "contacts", idColumn: "contactid" } }, tables: { contact: [{ contactid: "c1", fullname: "Casey", statecode: 0 }] }, simulator: { contactRoles: [] } };
  assert.ok(resolvePortalIdentity(portal, state, { contactId: "c1", roleSource: "memberships" }).roleIds.includes("auth"));
  // A flagged role wins over the name; two unflagged default names are ambiguous.
  const flagged = await temp(t, "pp-enhanced-flagged-");
  await write(flagged, Object.fromEntries([home, role("signed", "Signed-in visitors", { authenticatedusersrole: true }), role("auth", "Authenticated Users"), role("anon-a", "Anonymous Users"), role("anon-b", "anonymous users")]));
  const explicit = await importPortal(flagged);
  const explicitFlags = Object.fromEntries(portalWebRoles(explicit).map((entry) => [entry.id, [entry.authenticated, entry.anonymous]]));
  assert.deepEqual(explicitFlags, { "anon-a": [false, false], "anon-b": [false, false], auth: [false, false], signed: [true, false] });
  assert.deepEqual(
    explicit.diagnostics.filter((d) => d.code.startsWith("WEB_ROLE_FLAG")).map((d) => [d.code, d.flag]),
    [["WEB_ROLE_FLAG_AS_EXPORTED", "authenticatedusersrole"], ["WEB_ROLE_FLAG_AMBIGUOUS", "anonymoususersrole"]],
  );
});

test("exported special-role flags are kept as exported and unusual assignments are reported", async (t) => {
  // As in Third: two other roles carry the Authenticated Users flag; "Authenticated Users" does not.
  const dir = await temp(t, "pp-role-flags-");
  await write(dir, {
    ...portalFiles,
    "webrole.yml": [
      "- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true\n  adx_authenticatedusersrole: false",
      "- adx_webroleid: customiser\n  adx_name: Portal customiser\n  adx_anonymoususersrole: false\n  adx_authenticatedusersrole: true",
      "- adx_webroleid: webapi\n  adx_name: Web API User\n  adx_anonymoususersrole: false\n  adx_authenticatedusersrole: true",
      "- adx_webroleid: authenticated\n  adx_name: Authenticated Users\n  adx_anonymoususersrole: false\n  adx_authenticatedusersrole: false",
    ].join("\n"),
  });
  const portal = await importPortal(dir);
  const flags = Object.fromEntries(portalWebRoles(portal).map((role) => [role.name, role.authenticated]));
  assert.deepEqual(flags, { "Anonymous Users": false, "Authenticated Users": false, "Portal customiser": true, "Web API User": true });
  const reported = portal.diagnostics.filter((d) => d.code.startsWith("WEB_ROLE_FLAG"));
  assert.deepEqual(
    reported.map(({ code, flag, roles, unflagged }) => ({ code, flag, roles, unflagged })),
    [{ code: "WEB_ROLE_FLAG_AS_EXPORTED", flag: "authenticatedusersrole", roles: ["Portal customiser", "Web API User"], unflagged: ["Authenticated Users"] }],
  );
  assert.match(reported[0].message, /"Portal customiser", "Web API User" as the Authenticated Users role; "Authenticated Users" is not flagged\. The flags are used as exported\./);
});

test("enhanced exports import site languages, column permission profiles and column permissions", async (t) => {
  const xmlText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const component = (id, type, name, content) => [
    `powerpagecomponents/${id}/powerpagecomponent.xml`,
    `<powerpagecomponent powerpagecomponentid="${id}"><content>${xmlText(JSON.stringify(content))}</content><name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>0</statecode></powerpagecomponent>`,
  ];
  const language = (id, name, code, lcid) =>
    `<powerpagesitelanguage powerpagesitelanguageid="${id}"><content>${xmlText(JSON.stringify({ systemlanguage: lcid }))}</content><displayname>${name}</displayname><languagecode>${code}</languagecode><lcid>${lcid}</lcid><name>${name}</name><statecode>0</statecode><statuscode>1</statuscode></powerpagesitelanguage>`;
  const EN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const FR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PROFILE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const dir = await temp(t, "pp-enhanced-site-languages-");
  await write(dir, {
    "Assets/powerpagesites.xml": `<powerpagesites><powerpagesite powerpagesiteid="dddddddd-dddd-4ddd-8ddd-dddddddddddd"><content>${xmlText(JSON.stringify({ defaultlanguage: EN, website_language: 1033 }))}</content><name>Enhanced</name><statecode>0</statecode></powerpagesite></powerpagesites>`,
    "Assets/powerpagesitelanguages.xml": `<powerpagesitelanguages>${language(EN, "English", "en-US", 1033)}${language(FR, "Français (site)", "fr-FR", 1036)}</powerpagesitelanguages>`,
    ...Object.fromEntries([
      component("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", 2, "Home", { partialurl: "/" }),
      component(PROFILE, 28, "Restrict owner", { tablename: "contact", allcolumnpermissions: "746610001", adx_columnpermissionprofile_webrole: [] }),
      component("ffffffff-ffff-4fff-8fff-ffffffffffff", 29, "Owner read", { columnname: "ownerid", columnpermissionprofileid: PROFILE, permissions: "746610001" }),
    ]),
  });
  const portal = await importPortal(dir);
  assert.equal(portal.format, "enhanced");
  // The exported language code wins, also for a name the catalogue does not know.
  assert.deepEqual(
    portal.websiteLanguages.map(({ id, name, code, lcid, isDefault, published }) => ({ id, name, code, lcid, isDefault, published })),
    [
      { id: EN, name: "English", code: "en-US", lcid: 1033, isDefault: true, published: true },
      { id: FR, name: "Français (site)", code: "fr-FR", lcid: 1036, isDefault: false, published: true },
    ],
  );
  assert.equal(portal.language.code, "en-US");
  assert.equal(portal.diagnostics.some((d) => d.code === "WEBSITE_LANGUAGE_CODE_UNKNOWN"), false);
  // Language-code URLs and the sign-in redirect derive from the exported languages.
  const at = (target) => new URL(target, "http://local.invalid");
  assert.equal(languageRoute(portal, at("/fr-FR/")).location, "/");
  assert.equal(deniedPageRoute(portal, at("/secure/"), {}, {}, { origin: "http://127.0.0.1:1" }).location, "http://127.0.0.1:1/en-US/signin?ReturnUrl=%2Fsecure%2F");
  // Column permission profiles (28) and column permissions (29) are typed like the YAML export.
  assert.deepEqual(portal.records.filter((record) => /column/.test(record.kind)).map((record) => record.kind).sort(), ["columnpermission", "columnpermissionprofile"]);
  assert.equal(portal.records.some((record) => record.kind.startsWith("component:")), false);
});

test("record order is stable with concurrent directory and file reads", async (t) => {
  const dir = await temp(t, "pp-import-order-");
  const files = { ...portalFiles };
  for (let index = 0; index < 40; index++)
    files[`content-snippets/group-${index % 4}/nested-${index}/Snippet-${index}.contentsnippet.yml`] = `adx_contentsnippetid: snippet-${index}\nadx_name: Shared\nadx_value: v${index}`;
  await write(dir, files);
  const portal = await importPortal(dir);
  const order = portal.records.filter((r) => r.kind === "contentsnippet").map((r) => r.id);
  // The sequential depth-first readdir order of the original importer; the last read wins.
  const expected = [];
  const visit = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.contentsnippet\.yml$/.test(entry.name)) expected.push(/snippet-\d+/.exec(await fs.readFile(file, "utf8"))[0]);
    }
  };
  await visit(path.join(dir, "content-snippets"));
  assert.deepEqual(order, expected);
  assert.equal(portal.snippets.Shared, "v" + expected.at(-1).slice(8));
});

test("initial bootstrap uses solution identities, documented system tables and reports missing definitions", async (t) => {
  const dir = await temp(t, "pp-bootstrap-");
  const solutions = await temp(t, "pp-bootstrap-solutions-");
  await write(dir, portalFiles);
  await write(solutions, { "Entities/sample_item/Entity.xml": entity("sample_itemrecords") });
  const portal = await importPortal(dir);
  const metadata = await importSolutionData([solutions]);
  const state = initialState(portal, { metadata });
  assert.equal(state.mappings.sample_item.entitySet, "sample_itemrecords");
  assert.equal(state.mappings.sample_item.idColumn, "sample_itemid");
  assert.equal(state.mappings.sample_item.fieldMetadata, undefined);
  assert.deepEqual([state.mappings.category.entitySet, state.mappings.category.entitySetSource], ["categories", "dataverse-reference"]);
  assert.ok(state.simulator.importDiagnostics.some((d) => d.code === "TABLE_METADATA_MISSING" && d.entity === "category"));
  const plain = initialState(portal);
  assert.equal(plain.mappings.sample_item.entitySet, "sample_items");
  assert.ok(!plain.simulator.importDiagnostics.some((d) => d.code === "TABLE_METADATA_MISSING"));
});

test("a running runtime reloads solution changes, recompiles metadata and reports the project and bootstrap", async (t) => {
  const dir = await temp(t, "pp-reload-");
  // Keep the spelling os.tmpdir() gives (possibly a Windows 8.3 short path): the watcher
  // reports paths in this spelling while scanned layers use real paths.
  const solutions = await fs.mkdtemp(path.join(os.tmpdir(), "pp-reload-solutions-"));
  t.after(() => fs.rm(solutions, { recursive: true, force: true }));
  await write(dir, portalFiles);
  await write(solutions, { "Other/Solution.xml": "<ImportExportXml><SolutionManifest><UniqueName>Reload</UniqueName></SolutionManifest></ImportExportXml>", "Entities/sample_item/Entity.xml": entity("sample_itemrecords") });
  const project = { configFile: "mirage.project.yml", portals: [{ id: "site", sourceDir: dir }], solutions: [{ id: "base", root: solutions }], references: [], dataPacks: [] };
  const stateDir = await temp(t, "pp-reload-state-");
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(stateDir, "state.json"), port: 0, watch: true, solutionRoots: [solutions], project, environmentVariables: {} });
  t.after(() => app.close());
  const state = async () => (await fetch(app.url + "/__sim/api/state")).json();
  const before = await state();
  assert.equal(before.status.project.configFile, "mirage.project.yml");
  assert.deepEqual(before.status.bootstrap.layers.map((layer) => layer.dir), [await fs.realpath(solutions)]);
  assert.ok(before.status.bootstrap.timings.startupMs >= 0);
  const mapping = (snapshot) => snapshot.config.mappings.find((m) => m.logicalName === "sample_item");
  assert.equal(mapping(before).entitySet, "sample_itemrecords");
  assert.equal(mapping(before).schemaComplete, true);
  assert.equal(mapping(before).fieldMetadata.sample_name.maxLength, 100);
  await fs.access(path.join(stateDir, "cache", "solution-sources.json"));
  // Change the solution layer on disk; the watcher reloads and recompiles.
  await write(solutions, { "Entities/sample_item/Entity.xml": entity("sample_itemrows", '<attribute PhysicalName="sample_code"><Type>nvarchar</Type><LogicalName>sample_code</LogicalName><MaxLength>12</MaxLength></attribute>') });
  let after;
  // A reload is complete once it records its SOURCES_RELOADED diagnostic.
  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = await state();
    if (after.diagnostics.some((d) => d.code === "SOURCES_RELOADED") && mapping(after).entitySet === "sample_itemrows") break;
  }
  assert.equal(mapping(after).entitySet, "sample_itemrows");
  assert.equal(mapping(after).fieldMetadata.sample_code.maxLength, 12);
  assert.notEqual(after.status.sourceFingerprint, before.status.sourceFingerprint);
  assert.ok(after.status.revision > before.status.revision);
  assert.ok(after.diagnostics.some((d) => d.code === "SOURCES_RELOADED" && d.changed.some((file) => /Entity\.xml$/.test(file))));
  assert.equal((await fetch(app.url + "/_api/sample_itemrows?$select=sample_name")).status, 403);
});

test("the bootstrap report summarizes tables, grants, routing records and the /_api oracle", async (t) => {
  const dir = await temp(t, "pp-report-");
  const solutions = await temp(t, "pp-report-solutions-");
  await write(dir, { ...portalFiles, "web-files/app.js.webfile.yml": "adx_webfileid: app\nadx_name: app.js\nadx_partialurl: app.js\nadx_parentpageid: home", "web-files/app.js": "fetch('/_api/sample_itemrecords?$top=1'); fetch('/_api/missingsets'); fetch('/_api/cloudflow/v1.0/trigger/x');" });
  await write(solutions, { "Entities/sample_item/Entity.xml": entity("sample_itemrecords") });
  const report = await bootstrapReport({ label: "fixture", sourceDir: dir, solutionRoots: [solutions], order: "explicit", environmentVariables: {}, lcid: 1033 }, { noCache: true });
  assert.equal(report.summary.tables >= 1, true);
  assert.deepEqual(report.apiOracle.map((entry) => [entry.entitySet, entry.status]), [["cloudflow", "non-table-endpoint"], ["missingsets", "unresolved"], ["sample_itemrecords", "resolved"]]);
  assert.equal(report.permissions.exported.enabled, 1);
  assert.equal(report.summary.redirects, 1);
  assert.equal(report.summary.urlHistory, 1);
  assert.deepEqual(report.portalTablesWithoutDefinition.map((t) => t.logicalName), ["category"]);
  assert.equal(report.tables.find((t) => t.logicalName === "sample_item").fields.sample_name.maxLength, 100);
  assert.ok(report.diagnostics.some((d) => d.code === "TABLE_METADATA_MISSING"));
});

test("form and view changes in a solution layer reach the next rendered page after a reload", async (t) => {
  const dir = await temp(t, "pp-reload-form-");
  const solutions = await temp(t, "pp-reload-form-solutions-");
  const form = (text) =>
    `<forms><systemform><formid>{11111111-1111-1111-1111-111111111111}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><columns><column width="100%"><sections><section name="main"><rows><row><cell><labels><label description="${text}" languagecode="1033"/></labels><control id="sample_name" datafieldname="sample_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Portal item" languagecode="1033"/></LocalizedNames></systemform></forms>`;
  await write(dir, {
    ...portalFiles,
    "web-templates/Main.webtemplate.source.html": "<!doctype html><html><head><title>Home</title></head><body>{% entityform name: 'Item form' %}</body></html>",
    "basic-forms/item-form/Item-form.basicform.yml": "adx_entityformid: item-form\nadx_name: Item form\nadx_entityname: sample_item\nadx_formname: Portal item\nadx_mode: 100000000",
  });
  await write(solutions, {
    "Entities/sample_item/Entity.xml": entity("sample_itemrecords"),
    "Entities/sample_item/FormXml/main/{11111111-1111-1111-1111-111111111111}.xml": form("Name label v1"),
  });
  const stateDir = await temp(t, "pp-reload-form-state-");
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(stateDir, "state.json"), port: 0, watch: false, solutionRoots: [solutions] });
  t.after(() => app.close());
  assert.match(await (await fetch(app.url + "/")).text(), /Name label v1/);
  await write(solutions, { "Entities/sample_item/FormXml/main/{11111111-1111-1111-1111-111111111111}.xml": form("Name label v2") });
  await app.reload();
  const html = await (await fetch(app.url + "/")).text();
  assert.match(html, /Name label v2/);
  assert.doesNotMatch(html, /Name label v1/);
});

test("differing copies of a record: the file named after the record, else the newest commit, else the newest file", async (t) => {
  // Second exports its Header web template twice; the copy in Header.webtemplate.yml is the one in use.
  const named = await temp(t, "pp-import-dup-named-");
  await write(named, {
    ...portalFiles,
    "web-templates/Header-old.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header\nadx_mimetype: text/html",
    "web-templates/Header-old.webtemplate.source.html": "<header>old</header>",
    "web-templates/Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
    "web-templates/Header.webtemplate.source.html": "<header>current</header>",
  });
  const byName = await importPortal(named);
  const header = byName.records.filter((record) => record.kind === "webtemplate" && record.id === "header");
  assert.deepEqual(header.map((record) => path.basename(record._file)), ["Header.webtemplate.yml"]);
  const resolved = byName.diagnostics.find((d) => d.code === "DUPLICATE_RECORD_RESOLVED" && d.id === "header");
  assert.deepEqual([path.basename(resolved.file), path.basename(resolved.usedFile), resolved.reason], ["Header-old.webtemplate.yml", "Header.webtemplate.yml", "its file name matches the record name"]);
  assert.ok(resolved.message.includes(`the copy in ${resolved.usedFile} is used`));
  // Neither file is named after the record: the most recently modified file (outside Git).
  const timed = await temp(t, "pp-import-dup-mtime-");
  await write(timed, {
    ...portalFiles,
    "web-templates/Footer-a.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer\nadx_mimetype: text/html",
    "web-templates/Footer-b.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
  });
  await fs.utimes(path.join(timed, "web-templates/Footer-a.webtemplate.yml"), new Date("2025-06-01T00:00:00Z"), new Date("2025-06-01T00:00:00Z"));
  await fs.utimes(path.join(timed, "web-templates/Footer-b.webtemplate.yml"), new Date("2024-06-01T00:00:00Z"), new Date("2024-06-01T00:00:00Z"));
  const byTime = await importPortal(timed);
  assert.deepEqual(byTime.records.filter((record) => record.id === "footer").map((record) => path.basename(record._file)), ["Footer-a.webtemplate.yml"]);
  assert.equal(byTime.diagnostics.find((d) => d.code === "DUPLICATE_RECORD_RESOLVED" && d.id === "footer").reason, "its file was modified most recently");
  // Commit times decide before modification times; ties fall through to export order.
  const copies = [
    { kind: "webtemplate", id: "x", name: "X", _file: path.join(timed, "One.webtemplate.yml") },
    { kind: "webtemplate", id: "x", name: "X", _file: path.join(timed, "Two.webtemplate.yml") },
  ];
  const commits = { "One.webtemplate.yml": 1700000000000, "Two.webtemplate.yml": 1800000000000 };
  const committed = await chooseRecordCopy(copies, { commitTime: async (file) => commits[path.basename(file)] });
  assert.deepEqual([committed.record, committed.reason], [copies[1], "its file was committed most recently"]);
  const tie = await chooseRecordCopy(copies, { commitTime: async () => 1700000000000 });
  assert.deepEqual([tie.record, tie.reason], [copies[0], "it is the first copy in export order"]);
  const partlyUnknown = await chooseRecordCopy(copies, { commitTime: async (file) => (file.endsWith("Two.webtemplate.yml") ? 1800000000000 : null) });
  assert.equal(partlyUnknown.reason, "it is the first copy in export order");
});

test("same-name web link sets stay reachable by ID; the name lookup takes the first active set", async (t) => {
  const dir = await temp(t, "pp-import-weblinks-");
  await write(dir, {
    ...portalFiles,
    // Third exports three active sets named "Default"; the header template uses one by ID.
    "weblink-sets/Default/Default.weblinkset.yml": "- adx_weblinksetid: set-a\n  adx_name: Default\n- adx_weblinksetid: set-b\n  adx_name: Default\n- adx_weblinksetid: set-c\n  adx_name: Footer\n  statecode: 1",
    "weblink-sets/Default/Default.weblink.yml": "- adx_weblinkid: link-a\n  adx_name: Home A\n  adx_weblinksetid: set-a\n  adx_pageid: home\n- adx_weblinkid: link-b\n  adx_name: Home B\n  adx_weblinksetid: set-b\n  adx_pageid: home",
  });
  const portal = await importPortal(dir);
  assert.deepEqual(portal.weblinkSets.map((set) => [set.id, set.name, set.weblinks.map((link) => link.name)]), [["set-a", "Default", ["Home A"]], ["set-b", "Default", ["Home B"]]]);
  assert.equal(portal.weblinks.Default.id, "set-a");
  assert.equal(portal.weblinks.Footer, undefined);
  assert.deepEqual(portal.diagnostics.filter((d) => d.code === "WEBLINK_SET_NAME_SHARED").map((d) => [d.name, d.id, d.usedId]), [["Default", "set-b", "set-a"]]);
});

test("one URL claimed by several pages or web files is reported; parentless web files keep their partial URL", async (t) => {
  const dir = await temp(t, "pp-import-claims-");
  await write(dir, {
    ...portalFiles,
    "web-pages/dup/Dup.webpage.yml": "- adx_webpageid: dupa\n  adx_name: Dup A\n  adx_partialurl: dup\n  adx_parentpageid: home\n  adx_pagetemplateid: main\n- adx_webpageid: dupb\n  adx_name: Dup B\n  adx_partialurl: DUP\n  adx_parentpageid: home\n  adx_pagetemplateid: main",
    "web-files/site.css.webfile.yml": "- adx_webfileid: css-a\n  adx_name: site.css\n  adx_partialurl: site.css\n  adx_parentpageid: home\n- adx_webfileid: css-b\n  adx_name: site copy\n  adx_partialurl: site.css\n  adx_parentpageid: home",
    "web-files/site.css": "body { color: teal; }",
    // Example: a parentless web file whose partial URL starts with "//" (not an authority).
    "web-files/config.json.webfile.yml": "adx_webfileid: rte\nadx_name: config.json\nadx_partialurl: //RTE/config.json",
    "web-files/config.json": "{}",
  });
  const portal = await importPortal(dir);
  const claims = portal.diagnostics.filter((d) => d.code === "URL_CLAIMED_TWICE");
  assert.deepEqual(claims.map((d) => [d.kind, d.path, d.usedId, d.claimants.map((claimant) => claimant.id)]), [["webpage", "/dup", "dupa", ["dupa", "dupb"]], ["webfile", "/site.css", "css-a", ["css-a", "css-b"]]]);
  // IDs that are not GUIDs keep export order.
  assert.deepEqual(claims.map((d) => d.rule), ["export-order", "export-order"]);
  assert.ok(claims[0].message.includes("'Dup A' is served (first in export order)"));
  // GUID IDs: the first in SQL Server uniqueidentifier order is served, as Second sandbox
  // serves the restricted page (bca7581a-...-000d3aaa03a2) of the two claiming
  // /alternative-therapies/, though the other (fa65ade2-...-27887390aa0a) is exported first.
  const ordered = await temp(t, "pp-import-claims-guid-");
  await write(ordered, {
    ...portalFiles,
    "web-pages/alt/Alt.webpage.yml": "- adx_webpageid: fa65ade2-8125-69c9-2317-27887390aa0a\n  adx_name: Alternative public\n  adx_partialurl: alternative-therapies\n  adx_parentpageid: home\n  adx_pagetemplateid: main\n- adx_webpageid: bca7581a-3f1a-ee11-8f6d-000d3aaa03a2\n  adx_name: Alternative restricted\n  adx_partialurl: alternative-therapies\n  adx_parentpageid: home\n  adx_pagetemplateid: main",
  });
  const byId = await importPortal(ordered);
  const claim = byId.diagnostics.find((d) => d.code === "URL_CLAIMED_TWICE");
  assert.deepEqual([claim.rule, claim.usedId, claim.claimants.map((claimant) => claimant.name)], ["id-order", "bca7581a-3f1a-ee11-8f6d-000d3aaa03a2", ["Alternative public", "Alternative restricted"]]);
  assert.equal(byId.pages.find((page) => normalizePortalPath(page.url) === "/alternative-therapies").name, "Alternative restricted");
  assert.ok(guidOrderKey("bca7581a-3f1a-ee11-8f6d-000d3aaa03a2") < guidOrderKey("fa65ade2-8125-69c9-2317-27887390aa0a"));
  // Web files: the LAST in ID order is served, as Sample sandbox serves /favicon.ico from
  // 17197785-…-7c1e52266593 (image/svg+xml) rather than acbcf3df-…-0050f2811e07.
  const files = await temp(t, "pp-import-claims-files-");
  await write(files, {
    ...portalFiles,
    "web-files/favicon.ico.webfile.yml": "- adx_webfileid: acbcf3df-37af-eb11-89ee-0050f2811e07\n  adx_name: images/Forms_favicon.ico\n  adx_partialurl: favicon.ico\n  adx_parentpageid: home\n  mimetype: image/x-icon\n- adx_webfileid: 17197785-6341-f011-877a-7c1e52266593\n  adx_name: favicon.ico\n  adx_partialurl: favicon.ico\n  adx_parentpageid: home\n  mimetype: image/svg+xml",
    "web-files/favicon.ico": "<svg/>",
  });
  const byFileId = await importPortal(files);
  const fileClaim = byFileId.diagnostics.find((d) => d.code === "URL_CLAIMED_TWICE" && d.kind === "webfile");
  assert.deepEqual([fileClaim.rule, fileClaim.usedId], ["id-order-last", "17197785-6341-f011-877a-7c1e52266593"]);
  assert.ok(fileClaim.message.includes("'favicon.ico' is served (last in Dataverse ID order)"));
  const served = byFileId.webFiles.find((file) => normalizePortalPath(file.url) === "/favicon.ico");
  assert.deepEqual([served.id, served.mimeType], ["17197785-6341-f011-877a-7c1e52266593", "image/svg+xml"]);
  // SqlGuid order: the last group decides first; the first group is compared byte-swapped.
  assert.ok(guidOrderKey("ffffffff-ffff-ffff-ffff-000000000000") < guidOrderKey("00000000-0000-0000-0000-000000000001"));
  assert.ok(guidOrderKey("01000000-0000-0000-0000-000000000000") < guidOrderKey("00000001-0000-0000-0000-000000000000"));
  assert.equal(guidOrderKey("dupa"), null);
  assert.equal(portal.webFiles.find((file) => file.id === "rte").url, "/RTE/config.json");
  assert.equal(normalizePortalPath("//RTE/config.json"), "/rte/config.json");
  assert.equal(normalizePortalPath("//evil.example/"), "/evil.example");
});

test("enhanced content pages and snippets take their language from <powerpagesitelanguageid>", async (t) => {
  const xmlText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Exports nest the lookup value in an element of the same name, outside <content>.
  const language = (id) => `<powerpagesitelanguageid><powerpagesitelanguageid>${id}</powerpagesitelanguageid></powerpagesitelanguageid>`;
  const component = (id, type, name, content, extra = "") => [
    `powerpagecomponents/${id}/powerpagecomponent.xml`,
    `<powerpagecomponent powerpagecomponentid="${id}"><content>${xmlText(JSON.stringify(content))}</content><name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype>${extra}<statecode>0</statecode></powerpagecomponent>`,
  ];
  const siteLanguage = (id, name, code, lcid) =>
    `<powerpagesitelanguage powerpagesitelanguageid="${id}"><content>{}</content><name>${name}</name><languagecode>${code}</languagecode><lcid>${lcid}</lcid><statecode>0</statecode></powerpagesitelanguage>`;
  const dir = await temp(t, "pp-enhanced-content-languages-");
  await write(dir, {
    "Assets/powerpagesites.xml": `<powerpagesites><powerpagesite powerpagesiteid="site"><content>${xmlText(JSON.stringify({ defaultlanguage: "lang-en", website_language: 1033 }))}</content><name>Two languages</name></powerpagesite></powerpagesites>`,
    "Assets/powerpagesitelanguages.xml": `<powerpagesitelanguages>${siteLanguage("lang-en", "English", "en-US", 1033)}${siteLanguage("lang-fr", "French", "fr-FR", 1036)}</powerpagesitelanguages>`,
    ...Object.fromEntries([
      component("aaa-home", 2, "Home", { isroot: true, partialurl: "/" }),
      // Directory order puts the French copy first.
      component("bbb-home-fr", 2, "Home", { isroot: false, rootwebpageid: "aaa-home", copy: "<p>Bonjour</p>" }, language("lang-fr")),
      component("ccc-home-en", 2, "Home", { isroot: false, rootwebpageid: "aaa-home", copy: "<p>Hello</p>" }, language("lang-en")),
      component("ddd-snippet-fr", 7, "Greeting", { value: "Bonjour" }, language("lang-fr")),
      component("eee-snippet-en", 7, "Greeting", { value: "Hello" }, language("lang-en")),
      component("fff-redirect", 30, "Old home", { inboundurl: "old-home", webpageid: "aaa-home", statuscode: 301 }),
    ]),
  });
  const english = await importPortal(dir);
  assert.equal(english.pages.find((page) => page.url === "/").html, "<p>Hello</p>");
  assert.equal(english.snippets.Greeting, "Hello");
  const copy = english.records.find((record) => record.id === "ccc-home-en");
  assert.deepEqual([copy.powerpagecomponenttype, copy.powerpagesitelanguageid, copy.webpagelanguageid], [2, "lang-en", "lang-en"]);
  assert.equal(english.records.find((record) => record.id === "eee-snippet-en").contentsnippetlanguageid, "lang-en");
  assert.deepEqual(english.redirects.map((redirect) => [redirect.inboundUrl, redirect.statusCode, redirect.webPageId]), [["old-home", 301, "aaa-home"]]);
  const french = await importPortal(dir, { languageId: "lang-fr" });
  assert.equal(french.language.code, "fr-FR");
  assert.equal(french.pages.find((page) => page.url === "/").html, "<p>Bonjour</p>");
  assert.equal(french.snippets.Greeting, "Bonjour");
});

test("runtime and bootstrap report layer listed solution roots in derived order unless explicit order is requested", async (t) => {
  const dir = await temp(t, "pp-order-");
  await write(dir, portalFiles);
  const solutions = await temp(t, "pp-order-solutions-");
  const manifest = (name) => `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName></SolutionManifest></ImportExportXml>`;
  await write(solutions, {
    "Feature/Other/Solution.xml": manifest("Feature"),
    "Feature/Entities/sample_item/Entity.xml": '<Entity><Name>sample_item</Name><EntityInfo><entity Name="sample_item"><attributes><attribute PhysicalName="sample_extra"><Type>nvarchar</Type><LogicalName>sample_extra</LogicalName></attribute></attributes></entity></EntityInfo></Entity>',
    "Core/Other/Solution.xml": manifest("Core"),
    "Core/Entities/sample_item/Entity.xml": entity("sample_items"),
  });
  // Listed extension-first, as a user may list them.
  const roots = [path.join(solutions, "Feature"), path.join(solutions, "Core")];
  const runtimeLayers = async (options) => {
    const stateDir = await temp(t, "pp-order-state-");
    const app = await createSimulator({ sourceDir: dir, stateFile: path.join(stateDir, "state.json"), port: 0, watch: false, solutionRoots: roots, environmentVariables: {}, ...options });
    try {
      const { status } = await (await fetch(app.url + "/__sim/api/state")).json();
      return [status.bootstrap.solutionOrder, status.bootstrap.layers.map((layer) => layer.solution)];
    } finally {
      await app.close();
    }
  };
  assert.deepEqual(await runtimeLayers({}), ["derived", ["Core", "Feature"]]);
  assert.deepEqual(await runtimeLayers({ solutionOrder: "explicit" }), ["explicit", ["Feature", "Core"]]);
  // bootstrap-report resolves the same inputs as serve (--solution-root, --solution-order).
  const inputs = await resolveReportInputs({ source: dir, "solution-root": roots });
  assert.deepEqual([inputs.order, inputs.rootSource, inputs.discovered], ["derived", "cli", false]);
  const report = await bootstrapReport(inputs, { noCache: true });
  assert.deepEqual([report.inputs.rootOrder, report.inputs.rootSource], ["derived", "cli"]);
  assert.deepEqual(report.inputs.layers.map((layer) => layer.solution), ["Core", "Feature"]);
  const explicit = await resolveReportInputs({ source: dir, "solution-root": roots, "solution-order": "explicit" });
  assert.deepEqual((await bootstrapReport(explicit, { noCache: true })).inputs.layers.map((layer) => layer.solution), ["Feature", "Core"]);
});

test("duplicate-copy commit lookups are cached by file and content, asked again on change or another HEAD", async (t) => {
  const dir = await temp(t, "pp-import-git-cache-");
  await write(dir, {
    ...portalFiles,
    "web-templates/Footer-a.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer\nadx_mimetype: text/html",
    "web-templates/Footer-b.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
  });
  const cacheFile = path.join(await temp(t, "pp-import-git-cache-state-"), "cache", "portal-sources.json");
  const asked = [];
  let head = "a".repeat(40);
  const times = { "Footer-a.webtemplate.yml": 1_700_000_000_000, "Footer-b.webtemplate.yml": 1_800_000_000_000 };
  const git = {
    head: async () => head,
    commitTime: async (file) => {
      asked.push(path.basename(file));
      return times[path.basename(file)];
    },
  };
  const resolve = async () => {
    const cache = await SolutionFileCache.open(cacheFile);
    const portal = await importPortal(dir, { cache, git });
    await cache.save();
    asked.sort();
    return portal.diagnostics.find((d) => d.code === "DUPLICATE_RECORD_RESOLVED" && d.id === "footer");
  };
  const first = await resolve();
  assert.deepEqual([path.basename(first.usedFile), first.reason], ["Footer-b.webtemplate.yml", "its file was committed most recently"]);
  assert.deepEqual(asked, ["Footer-a.webtemplate.yml", "Footer-b.webtemplate.yml"]);
  // A restart with unchanged files asks git nothing.
  asked.length = 0;
  assert.equal(path.basename((await resolve()).usedFile), "Footer-b.webtemplate.yml");
  assert.deepEqual(asked, []);
  // A new modification time with the same content keeps the cached time.
  const footerA = path.join(dir, "web-templates/Footer-a.webtemplate.yml");
  await fs.utimes(footerA, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
  await resolve();
  assert.deepEqual(asked, []);
  // Changed content is asked again.
  await fs.writeFile(footerA, "adx_webtemplateid: footer\nadx_name: Footer\nadx_mimetype: text/plain");
  times["Footer-a.webtemplate.yml"] = 1_900_000_000_000;
  assert.equal(path.basename((await resolve()).usedFile), "Footer-a.webtemplate.yml");
  assert.deepEqual(asked, ["Footer-a.webtemplate.yml"]);
  // Another checked-out commit asks again for every copy.
  asked.length = 0;
  head = "b".repeat(40);
  await resolve();
  assert.deepEqual(asked, ["Footer-a.webtemplate.yml", "Footer-b.webtemplate.yml"]);
  // Outside a git checkout nothing is asked and modification times decide.
  asked.length = 0;
  head = null;
  assert.equal((await resolve()).reason, "its file was modified most recently");
  assert.deepEqual(asked, []);
});
