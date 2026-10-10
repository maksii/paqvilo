import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import {
  PAGE_KINDS,
  PLATFORM_BUNDLES,
  PLATFORM_RESOURCES,
  bootstrapVariant,
  nativePageRegions,
  platformBundleFor,
  platformShell,
  pageKind,
  webFormsForm,
} from "../lib/platform-manifest.mjs";
import { signInHeaders } from "../testing/session.mjs";

const SITE = "5a1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e6f";
const CONTACT = "c0000000-0000-4000-8000-000000000011";
const VALIDATED = 'var Page_Validators = (window.Page_Validators || []).concat([document.getElementById("RequiredFieldValidatorname")].filter(Boolean));';

test("page kinds follow the rendered native controls", () => {
  assert.deepEqual(Object.keys(PAGE_KINDS), ["anonymous", "authenticated", "list", "basic-form", "multistep-form", "modal-form"]);
  assert.equal(pageKind('<div id="EntityFormControl_0123456789abcdef0123456789abcdef" data-pp-native-form></div>'), "basic-form");
  assert.equal(pageKind('<div id="WebFormControl_0123456789abcdef0123456789abcdef" data-pp-native-form></div>'), "multistep-form");
  assert.equal(pageKind('<div class="entity-grid entitylist" data-view-layouts=""></div>'), "list");
  assert.equal(pageKind("<p>Welcome</p>", { authenticated: true }), "authenticated");
  assert.equal(pageKind("<p>Welcome</p>"), "anonymous");
  // Every resource is attributed to page kinds and has a native and local counterpart.
  for (const resource of PLATFORM_RESOURCES) {
    assert.ok(resource.kinds.length && resource.kinds.every((kind) => kind in PAGE_KINDS), resource.id);
    assert.ok(resource.native, resource.id);
    assert.ok("local" in resource, resource.id);
  }
});

test("the WebForms server form carries the native hidden fields, postback stub and form scripts in order", () => {
  const html = webFormsForm({ action: '/contact-us/?a=1&b="x"', content: `<div class="container"><div id="EntityFormControl_0123456789abcdef0123456789abcdef" data-pp-native-form>Body</div></div><script>${VALIDATED}</script>` });
  // Without a form control only the ScriptManager's blockUI reference loads.
  const bare = webFormsForm({ id: "content_form", content: "<p>Copy</p>" });
  assert.match(bare, /<script src="\/js\/jquery\.blockUI\.js" type="text\/javascript"><\/script>/);
  assert.doesNotMatch(bare, /xrm-adx|WebForm_OnSubmit\(\)/);
  assert.match(html, /^<form method="post" action="\/contact-us\/\?a=1&amp;b=&quot;x&quot;" onsubmit="javascript:return WebForm_OnSubmit\(\);" id="liquid_form">/);
  const order = [
    '<div class="aspNetHidden">',
    'name="__EVENTTARGET"',
    'name="__EVENTARGUMENT"',
    'name="__VIEWSTATE"',
    "var theForm = document.forms['liquid_form'];",
    "function __doPostBack(eventTarget, eventArgument)",
    // The WebForms script resources at their native paths (local equivalents without a capture).
    '<script src="/WebResource.axd?d=paqvilo-webforms&amp;t=0"',
    '<script src="/ScriptResource.axd?d=paqvilo-webuivalidation&amp;t=0"',
    '<script src="/ScriptResource.axd?d=paqvilo-microsoftajax&amp;t=0"',
    '<script src="/ScriptResource.axd?d=paqvilo-microsoftajaxwebforms&amp;t=0"',
    '<script src="/js/jquery.blockUI.js"',
    '<script src="/xrm-adx/js/webform.js"',
    '<script src="/xrm-adx/js/radcaptcha.js"',
    '<script src="/xrm-adx/js/crmentityformview.js"',
    "function WebForm_OnSubmit()",
    'name="__VIEWSTATEGENERATOR"',
    'name="__VIEWSTATEENCRYPTED"',
    'name="__EVENTVALIDATION"',
    '<div class="container"><div id="EntityFormControl_0123456789abcdef0123456789abcdef" data-pp-native-form>Body</div></div>',
  ];
  let at = -1;
  for (const marker of order) {
    const next = html.indexOf(marker, at + 1);
    assert.ok(next > at, `${marker} after position ${at}`);
    at = next;
  }
  assert.match(html, /name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="[0-9A-F]{8}"/);
  assert.doesNotMatch(html, /crmentityformview-datetime\.js/);
  // Read-only forms register no validators, so the form has no onsubmit handler; date
  // controls add the date-time form script; captured AXD paths replace the local runtime.
  const readOnly = webFormsForm({ id: "content_form", action: "/_portal/modal", content: '<div id="EntityFormControl" data-pp-native-form><div class="input-group datetimepicker" data-date-format="DD/MM/YYYY"></div></div>', aspNetScripts: '<script src="/WebResource.axd?d=a&amp;t=1"></script>' });
  assert.match(readOnly, /^<form method="post" action="\/_portal\/modal" id="content_form">/);
  assert.match(readOnly, /var theForm = document\.forms\['content_form'\];/);
  assert.match(readOnly, /<script src="\/WebResource\.axd\?d=a&amp;t=1"><\/script>/);
  assert.doesNotMatch(readOnly, /webforms-compat\.js|WebForm_OnSubmit\(\)/);
  assert.match(readOnly, /<script src="\/xrm-adx\/js\/crmentityformview-datetime\.js"/);
});

test("AXD scripts load inside the form on form pages and nowhere else; captured bundles replace local equivalents", () => {
  const scripts = ["/WebResource.axd?d=w&t=1", { src: "/ScriptResource.axd?d=s&t=2", type: "text/javascript" }, "/scripts/extra.js"];
  const render = (paths) => paths.map((entry) => `<script src="${typeof entry === "string" ? entry : entry.src}"></script>`).join("");
  const form = nativePageRegions({ content: '<div id="EntityFormControl_0123456789abcdef0123456789abcdef" data-pp-native-form></div>', action: "/form/", bodyScripts: scripts, renderScripts: render });
  assert.equal(form.kind, "basic-form");
  assert.match(form.content, /^<form method="post" action="\/form\/" id="liquid_form">/);
  assert.ok(form.content.indexOf("/WebResource.axd?d=w&t=1") < form.content.indexOf("/ScriptResource.axd?d=s&t=2"));
  assert.ok(form.content.indexOf("/ScriptResource.axd") < form.content.indexOf("data-pp-native-form"));
  assert.doesNotMatch(form.content, /webforms-compat\.js/);
  assert.equal(form.bodyScripts, '<script src="/scripts/extra.js"></script>');
  const plain = nativePageRegions({ content: "<p>Guidance</p>", action: "/guidance/", bodyScripts: scripts, renderScripts: render, authenticated: true });
  assert.equal(plain.kind, "authenticated");
  assert.equal(plain.content, "<p>Guidance</p>");
  assert.equal(plain.bodyScripts, '<script src="/scripts/extra.js"></script>');
});

async function shellFixture(t, { shellProfile, settings = [] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-shell-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Shell\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: plain",
    "Form.webpage.yml": "adx_webpageid: form\nadx_name: Form\nadx_partialurl: form\nadx_parentpageid: home\nadx_pagetemplateid: form",
    "List.webpage.yml": "adx_webpageid: list\nadx_name: List\nadx_partialurl: list\nadx_parentpageid: home\nadx_pagetemplateid: list",
    "Plain.pagetemplate.yml": "adx_pagetemplateid: plain\nadx_webtemplateid: plaincontent\nadx_usewebsiteheaderandfooter: true",
    "FormPage.pagetemplate.yml": "adx_pagetemplateid: form\nadx_webtemplateid: formcontent\nadx_usewebsiteheaderandfooter: true",
    "ListPage.pagetemplate.yml": "adx_pagetemplateid: list\nadx_webtemplateid: listcontent\nadx_usewebsiteheaderandfooter: true",
    "Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
    "Header.webtemplate.source.html": '<header class="site-header"><input type="hidden" id="userroles"></header>',
    "Footer.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
    "Footer.webtemplate.source.html": '<footer class="site-footer">Footer</footer><div id="cookie-banner">Cookies</div>',
    "PlainContent.webtemplate.yml": "adx_webtemplateid: plaincontent\nadx_name: Plain content",
    "PlainContent.webtemplate.source.html": '<div class="page-header"><h1>Welcome</h1></div><p>Home</p>',
    "FormContent.webtemplate.yml": "adx_webtemplateid: formcontent\nadx_name: Form content",
    "FormContent.webtemplate.source.html": '<div class="page-header"><h1>Contact us</h1></div>{% entityform name: "Contact" %}',
    "ListContent.webtemplate.yml": "adx_webtemplateid: listcontent\nadx_name: List content",
    "ListContent.webtemplate.source.html": "{% include 'entity_list' key: 'Accounts' %}",
    "Contact.basicform.yml": "adx_entityformid: 2c000000-0000-4000-8000-000000000001\nadx_name: Contact\nadx_entityname: contact\nadx_mode: 100000000",
    "Accounts.list.yml": "adx_entitylistid: 1c000000-0000-4000-8000-000000000001\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 5",
  };
  if (settings.length) files["sitesetting.yml"] = settings.map(([name, value], index) => `- adx_sitesettingid: 5e100000-0000-4000-8000-00000000000${index}\n  adx_name: ${name}\n  adx_value: "${value}"`).join("\n");
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" }, account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" } },
    tables: { contact: [{ contactid: CONTACT, fullname: "Grace" }], account: [{ accountid: "a0000000-0000-4000-8000-000000000011", name: "Alpha" }] },
    permissions: [
      { id: "contact", entity: "contact", scope: "global", roles: ["Member"], operations: ["read", "create"] },
      { id: "account", entity: "account", scope: "global", roles: ["Member"], operations: ["read"] },
    ],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: CONTACT, contactId: CONTACT, roles: ["Member"] },
      live: { origin: null },
      endpoints: [],
      ...(shellProfile ? { shellProfile } : {}),
      componentSchemas: {
        Contact: { entity: "contact", mode: 100000000, fields: [{ name: "fullname", label: "Full name", required: true }] },
        Accounts: { entity: "account", fields: [{ name: "name", label: "Name" }] },
      },
    },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), initial, watch: false });
  t.after(() => app.close());
  const session = signInHeaders(app, CONTACT, { roles: ["Member"] });
  return { app, get: (pathname, headers = session) => fetch(app.url + pathname, { headers }) };
}

const bodyOf = (html) => html.slice(html.indexOf("<body"), html.lastIndexOf("</body>"));

test("layout pages carry the native chrome around the header, content and footer; only form pages wrap the content", async (t) => {
  const { get } = await shellFixture(t, { shellProfile: { bodyScripts: ["/WebResource.axd?d=w&t=1", "/ScriptResource.axd?d=s&t=2"] } });
  const home = bodyOf(await (await get("/")).text());
  const order = (html, markers) => {
    let at = -1;
    for (const marker of markers) {
      const next = html.indexOf(marker, at + 1);
      assert.ok(next > at, `${marker} after position ${at}`);
      at = next;
    }
  };
  // Local shell contract: offline bar, header, empty anti-forgery holder, the body-start
  // platform bundles, content, pcf-loader, native-controls root, controls host, footer (before
  // the authored cookie banner), then the after-footer bundles.
  order(home, ['<div id="offlineNotificationBar" class="displayNone">', '<header class="site-header">', '<div id="antiforgerytoken" data-url="/_layout/tokenhtml"></div>', "/client-telemetry.bundle-", "/preform.moment_2_29_4.bundle-", "/pcf-extended.bundle-", "<p>Home</p>", "/pcf-loader.bundle-", '<div id="pp-native-controls-react-root"></div>', "/controls/host/main.", '<footer class="site-footer">', '<div id="cookie-banner">', "/bootstrap.bundle-", "/postpreform.bundle-", "/app.bundle-", "/default-1033.moment_2_29_4.bundle-"]);
  assert.doesNotMatch(home, /__sim-static/);
  assert.doesNotMatch(home, /<form\b|\.axd/);
  const list = bodyOf(await (await get("/list/")).text());
  assert.match(list, /class="entity-grid entitylist/);
  assert.doesNotMatch(list, /id="liquid_form"|\.axd/);
  const form = bodyOf(await (await get("/form/?source=1")).text());
  order(form, ['<div id="antiforgerytoken" data-url="/_layout/tokenhtml"></div>', '<form method="post" action="/form/?source=1" onsubmit="javascript:return WebForm_OnSubmit();" id="liquid_form">', '<script src="/WebResource.axd?d=w&amp;t=1"', '<script src="/ScriptResource.axd?d=s&amp;t=2"', '<script src="/xrm-adx/js/crmentityformview.js"', 'name="__EVENTVALIDATION"', '<div class="page-header"><h1>Contact us</h1></div>', "data-pp-native-form", "</form>", '<div id="pp-native-controls-react-root"></div>', '<footer class="site-footer">']);
  assert.equal(form.match(/WebResource\.axd/g).length, 1);
  assert.equal(form.match(/id="antiforgerytoken"/g).length, 1);
  assert.doesNotMatch(form, /<input name="__RequestVerificationToken"/);
});

test("anti-forgery endpoints return the native self-closing input with the cookie token", async (t) => {
  const { app, get } = await shellFixture(t);
  for (const pathname of ["/_layout/tokenhtml?_=1", `/_portal/${SITE}/Layout/GetAntiForgeryToken?_=2`]) {
    const response = await get(pathname);
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await response.text(), `<input name="__RequestVerificationToken" type="hidden" value="${app.state().csrf}" />`);
    assert.match(response.headers.get("set-cookie"), /^__RequestVerificationToken=[\w-]+; path=\/; secure; HttpOnly; SameSite=None$/);
  }
  assert.equal((await get(`/_portal/00000000-0000-4000-8000-000000000000/Layout/GetAntiForgeryToken`)).status, 404);
});

test("native platform paths are served from local equivalents unless the export provides them", async (t) => {
  const { get } = await shellFixture(t);
  const expectations = [
    ["/js/jquery.blockUI.js", /application\/javascript/, /\$\.blockUI = function/],
    ["/JS/JQUERY.BLOCKUI.JS", /application\/javascript/, /\$\.unblockUI = function/],
    ["/xrm-adx/js/webform.js", /application\/javascript/, /window\.__ppXrmWebForm/],
    ["/xrm-adx/js/radcaptcha.js", /application\/javascript/, /onClientLoad/],
    ["/xrm-adx/js/crmentityformview.js", /application\/javascript/, /validateRequiredField/],
    ["/xrm-adx/js/crmentityformview-datetime.js", /application\/javascript/, /initializeDateControls/],
    [`/_portal/${SITE}/Resources/ResourceManager?lang=en-US`, /text\/javascript/, /^window\.ResourceManager = \{[\s\S]*"Home_DefaultText": "Home"/],
    ["/__sim-static/native/platform-app-compat.js", /application\/javascript/, /aria-roledescription/],
    ["/__sim-static/native/jquery-blockui-compat.js", /application\/javascript/, /blockOverlay/],
    ["/__sim-static/native/platform-chrome.css", /text\/css/, /\.displayNone\{display:none!important\}/],
  ];
  for (const [pathname, type, body] of expectations) {
    const response = await get(pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get("content-type"), type, pathname);
    assert.match(await response.text(), body, pathname);
  }
  for (const pathname of ["/css/images/web.png", "/resource/powerappsportal/img/close.png"]) {
    const response = await get(pathname);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  }
  assert.equal((await get("/js/jquery.blockUI.js")).headers.get("x-sim-resource-provider"), "local-platform-equivalent");
  assert.equal((await get(`/_portal/00000000-0000-4000-8000-000000000000/Resources/ResourceManager`)).status, 404);
});

test("an exported web file at a native platform path wins over the local equivalent", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-webfile-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "web-files"), { recursive: true });
  await fs.writeFile(path.join(dir, "website.yml"), `adx_websiteid: ${SITE}\nadx_name: Files`);
  await fs.writeFile(path.join(dir, "Home.webpage.yml"), "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true");
  await fs.writeFile(path.join(dir, "JsFolder.webpage.yml"), "adx_webpageid: jsfolder\nadx_name: js\nadx_partialurl: js\nadx_parentpageid: home");
  await fs.writeFile(path.join(dir, "web-files", "jquery.blockUI.js.webfile.yml"), "adx_webfileid: blockui\nadx_name: jquery.blockUI.js\nadx_partialurl: jquery.blockUI.js\nadx_parentpageid: jsfolder\nfilename: jquery.blockUI.js\nmimetype: application/javascript");
  await fs.writeFile(path.join(dir, "web-files", "jquery.blockUI.js"), "window.exportedBlockUI = true;");
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), initial: { version: 1, simulator: { mode: "local", pageMode: "local", identity: { roles: [] }, live: { origin: null }, endpoints: [] } }, watch: false });
  t.after(() => app.close());
  const response = await fetch(`${app.url}/js/jquery.blockUI.js`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "window.exportedBlockUI = true;");
  assert.notEqual(response.headers.get("x-sim-resource-provider"), "local-platform-equivalent");
});

test("legacy ASPX page templates render their WebForms layout with the page's attached form and list", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-rewrite-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Rewrite\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer`,
    "Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
    "Header.webtemplate.source.html": "<header>Header</header>",
    "Footer.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
    "Footer.webtemplate.source.html": "<footer>Footer</footer>",
    "Home.webpage.yml": "adx_webpageid: 0e000000-0000-4000-8000-000000000001\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: 0f000000-0000-4000-8000-000000000003",
    "Cases.webpage.yml": "adx_webpageid: 0e000000-0000-4000-8000-000000000002\nadx_name: Cases\nadx_title: Case list\nadx_partialurl: cases\nadx_parentpageid: 0e000000-0000-4000-8000-000000000001\nadx_pagetemplateid: 0f000000-0000-4000-8000-000000000001\nadx_entitylist: 1c000000-0000-4000-8000-000000000001",
    "Cases.webpage.copy.html": "<p>Open cases</p>",
    "Profile.webpage.yml": "adx_webpageid: 0e000000-0000-4000-8000-000000000003\nadx_name: Profile\nadx_partialurl: profile\nadx_parentpageid: 0e000000-0000-4000-8000-000000000001\nadx_pagetemplateid: 0f000000-0000-4000-8000-000000000002\nadx_entityform: 2c000000-0000-4000-8000-000000000001",
    "Missing.webpage.yml": "adx_webpageid: 0e000000-0000-4000-8000-000000000004\nadx_name: Missing\nadx_partialurl: missing\nadx_parentpageid: 0e000000-0000-4000-8000-000000000001\nadx_pagetemplateid: 0f000000-0000-4000-8000-000000000001\nadx_entityform: 2c000000-0000-4000-8000-0000000000ff",
    "WebForm.pagetemplate.yml": "adx_pagetemplateid: 0f000000-0000-4000-8000-000000000001\nadx_name: Web Form\nadx_rewriteurl: ~/Pages/WebForm.aspx",
    "Page.pagetemplate.yml": "adx_pagetemplateid: 0f000000-0000-4000-8000-000000000002\nadx_name: Page\nadx_rewriteurl: ~/Pages/Page.aspx",
    "Blank.pagetemplate.yml": "adx_pagetemplateid: 0f000000-0000-4000-8000-000000000003\nadx_name: Blank\nadx_rewriteurl: ~/Pages/Blank.aspx",
    "Cases.list.yml": "adx_entitylistid: 1c000000-0000-4000-8000-000000000001\nadx_name: Cases\nadx_entityname: account\nadx_pagesize: 5",
    "Profile.basicform.yml": "adx_entityformid: 2c000000-0000-4000-8000-000000000001\nadx_name: Profile form\nadx_entityname: contact\nadx_mode: 100000000",
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" }, account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" } },
    tables: { contact: [{ contactid: CONTACT, fullname: "Grace" }], account: [{ accountid: "a0000000-0000-4000-8000-000000000021", name: "Alpha" }] },
    permissions: [
      { id: "contact", entity: "contact", scope: "global", roles: ["Member"], operations: ["read", "create"] },
      { id: "account", entity: "account", scope: "global", roles: ["Member"], operations: ["read"] },
    ],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { roles: [] },
      live: { origin: null },
      endpoints: [],
      componentSchemas: { "2c000000-0000-4000-8000-000000000001": { entity: "contact", mode: 100000000, fields: [{ name: "fullname", label: "Full name", required: true }] } },
    },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), initial, watch: false });
  t.after(() => app.close());
  const session = signInHeaders(app, CONTACT, { roles: ["Member"] });
  const body = async (pathname) => bodyOf(await (await fetch(app.url + pathname, { headers: session })).text());
  // WebForm.aspx (WebForms.master): content_form, page heading, page copy, default
  // validation hooks and the attached list as the static EntityListControl. The list's view is
  // absent from the (empty) solution sources, so the grid uses the primary name column.
  const cases = await body("/cases/");
  const order = (html, markers) => {
    let at = -1;
    for (const marker of markers) {
      const next = html.indexOf(marker, at + 1);
      assert.ok(next > at, `${marker} after position ${at}`);
      at = next;
    }
  };
  order(cases, ['<form method="post" action="/cases/" id="content_form">', '<script src="/js/jquery.blockUI.js"', '<div class="page-heading"><div class="container">', '<ul class="breadcrumb">', '<div class="page-header"><h1>Case list</h1></div><div class="notifications"></div>', '<div class="container">', "<p>Open cases</p>", "function entityFormClientValidate()", "function webFormClientValidate()", '<div id="EntityListControl" class="entitylist">', 'class="entity-grid entitylist', "</form>"]);
  assert.doesNotMatch(cases, /xrm-adx\/js\/crmentityformview\.js/);
  const layout = JSON.parse(Buffer.from(/data-view-layouts="([^"]*)"/.exec(cases)[1], "base64").toString("utf8"))[0];
  assert.deepEqual(layout.Columns.map((column) => column.LogicalName), ["name"]);
  // Page.aspx (WebFormsContent.master): two columns, the static EntityFormControl, sidebar.
  const profile = await body("/profile/");
  order(profile, ['id="content_form"', '<div class="row"><div class="col-md-8">', '<div id="EntityFormControl" data-pp-native-form>', 'name="ctl00$ContentContainer$MainContent$EntityControls$EntityFormControl$EntityFormControl_EntityFormView$', '<div class="page-metadata clearfix">', '<div class="col-md-4"><div class="sidebar">']);
  assert.match(profile, /<script src="\/xrm-adx\/js\/crmentityformview\.js"/);
  // A page whose attached basic form is not in the export renders without it.
  const missing = await (await fetch(app.url + "/missing/", { headers: session })).text();
  assert.match(missing, /<div class="page-copy">/);
  assert.doesNotMatch(missing, /data-pp-native-form|Liquid error/);
  // Blank.aspx (Default.master) has no server form.
  const home = await body("/");
  assert.doesNotMatch(home, /content_form|liquid_form/);
  const diagnostics = (await (await fetch(`${app.url}/__sim/api/diagnostics`, { headers: { "x-sim-csrf": app.state().csrf } })).json());
  const entries = Array.isArray(diagnostics) ? diagnostics : diagnostics.diagnostics ?? [];
  assert.ok(entries.some((entry) => entry.code === "SYSTEMVIEW_UNRESOLVED" && entry.path === "/cases/"));
  assert.ok(entries.some((entry) => entry.code === "COMPONENT_NOT_EXPORTED" && entry.path === "/missing/"));
});

test("classic workflow execution reports its local limitation and Bootstrap glyph fonts are served", async (t) => {
  const { app, get } = await shellFixture(t);
  const session = signInHeaders(app, CONTACT, { roles: ["Member"] });
  const workflow = await fetch(`${app.url}/_services/execute-workflow/${SITE}`, {
    method: "POST",
    headers: { ...session, "content-type": "application/json", __RequestVerificationToken: app.state().csrf },
    body: JSON.stringify({ workflow: { LogicalName: "workflow", Id: "0a000000-0000-4000-8000-000000000099" }, entity: { LogicalName: "contact", Id: CONTACT } }),
  });
  assert.equal(workflow.status, 501);
  assert.match(JSON.stringify(await workflow.json()), /WorkflowUnsupported/);
  for (const [name, type] of [["glyphicons-halflings-regular.woff2", "font/woff2"], ["glyphicons-halflings-regular.ttf", "font/ttf"]]) {
    const font = await get(`/fonts/${name}`);
    assert.equal(font.status, 200, name);
    assert.equal(font.headers.get("content-type"), type);
  }
});

// The 17 platform bundles in the default shell order.
const BOOTSTRAP3_BUNDLES = [
  "dist/font-awesome.bundle-3d8a58a48f.css",
  "dist/preform.bundle-b72a6ea21d.css",
  "dist/privatemode.bundle-049b12b66e.css",
  "dist/pwa-style.bundle-55718a4c0d.css",
  "dist/pcf-style.bundle-373a0f4982.css",
  "dist/client-telemetry.bundle-d490766e4f.js",
  "dist/client-telemetry-wrapper.bundle-633e70f51b.js",
  "dist/preform.moment_2_29_4.bundle-750b699ecd.js",
  "dist/pcf-dependency.bundle-805a1661b7.js",
  "dist/pcf.bundle-60440c37cb.js",
  "dist/pcf-extended.bundle-b0e01b5622.js",
  "dist/pcf-loader.bundle-f4a0e619b8.js",
  "controls/host/main.3ee2491f78.chunk.js",
  "dist/bootstrap.bundle-105a4995b8.js",
  "dist/postpreform.bundle-4687dda8df.js",
  "dist/app.bundle-1e948af604.js",
  "dist/default-1033.moment_2_29_4.bundle-eda4e638fd.js",
].map((name) => `/resource/powerappsportal/${name}`);

test("platform bundles follow the live order per Bootstrap build; a captured shell supplies the deployed names", () => {
  const sources = (html) => [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  const shell = platformShell({ websiteId: `{${SITE.toUpperCase()}}`, bootstrap: '<link rel="stylesheet" href="/bootstrap.min.css">' });
  assert.equal(PLATFORM_BUNDLES.length, 17);
  assert.deepEqual([shell.headStart, shell.headEnd, shell.bodyStart, shell.afterContent, shell.afterFooter].flatMap(sources), [`/_portal/${SITE}/Resources/ResourceManager?lang=en-US`, "/bootstrap.min.css", ...BOOTSTRAP3_BUNDLES]);
  assert.match(shell.afterContent, /pcf-loader\.bundle-f4a0e619b8\.js" type="text\/javascript"><\/script><div id="pp-native-controls-react-root"><\/div><script src="[^"]+main\.3ee2491f78\.chunk\.js" type="text\/javascript" defer><\/script>$/);
  assert.equal(platformShell({ controlsRoot: false }).afterContent.includes("pp-native-controls-react-root"), false);
  // Site/BootstrapV5Enabled = true (Example commondev) selects the BootstrapV5 builds.
  assert.equal(bootstrapVariant({ "Site/BootstrapV5Enabled": "True" }), "BootstrapV5");
  assert.equal(bootstrapVariant({ "site/bootstrapv5enabled": "false" }), "BootstrapV3");
  assert.equal(bootstrapVariant({}), "BootstrapV3");
  const v5 = platformShell({ variant: "BootstrapV5" }).bundles.map((bundle) => bundle.path);
  assert.deepEqual(v5.filter((pathname, index) => pathname !== BOOTSTRAP3_BUNDLES[index]).map((pathname) => pathname.replace("/resource/powerappsportal/dist/", "")), [
    "font-awesome.BootstrapV5.bundle-2ce6efb497.css",
    "preform.BootstrapV5.bundle-e3e84e09a3.css",
    "preform.BootstrapV5.moment_2_29_4.bundle-e6db58f462.js",
    "bootstrap.BootstrapV5.bundle-be8391e97d.js",
    "postpreform.BootstrapV5.bundle-1e48131190.js",
    "app.BootstrapV5.bundle-4299f393fc.js",
  ]);
  const captured = platformShell({
    websiteId: SITE,
    profile: {
      stylesheets: ["/css/bootstrap.min.css", "/resource/powerappsportal/dist/font-awesome.bundle-3d8a58a48f.css", "/theme.css"],
      headScripts: [`/_portal/${SITE}/Resources/ResourceManager?lang=en-US`],
      beforeContentScripts: ["/resource/powerappsportal/dist/preform.moment_2_29_4.bundle-750b699ecd.js"],
      bodyScripts: ["/WebResource.axd?d=a&t=1", "/resource/powerappsportal/dist/client-telemetry.bundle-2bb0ef927d.js"],
      afterFooterScripts: [{ src: "/resource/powerappsportal/dist/app.bundle-79acd4df74.js" }],
    },
  });
  assert.deepEqual(captured.bundles.filter((bundle) => bundle.captured).map((bundle) => bundle.id), ["font-awesome", "client-telemetry", "preform", "app"]);
  assert.match(captured.bodyStart, /\/dist\/client-telemetry\.bundle-2bb0ef927d\.js"/);
  assert.match(captured.afterFooter, /\/dist\/app\.bundle-79acd4df74\.js"/);
  assert.match(captured.headStart, /^<script src="\/_portal\/[^"]+\/Resources\/ResourceManager\?lang=en-US"><\/script><link rel="stylesheet" href="\/css\/bootstrap\.min\.css">/);
  assert.deepEqual(captured.remaining, { stylesheets: ["/theme.css"], headScripts: [], beforeContentScripts: [], bodyScripts: ["/WebResource.axd?d=a&t=1"], afterFooterScripts: [] });
  // Any build of a bundle is recognised; other paths are not platform bundles.
  assert.equal(platformBundleFor("/resource/powerappsportal/dist/default-1036.moment_2_29_4.bundle-0123456789.js")?.id, "moment-locale");
  assert.equal(platformBundleFor("/resource/powerappsportal/dist/app.BootstrapV5.bundle-4299f393fc.js?v=1")?.id, "app");
  assert.equal(platformBundleFor("/resource/powerappsportal/dist/unknown.bundle-0123456789.js"), null);
  assert.equal(platformBundleFor("/dist/app.bundle-1e948af604.js"), null);
});

test("pages load the platform bundles in live order per Bootstrap build; bundle paths serve local equivalents or placeholders", async (t) => {
  const markers = {
    preform: [/jQuery v3/, /moment/, /datetimepicker/, /dialog/],
    "preform-style": [/offlineNotificationBar/],
    bootstrap: [/data-bs-toggle/, /data-toggle/],
    postpreform: [/__ppSimDatejs/, /blockUI/],
    app: [/entity-grid/, /footerSpacing/, /aria-roledescription/],
    "moment-locale": [/\.locale\(/],
  };
  for (const variant of ["BootstrapV3", "BootstrapV5"]) {
    const { app, get } = await shellFixture(t, variant === "BootstrapV5" ? { settings: [["Site/BootstrapV5Enabled", "true"]] } : {});
    const html = await (await get("/")).text();
    const expected = platformShell({ variant }).bundles;
    const resources = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((match) => match[1].split("?")[0]);
    // The site has no bootstrap.min.css content style, so the platform's default is linked.
    assert.deepEqual(resources, [`/_portal/${SITE}/Resources/ResourceManager`, "/css/bootstrap.min.css", ...expected.map((bundle) => bundle.path)], variant);
    assert.doesNotMatch(html, /__sim-static/);
    for (const bundle of PLATFORM_BUNDLES) {
      const pathname = expected.find((entry) => entry.id === bundle.id).path;
      const response = await get(pathname);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers.get("content-type"), bundle.kind === "stylesheet" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8", pathname);
      assert.equal(response.headers.get("x-sim-resource-provider"), bundle.local.length ? "local-platform-equivalent" : "local-platform-placeholder", pathname);
      const body = await response.text();
      assert.equal(body.length > 0, bundle.local.length > 0, pathname);
      for (const marker of markers[bundle.id] ?? []) assert.match(body, marker, `${bundle.id} ${marker}`);
      assert.doesNotMatch(body, /sourceMappingURL/, pathname);
    }
    const bootstrapCss = await get("/css/bootstrap.min.css");
    assert.equal(bootstrapCss.headers.get("x-sim-resource-provider"), "local-platform-placeholder");
    await get(expected.find((bundle) => bundle.id === "pcf").path);
    // One diagnostic per runtime and resource without a local equivalent.
    const diagnostics = await (await fetch(`${app.url}/__sim/api/diagnostics`, { headers: { "x-sim-csrf": app.state().csrf } })).json();
    const entries = Array.isArray(diagnostics) ? diagnostics : (diagnostics.diagnostics ?? []);
    assert.deepEqual(
      entries.filter((entry) => entry.code === "PLATFORM_BUNDLE_PLACEHOLDER").map((entry) => entry.bundle).sort(),
      [...PLATFORM_BUNDLES.filter((bundle) => !bundle.local.length).map((bundle) => bundle.id), "platform-bootstrap"].sort(),
    );
  }
});

test("form pages load the WebForms script resources at their native paths, served by local equivalents", async (t) => {
  const { app, get } = await shellFixture(t);
  const form = await (await get("/form/")).text();
  const axd = [...form.matchAll(/<script src="(\/(?:Web|Script)Resource\.axd\?[^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));
  assert.deepEqual(axd, ["/WebResource.axd?d=paqvilo-webforms&t=0", "/ScriptResource.axd?d=paqvilo-webuivalidation&t=0", "/ScriptResource.axd?d=paqvilo-microsoftajax&t=0", "/ScriptResource.axd?d=paqvilo-microsoftajaxwebforms&t=0"]);
  assert.doesNotMatch(form, /<(?:script|link)[^>]*(?:src|href)="[^"]*__sim-static/);
  const body = async (pathname) => {
    const response = await get(pathname);
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("content-type"), "application/javascript; charset=utf-8", pathname);
    return { provider: response.headers.get("x-sim-resource-provider"), text: await response.text() };
  };
  const webForms = await body(axd[0]);
  assert.equal(webForms.provider, "local-platform-equivalent");
  assert.match(webForms.text, /WebForm_DoPostBackWithOptions/);
  // MicrosoftAjax contributes Date.prototype.format on form pages; Datejs belongs to postpreform.
  const ajax = await body(axd[2]);
  assert.match(ajax.text, /Date\.prototype, "format"/);
  assert.doesNotMatch(ajax.text, /__ppSimDatejs/);
  const postpreform = await body(platformShell().bundles.find((bundle) => bundle.id === "postpreform").path);
  assert.match(postpreform.text, /__ppSimDatejs/);
  assert.doesNotMatch(postpreform.text, /Date\.prototype, "format"/);
  assert.equal((await body(axd[3])).provider, "local-platform-placeholder");
  // A d value that is not a local equivalent is not served by them.
  assert.equal((await get("/ScriptResource.axd?d=unknown&t=0")).headers.get("x-sim-resource-provider"), null);
  const diagnostics = await (await fetch(`${app.url}/__sim/api/diagnostics`, { headers: { "x-sim-csrf": app.state().csrf } })).json();
  const entries = Array.isArray(diagnostics) ? diagnostics : (diagnostics.diagnostics ?? []);
  assert.ok(entries.some((entry) => entry.code === "PLATFORM_BUNDLE_PLACEHOLDER" && entry.bundle === "paqvilo-microsoftajaxwebforms"));
});
