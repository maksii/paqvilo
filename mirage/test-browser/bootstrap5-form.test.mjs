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
import { ownedFixture } from "../testing/owned-fixture.mjs";

const require = createRequire(import.meta.url);
const SITE = "7b2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c3d";
const CONTACT = "c2000000-0000-4000-8000-000000000011";
const ACCOUNT = "a2000000-0000-4000-8000-000000000011";
const FORM = "2d000000-0000-4000-8000-000000000011";

// A Bootstrap 5 site (Site/BootstrapV5Enabled) with one insert form: a required name,
// an empty read-only code, an option set and a modal lookup.
test("Bootstrap 5 forms: the runtime adopts its form marker, dashes empty read-only boxes and renders Bootstrap 5 lookup grids and success panels", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap5-form-browser-"));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const jquery = await fs.readFile(path.join(path.dirname(require.resolve("jquery/package.json")), "dist", "jquery.min.js"));
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Widgets`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: form",
    "FormPage.pagetemplate.yml": "adx_pagetemplateid: form\nadx_webtemplateid: formcontent",
    "FormContent.webtemplate.yml": "adx_webtemplateid: formcontent\nadx_name: Form content",
    "FormContent.webtemplate.source.html": '<script src="/jquery.min.js"></script><div class="page-header"><h1>Widget</h1></div>{% entityform name: "Widget" %}',
    "Widget.basicform.yml": `adx_entityformid: ${FORM}\nadx_name: Widget\nadx_entityname: contact\nadx_mode: 100000000\nadx_onsuccess: 756150000\nadx_successmessage: Widget saved.\nadx_hideformonsuccess: false`,
    "jquery.min.js.webfile.yml": "adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js",
    "sitesetting.yml": '- adx_sitesettingid: 5e200000-0000-4000-8000-000000000011\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, "jquery.min.js"), jquery);
  const initial = {
    version: 1,
    mappings: {
      contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname", relationships: { parentcustomerid_account: { from: "parentcustomerid", to: "accountid", entity: "account", many: false, schemaName: "contact_customer_accounts" }, managingpartnerid: { from: "managingpartnerid", to: "accountid", entity: "account", many: false, schemaName: "contact_managingpartner" } } },
      account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" },
    },
    tables: { contact: [{ contactid: CONTACT, fullname: "Grace" }], account: [{ accountid: ACCOUNT, name: "Acme" }] },
    permissions: [
      { id: "contact", entity: "contact", scope: "global", roles: ["Member"], operations: ["read", "create", "append", "appendTo"] },
      { id: "account", entity: "account", scope: "global", roles: ["Member"], operations: ["read", "append", "appendTo"] },
    ],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: CONTACT, contactId: CONTACT, roles: ["Member"] },
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        Widget: {
          entity: "contact",
          mode: 100000000,
          fields: [
            { name: "fullname", label: "Full name", required: true, maxLength: 100 },
            { name: "jobtitle", label: "Code", readOnly: true },
            { name: "preferredcontactmethodcode", label: "Preferred", dataverseType: "picklist", options: [{ value: 1, label: "Email" }, { value: 2, label: "Phone" }] },
            { name: "parentcustomerid", label: "Company", type: "lookup", lookupTargets: ["account"] },
            { name: "managingpartnerid", label: "Partner", type: "lookup", lookupTargets: ["account"] },
          ],
        },
      },
    },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), initial, watch: false });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, app, CONTACT, { roles: ["Member"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const gridBodies = [];
  const tokenRequests = [];
  page.on("request", (request) => request.url().includes("/_layout/tokenhtml") && tokenRequests.push(request.url()));
  page.on("request", (request) => request.url().includes("/_services/entity-lookup-grid-data.json/") && gridBodies.push(request.postDataJSON()));
  await page.route("**/*", (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(`${app.url}/`);
  await page.waitForSelector("#parentcustomerid_lookupmodal .view-toolbar");
  const partnerButtons = page.locator("#managingpartnerid_lookupmodal section.modal-lookup > .modal-dialog > .modal-content > .modal-footer").locator("button.primary, .remove-value");
  assert.deepEqual(await partnerButtons.evaluateAll((els) => els.map((el) => el.disabled)), [false, false]);

  // The server marker becomes runtime state: the platform markup carries no marker comment.
  assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes("pp-native-form")), false);
  // An empty read-only box shows the muted dash after it.
  assert.deepEqual(
    await page.locator("#jobtitle").evaluate((box) => ({ text: box.nextElementSibling?.textContent, className: box.nextElementSibling?.className, hidden: box.nextElementSibling?.getAttribute("aria-hidden"), position: box.parentElement.style.position })),
    { text: "—", className: "text-muted", hidden: "true", position: "relative" },
  );
  // Bootstrap 5 option sets are form-select boxes whose options stay unannotated.
  assert.deepEqual(
    await page.locator("#preferredcontactmethodcode").evaluate((select) => ({ formSelect: select.classList.contains("form-select"), setsize: [...select.options].some((option) => option.hasAttribute("aria-setsize")) })),
    { formSelect: true, setsize: false },
  );
  // The lookup dialog grid renders the Bootstrap 5 toolbar and responsive table.
  const grid = page.locator("#parentcustomerid_lookupmodal .entity-grid");
  assert.equal(await grid.locator(".view-toolbar > .float-end.toolbar-actions > .input-group.float-start.view-search").count(), 1);
  assert.equal(await grid.locator(".view-toolbar .input-group-btn.align-top > button.btn.btn-default > .visually-hidden").innerText(), "Search Results");
  assert.equal(await grid.locator(".view-grid.table-responsive > span[aria-label='Choose one record and click Select to continue']").count(), 1);
  assert.equal(await grid.locator(".view-grid > table").getAttribute("class"), "table table-hover");
  // Closed, the dialog announces nothing; its hidden section carries no Bootstrap 3 state.
  assert.equal(await grid.locator("[id^='SearchCountText']").count(), 0);
  const dialog = page.locator("#parentcustomerid_lookupmodal section.modal-lookup");
  await page.locator("button.launchentitylookup[aria-label*='Company']").click();
  await page.waitForSelector("#parentcustomerid_lookupmodal section.modal-lookup.show tbody tr");
  // Open: "show" only, no aria-hidden, both footer actions disabled, the platform's checkbox label and
  // the field-named announcer once the grid has loaded; rows carry no ARIA of their own.
  assert.deepEqual(await dialog.evaluate((el) => [el.className, el.getAttribute("aria-hidden"), el.getAttribute("role"), el.hasAttribute("hidden")]), ["modal fade modal-lookup show", null, "dialog", false]);
  assert.deepEqual(await dialog.locator(".modal-footer button.primary, .modal-footer .remove-value").evaluateAll((els) => els.map((el) => el.disabled)), [true, true]);
  // Opening one lookup dialog disables Select and Remove value in every lookup dialog (live DOM);
  // a lookup grid posts a null natural-language filter (live requests).
  assert.deepEqual(await partnerButtons.evaluateAll((els) => els.map((el) => el.disabled)), [true, true]);
  assert.equal(gridBodies.at(-1).nlSearchFilter, null);
  // A lookup dialog announces nothing to the page (live DOM).
  assert.equal(await page.locator("#modal-status-announcer").count(), 0);
  assert.equal(await grid.locator(":scope > #SearchCountTextparentcustomerid.visually-hidden").innerText(), "1 records found");
  assert.deepEqual(await grid.locator("tbody tr").first().evaluate((tr) => [tr.getAttribute("role"), tr.getAttribute("aria-checked"), tr.querySelector("td[data-th='Select'] span").getAttribute("aria-label"), tr.querySelector("td[data-th='Select'] span").getAttribute("title")]), [null, null, "Select or deselect the row Acme", "Checkbox"]);
  await grid.locator("tbody tr").first().click();
  assert.equal(await dialog.locator(".modal-footer button.primary").isDisabled(), false);
  await dialog.locator(".modal-footer button.primary").click();
  await page.waitForSelector("#parentcustomerid_lookupmodal section.modal-lookup", { state: "hidden" });
  // Select writes the id and entity name (the name input's value property only), marks the id dirty
  // the platform's way and leaves the chosen row cleared; the closed dialog hides by style alone.
  assert.deepEqual(
    await page.evaluate(() => [document.getElementById("parentcustomerid").value, document.getElementById("parentcustomerid").getAttribute("class"), document.getElementById("parentcustomerid_entityname").value, document.getElementById("parentcustomerid_name").value, document.getElementById("parentcustomerid_name").getAttribute("value")]),
    [ACCOUNT, " dirty", "account", "Acme", null],
  );
  assert.deepEqual(await dialog.evaluate((el) => [el.className, el.getAttribute("aria-hidden"), el.hasAttribute("hidden"), el.style.display]), ["modal fade modal-lookup", "true", false, "none"]);
  assert.deepEqual(await grid.locator("tbody tr").first().evaluate((tr) => [tr.getAttribute("class"), tr.querySelector("td[data-th='Select']").innerHTML]), ["", ""]);
  await page.locator("button.clearlookupfield[aria-label*='Company']").click();
  assert.deepEqual(await page.evaluate(() => [document.getElementById("parentcustomerid").value, document.getElementById("parentcustomerid_entityname").value, document.querySelector("button.clearlookupfield[aria-label*='Company']").style.display]), ["", "", "none"]);

  // A success that keeps the form shows the Bootstrap 5 panel with its close button, and the
  // insert form re-renders with the posted value.
  await page.locator("#fullname").fill("Widget One");
  // The grids above fetched the shell token (live does too); drop it so only the postback could ask again.
  await page.evaluate(() => (document.getElementById("antiforgerytoken").innerHTML = ""));
  tokenRequests.length = 0;
  await Promise.all([page.waitForURL(`${app.url}/`), page.waitForEvent("load"), page.locator("#InsertButton").click()]);
  await page.waitForSelector("#MessagePanel");
  // The postback carries the page's local token: no token request for it (live makes none).
  assert.deepEqual(tokenRequests, []);
  assert.equal(await page.locator("#MessagePanel").getAttribute("class"), "message alert success alert alert-success");
  assert.equal(await page.locator("#MessagePanel #btnCloseMessage.btn-close").getAttribute("data-bs-dismiss"), "alert");
  assert.equal(await page.locator("#MessageLabel").innerText(), "Widget saved.");
  assert.equal(await page.locator("#fullname").getAttribute("value"), "Widget One");
  assert.match(await page.locator(".entity-form").first().getAttribute("class"), /^entity-form entity-form$/);
  assert.deepEqual(errors, []);
});
