import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPortal } from "../lib/importer.mjs";
import { importSolutionMetadata } from "../lib/solution-metadata.mjs";
import { resolvePageResources } from "../lib/page-resources.mjs";

const portal = () => ({
  sourceDir: "C:/portal",
  website: { adx_headerwebtemplateid: "wt-header", adx_footerwebtemplateid: "wt-footer" },
  pages: [{
    id: "page-1", name: "Workspace", title: "Workspace", url: "/workspace/",
    pageTemplateId: "pt-1", formId: "form-1", listId: "list-1",
    html: "{% include 'Shell' %}{% fetchxml rows %}<fetch><entity name=\"sample_application\"><attribute name=\"sample_name\"/><link-entity name=\"account\" from=\"accountid\" to=\"sample_accountid\"><attribute name=\"name\"/></link-entity></entity></fetch>{% endfetchxml %}{{ snippets['Workspace/Intro'] }}{{ settings['Search/Enabled'] }}",
    js: "",
    css: "",
    metadata: { id: "page-1", _file: "C:/portal/web-pages/Workspace.webpage.yml" },
  }],
  pageTemplates: [{ id: "pt-1", name: "Standard", webTemplateId: "wt-shell", metadata: { id: "pt-1", _file: "C:/portal/page-templates/Standard.pagetemplate.yml" } }],
  templates: {
    "wt-shell": { id: "wt-shell", name: "Shell", source: "{% extends 'Base' %}{% entityform id: 'form-2' %}{{ settings.Theme }}", metadata: { id: "wt-shell", _file: "C:/portal/web-templates/Shell.webtemplate.yml" } },
    Shell: { id: "wt-shell", name: "Shell", source: "{% extends 'Base' %}{% entityform id: 'form-2' %}{{ settings.Theme }}", metadata: { id: "wt-shell", _file: "C:/portal/web-templates/Shell.webtemplate.yml" } },
    "wt-base": { id: "wt-base", name: "Base", source: "{{ snippets['Default'] }}{% entitylist id: 'list-2' %}", metadata: { id: "wt-base", _file: "C:/portal/web-templates/Base.webtemplate.yml" } },
    Base: { id: "wt-base", name: "Base", source: "{{ snippets['Default'] }}{% entitylist id: 'list-2' %}", metadata: { id: "wt-base", _file: "C:/portal/web-templates/Base.webtemplate.yml" } },
    "wt-header": { id: "wt-header", name: "Header", source: "{% include 'Header Partial' %}", metadata: { id: "wt-header", _file: "C:/portal/web-templates/Header.webtemplate.yml" } },
    Header: { id: "wt-header", name: "Header", source: "{% include 'Header Partial' %}", metadata: { id: "wt-header", _file: "C:/portal/web-templates/Header.webtemplate.yml" } },
    "wt-header-partial": { id: "wt-header-partial", name: "Header Partial", source: "{{ snippets['Shell/Head'] }}", metadata: { id: "wt-header-partial", _file: "C:/portal/web-templates/Header-Partial.webtemplate.yml" } },
    "Header Partial": { id: "wt-header-partial", name: "Header Partial", source: "{{ snippets['Shell/Head'] }}", metadata: { id: "wt-header-partial", _file: "C:/portal/web-templates/Header-Partial.webtemplate.yml" } },
    "wt-footer": { id: "wt-footer", name: "Footer", source: "<footer>End</footer>", metadata: { id: "wt-footer", _file: "C:/portal/web-templates/Footer.webtemplate.yml" } },
    Footer: { id: "wt-footer", name: "Footer", source: "<footer>End</footer>", metadata: { id: "wt-footer", _file: "C:/portal/web-templates/Footer.webtemplate.yml" } },
    "wt-form-helper": { id: "wt-form-helper", name: "Form Helper", source: "{{ snippets['Form/Help'] }}", metadata: { id: "wt-form-helper", _file: "C:/portal/web-templates/Form-Helper.webtemplate.yml" } },
    "Form Helper": { id: "wt-form-helper", name: "Form Helper", source: "{{ snippets['Form/Help'] }}", metadata: { id: "wt-form-helper", _file: "C:/portal/web-templates/Form-Helper.webtemplate.yml" } },
  },
  forms: [
    { id: "form-1", name: "Application", entityName: "sample_application", metadata: { id: "form-1", kind: "basicform", _file: "C:/portal/basic-forms/Application.basicform.yml" } },
    { id: "form-2", name: "Contact", entityName: "contact", js: "{% include 'Form Helper' %}{{ settings['Form/Enabled'] }}", metadata: { id: "form-2", kind: "basicform", _file: "C:/portal/basic-forms/Contact.basicform.yml" } },
  ],
  advancedForms: [],
  lists: [{ id: "list-1", name: "Apps", entityName: "sample_application", metadata: { id: "list-1", _file: "C:/portal/lists/Apps.list.yml", adx_view: "view-1" } }, { id: "list-2", name: "Contacts", entityName: "contact", metadata: { id: "list-2", _file: "C:/portal/lists/Contacts.list.yml" } }],
  records: [
    { kind: "contentsnippet", id: "snip-1", name: "Workspace/Intro", _file: "C:/portal/content-snippets/Intro.contentsnippet.yml" },
    { kind: "contentsnippet", id: "snip-2", name: "Default", _file: "C:/portal/content-snippets/Default.contentsnippet.yml" },
    { kind: "contentsnippet", id: "snip-3", name: "Head/Bottom", _file: "C:/portal/content-snippets/Head-Bottom.contentsnippet.yml" },
    { kind: "contentsnippet", id: "snip-4", name: "Browser Title Suffix", _file: "C:/portal/content-snippets/Title-Suffix.contentsnippet.yml" },
    { kind: "contentsnippet", id: "snip-5", name: "Shell/Head", _file: "C:/portal/content-snippets/Shell-Head.contentsnippet.yml" },
    { kind: "contentsnippet", id: "snip-6", name: "Form/Help", _file: "C:/portal/content-snippets/Form-Help.contentsnippet.yml" },
    { kind: "sitesetting", id: "setting-1", name: "Search/Enabled", _file: "C:/portal/sitesetting.yml" },
    { kind: "sitesetting", id: "setting-2", name: "Theme", _file: "C:/portal/sitesetting.yml" },
    { kind: "sitesetting", id: "setting-3", name: "Webapi/sample_application/enabled", _file: "C:/portal/sitesetting.yml" },
    { kind: "sitesetting", id: "setting-4", name: "Form/Enabled", _file: "C:/portal/sitesetting.yml" },
  ],
  settings: { "Webapi/sample_application/enabled": "true" },
  snippets: { Default: "Hi", "Head/Bottom": "{{ snippets['Shell/Head'] }}", "Browser Title Suffix": " | ExampleApp", "Shell/Head": "{{ settings.Theme }}", "Form/Help": "help" },
});

test("resolves a page's static Liquid, component, settings, snippet and data dependencies with provenance", () => {
  const result = resolvePageResources(portal(), "/workspace/?tab=mine", {
    solutionMetadata: {
      entities: {
        sample_application: { fields: { sample_name: {}, sample_accountid: {} }, sources: ["C:/ExampleApp/Entities/sample_application/Entity.xml"] },
        account: { fields: { name: {} }, sources: ["C:/ExampleApp/Entities/account/Entity.xml"] },
        contact: { fields: { fullname: {} }, sources: ["C:/ExampleApp/Entities/contact/Entity.xml"] },
      },
      views: [{ id: "view-1", name: "Applications", entity: "sample_application", fields: [{ name: "sample_name", width: 180 }], fetchXml: "<fetch/>", file: "C:/ExampleApp/Entities/sample_application/SavedQueries.xml" }],
      componentSchemas: { "form-1": { fields: [{ name: "sample_name" }] } },
    },
  });
  assert.equal(result.page.id, "page-1");
  assert.equal(result.pageTemplate.name, "Standard");
  assert.deepEqual(result.webTemplates.map((item) => item.name).sort(), ["Base", "Footer", "Form Helper", "Header", "Header Partial", "Shell"]);
  assert.deepEqual(result.snippets.map((item) => item.name).sort(), ["Browser Title Suffix", "Default", "Form/Help", "Head/Bottom", "Shell/Head", "Workspace/Intro"]);
  assert.deepEqual(result.siteSettings.map((item) => item.name).sort(), ["Form/Enabled", "Search/Enabled", "Theme", "Webapi/sample_application/enabled"]);
  assert.deepEqual(result.forms.map((item) => item.id).sort(), ["form-1", "form-2"]);
  assert.equal(result.views[0].id, "view-1");
  assert.deepEqual(result.tables.map((item) => item.name).sort(), ["account", "contact", "sample_application"]);
  assert.ok(result.columns.some((column) => column.entity === "sample_application" && column.name === "sample_name"));
  assert.ok(result.dependencies.every((item) => item.kind && item.name && (item.sourceFile || item.file)));
  assert.ok(result.dependencies.some((item) => item.sourceFile === "C:/portal/web-templates/Base.webtemplate.yml"));
  assert.deepEqual(result.unresolved, []);
});

test("reports dynamic or absent references instead of claiming complete page coverage", () => {
  const input = portal();
  input.pages[0].html = "{% include templateName %}{% entityform id: activeForm %}{{ snippets[request.params.snippet] }}";
  input.pages[0].formId = null;
  input.pages[0].listId = null;
  const result = resolvePageResources(input, "/workspace/");
  assert.ok(result.unresolved.some((item) => item.kind === "web-template" && item.reason.includes("dynamic")));
  assert.ok(result.unresolved.some((item) => item.kind === "entityform" && item.reason.includes("variable")));
  assert.ok(result.unresolved.some((item) => item.kind === "content-snippet" && item.expression.includes("request.params")));
});

test("an unknown route returns an explicit unresolved page dependency", () => {
  const result = resolvePageResources(portal(), "/missing/");
  assert.equal(result.page, null);
  assert.equal(result.unresolved[0].kind, "page");
});

test("literal built-in list includes resolve comma-separated and JSON exported views; dynamic keys stay unknown", () => {
  const input = portal();
  input.pages[0].formId = null; input.pages[0].listId = null;
  input.pages[0].html = `{% include 'entity_list' key:'list-1' %}{% include 'entity_list' label:'key: fake' key:request.params.list %}`;
  input.templates = {}; input.pageTemplates = []; input.pages[0].pageTemplateId = null; input.website = {};
  input.lists[0].metadata.adx_view = 'view-1,view-2';
  input.lists[0].metadata.adx_views = JSON.stringify({ Type: 'ViewMetadata', Views: [{ ViewId: 'view-3' }, { ViewId: 'view-1' }] });
  const metadata = { entities: { sample_application: { fields: { sample_name: {} }, sources: ['C:/solution/table.xml'] } }, views: ['view-1','view-2','view-3'].map((id) => ({ id, name: id, entity: 'sample_application', fields: [{ name: 'sample_name' }], file: `C:/solution/${id}.xml` })) };
  const report = resolvePageResources(input, '/workspace/', { solutionMetadata: metadata });
  assert.equal(report.components.filter(row => row.kind === 'list').length, 1);
  assert.deepEqual(report.views.map(row => row.id), ['view-1','view-2','view-3']);
  assert.equal(report.tables[0].logicalName, 'sample_application');
  assert.equal(report.columns.some(row => row.name === 'sample_name'), true);
  assert.equal(report.unresolved.filter(row => row.kind === 'entitylist' && /variable/.test(row.reason)).length, 1);
  assert.equal(report.unresolved.some(row => row.expression.includes('fake') && row.kind === 'list'), false);
});

test("raw, nested comments and manifests do not introduce executable reference dependencies", () => {
  const input = portal();
  input.pages[0].formId = null; input.pages[0].listId = null; input.pageTemplates = []; input.pages[0].pageTemplateId = null; input.website = {}; input.templates = {};
  input.pages[0].html = `{%- raw -%}{% include 'Missing' %}{% entitylist id:chosen %}{{ snippets['Missing'] }}<fetch><entity name="invented_missing"/></fetch>{% comment %}{%- endraw -%}{% comment %}{% comment %}{{ settings.Missing }}{% endcomment %}{% entityform id:'missing' %}{% endcomment %}{% manifest %}{"description":"{% include 'Missing' %}"}{% endmanifest %}{% include 'entity_list' key:'list-1' %}{% entityview id:chosen_view %}`;
  input.lists[0].metadata.adx_view = null;
  const report = resolvePageResources(input, '/workspace/');
  assert.equal(report.components.filter(row => row.kind === 'list').length, 1);
  assert.equal(report.snippets.some(row => row.name === 'Missing'), false);
  assert.equal(report.siteSettings.some(row => row.name === 'Missing'), false);
  assert.equal(report.tables.some(row => row.logicalName === 'invented_missing'), false);
  assert.equal(report.unresolved.filter(row => ['web-template','entitylist','entityform'].includes(row.kind)).length, 0);
  assert.equal(report.unresolved.filter(row => row.kind === 'entityview').length, 1);
});

test("an exported override of entity_list is inspected as a template without assuming its arguments render a native list", () => {
  const input = portal();
  input.pages[0].formId = null; input.pages[0].listId = null; input.pageTemplates = []; input.pages[0].pageTemplateId = null; input.website = {};
  input.pages[0].html = `{% include 'ENTITY_LIST' key:'list-1' %}`;
  input.templates = { custom: { id: 'custom', name: 'entity_list', source: '{{ settings.Custom }}', metadata: { _file: 'C:/portal/custom.yml' } } };
  input.records.push({ kind: 'sitesetting', name: 'Custom', _file: 'C:/portal/settings.yml' });
  const report = resolvePageResources(input, '/workspace/');
  assert.equal(report.webTemplates[0].name, 'entity_list');
  assert.equal(report.components.some(row => row.kind === 'list'), false);
  assert.equal(report.siteSettings.some(row => row.name === 'Custom'), true);
});

test("real PAC and unpacked solution imports return openable source-relative page dependencies", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-resources-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const portalPath = path.join(root, "portal"), solutionPath = path.join(root, "solution");
  await fs.mkdir(portalPath);
  await fs.mkdir(solutionPath);
  const portalRoot = await fs.realpath(portalPath), solutionRoot = await fs.realpath(solutionPath);
  const write = async (base, relative, value) => {
    const target = path.join(base, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
    return target;
  };
  await write(portalRoot, "website.yml", "adx_websiteid: site\nadx_name: Test\nadx_defaultlanguage: english\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer");
  await write(portalRoot, "web-pages/home/Home.webpage.yml", "adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: main");
  await write(portalRoot, "web-pages/work/Work.webpage.yml", "adx_webpageid: work\nadx_name: Work\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: work\nadx_pagetemplateid: main");
  const copyRecord = await write(portalRoot, "web-pages/work/content-pages/Work.en-US.webpage.yml", "adx_webpageid: translation\nadx_name: Work\nadx_title: Work\nadx_isroot: false\nadx_rootwebpageid: work\nadx_webpagelanguageid: english\nadx_partialurl: work\nadx_entityformid: contact-form");
  const pageBody = await write(portalRoot, "web-pages/work/content-pages/Work.en-US.webpage.copy.html", "<main>{% include 'Content' %}{{ settings['Home/Flag'] }}</main>");
  await write(portalRoot, "page-templates/Main.pagetemplate.yml", "adx_pagetemplateid: main\nadx_name: Main\nadx_usewebsiteheaderandfooter: true\nadx_webtemplateid: content");
  await write(portalRoot, "web-templates/Content.webtemplate.yml", "adx_webtemplateid: content\nadx_name: Content");
  const contentBody = await write(portalRoot, "web-templates/Content.webtemplate.source.html", "{{ snippets['Nested'] }}{% fetchxml q %}<fetch><entity name=\"contact\"><attribute name=\"fullname\"/></entity></fetch>{% endfetchxml %}");
  await write(portalRoot, "web-templates/Header.webtemplate.yml", "adx_webtemplateid: header\nadx_name: Header");
  await write(portalRoot, "web-templates/Header.webtemplate.source.html", "<header>Header</header>");
  await write(portalRoot, "web-templates/Footer.webtemplate.yml", "adx_webtemplateid: footer\nadx_name: Footer");
  await write(portalRoot, "web-templates/Footer.webtemplate.source.html", "<footer>Footer</footer>");
  await write(portalRoot, "content-snippets/Nested.contentsnippet.yml", "adx_contentsnippetid: nested\nadx_name: Nested");
  const nestedBody = await write(portalRoot, "content-snippets/Nested.contentsnippet.value.html", "{{ settings.Theme }}");
  await write(portalRoot, "content-snippets/Head.contentsnippet.yml", "adx_contentsnippetid: head\nadx_name: Head/Bottom");
  await write(portalRoot, "content-snippets/Head.contentsnippet.value.html", "head");
  await write(portalRoot, "content-snippets/Suffix.contentsnippet.yml", "adx_contentsnippetid: suffix\nadx_name: Browser Title Suffix");
  await write(portalRoot, "content-snippets/Suffix.contentsnippet.value.html", "suffix");
  await write(portalRoot, "sitesetting.yml", "- adx_sitesettingid: flag\n  adx_name: Home/Flag\n  adx_value: true\n- adx_sitesettingid: theme\n  adx_name: Theme\n  adx_value: light");
  await write(portalRoot, "basic-forms/Contact.basicform.yml", "adx_entityformid: contact-form\nadx_name: Contact Form\nadx_entityname: contact\nadx_formname: Contact\nadx_customjavascript: \"{% include 'Form Helper' %}\"");
  await write(portalRoot, "basic-forms/Contact.basicform.custom_javascript.js", "{% include 'Form Helper' %}");
  await write(portalRoot, "web-templates/Form-Helper.webtemplate.yml", "adx_webtemplateid: helper\nadx_name: Form Helper");
  await write(portalRoot, "web-templates/Form-Helper.webtemplate.source.html", "form helper");
  const tableFile = await write(solutionRoot, "Entities/contact/Entity.xml", "<Entity><attributes><attribute><LogicalName>contactid</LogicalName><Type>uniqueidentifier</Type></attribute><attribute><LogicalName>fullname</LogicalName><Type>nvarchar</Type><RequiredLevel>None</RequiredLevel></attribute></attributes></Entity>");

  const imported = await importPortal(portalRoot);
  assert.equal(imported.pages.find((page) => page.url === "/work/").metadata._file, copyRecord);
  const solution = await importSolutionMetadata([solutionRoot], { entities: ["contact"], portal: imported });
  const result = resolvePageResources(imported, "/work/", { solutionMetadata: solution });
  assert.equal(result.page.sourceFile, pageBody);
  assert.ok(result.dependencies.some((item) => item.sourceFile === contentBody));
  assert.ok(result.snippets.some((item) => item.sourceFile === nestedBody));
  assert.ok(result.webTemplates.some((item) => item.name === "Header"));
  assert.ok(result.webTemplates.some((item) => item.name === "Footer"));
  assert.ok(result.webTemplates.some((item) => item.name === "Form Helper"));
  assert.ok(result.siteSettings.some((item) => item.name === "Home/Flag"));
  assert.ok(result.siteSettings.some((item) => item.name === "Theme"));
  assert.ok(result.tables.some((item) => item.name === "contact"));
  assert.equal(result.tables.find((item) => item.name === "contact").sourceFile, tableFile);
  assert.equal(path.resolve(portalRoot, result.tables.find((item) => item.name === "contact").relativePath), tableFile);
  assert.deepEqual(result.unresolved, []);
});

test("inspection adds include chains, usages, access rules, publishing state, values, permissions and related metadata", async () => {
  const { inspectPage } = await import("../lib/page-resources.mjs");
  const input = portal();
  input.pages.push({ id: "parent", name: "Parent", url: "/", parentId: null, metadata: { id: "parent" } });
  input.pages[0].parentId = "parent";
  input.pages[0].metadata.adx_publishingstateid = "published";
  input.pages[0].html += "{% editable snippets 'Workspace/Intro' type: 'html' %}{% editable page 'adx_copy' %}";
  input.records.push(
    { kind: "publishingstate", id: "published", name: "Published", adx_isvisible: true },
    { kind: "webrole", id: "member", name: "Member" },
    { kind: "webpageaccesscontrolrule", id: "rule", name: "Members", adx_webpageid: "parent", adx_right: 2, adx_scope: 1, adx_webpageaccesscontrolrule_webrole: ["member"], _file: "C:/portal/webpagerule.yml" },
    { kind: "weblinkset", id: "nav", name: "Primary" },
    { kind: "weblink", id: "link", name: "Workspace link", adx_pageid: "page-1", adx_weblinksetid: "nav" },
    { kind: "sitemarker", id: "marker", name: "Workspace", adx_pageid: "page-1" },
    { kind: "redirect", id: "old", name: "Old", adx_inboundurl: "old-workspace", adx_statuscode: 301, adx_webpageid: "page-1" },
  );
  const solutionMetadata = { entities: { sample_application: { fields: { sample_name: { label: "Name", dataverseType: "nvarchar", required: true, maxLength: 100 } }, sources: [] } }, views: [], componentSchemas: {} };
  const report = inspectPage({ ...input, snippets: { ...input.snippets, "Workspace/Intro": "Local intro" } }, "/workspace/", {
    solutionMetadata,
    sourcePortal: { ...input, snippets: { ...input.snippets, "Workspace/Intro": "Exported intro" } },
    overrides: { snippets: { "Workspace/Intro": "Local intro" } },
    identity: { roles: ["Member"], roleIds: ["member"], roleSource: "memberships" },
    access: () => ({ allowed: true, status: 200, reason: "public-or-role" }),
    mapping: (entity) => (entity === "sample_application" ? { entitySet: "sample_applications", idColumn: "sample_applicationid" } : null),
    tablePermissions: (entity) => ({ mode: "enforce", entity }),
  });
  assert.deepEqual(report.page.publishingState, { id: "published", name: "Published", visible: true, resolved: true });
  assert.equal(report.page.parent.url, "/");
  assert.deepEqual(report.page.access.rules.map((rule) => [rule.name, rule.inherited, rule.matches, rule.rightLabel]), [["Members", true, true, "Restrict read"]]);
  assert.deepEqual(report.templateChain.slice(0, 4).map((row) => `${row.depth}:${row.kind}:${row.name}`), ["0:page-template:Standard", "1:web-template:Shell", "2:web-template:Base", "3:content-snippet:Default"]);
  assert.ok(report.webTemplates.find((template) => template.name === "Header Partial").includedBy.includes("web-template:wt-header"));
  assert.ok(report.usages.some((usage) => usage.kind === "editable" && usage.target === "snippet" && usage.reference === "Workspace/Intro"));
  assert.ok(report.usages.some((usage) => usage.kind === "editable" && usage.target === "page" && usage.reference === "adx_copy"));
  assert.ok(report.usages.some((usage) => usage.kind === "fetchxml" && usage.tables.includes("account")));
  const application = report.tables.find((table) => table.logicalName === "sample_application");
  assert.deepEqual([application.entitySet, application.mapped, application.permissions.entity], ["sample_applications", true, "sample_application"]);
  const column = report.columns.find((item) => item.entity === "sample_application" && item.name === "sample_name");
  assert.deepEqual([column.label, column.type, column.required, column.maxLength], ["Name", "nvarchar", true, 100]);
  const intro = report.snippets.find((snippet) => snippet.name === "Workspace/Intro");
  assert.deepEqual([intro.value, intro.sourceValue, intro.overridden], ["Local intro", "Exported intro", true]);
  assert.deepEqual(report.related.weblinks.map((link) => [link.name, link.set]), [["Workspace link", "Primary"]]);
  assert.deepEqual(report.related.sitemarkers.map((marker) => marker.name), ["Workspace"]);
  assert.deepEqual(report.related.redirects.map((redirect) => [redirect.inboundUrl, redirect.statusCode]), [["old-workspace", 301]]);
  assert.deepEqual(inspectPage(input, "/missing/").related, { weblinks: [], sitemarkers: [], redirects: [], shortcuts: [] });
});
