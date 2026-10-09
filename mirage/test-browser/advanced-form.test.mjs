import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

test("advanced form validates, saves a record, and advances to a persisted edit step", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "advanced-form-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_websiteid: website\nadx_name: Test",
    "Home.webpage.yml":
      "adx_webpageid: home\nadx_name: Wizard\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    "Main.pagetemplate.yml":
      "adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true",
    "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "Main.webtemplate.source.html": '{% webform name: "Contact wizard" %}',
    "Wizard.advancedform.yml":
      "adx_webformid: wizard\nadx_name: Contact wizard",
    "Complete.webpage.yml":
      "adx_webpageid: complete\nadx_name: Complete\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: complete\nadx_pagetemplateid: template",
  };
  for (const [name, content] of Object.entries(files))
    await fs.writeFile(path.join(root, name), content);
  const initial = {
    mappings: {
      contact: {
        entitySet: "contacts",
        idColumn: "contactid",
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
      },
    },
    tables: {
      contact: [],
      account: [
        {
          accountid: "11111111-1111-1111-1111-111111111111",
          name: "Local organization",
        },
      ],
    },
    plugins: [
      {
        id: "block-name",
        entity: "contact",
        operations: ["create"],
        validate: [
          {
            field: "fullname",
            pattern: "^(?!Blocked$).+",
            message: "The name is blocked.",
          },
        ],
      },
    ],
    permissions: [],
    settings: { permissionMode: "permissive" },
    presets: {},
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: "editor", roles: ["Editor"] },
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        wizard: {
          initialStepId: "create",
          steps: [
            {
              stepId: "create",
              nextStepId: "edit",
              entity: "contact",
              title: "Create contact",
              mode: 100000000,
              fields: [
                { name: "fullname", label: "Name", required: true },
                {
                  name: "optionalchoice",
                  label: "Optional choice",
                  type: "number",
                  options: [{ value: 1, label: "Yes" }],
                },
                {
                  name: "parentcustomerid",
                  label: "Customer",
                  type: "lookup",
                  lookupStyle: "dropdown",
                },
              ],
            },
            {
              stepId: "edit",
              nextStepId: "redirect",
              submitLabel: "Submit",
              entity: "contact",
              title: "Edit contact",
              mode: 100000001,
              fields: [
                { name: "fullname", label: "Name", required: true },
                { name: "age", label: "Age", type: "number" },
                {
                  name: "optionalchoice",
                  label: "Optional choice",
                  type: "number",
                  options: [{ value: 1, label: "Yes" }],
                },
              ],
            },
            {
              stepId: "redirect",
              type: "redirect",
              redirectUrl: "/complete/",
              appendRecordId: true,
              recordQueryName: "id",
            },
          ],
        },
      },
    },
  };
  initial.simulator.componentSchemas.wizard.steps[0].fields.push(
    { name: "optionalhidden", hidden: true },
    { name: "meaningfulhidden", hidden: true, default: "backend-context" },
    { name: "disabledcount", type: "number", default: 99 },
    {
      name: "disabledchoice",
      type: "number",
      options: [{ value: 1, label: "One" }],
      readOnly: true,
    },
  );
  // Native step JavaScript precedes the form markup, so DOM access waits for ready.
  initial.simulator.componentSchemas.wizard.steps[0].js =
    'window.stepScriptSawField=!!document.getElementById("fullname");document.addEventListener("DOMContentLoaded",()=>{document.getElementById("disabledcount").disabled=true;document.getElementById("parentcustomerid").value="11111111-1111-1111-1111-111111111111";const ui=document.createElement("input");ui.type="number";ui.name="no-autofill";ui.value="123";document.querySelector("#WebFormPanel").append(ui);});';
  const app = await createSimulator({ sourceDir: root, initial, watch: false });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage(),
    errors = [],
    writes = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (
      r.url().includes("/__sim/forms/") &&
      ["POST", "PATCH"].includes(r.method())
    )
      writes.push(r.postDataJSON().values);
  });
  await page.goto(app.url);
  assert.equal(await page.evaluate(() => window.stepScriptSawField), false);
  assert.equal(await page.locator("#WebFormControl_wizard #WebFormPanel.crmEntityFormView #EntityFormView.entity-form").count(), 1);
  // Authored native forms may repeat a logical binding in an administration tab.
  // Source getElementById updates the first binding; a blank duplicate must not erase it.
  await page.evaluate(() => {
    const panel = document.querySelector("#WebFormPanel");
    for (const id of ["fullname", "meaningfulhidden"]) {
      const duplicate = document.createElement("input");
      duplicate.name = document.getElementById(id).name;
      duplicate.value = "";
      panel.append(duplicate);
    }
  });
  await page.getByLabel("Name", { exact: true }).fill("Blocked");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  // LiquidServerControl writes the save failure above the page; the form keeps its values.
  await page
    .locator("div.alert.alert-block.alert-danger p.text-danger")
    .filter({ hasText: "The name is blocked." })
    .waitFor();
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Blocked");
  assert.equal(app.store.snapshot().tables.contact.length, 0);
  assert.equal(new URL(page.url()).searchParams.has("stepid"), false);
  await page.getByLabel("Name", { exact: true }).fill("Local Person");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForURL(/stepid=edit/);
  assert.equal(Object.hasOwn(writes[0], "optionalchoice"), false);
  await page.getByLabel("Optional choice").selectOption("1");
  await page.getByLabel("Optional choice").selectOption("");
  // Browsers post only enabled controls: the script-disabled count is not saved.
  assert.deepEqual(writes[1], {
    fullname: "Local Person",
    meaningfulhidden: "backend-context",
    "parentcustomerid_account@odata.bind":
      "/accounts(11111111-1111-1111-1111-111111111111)",
  });
  assert.equal(Object.hasOwn(app.store.snapshot().tables.contact[0], "disabledcount"), false);
  await page.getByLabel("Age", { exact: true }).fill("38");
  assert.equal(
    await page.getByLabel("Name", { exact: true }).inputValue(),
    "Local Person",
  );
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.waitForURL(/\/complete\/\?id=/);
  const rows = app.store.snapshot().tables.contact;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].age, 38);
  assert.equal(writes.at(-1).optionalchoice, null);
  assert.equal(rows[0].optionalchoice, null);
  assert.equal(rows[0].meaningfulhidden, "backend-context");
  assert.equal(Object.hasOwn(rows[0], "optionalhidden"), false);
  assert.equal(rows[0].contactid, new URL(page.url()).searchParams.get("id"));
  assert.deepEqual(errors, []);
});
