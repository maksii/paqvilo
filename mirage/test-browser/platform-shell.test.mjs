import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";
import { signInContext } from "../testing/session.mjs";

const require = createRequire(import.meta.url);
const SITE = "7b2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d";
const CONTACT = "c2000000-0000-4000-8000-000000000001";

// Synthetic portal: header with a dropdown menu, footer followed by an authored cookie
// banner, a plain page and a basic form page. Nothing leaves loopback.
async function portalFixture(t, { settings = [], home = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-shell-browser-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const jquery = await fs.readFile(path.join(path.dirname(require.resolve("jquery/package.json")), "dist", "jquery.min.js"));
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Shell\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: plain",
    "Form.webpage.yml": "adx_webpageid: form\nadx_name: Form\nadx_partialurl: form\nadx_parentpageid: home\nadx_pagetemplateid: form",
    "Plain.pagetemplate.yml": "adx_pagetemplateid: plain\nadx_webtemplateid: plaincontent\nadx_usewebsiteheaderandfooter: true",
    "FormPage.pagetemplate.yml": "adx_pagetemplateid: form\nadx_webtemplateid: formcontent\nadx_usewebsiteheaderandfooter: true",
    "Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
    "Header.webtemplate.source.html":
      '<script src="/jquery.min.js"></script><header><ul class="nav"><li class="dropdown"><a href="#" class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" title="Services">Services</a><ul class="dropdown-menu"><li><a href="/">Home</a></li></ul></li></ul></header>',
    "Footer.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
    "Footer.webtemplate.source.html":
      '<style>footer.site{position:absolute;top:0;left:0;right:0;height:80px;background:#fff}</style><footer class="site">Footer</footer><div id="cookie-consent-banner">Cookies</div>',
    "PlainContent.webtemplate.yml": "adx_webtemplateid: plaincontent\nadx_name: Plain content",
    "PlainContent.webtemplate.source.html": "<p>Welcome</p><script>window.parseTimeDate = Date.parse('08/10/2026 12:34'); document.addEventListener('DOMContentLoaded', () => { window.parsedDate = Date.parse('08/10/2026 12:34'); }); window.$ = window.jQuery;</script>",
    "FormContent.webtemplate.yml": "adx_webtemplateid: formcontent\nadx_name: Form content",
    "FormContent.webtemplate.source.html": '<div class="page-header"><h1>Contact us</h1></div>{% entityform name: "Contact" %}',
    "Contact.basicform.yml": "adx_entityformid: 2d000000-0000-4000-8000-000000000001\nadx_name: Contact\nadx_entityname: contact\nadx_mode: 100000000",
    "jquery.min.js.webfile.yml": "adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js",
  };
  if (home) files["PlainContent.webtemplate.source.html"] = home;
  if (settings.length) files["sitesetting.yml"] = settings.map(([name, value], index) => `- adx_sitesettingid: 5e200000-0000-4000-8000-00000000000${index}\n  adx_name: ${name}\n  adx_value: "${value}"`).join("\n");
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, "jquery.min.js"), jquery);
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" } },
    tables: { contact: [{ contactid: CONTACT, fullname: "Grace" }] },
    permissions: [{ id: "contact", entity: "contact", scope: "global", roles: ["Member"], operations: ["read", "create"] }],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: CONTACT, contactId: CONTACT, roles: ["Member"] },
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        Contact: { entity: "contact", mode: 100000000, fields: [{ name: "fullname", label: "Full name", required: true }, { name: "emailaddress1", label: "Email" }] },
      },
    },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), initial, watch: false });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, app, CONTACT, { roles: ["Member"] });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(`${request.method()} ${request.url().replace(app.url, "")}`));
  await page.route("**/*", (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  return { app, page, errors, requests };
}

test("platform chrome, lazy anti-forgery token, app-bundle accessibility and Datejs on a plain page", async (t) => {
  const { app, page, errors, requests } = await portalFixture(t);
  await page.goto(`${app.url}/`);
  // Body order as on sandbox: offline bar (hidden by the platform styles), header, empty
  // anti-forgery holder, content, native-controls root, footer, then the authored banner.
  const order = await page.evaluate(() => [...document.body.children].map((element) => element.id || element.tagName.toLowerCase()).filter((name) => !["script", "style", "link"].includes(name)));
  assert.deepEqual(order.slice(0, 3), ["offlineNotificationBar", "header", "antiforgerytoken"]);
  assert.ok(order.indexOf("pp-native-controls-react-root") < order.indexOf("footer"));
  assert.ok(order.indexOf("footer") < order.indexOf("cookie-consent-banner"), "the footer adapter keeps the footer before the banner");
  assert.equal(await page.locator("#offlineNotificationBar").isVisible(), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("footer.site")).position), "static");
  assert.equal(await page.locator("#antiforgerytoken input").count(), 0);
  assert.equal(requests.filter((request) => /\.axd|\/_layout\/tokenhtml/.test(request)).length, 0);
  // The first token request fills the holder from its data-url once (cache-busted GET).
  const tokens = await page.evaluate(() => Promise.all([0, 1].map(() => new Promise((resolve) => window.shell.getTokenDeferred().done(resolve)))));
  assert.deepEqual(tokens, [app.state().csrf, app.state().csrf]);
  assert.equal(await page.locator('#antiforgerytoken input[name="__RequestVerificationToken"]').getAttribute("value"), app.state().csrf);
  assert.equal(requests.filter((request) => /^GET \/_layout\/tokenhtml\?_=\d+$/.test(request)).length, 1);
  // app.bundle accessibility block: dropdown toggles.
  const toggle = page.locator("li.dropdown > a.dropdown-toggle");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await toggle.getAttribute("aria-haspopup"), null);
  assert.equal(await toggle.getAttribute("aria-label"), "Services");
  // postpreform equivalent at the platform position (after the footer): content scripts that
  // run while the page parses get the browser's Date.parse, ready handlers get Datejs.
  assert.deepEqual(await page.evaluate(() => [typeof window.parseTimeDate, window.parsedDate instanceof Date, window.parsedDate.getMonth(), typeof Date.today, typeof jQuery.blockUI]), ["number", true, 7, "function", "function"]);
  // The page links the platform bundles, not the local adapters.
  assert.equal(requests.filter((request) => request.includes("/__sim-static/")).length, 0);
  assert.ok(requests.includes("GET /resource/powerappsportal/dist/preform.moment_2_29_4.bundle-750b699ecd.js"));
  assert.ok(requests.includes("GET /resource/powerappsportal/dist/app.bundle-1e948af604.js"));
  await page.evaluate(() => jQuery.blockUI({ message: "<p>Working</p>", fadeIn: 0 }));
  assert.equal(await page.locator("body > div.blockUI.blockOverlay").count(), 1);
  assert.equal(await page.locator("body > div.blockUI.blockMsg.blockPage").innerText(), "Working");
  await page.evaluate(() => jQuery.unblockUI({ fadeOut: 0 }));
  assert.equal(await page.locator("body > .blockUI").count(), 0);
  assert.deepEqual(errors, []);
});

test("basic form pages run inside the WebForms form with the platform form scripts", async (t) => {
  const { app, page, errors, requests } = await portalFixture(t);
  await page.goto(`${app.url}/form/?ref=1`);
  const form = page.locator("form#liquid_form");
  assert.equal(await form.getAttribute("action"), "/form/?ref=1");
  assert.equal(await form.getAttribute("onsubmit"), "javascript:return WebForm_OnSubmit();");
  assert.deepEqual(await form.locator("div.aspNetHidden input").evaluateAll((inputs) => inputs.map((input) => input.name)), ["__EVENTTARGET", "__EVENTARGUMENT", "__VIEWSTATE", "__VIEWSTATEGENERATOR", "__VIEWSTATEENCRYPTED", "__EVENTVALIDATION"]);
  for (const script of ["/js/jquery.blockUI.js", "/xrm-adx/js/webform.js", "/xrm-adx/js/radcaptcha.js", "/xrm-adx/js/crmentityformview.js"])
    assert.ok(requests.includes(`GET ${script}`), script);
  assert.deepEqual(
    await page.evaluate(() => [typeof theForm, typeof window.radcaptcha.onClientLoad, typeof WebForm_DoPostBackWithOptions, typeof validateRequiredField, Array.isArray(document.getElementsByClassName("form-control"))]),
    ["object", "function", "function", "function", true],
  );
  // The platform's word-boundary getElementsByClassName (an Array, so page scripts can call
  // forEach) does not change jQuery class selection (sandbox live-run11/12).
  const selection = await page.evaluate(() => ({
    method: document.getElementsByClassName("control").length,
    words: document.getElementsByClassName("control").some((element) => element.classList.contains("form-control")),
    native: document.querySelectorAll(".control").length,
    jquery: jQuery(".control").length,
    compound: jQuery("table .control").length === document.querySelectorAll("table .control").length,
    forEach: (() => { let count = 0; document.getElementsByClassName("form-control").forEach(() => count++); return count; })(),
  }));
  assert.ok(selection.words && selection.method > selection.native, JSON.stringify(selection));
  assert.equal(selection.jquery, selection.native);
  assert.equal(selection.compound, true);
  assert.ok(selection.forEach > 0);
  // Heading announcer and form label from the page heading.
  const announcer = page.locator('.page-header > div.sr-only[role="alert"][aria-roledescription="heading"]');
  assert.equal(await announcer.getAttribute("aria-label"), "Contact us");
  assert.equal(await page.locator(".crmEntityFormView").getAttribute("aria-label"), "Contact us");
  // A browser submission of the server form is a postback: no POST to the page, the page
  // re-renders at the form action.
  await page.locator("#fullname").fill("Grace Hopper");
  await page.evaluate(() => {
    const extra = document.createElement("input");
    extra.type = "submit";
    extra.id = "authored-submit";
    document.querySelector("form#liquid_form").appendChild(extra);
  });
  await Promise.all([page.waitForURL(`${app.url}/form/?ref=1`), page.locator("#authored-submit").click()]);
  assert.equal(requests.filter((request) => request.startsWith("POST /form/")).length, 0);
  assert.deepEqual(errors, []);
});

test("Site/BootstrapV5Enabled pages load the BootstrapV5 bundles, whose local equivalent runs the Bootstrap 5 data API", async (t) => {
  // Bootstrap 5 markup as the Example export uses it: data-bs-toggle, data-bs-target and data-bs-dismiss.
  const home =
    '<style>.modal{display:none}.dropdown-menu{display:none}.dropdown-menu.show{display:block}</style>' +
    '<div class="dropdown"><button type="button" class="dropdown-toggle" id="menu" data-bs-toggle="dropdown">Menu</button><ul class="dropdown-menu" id="menuItems"><li>Item</li></ul></div>' +
    '<button type="button" id="open" data-bs-toggle="modal" data-bs-target="#confirm">Cancel</button>' +
    '<div class="modal fade" id="confirm" tabindex="-1"><div class="modal-dialog"><p>Discard the draft?</p><button type="button" id="dismiss" data-bs-dismiss="modal">No</button></div></div>' +
    '<button type="button" id="collapseToggle" data-bs-toggle="collapse" data-bs-target="#details">Details</button><div id="details" hidden>More</div>';
  const { app, page, errors, requests } = await portalFixture(t, { settings: [["Site/BootstrapV5Enabled", "true"]], home });
  await page.goto(`${app.url}/`);
  for (const bundle of ["preform.BootstrapV5.moment_2_29_4.bundle-e6db58f462.js", "bootstrap.BootstrapV5.bundle-be8391e97d.js", "postpreform.BootstrapV5.bundle-1e48131190.js", "app.BootstrapV5.bundle-4299f393fc.js", "font-awesome.BootstrapV5.bundle-2ce6efb497.css"])
    assert.ok(requests.includes(`GET /resource/powerappsportal/dist/${bundle}`), bundle);
  assert.equal(requests.filter((request) => request.includes("/__sim-static/")).length, 0);
  await page.locator("#menu").click();
  assert.equal(await page.locator("#menuItems").isVisible(), true);
  assert.equal(await page.locator("#menu").getAttribute("aria-expanded"), "true");
  await page.locator("#menu").click();
  assert.equal(await page.locator("#menuItems").isVisible(), false);
  await page.locator("#open").click();
  assert.equal(await page.locator("#confirm").isVisible(), true);
  await page.locator("#dismiss").click();
  assert.equal(await page.locator("#confirm").isVisible(), false);
  await page.locator("#collapseToggle").click();
  assert.equal(await page.locator("#details").isVisible(), true);
  assert.equal(await page.evaluate(() => typeof jQuery.fn.modal), "function");
  assert.deepEqual(errors, []);
});
