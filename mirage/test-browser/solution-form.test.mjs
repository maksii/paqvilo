import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";
import { signInContext } from "../testing/session.mjs";
import { clientRuntime } from "../lib/platform.mjs";

async function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}
const metadata =
  '<Entity><Name>contact</Name><EntityInfo><entity><attributes><attribute PhysicalName="fullname"><Name>fullname</Name><LogicalName>fullname</LogicalName><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel><displaynames><displayname description="Name" languagecode="1033" /></displaynames></attribute><attribute PhysicalName="age"><Name>age</Name><LogicalName>age</LogicalName><Type>int</Type><RequiredLevel>none</RequiredLevel></attribute><attribute PhysicalName="parentcustomerid"><Name>parentcustomerid</Name><LogicalName>parentcustomerid</LogicalName><Type>lookup</Type><RequiredLevel>none</RequiredLevel></attribute></attributes></entity></EntityInfo></Entity>';
const form = (label) =>
  `<forms><systemform><formid>{contact-form}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><labels><label description="General" languagecode="1033" /></labels><columns><column width="100%"><sections><section name="main" showlabel="true"><labels><label description="Contact details" languagecode="1033" /></labels><rows><row><cell><labels><label description="${label}" languagecode="1033" /></labels><control id="fullname" datafieldname="fullname" /></cell></row><row><cell><labels><label description="Age" languagecode="1033" /></labels><control id="age" datafieldname="age" /></cell></row><row><cell><labels><label description="Organisation" languagecode="1033" /></labels><control id="parentcustomerid" datafieldname="parentcustomerid" /></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Portal contact" languagecode="1033" /></LocalizedNames></systemform></forms>`;
const view =
  '<savedqueries><savedquery><savedqueryid>{contact-view}</savedqueryid><layoutxml><grid><row id="contactid"><cell name="fullname" width="180" /><cell name="age" width="80" /></row></grid></layoutxml><fetchxml><fetch><entity name="contact"><attribute name="contactid"/><attribute name="fullname"/><attribute name="age"/><filter><condition attribute="age" operator="ge" value="18" /></filter></entity></fetch></fetchxml><LocalizedNames><LocalizedName description="Adults" languagecode="1033" /></LocalizedNames></savedquery></savedqueries>';
const SUCCESS = "Submission completed successfully.";

test("solution form layout creates typed data, saved view filters rows, and sources reload", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "solution-browser-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const portalRoot = path.join(root, "portal"),
    solutionRoot = path.join(root, "solution");
  await write(portalRoot, {
    "website.yml": "adx_websiteid: website\nadx_name: Test",
    "web-pages/home/Home.webpage.yml":
      "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    "page-templates/Main.pagetemplate.yml":
      "adx_pagetemplateid: template\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true",
    "web-templates/main/Main.webtemplate.yml":
      "adx_webtemplateid: main\nadx_name: Main",
    // The built-in entity_list include renders the native grid; rows load from the grid service.
    "web-templates/main/Main.webtemplate.source.html":
      "<h1>Contacts</h1>{% if request.params.id %}{% entityform name: \"Edit contact\" %}{% else %}{% entityform name: \"Create contact\" %}{% endif %}{% include 'entity_list' key: 'Adults' %}",
    "basic-forms/contact/Contact.basicform.yml":
      "adx_entityformid: contact-basic\nadx_name: Create contact\nadx_entityname: contact\nadx_formname: Portal contact\nadx_mode: 100000000\nadx_tabname: General",
    "basic-forms/contact/Edit.basicform.yml":
      "adx_entityformid: contact-edit\nadx_name: Edit contact\nadx_entityname: contact\nadx_formname: Portal contact\nadx_mode: 100000001\nadx_tabname: General",
    // Native custom JavaScript is the first child of the form control, so DOM access waits for ready.
    "basic-forms/contact/Contact.basicform.custom_javascript.js":
      "window.importedFormGreeting = \"{{ snippets['Greeting'] }}\";window.validationSummaryAtParse = document.querySelectorAll('.validation-summary').length;document.addEventListener('DOMContentLoaded',()=>document.querySelector('.validation-summary').insertAdjacentHTML('afterend','<div role=\"alert\" id=\"authored-validation\">Source validation message</div>'));",
    "content-snippets/Greeting.contentsnippet.yml":
      "adx_contentsnippetid: greeting\nadx_name: Greeting",
    "content-snippets/Greeting.contentsnippet.value.html": "Hello from source",
    "lists/Adults.list.yml":
      "adx_entitylistid: adults-list\nadx_name: Adults\nadx_entityname: contact\nadx_view: contact-view",
    "web-pages/private/Private.webpage.yml":
      "adx_webpageid: private-page\nadx_name: Private\nadx_partialurl: private\nadx_parentpageid: home",
    "web-roles/Private.webrole.yml":
      "adx_webroleid: private-reader\nadx_name: Private Reader",
    "webpage-access-control-rules/Private.webpageaccesscontrolrule.yml":
      "adx_webpageaccesscontrolruleid: private-rule\nadx_webpageid: private-page\nadx_name: Private page\nadx_right: 2\nadx_scope: 0\nadx_webpageaccesscontrolrule_webrole:\n  - private-reader",
    "web-files/head-order.js":
      'window.modalHeadSawForm = !!document.querySelector(".crmEntityFormView");',
    "web-files/head-order.js.webfile.yml":
      "adx_webfileid: head-order\nadx_name: head-order.js\nadx_partialurl: head-order.js\nadx_parentpageid: home\nfilename: head-order.js",
    "web-files/body-order.js":
      'window.modalBodySawForm = !!document.querySelector(".crmEntityFormView");',
    "web-files/body-order.js.webfile.yml":
      "adx_webfileid: body-order\nadx_name: body-order.js\nadx_partialurl: body-order.js\nadx_parentpageid: home\nfilename: body-order.js",
  });
  await write(solutionRoot, {
    "Entities/Contact/Entity.xml": metadata,
    "Entities/Contact/FormXml/main/{contact-form}.xml": form("Full name"),
    "Entities/Contact/SavedQueries/{contact-view}.xml": view,
  });
  const initial = {
    version: 1,
    mappings: {
      contact: {
        entitySet: "contacts",
        idColumn: "contactid",
        inferred: false,
        relationships: {
          parentcustomerid_account: {
            entity: "account",
            from: "parentcustomerid",
            to: "accountid",
            many: false,
          },
        },
      },
      account: {
        entitySet: "accounts",
        idColumn: "accountid",
        nameColumn: "name",
        inferred: false,
      },
    },
    tables: {
      contact: [{ contactid: "young", fullname: "Young contact", age: 12 }],
      account: [{ accountid: "org", name: "Local Organisation" }],
    },
    plugins: [],
    permissions: [],
    presets: {},
    settings: { permissionMode: "permissive" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: "editor", roles: ["Editor"] },
      live: { origin: null, allowWrites: false },
      endpoints: [],
      componentSchemas: {},
      externalAssets: false,
    },
  };
  const app = await createSimulator({
    sourceDir: portalRoot,
    solutionRoots: [solutionRoot],
    initial,
    watch: true,
  });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  // Portal requests are signed in explicitly as the configured Editor persona.
  const context = await browser.newContext();
  await signInContext(context, app, "editor", { roles: ["Editor"] });
  const page = await context.newPage();
  const errors = [],
    writes = [];
  page.on("request", (r) => {
    if (
      r.url().includes("/__sim/forms/") &&
      ["POST", "PATCH"].includes(r.method())
    )
      writes.push(r.postDataJSON().values);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.url);
  const summary = page.locator("#EntityFormPanel .validation-summary");
  assert.equal(await summary.count(), 1);
  assert.equal(await summary.isVisible(), false);
  assert.equal(await page.evaluate(() => window.validationSummaryAtParse), 0);
  assert.equal(await page.locator("#authored-validation").isVisible(), true);
  assert.equal(
    await page.locator("#authored-validation").innerText(),
    "Source validation message",
  );
  // Native sortable list headers carry aria-label too; scope label lookups to the form.
  const formPanel = page.locator("#EntityFormPanel");
  await formPanel.getByLabel("Full name").fill("Local Adult");
  await formPanel.getByLabel("Age").fill("42");
  // Native lookup: read-only name box, hidden id/entityname pair and a modal grid.
  const clearLookup = page.getByRole("button", {
    name: "Organisation Clear lookup field",
  });
  assert.equal(await clearLookup.isVisible(), false);
  await page
    .getByRole("button", { name: "Organisation Launch lookup modal" })
    .click();
  const lookupModal = page.locator("#parentcustomerid_lookupmodal section.modal-lookup");
  await lookupModal.locator('tr[data-name="Local Organisation"]').click();
  await lookupModal.getByRole("button", { name: "Select", exact: true }).click();
  assert.equal(
    await page.locator("#parentcustomerid_name").inputValue(),
    "Local Organisation",
  );
  assert.equal(await page.locator("#parentcustomerid").inputValue(), "org");
  assert.equal(
    await page.locator("#parentcustomerid_entityname").inputValue(),
    "account",
  );
  assert.equal(await clearLookup.isVisible(), true);
  assert.equal(await page.locator("table.section[data-name=main]").count(), 1);
  assert.equal(
    await page.evaluate(() => window.importedFormGreeting),
    "Hello from source",
  );
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  // Native postback: the page re-renders with the success message and hides the form.
  await page.locator("#MessageLabel").filter({ hasText: SUCCESS }).waitFor();
  assert.equal(await page.locator("#EntityFormPanel").isVisible(), false);
  const state = app.store.snapshot();
  const adult = state.tables.contact.find((r) => r.fullname === "Local Adult");
  assert.equal(adult.age, 42);
  assert.equal(
    writes[0]["parentcustomerid_account@odata.bind"],
    "/accounts(org)",
  );
  assert.equal(Object.hasOwn(writes[0], "parentcustomerid"), false);
  assert.deepEqual(adult.parentcustomerid, {
    id: "org",
    logical_name: "account",
    name: "Local Organisation",
  });
  await page.reload();
  const rows = page.locator("div.entitylist .view-grid tbody tr");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 1);
  assert.equal(
    await page.locator("div.entitylist .view-grid tbody").innerText(),
    "Local Adult\t42",
  );

  const modalState = app.store.snapshot();
  modalState.simulator.shellProfile = {
    stylesheets: [],
    headScripts: ["/head-order.js"],
    bodyScripts: ["/body-order.js", { src: "/body-order.js", defer: true }],
  };
  await app.store.replaceState(modalState);
  const modalPath =
    "/_portal/modal-form-template-path/website?entityformid=%7BCONTACT-BASIC%7D";
  const countBeforeModal = app.store.snapshot().tables.contact.length;
  const modal = await context.newPage();
  modal.on("pageerror", (e) => errors.push(e.message));
  const modalResponse = await modal.goto(app.url + modalPath);
  assert.equal(modalResponse.status(), 200);
  // Portal documents carry the site's HTTP/* headers; the loopback confinement policy is an
  // explicit opt-in (simulator.confinePortalPages).
  assert.equal(modalResponse.headers()["x-frame-options"], "SAMEORIGIN");
  assert.equal(modalResponse.headers()["content-security-policy"], undefined);
  assert.equal(app.store.snapshot().tables.contact.length, countBeforeModal);
  // Form.aspx: form#content_form > #EntityFormControl (static client id).
  assert.equal(
    await modal.locator("form#content_form #EntityFormControl #EntityFormControl_EntityFormView").count(),
    1,
  );
  assert.equal(await modal.locator("table.section[data-name=main]").count(), 1);
  assert.equal(
    await modal.evaluate(() => window.importedFormGreeting),
    "Hello from source",
  );
  assert.equal(await modal.evaluate(() => window.modalHeadSawForm), false);
  assert.equal(await modal.evaluate(() => window.modalBodySawForm), true);
  assert.equal(
    await modal.locator('body script[src="/body-order.js"][defer]').count(),
    1,
  );
  await modal.getByLabel("Full name").fill("Modal Adult");
  await modal.getByLabel("Age").fill("31");
  await modal.getByRole("button", { name: "Submit", exact: true }).click();
  await modal.locator("#MessageLabel").filter({ hasText: SUCCESS }).waitFor();
  const modalAdult = app.store
    .snapshot()
    .tables.contact.find((r) => r.fullname === "Modal Adult");
  assert.equal(modalAdult.age, 31);
  assert.equal(
    app.store.snapshot().tables.contact.length,
    countBeforeModal + 1,
  );
  for (const [route, status] of [
    [
      "/_portal/modal-form-template-path/00000000-0000-0000-0000-000000000000?entityformid=contact-basic",
      200,
    ],
    [
      "/_portal/modal-form-template-path/00000000-0000-0000-0000-000000000000?entityformid=contact-basic&pageid=private-page",
      403,
    ],
    [
      "/_portal/modal-form-template-path/wrong-website?entityformid=contact-basic",
      404,
    ],
    ["/_portal/modal-form-template-path/website?entityformid=missing", 404],
    [
      "/_portal/modal-form-template-path/website?entityformid=contact-basic&pageid=missing",
      404,
    ],
    [
      "/_portal/modal-form-template-path/website?entityformid=contact-basic&pageid=private-page",
      403,
    ],
  ])
    assert.equal((await fetch(app.url + route)).status, status, route);
  const revision = app.state().status.revision;
  await fs.writeFile(
    path.join(solutionRoot, "Entities/Contact/FormXml/main/{contact-form}.xml"),
    form("Renamed full name"),
  );
  await page.waitForFunction(
    () =>
      document.querySelector("label[for=fullname]")?.textContent ===
      "Renamed full name",
  );
  assert.ok(app.state().status.revision > revision);
  await page.goto(app.url + "?id=" + adult.contactid).catch((error) => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
  await page.waitForFunction(
    () => document.querySelector("#EntityFormPanel #EntityFormControl_contactedit_EntityFormView_EntityID")?.value,
  );
  assert.equal(
    await page.locator("#parentcustomerid_name").inputValue(),
    "Local Organisation",
  );
  await page
    .getByRole("button", { name: "Organisation Clear lookup field" })
    .click();
  assert.equal(await page.locator("#parentcustomerid_name").inputValue(), "");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.locator("#MessageLabel").filter({ hasText: SUCCESS }).waitFor();
  assert.equal(writes[1]["parentcustomerid_account@odata.bind"], null);
  assert.equal(
    app.store
      .snapshot()
      .tables.contact.find((r) => r.contactid === adult.contactid)
      .parentcustomerid,
    null,
  );
  // Native modal postbacks navigate the frame, so source parent load handlers see
  // completion, and Form.aspx posts "Success" to the parent window.
  await modal.goto(app.url + "/");
  await modal.evaluate((src) => {
    window.formFrameLoads = 0;
    window.frameMessages = [];
    window.addEventListener("message", (event) => window.frameMessages.push(event.data));
    const frame = document.createElement("iframe");
    frame.id = "native-modal-frame";
    frame.addEventListener("load", () => {
      window.formFrameLoads += 1;
    });
    frame.src = src;
    document.body.append(frame);
  }, modalPath);
  await modal.waitForFunction(() => window.formFrameLoads >= 1);
  const frame = await (
    await modal.locator("#native-modal-frame").elementHandle()
  ).contentFrame();
  await frame.getByLabel("Renamed full name").fill("Frame Adult");
  await frame.getByLabel("Age").fill("45");
  await frame.getByRole("button", { name: "Submit", exact: true }).click();
  await modal.waitForFunction(() => window.formFrameLoads >= 2);
  await modal.waitForFunction(() => window.frameMessages.includes("Success"));
  assert.equal(
    await frame.locator("#MessageLabel").innerText(),
    SUCCESS,
  );
  assert.equal(await frame.locator("#EntityFormPanel").isVisible(), false);
  const savedFrame = app.store
    .snapshot()
    .tables.contact.find((r) => r.fullname === "Frame Adult");
  assert.equal(savedFrame.age, 45);
  assert.equal(
    await frame.locator("#EntityFormControl_EntityFormView_EntityID").inputValue(),
    savedFrame.contactid,
  );
  await modal.goto(app.url + modalPath);
  const childStreams = [];
  const extraTopStreams = [];
  modal.on("request", (request) => {
    if (new URL(request.url()).pathname === "/__sim/events")
      (request.frame() !== modal.mainFrame()
        ? childStreams
        : extraTopStreams
      ).push(request.url());
  });
  await modal.evaluate(
    (source) => {
      (0, eval)(source);
      (0, eval)(source);
    },
    clientRuntime("token", "repeated-bootstrap"),
  );
  await modal.evaluate((src) => {
    window.lookupFramesLoaded = 0;
    for (let index = 0; index < 8; index++) {
      const child = document.createElement("iframe");
      child.id = "connection-pool-frame-" + index;
      child.src = src;
      child.addEventListener("load", () => {
        window.lookupFramesLoaded++;
      });
      document.body.append(child);
    }
  }, modalPath);
  await modal.waitForFunction(
    () => window.lookupFramesLoaded === 8,
    {},
    { timeout: 10000 },
  );
  assert.deepEqual(childStreams, []);
  assert.deepEqual(extraTopStreams, []);
  assert.equal(
    (await modal.request.get(app.url + "/__sim/api/state")).status(),
    200,
  );
  await modal.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide")),
  );
  assert.equal(
    await modal.evaluate(() => window.__portalSimulation.reloadStream),
    null,
  );
  await modal.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow"));
    window.dispatchEvent(new PageTransitionEvent("pageshow"));
  });
  await modal.waitForFunction(
    () => window.__portalSimulation.reloadStream.readyState === 1,
  );
  assert.equal(extraTopStreams.length, 1);
  assert.deepEqual(errors, []);
});
