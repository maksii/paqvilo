import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPortal } from "../lib/importer.mjs";
import {
  COMPONENT_TYPES,
  componentRequests,
  pageComponentKinds,
  classifyMissingIncludes,
  compareImport,
  censusSummary,
  exportCensus,
  formatMatrix,
  matrixProblems,
  parseArgs,
  portalMatrix,
} from "../portal-matrix.mjs";

async function tree(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portal-matrix-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}

const ROLE_AUTHENTICATED = "0f1a2b3c-0000-4000-8000-000000000001";
const ROLE_ANONYMOUS = "0f1a2b3c-0000-4000-8000-000000000002";
/** PAC standard layout: active, inactive, orphaned and duplicated records of the modelled kinds. */
const standardExport = {
  "website.yml": "adx_websiteid: site\nadx_name: Standard\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer\nadx_defaultlanguage: english",
  "websitelanguage.yml": "- adx_websitelanguageid: english\n  adx_name: English\n",
  "webrole.yml": [
    `- adx_webroleid: ${ROLE_AUTHENTICATED}`,
    "  adx_name: Authenticated Users",
    "  adx_authenticatedusersrole: true",
    "  adx_anonymoususersrole: false",
    `- adx_webroleid: ${ROLE_ANONYMOUS}`,
    "  adx_name: Anonymous Users",
    "  adx_authenticatedusersrole: false",
    "  adx_anonymoususersrole: true",
    "",
  ].join("\n"),
  "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: main",
  "web-pages/work/Work.webpage.yml": "adx_webpageid: work\nadx_name: Work\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: work\nadx_pagetemplateid: main",
  "web-pages/work/content-pages/Work.en-US.webpage.yml":
    "adx_webpageid: work-en\nadx_name: Work\nadx_isroot: false\nadx_rootwebpageid: work\nadx_webpagelanguageid: english\nadx_partialurl: work",
  "web-pages/work/content-pages/Work.en-US.webpage.copy.html": "<p>{{ snippets['Label'] }}</p>",
  "web-pages/orphan/Orphan.webpage.yml": "adx_webpageid: orphan\nadx_name: Orphan\nadx_isroot: true\nadx_parentpageid: missing-parent\nadx_partialurl: orphan\nadx_pagetemplateid: main",
  "web-pages/retired/Retired.webpage.yml": "adx_webpageid: retired\nadx_name: Retired\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: retired\nadx_pagetemplateid: main\nstatecode: 1\nstatuscode: 2",
  "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_name: Main\nadx_usewebsiteheaderandfooter: true\nadx_webtemplateid: content",
  "web-templates/header/Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
  "web-templates/header/Header.webtemplate.source.html": "<header>{{ snippets['Greeting'] }}</header>",
  "web-templates/footer/Footer.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
  "web-templates/footer/Footer.webtemplate.source.html": "<footer>{% include 'Absent Template' %}{% include 'Old' %}</footer>",
  "web-templates/content/Content.webtemplate.yml": "adx_webtemplateid: content\nadx_name: Content",
  "web-templates/content/Content.webtemplate.source.html": "{% include 'Page Copy' %}",
  "web-templates/old/Old.webtemplate.yml": "adx_webtemplateid: old\nadx_name: Old\nstatecode: 1",
  "web-templates/old/Old.webtemplate.source.html": "<p>old</p>",
  "content-snippets/greeting/Greeting.contentsnippet.yml": "adx_contentsnippetid: greeting\nadx_name: Greeting",
  "content-snippets/greeting/Greeting.contentsnippet.value.html": "Hello",
  "content-snippets/label/Label.en-US.contentsnippet.yml": "adx_contentsnippetid: label-en\nadx_name: Label\nadx_contentsnippetlanguageid: english",
  "content-snippets/label/Label.en-US.contentsnippet.value.html": "Label",
  "content-snippets/label/Label.fr-FR.contentsnippet.yml": "adx_contentsnippetid: label-fr\nadx_name: Label\nadx_contentsnippetlanguageid: french",
  "content-snippets/label/Label.fr-FR.contentsnippet.value.html": "Libellé",
  "sitesetting.yml": [
    "- adx_sitesettingid: s1",
    "  adx_name: Search/Enabled",
    "  adx_value: 'false'",
    "- adx_sitesettingid: s2",
    "  adx_name: Search/Enabled",
    "  adx_value: 'true'",
    "- adx_sitesettingid: s3",
    "  adx_name: Retired/Setting",
    "  adx_value: x",
    "  statecode: 1",
    "- adx_sitesettingid: s4",
    "  adx_name: Webapi/contact/enabled",
    "  adx_value: 'true'",
    "- adx_sitesettingid: s5",
    "  adx_name: Webapi/contact/fields",
    "  adx_value: contactid,fullname",
    "",
  ].join("\n"),
  "web-files/app.js.webfile.yml": "adx_webfileid: app\nadx_name: app.js\nadx_partialurl: app.js\nadx_parentpageid: home\nfilename: app.js",
  "web-files/app.js": "window.app = 1;",
  "web-files/missing.js.webfile.yml": "adx_webfileid: missing\nadx_name: missing.js\nadx_partialurl: missing.js\nadx_parentpageid: home\nfilename: missing.js",
  "weblink-sets/primary-a/Primary-a.en-US.weblinkset.yml": "adx_weblinksetid: set-a\nadx_name: Primary",
  "weblink-sets/primary-a/Primary-a.en-US.weblinkset.weblink.yml": [
    "- adx_weblinkid: link-a1",
    "  adx_name: A1",
    "  adx_weblinksetid: set-a",
    "  adx_pageid: home",
    "- adx_weblinkid: link-a2",
    "  adx_name: A2",
    "  adx_weblinksetid: set-a",
    "  adx_pageid: work",
    "",
  ].join("\n"),
  "weblink-sets/primary-b/Primary-b.en-US.weblinkset.yml": "adx_weblinksetid: set-b\nadx_name: Primary",
  "weblink-sets/primary-b/Primary-b.en-US.weblinkset.weblink.yml": "- adx_weblinkid: link-b1\n  adx_name: B1\n  adx_weblinksetid: set-b\n  adx_pageid: home\n",
  "redirect.yml": "- adx_redirectid: r1\n  adx_name: Old home\n  adx_inboundurl: old-home\n  adx_webpageid: home\n",
  "urlhistory.yml": "- adx_urlhistoryid: u1\n  adx_name: /previous-work/\n  adx_webpageid: work\n",
  "polls/poll/Poll.poll.yml": "adx_pollid: poll\nadx_name: Poll",
  // Restrict Read on /work/ for Authenticated Users: anonymous visitors are sent to sign-in.
  "webpagerule.yml": [
    "- adx_webpageaccesscontrolruleid: work-rule",
    "  adx_name: Work restricted",
    "  adx_webpageid: work",
    "  adx_right: 2",
    "  adx_scope: 1",
    "  adx_webpageaccesscontrolrule_webrole:",
    `  - ${ROLE_AUTHENTICATED}`,
    "",
  ].join("\n"),
  "table-permissions/contact.tablepermission.yml": [
    "adx_entitypermissionid: contact-read",
    "adx_entityname: Contacts",
    "adx_entitylogicalname: contact",
    "adx_scope: 756150000",
    "adx_read: true",
    "adx_entitypermission_webrole:",
    `- ${ROLE_AUTHENTICATED}`,
    "",
  ].join("\n"),
};

function component(id, type, name, content, extra = "", statecode = 0) {
  const encode = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<powerpagecomponent powerpagecomponentid="${id}"><content>${encode(JSON.stringify(content))}</content><name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype>${extra}<statecode>${statecode}</statecode></powerpagecomponent>`;
}
const LANGUAGE = "<powerpagesitelanguageid><powerpagesitelanguageid>lang-en</powerpagesitelanguageid></powerpagesitelanguageid>";
/** Enhanced data model layout: documented component types, site and site-language assets. */
const enhancedExport = {
  "Assets/powerpagesites.xml":
    '<powerpagesites><powerpagesite powerpagesiteid="enhanced-site"><content>{"defaultlanguage":"lang-en","website_language":1033}</content><name>Enhanced</name><statecode>0</statecode></powerpagesite></powerpagesites>',
  "Assets/powerpagesitelanguages.xml":
    '<powerpagesitelanguages><powerpagesitelanguage powerpagesitelanguageid="lang-en"><content>{"systemlanguage":1033}</content><name>English</name><languagecode>en-US</languagecode><statecode>0</statecode></powerpagesitelanguage></powerpagesitelanguages>',
  "powerpagecomponents/home/powerpagecomponent.xml": component("home", 2, "Home", { isroot: true, partialurl: "/", pagetemplateid: "main" }),
  "powerpagecomponents/home-en/powerpagecomponent.xml": component("home-en", 2, "Home", { isroot: false, rootwebpageid: "home", partialurl: "/", copy: "<p>Welcome {{ user.fullname }}</p>" }, LANGUAGE),
  "powerpagecomponents/main/powerpagecomponent.xml": component("main", 6, "Main", { webtemplateid: "layout", usewebsiteheaderandfooter: false }),
  "powerpagecomponents/layout/powerpagecomponent.xml": component("layout", 8, "Layout", { source: "<main>{% include 'Page Copy' %}</main>" }),
  "powerpagecomponents/role-auth/powerpagecomponent.xml": component(ROLE_AUTHENTICATED, 11, "Authenticated Users", { authenticatedusersrole: true, anonymoususersrole: false }),
  "powerpagecomponents/role-anon/powerpagecomponent.xml": component(ROLE_ANONYMOUS, 11, "Anonymous Users", { authenticatedusersrole: false, anonymoususersrole: true }),
  "powerpagecomponents/redirect/powerpagecomponent.xml": component("redirect", 30, "Old home", { inboundurl: "old-home", webpageid: "home", statuscode: 301 }),
  "powerpagecomponents/profile/powerpagecomponent.xml": component("profile", 28, "Contact columns", { tablename: "contact", allcolumnpermissions: "746610001", adx_columnpermissionprofile_webrole: [ROLE_AUTHENTICATED] }),
  "powerpagecomponents/permission/powerpagecomponent.xml": component("permission", 18, "Contacts", { entitylogicalname: "contact", entityname: "Contacts", scope: 756150000, read: true, adx_entitypermission_webrole: [ROLE_AUTHENTICATED] }),
  "powerpagecomponents/setting/powerpagecomponent.xml": component("setting", 9, "Webapi/contact/enabled", { value: "true" }),
  "powerpagecomponents/fields/powerpagecomponent.xml": component("fields", 9, "Webapi/contact/fields", { value: "contactid,fullname" }),
  "powerpagecomponents/file/powerpagecomponent.xml": component("file", 3, "app.js", { partialurl: "app.js", parentpageid: "home" }, '<filecontent mimetype="application/javascript">app.js</filecontent>'),
  "powerpagecomponents/file/filecontent/app.js": "window.enhanced = 1;",
  "powerpagecomponents/retired/powerpagecomponent.xml": component("retired", 8, "Retired", { source: "x" }, "", 1),
};

test("census counts standard export records by kind, state, name and attachment without the importer", async (t) => {
  const census = await exportCensus(await tree(t, standardExport));
  assert.equal(census.format, "standard");
  assert.deepEqual(census.pages.roots, { total: 4, active: 3 });
  assert.deepEqual(census.pages.content, { total: 1, active: 1 });
  assert.deepEqual({ total: census.kinds.webtemplate.total, active: census.kinds.webtemplate.active }, { total: 4, active: 3 });
  assert.equal(census.kinds.contentsnippet.active, 3);
  assert.equal(census.kinds.contentsnippet.activeNames.size, 2);
  assert.equal(census.kinds.sitesetting.active, 4);
  assert.equal(census.kinds.sitesetting.activeNames.size, 3);
  assert.equal(census.kinds.webpageaccesscontrolrule.active, 1);
  assert.equal(census.webFiles.active, 2);
  assert.deepEqual(census.webFiles.attachmentMissing.map((item) => item.name), ["missing.js"]);
  assert.equal(census.kinds.weblink.active, 3);
  assert.equal(census.kinds.weblinkset.activeNames.size, 1);
  assert.equal(census.kinds.poll.total, 1);
  assert.deepEqual(census.webTemplates.map(({ name, active }) => [name, active]).sort(), [["Content", true], ["Footer", true], ["Header", true], ["Old", false]]);
  const summary = censusSummary(census);
  assert.equal(summary.kinds.webpage.total, 5);
  assert.equal(summary.pages.activeRootsWithoutActiveContent, 2);
  assert.doesNotThrow(() => JSON.stringify(summary));
});

test("census reads enhanced components by documented type, site languages and language-tagged records", async (t) => {
  const census = await exportCensus(await tree(t, enhancedExport));
  assert.equal(census.format, "enhanced");
  assert.equal(COMPONENT_TYPES[30], "redirect");
  assert.equal(census.kinds.redirect.total, 1);
  assert.equal(census.kinds.columnpermissionprofile.total, 1);
  assert.deepEqual(census.pages.roots, { total: 1, active: 1 });
  assert.deepEqual(census.pages.content, { total: 1, active: 1 });
  assert.deepEqual({ total: census.kinds.webtemplate.total, active: census.kinds.webtemplate.active }, { total: 2, active: 1 });
  assert.equal(census.siteLanguages.active, 1);
  assert.deepEqual(census.siteLanguages.names, ["English"]);
  assert.deepEqual(census.languageTagged, { webpage: 1 });
  assert.equal(census.website.name, "Enhanced");
  assert.deepEqual(census.webFiles.attachmentMissing, []);
  assert.deepEqual(census.unknownTypes, {});
});

test("import comparison explains standard losses by diagnostics and reports link sets that share a name", async (t) => {
  const dir = await tree(t, standardExport);
  const census = await exportCensus(dir);
  const portal = await importPortal(dir);
  const comparison = compareImport(census, portal);
  const row = (kind) => comparison.rows.find((item) => item.kind === kind);
  assert.deepEqual(comparison.unexplained, []);
  assert.deepEqual([row("webpage").expected, row("webpage").imported], [3, 2]);
  assert.match(row("webpage").explained[0].reason, /page-hierarchy/);
  assert.deepEqual([row("webtemplate").expected, row("webtemplate").imported], [3, 3]);
  assert.deepEqual([row("contentsnippet").expected, row("contentsnippet").imported], [2, 2]);
  assert.deepEqual([row("sitesetting").expected, row("sitesetting").imported], [3, 3]);
  assert.deepEqual([row("webfile").expected, row("webfile").imported, row("webfile").explained[0].count], [2, 1, 1]);
  assert.equal(row("weblink").expected, 3);
  assert.equal(row("weblink").imported + row("weblink").explained.reduce((sum, item) => sum + item.count, 0), 3);
  // Every active link set is reachable by ID; sets that share a name are a note (WEBLINK_SET_NAME_SHARED).
  assert.equal(row("weblink").imported, 3);
  assert.deepEqual(comparison.limitations, []);
  assert.match(comparison.notes.find((item) => item.kind === "weblinkset").reason, /Primary/);
  for (const kind of ["redirect", "urlhistory", "websitelanguage", "webrole", "tablepermission"]) assert.equal(row(kind).unexplained, 0, kind);
  assert.deepEqual(comparison.notModelled.map((item) => item.kind), ["poll"]);
});

test("import comparison flags model losses no diagnostic explains", async (t) => {
  const dir = await tree(t, standardExport);
  const census = await exportCensus(dir);
  const portal = await importPortal(dir);
  const lossy = { ...portal, pages: portal.pages.slice(1), redirects: [] };
  const comparison = compareImport(census, lossy);
  assert.deepEqual(
    comparison.unexplained.map(({ kind, unexplained }) => [kind, unexplained]),
    [["webpage", 1], ["redirect", 1]],
  );
});

test("enhanced comparison measures every documented component type against the imported model", async (t) => {
  const dir = await tree(t, enhancedExport);
  const census = await exportCensus(dir);
  const portal = await importPortal(dir);
  const comparison = compareImport(census, portal);
  const row = (kind) => comparison.rows.find((item) => item.kind === kind);
  // Whatever the importer currently recognises, the comparison reports it against the census.
  assert.equal(row("redirect").expected, 1);
  assert.equal(row("redirect").imported, portal.redirects.length);
  assert.equal(row("redirect").unexplained, 1 - portal.redirects.length);
  assert.equal(row("websitelanguage").expected, 1);
  assert.equal(row("websitelanguage").imported, portal.websiteLanguages.length);
  assert.equal(row("columnpermissionprofile").expected, 1);
  assert.equal(row("columnpermissionprofile").imported, 1);
  assert.deepEqual(
    comparison.unrecognizedComponentTypes.map((item) => item.kind).sort(),
    [...new Set(portal.records.map((record) => record.kind).filter((kind) => kind.startsWith("component:")))].sort(),
  );
  for (const item of comparison.unrecognizedComponentTypes) assert.equal(item.documented, COMPONENT_TYPES[item.kind.split(":")[1]] ?? null);
  assert.deepEqual([row("webpage").expected, row("webpage").imported], [1, 1]);
  assert.equal(row("webfile").unexplained, 0);
});

test("missing includes are classified as absent, inactive or present but unresolved", () => {
  const templates = [
    { name: "Old", active: false, file: "old.yml" },
    { name: "Present", active: true, file: "present.yml" },
  ];
  assert.deepEqual(
    classifyMissingIncludes(["Absent", "old", "Present"], templates).map(({ name, classification, caseDiffers }) => [name, classification, Boolean(caseDiffers)]),
    [
      ["Absent", "absent-from-export", false],
      ["old", "inactive-in-export", true],
      ["Present", "present-not-resolved", false],
    ],
  );
});

test("arguments select project portals, stages, personas and per-portal presets", () => {
  const options = parseArgs(["--project", "p.yml", "--portal", "a,b", "--only", "import,liquid", "--personas", "all-roles", "--preset", "a=demo", "--limit", "5", "--path", "/x/", "--strict"]);
  assert.equal(options.project, "p.yml");
  assert.deepEqual(options.portals, ["a", "b"]);
  assert.deepEqual(options.only, ["import", "liquid"]);
  assert.deepEqual(options.personas, ["all-roles"]);
  assert.deepEqual(options.presets, { a: "demo" });
  assert.equal(options.limit, 5);
  assert.equal(options.pathPrefix, "/x/");
  assert.equal(options.strict, true);
  assert.deepEqual(parseArgs(["--sites", "sample, second", "--env", "second=test"]).env, { second: "test" });
  assert.throws(() => parseArgs(["--project", "p.yml", "--sites", "sample"]), /one of --project, --sites or --samples/);
  assert.deepEqual(parseArgs(["--samples", "R2", "--portal", "pps-a"]).portals, ["pps-a"]);
  assert.throws(() => parseArgs(["--sites", "sample", "--portal", "a"]), /--portal selects portals of --project/);
  assert.throws(() => parseArgs(["--preset", "demo"]), /PORTAL=NAME/);
  assert.throws(() => parseArgs(["--limit", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--project"]), /requires a value/);
});

test("problems and Markdown name unexplained imports, failed requests and failed serve checks", () => {
  const matrix = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    platform: "test",
    node: "v22",
    durationMs: 1000,
    input: { project: "p.yml", version: 2, solutionOrder: "derived" },
    stages: ["import", "sweep", "runtime"],
    personas: ["anonymous", "all-roles"],
    sweepScope: { state: "fresh bootstrap", limit: null, pathPrefix: null },
    portals: [
      {
        id: "one",
        sourceDir: "C:/one",
        solutionRoots: [],
        errors: [{ stage: "liquid", message: "boom" }],
        import: {
          format: "enhanced",
          website: { name: "One" },
          comparison: {
            rows: [{ kind: "redirect", label: "redirects", expected: 2, imported: 0, difference: 2, explained: [], unexplained: 2 }],
            notModelled: [],
            unrecognizedComponentTypes: [{ kind: "component:30", documented: "redirect", records: 2 }],
            unexplained: [{ kind: "redirect", expected: 2, imported: 0, unexplained: 2 }],
            limitations: [],
          },
          diagnostics: {},
        },
        sweep: {
          runs: [
            { persona: "anonymous", identity: null, pages: 1, requests: 1, byStatus: { 500: 1 }, liquidErrorPages: [{ url: "/", messages: ["Liquid error: x"] }], liquidDiagnosticCounts: {}, injectedNonDocuments: [], failures: [{ url: "/", status: 500, failure: null }] },
            { persona: "all-roles", identity: { authenticated: true, roles: ["A", "B"] }, pages: 1, requests: 1, byStatus: { 200: 1 }, liquidErrorPages: [], liquidDiagnosticCounts: {}, injectedNonDocuments: [], failures: [] },
          ],
        },
        runtime: { coldStartMs: 1500, warmStartMs: 500, webApiProbe: { identity: "anonymous", tables: 1, byStatus: { 403: 1 } }, webApiProbeAllRoles: { identity: "all-roles", tables: 1, byStatus: { 200: 1 } } },
      },
    ],
    serve: { startMs: 100, stop: { graceful: true, ms: 10 }, portals: [], checks: [{ name: "distinct CSRF tokens", passed: false }] },
  };
  const problems = matrixProblems(matrix);
  assert.deepEqual(problems.map((item) => item.stage), ["liquid", "import", "sweep", "serve"]);
  const markdown = formatMatrix(matrix);
  assert.match(markdown, /\| redirect \| 0\/2 ⚠ \|/);
  assert.match(markdown, /anonymous: status codes \| 500×1/);
  assert.match(markdown, /all-roles: status codes \| 200×1/);
  assert.match(markdown, /all-roles: identity \| contact, 2 role\(s\)/);
  assert.match(markdown, /Web API probe, all-roles session \| 1 tables: 200×1/);
  assert.match(markdown, /distinct CSRF tokens \| FAIL/);
  assert.match(markdown, /component:30 \(redirect\)/);
  assert.match(markdown, /liquid stage failed: boom/);
});

/** Minimal unpacked solution: complete account and contact definitions, so the scaffold can create persona contacts. */
function solutionTree() {
  const attribute = (name, type, extra = "") => `<attribute PhysicalName="${name}"><Type>${type}</Type><LogicalName>${name}</LogicalName>${extra}</attribute>`;
  const label = (text) => `<labels><label description="${text}" languagecode="1033" /></labels>`;
  const stateStatus =
    attribute("statecode", "state", `<optionset><OptionSetType>state</OptionSetType><states><state value="0" defaultstatus="1" invariantname="Active">${label("Active")}</state><state value="1" defaultstatus="2" invariantname="Inactive">${label("Inactive")}</state></states></optionset>`) +
    attribute("statuscode", "status", `<optionset><OptionSetType>status</OptionSetType><statuses><status value="1" state="0">${label("Active")}</status><status value="2" state="1">${label("Inactive")}</status></statuses></optionset>`);
  const system = ["createdon", "modifiedon", "createdby", "modifiedby", "ownerid"].map((name) => attribute(name, name.endsWith("on") ? "datetime" : "lookup")).join("");
  const entity = (name, set, attributes) =>
    `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><attributes>${attribute(`${name}id`, "primarykey")}${attributes}${stateStatus}${system}</attributes><EntitySetName>${set}</EntitySetName></entity></EntityInfo></Entity>`;
  const name = (column) => attribute(column, "nvarchar", "<DisplayMask>PrimaryName|ValidForForm</DisplayMask><RequiredLevel>none</RequiredLevel><MaxLength>100</MaxLength>");
  return {
    "solutions/core/Other/Solution.xml": "<ImportExportXml><SolutionManifest><UniqueName>core</UniqueName></SolutionManifest></ImportExportXml>",
    "solutions/core/Other/Customizations.xml": `<ImportExportXml><Entities>${entity("account", "accounts", name("name"))}${entity("contact", "contacts", name("fullname") + attribute("firstname", "nvarchar") + attribute("lastname", "nvarchar") + attribute("parentcustomerid", "customer"))}</Entities><EntityRelationships><EntityRelationship Name="contact_customer_accounts"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>contact</ReferencingEntityName><ReferencedEntityName>account</ReferencedEntityName><ReferencingAttributeName>parentcustomerid</ReferencingAttributeName></EntityRelationship></EntityRelationships></ImportExportXml>`,
  };
}

test("matrix runs every stage for a two-portal project and checks multi-portal isolation", { timeout: 300_000 }, async (t) => {
  const root = await tree(t, {
    ...Object.fromEntries(Object.entries(standardExport).map(([name, content]) => [`portals/standard/${name}`, content])),
    ...Object.fromEntries(Object.entries(enhancedExport).map(([name, content]) => [`portals/enhanced/${name}`, content])),
    ...solutionTree(),
    "mirage.project.yml": [
      "version: 2",
      "defaultPortal: std",
      "watch: false",
      "portals:",
      "  - { id: std, path: portals/standard, reference: dev }",
      "  - { id: enh, path: portals/enhanced }",
      "solutions:",
      "  - { id: core, path: solutions/core }",
      "references:",
      "  - { id: dev, origin: https://reference.example.test, environment: dev, default: true }",
      "",
    ].join("\n"),
  });
  const out = path.join(root, "matrix");
  const matrix = await portalMatrix({ project: path.join(root, "mirage.project.yml"), out, log: () => {} });
  assert.deepEqual(matrix.portals.map((portal) => portal.id), ["std", "enh"]);
  assert.deepEqual(matrix.stages, ["import", "bootstrap", "liquid", "webapi", "sweep", "scaffold", "runtime", "serve"]);
  assert.deepEqual([matrix.personas, matrix.scaffoldPersonas, matrix.scaffoldProfile], [["anonymous"], ["anonymous", "all-roles"], "smoke"]);
  for (const portal of matrix.portals) {
    assert.deepEqual(portal.errors, [], `${portal.id}: ${JSON.stringify(portal.errors)}`);
    assert.equal(portal.origin, "https://reference.example.test");
    assert.ok(portal.import.comparison.rows.length > 20);
    assert.equal(portal.bootstrap.layers, 1);
    assert.deepEqual(portal.sweep.runs.map((run) => run.persona), ["anonymous"]);
    assert.deepEqual(portal.scaffold.runs.map((run) => run.persona), ["scaffold anonymous", "scaffold all-roles"]);
    assert.ok(portal.scaffold.personas >= 1, JSON.stringify(portal.scaffold));
    assert.deepEqual(portal.scaffold.coverage.roles, ["Authenticated Users"]);
    assert.ok(portal.scaffold.startMs > 0);
    assert.ok(portal.runtime.coldStartMs > 0 && portal.runtime.warmStartMs > 0);
    assert.ok(portal.runtime.stateBytesAfterStart > 0);
    assert.equal(portal.runtime.admin, 200);
    assert.equal(portal.runtime.webApiProbe.tables, 1);
    assert.equal(portal.runtime.webApiProbeAllRoles, undefined);
  }
  const [standard, enhanced] = matrix.portals;
  assert.equal(standard.import.format, "standard");
  assert.equal(enhanced.import.format, "enhanced");
  assert.deepEqual(
    standard.liquid.missingIncludes.map(({ name, classification }) => [name, classification]).sort(),
    [["Absent Template", "absent-from-export"], ["Old", "inactive-in-export"]],
  );
  // Contact read is granted to Authenticated Users only: anonymous 403, the signed-in coverage contact 200.
  assert.equal(standard.runtime.webApiProbe.results[0].status, 403);
  assert.equal(standard.scaffold.webApiProbe.results[0].status, 403);
  assert.equal(standard.scaffold.webApiProbeCoverage.results[0].status, 200);
  // The restricted page sends anonymous visitors to sign-in and renders for the signed-in coverage contact.
  const fresh = JSON.parse(await fs.readFile(path.join(out, "std", "sweep.json"), "utf8")).runs;
  assert.equal(fresh[0].results.find((result) => result.url === "/work/").status, 302);
  const scaffolded = JSON.parse(await fs.readFile(path.join(out, "std", "scaffold.json"), "utf8")).runs;
  const work = (persona) => scaffolded.find((run) => run.persona === persona).results.find((result) => result.url === "/work/").status;
  assert.equal(work("scaffold anonymous"), 302);
  assert.equal(work("scaffold all-roles"), 200);
  assert.equal(standard.scaffold.runs[1].identity.authenticated, true);
  assert.deepEqual(matrix.serve.checks.filter((item) => !item.passed), []);
  assert.deepEqual(matrix.serve.portals.map((portal) => portal.projectPortal), ["std", "enh"]);
  assert.ok(matrix.serve.stop.graceful);
  for (const file of ["matrix.json", "matrix.md", "std/import.json", "std/sweep.json", "std/scaffold.json", "enh/runtime.json"])
    assert.ok((await fs.stat(path.join(out, file))).isFile(), file);
  const markdown = await fs.readFile(path.join(out, "matrix.md"), "utf8");
  assert.match(markdown, /## Scaffold data/);
  assert.match(markdown, /## Multi-portal serve/);
  assert.match(markdown, /\| std \| enh \|/);
});

test("page components include Liquid-embedded forms and lists reached through static includes", () => {
  const portal = {
    templates: {
      layout: { id: "layout", name: "Layout", source: "{% include 'Body' %}" },
      Body: { id: "body", name: "Body", source: "{% entitylist name:'Cases' %}" },
    },
    pageTemplates: [{ id: "pt", webTemplateId: "layout" }],
    pages: [
      { id: "a", pageTemplateId: "pt", html: "{% webform name:'Apply' %}" },
      { id: "b", formId: "f1", html: "" },
    ],
  };
  assert.deepEqual([...pageComponentKinds(portal, portal.pages[0])].sort(), ["advancedform", "list"]);
  assert.deepEqual([...pageComponentKinds(portal, portal.pages[1])], ["basicform"]);
  const summary = componentRequests(
    [
      { pageId: "a", status: 200, derivedRecord: null, otherDiagnostics: ["COMPONENT_SCHEMA_REQUIRED"] },
      { pageId: "b", status: 501, derivedRecord: { id: "x" }, otherDiagnostics: [] },
    ],
    portal,
  );
  assert.deepEqual(summary.listPages, { requests: 1, byStatus: { 200: 1 } });
  assert.deepEqual(summary.basicFormPages, { requests: 1, byStatus: { 501: 1 } });
  assert.deepEqual(summary.recordRequests, { requests: 1, byStatus: { 501: 1 } });
  assert.deepEqual(summary.componentDiagnostics, { COMPONENT_SCHEMA_REQUIRED: 1 });
});

test("route collisions use the runtime's path normalization and separate distinct records from re-exported IDs", async () => {
  const { normalizePortalPath } = await import("../lib/importer.mjs");
  const { routeCollisions } = await import("../portal-matrix.mjs");
  const portal = {
    pages: [
      { id: "home", name: "Home", url: "/" },
      { id: "news", name: "News", url: "/news/" },
      { id: "news", name: "News (renamed copy)", url: "/news/" },
      { id: "a", name: "A", url: "/same/" },
      { id: "b", name: "B", url: "/Same/" },
    ],
    // A parentless web file whose partial URL starts with "/" is imported as "//file.json".
    webFiles: [{ id: "file", name: "file.json", url: "//file.json" }],
  };
  const { collisions, malformed } = routeCollisions(portal, normalizePortalPath);
  const byRoute = Object.fromEntries(collisions.map((item) => [item.route, item]));
  assert.equal(byRoute["/news"].distinctRecords, 1);
  assert.equal(byRoute["/same"].distinctRecords, 2);
  assert.deepEqual(malformed.map((item) => item.url), ["//file.json"]);
  // Whether "//file.json" still collides with "/" depends on normalizePortalPath; report either way.
  assert.equal(Boolean(byRoute["/"]), normalizePortalPath("//file.json") === "/");
});

test("resolved duplicate copies and resolved URL claims are explained, not reported as problems", async (t) => {
  const dir = await tree(t, {
    ...standardExport,
    // The same page ID exported twice with different content (a stale renamed folder).
    "web-pages/work-old/Work-Old.webpage.yml": "adx_webpageid: work\nadx_name: Work (old)\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: work\nadx_pagetemplateid: main",
  });
  const census = await exportCensus(dir);
  const portal = await importPortal(dir);
  const comparison = compareImport(census, portal);
  const page = comparison.rows.find((row) => row.kind === "webpage");
  assert.equal(page.expected, 4);
  assert.equal(page.unexplained, 0, JSON.stringify(page));
  const { normalizePortalPath } = await import("../lib/importer.mjs");
  const { routeCollisions } = await import("../portal-matrix.mjs");
  const claimed = {
    pages: [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "First", url: "/same/" },
      { id: "bbbbbbbb-0000-0000-0000-000000000002", name: "Second", url: "/same/" },
    ],
    webFiles: [],
    diagnostics: [{ code: "URL_CLAIMED_TWICE", kind: "webpage", path: "/same", usedId: "aaaaaaaa-0000-0000-0000-000000000001", rule: "id-order" }],
  };
  const [collision] = routeCollisions(claimed, normalizePortalPath).collisions;
  assert.deepEqual(collision.resolved, { rule: "id-order", served: "First" });
  const problems = matrixProblems({ portals: [{ id: "p", errors: [], import: { comparison: { unexplained: [] }, routes: { collisions: [collision], malformed: [] } } }] });
  assert.deepEqual(problems, []);
});
