import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

const require = createRequire(import.meta.url);
const SITE = "6a2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d";
const CONTACT = "c1000000-0000-4000-8000-000000000001";
const ACCOUNTS = ["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000002", "a1000000-0000-4000-8000-000000000003"];

test("native client runtime: WebForms validators, jQuery grid events, paging and the lookup modal", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-runtime-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Synthetic fixture: the portal's own jQuery is a source web file; nothing leaves loopback.
  const jquery = await fs.readFile(path.join(path.dirname(require.resolve("jquery/package.json")), "dist", "jquery.min.js"));
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Runtime`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    "Main.pagetemplate.yml": "adx_pagetemplateid: template\nadx_webtemplateid: main",
    "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "Main.webtemplate.source.html": `<script src="/jquery.min.js"></script>{% include 'entity_list' key: 'Accounts' %}{% entityform name: "Edit contact" %}`,
    "jquery.min.js.webfile.yml": "adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js",
    "Accounts.list.yml": "adx_entitylistid: 1c000000-0000-4000-8000-000000000001\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 1\nadx_searchenabled: true",
    "Edit.basicform.yml": "adx_entityformid: 2c000000-0000-4000-8000-000000000001\nadx_name: Edit contact\nadx_entityname: contact\nadx_mode: 100000001",
    "Edit.basicform.custom_javascript.js": "$(document).ready(function(){window.validatorCount=Page_Validators.length;$(document).ajaxComplete(function(_e,xhr,settings){if(/entity-(grid|lookup-grid)-data\\.json/.test(settings.url))(window.gridResponses=window.gridResponses||[]).push(xhr.responseJSON.PageNumber+'/'+xhr.responseJSON.ItemCount);});$('.entity-grid.entitylist').on('loaded',function(){window.listLoads=(window.listLoads||0)+1;});$('#parentcustomerid_lookupmodal section.modal').on('show.bs.modal',function(){window.lookupShown=(window.lookupShown||0)+1;});});",
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, "jquery.min.js"), jquery);
  const initial = {
    version: 1,
    mappings: {
      contact: {
        entitySet: "contacts",
        idColumn: "contactid",
        nameColumn: "fullname",
        relationships: { parentcustomerid_account: { entity: "account", from: "parentcustomerid", to: "accountid", many: false } },
      },
      account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" },
    },
    tables: {
      contact: [{ contactid: CONTACT, fullname: "Ada" }],
      account: ACCOUNTS.map((accountid, index) => ({ accountid, name: ["Alpha", "Beta", "Gamma"][index] })),
    },
    permissions: [],
    settings: { permissionMode: "permissive" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: CONTACT, contactId: CONTACT, fullname: "Ada", roles: ["Editor"] },
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        Accounts: { entity: "account", fields: [{ name: "name", label: "Account name" }] },
        "2c000000-0000-4000-8000-000000000001": {
          entity: "contact",
          mode: 100000001,
          fields: [
            { name: "fullname", label: "Full name", required: true },
            { name: "parentcustomerid", label: "Organisation", type: "lookup" },
          ],
        },
      },
    },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), initial, watch: false });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith(app.url) && !request.url().startsWith("data:")) external.push(request.url());
  });
  await page.goto(`${app.url}/?id=${CONTACT}`);
  // List: rows arrive through jQuery.ajax, raise "loaded" and page natively.
  await page.waitForFunction(() => window.listLoads >= 1);
  const list = page.locator("div.entitylist .entity-grid.entitylist");
  assert.equal(await list.locator(".view-grid tbody tr").count(), 1);
  assert.equal(await list.locator(".view-grid tbody tr td[data-attribute=name]").getAttribute("data-value"), "Alpha");
  assert.deepEqual(await page.evaluate(() => window.gridResponses), ["1/3"]);
  await list.locator(".view-pagination ul.pagination a.entity-pager-next-link").click();
  await page.waitForFunction(() => window.listLoads >= 2);
  assert.equal(await list.locator(".view-grid tbody tr td[data-attribute=name]").getAttribute("data-value"), "Beta");
  // Authored code refreshes a grid with the native jQuery "refresh" event.
  await page.evaluate(() => $(".entity-grid.entitylist").trigger("refresh"));
  await page.waitForFunction(() => window.listLoads >= 3);
  assert.equal(await list.locator(".view-grid tbody tr").count(), 1);
  // Quick search re-queries page 1 with begins-with semantics.
  await list.locator(".view-search input.query").fill("Ga");
  await list.locator(".view-search input.query").press("Enter");
  await page.waitForFunction(() => window.gridResponses.at(-1) === "1/1");
  assert.equal(await list.locator(".view-grid tbody tr td[data-attribute=name]").getAttribute("data-value"), "Gamma");

  // WebForms validation globals: required validator, summary and ValidatorEnable.
  assert.equal(await page.evaluate(() => window.validatorCount), 1);
  await page.locator("#fullname").fill("");
  assert.equal(await page.evaluate(() => Page_ClientValidate("")), false);
  // Invalid validation schedules focus on the summary; observe it before moving on.
  await page.waitForFunction(() => document.activeElement === document.querySelector(".validation-summary a"));
  const summary = page.locator("#EntityFormPanel .validation-summary");
  assert.equal(await summary.isVisible(), true);
  assert.match(await summary.innerText(), /The form could not be submitted for the following reasons:/);
  assert.match(await summary.locator("a").first().innerText(), /Full name is a required field\./);
  assert.equal(await page.evaluate(() => { ValidatorEnable(document.getElementById("RequiredFieldValidatorfullname"), false); return Page_ClientValidate(""); }), true);
  await page.evaluate(() => ValidatorEnable(document.getElementById("RequiredFieldValidatorfullname"), true));
  await page.locator("#fullname").fill("Ada Lovelace");

  // Lookup modal: show.bs.modal, lookup grid service, row selection and footer Select.
  await page.evaluate(() => document.addEventListener("click", (event) => { if (event.target.closest?.(".launchentitylookup")) window.lookupClicks = (window.lookupClicks || 0) + 1; }, true));
  await page.getByRole("button", { name: "Organisation Launch lookup modal" }).click();
  const modal = page.locator("#parentcustomerid_lookupmodal section.modal-lookup");
  try {
    await modal.locator('tr[data-name="Beta"]').waitFor();
  } catch (error) {
    t.diagnostic(JSON.stringify(await page.evaluate(() => {
      const modal = document.querySelector("#parentcustomerid_lookupmodal section.modal-lookup");
      return {
        shown: window.lookupShown,
        clicks: window.lookupClicks,
        scroll: [window.scrollX, window.scrollY],
        active: document.activeElement?.id || document.activeElement?.className,
        responses: window.gridResponses,
        modal: { classes: modal?.className, hidden: modal?.hidden, display: modal?.style.display, text: modal?.textContent },
      };
    })));
    t.diagnostic(JSON.stringify({ errors, external }));
    throw error;
  }
  assert.equal(await page.evaluate(() => window.lookupShown), 1);
  assert.equal(await modal.locator(".modal-footer button.primary").isDisabled(), true);
  await modal.locator('tr[data-name="Beta"]').click();
  assert.equal(await modal.locator('tr[data-name="Beta"]').getAttribute("aria-checked"), "true");
  await modal.locator(".modal-footer button.primary").click();
  await modal.waitFor({ state: "hidden" });
  assert.deepEqual(
    await page.evaluate(() => [$("#parentcustomerid").val(), $("#parentcustomerid_name").val(), $("#parentcustomerid_entityname").val()]),
    [ACCOUNTS[1], "Beta", "account"],
  );
  assert.ok((await page.evaluate(() => window.gridResponses)).includes("1/3"));
  // Native postback: success message after the page re-renders.
  await page.locator("#UpdateButton").click();
  await page.locator("#MessageLabel").filter({ hasText: "Submission completed successfully." }).waitFor();
  const saved = app.store.snapshot().tables.contact[0];
  assert.equal(saved.fullname, "Ada Lovelace");
  assert.equal(saved.parentcustomerid.id, ACCOUNTS[1]);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
