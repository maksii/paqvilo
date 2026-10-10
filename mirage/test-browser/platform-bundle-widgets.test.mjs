import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

const SITE = "8b3c4d5e-2f30-4b6c-9d7e-8f9a0b1c2d3e";
const ACCOUNTS = ["a2000000-0000-4000-8000-000000000001", "a2000000-0000-4000-8000-000000000002"];

// Synthetic portal: a list with a row action and an authored script that uses jQuery UI
// widgets from the platform's preform bundle. Nothing leaves loopback.
test("platform bundle equivalents: the row action menu opens below its button, jQuery UI datepicker and tabs work", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-bundle-widgets-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settings = JSON.stringify({ ItemActions: [{ Type: "CrmEntityFormView-DeleteAction", Label: "Remove" }] });
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Widgets`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    "Main.pagetemplate.yml": "adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true",
    "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "Main.webtemplate.source.html":
      "<style>.dropdown-menu{display:none}.open>.dropdown-menu{display:block}</style>" +
      '<input type="text" id="reportDate"><div id="tabs"><ul><li><a href="#first">First</a></li><li><a href="#second">Second</a></li></ul><div id="first">One</div><div id="second">Two</div></div>' +
      "{% include 'entity_list' key: 'Accounts' %}<div style=\"height:3000px\"></div>" +
      // Authored scripts use the widgets once the document is ready, after the platform bundles load.
      "<script>$(function(){ $('#reportDate').datepicker({ dateFormat: 'dd-mm-yy', minDate: '+1D' }); $('#tabs').tabs(); });</script>",
    "Accounts.list.yml": `adx_entitylistid: 1d000000-0000-4000-8000-000000000001\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 5\nadx_settings: '${settings}'`,
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, "state.json"),
    watch: false,
    initial: {
      version: 1,
      mappings: { account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" } },
      tables: { account: ACCOUNTS.map((accountid, index) => ({ accountid, name: ["Alpha", "Beta"][index] })) },
      permissions: [],
      settings: { permissionMode: "permissive" },
      simulator: { mode: "local", pageMode: "local", identityScope: "configured", identity: { id: null, roles: [] }, live: { origin: null }, endpoints: [], componentSchemas: { Accounts: { entity: "account", fields: [{ name: "name", label: "Account name" }] } } },
    },
  });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(app.url + "/");
  const row = page.locator(`.entity-grid tr[data-id="${ACCOUNTS[0]}"]`);
  await row.waitFor();
  const toggle = row.locator(".dropdown.action > button");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  const placement = await row.locator(".dropdown.action").evaluate((container) => {
    const menu = container.querySelector(".dropdown-menu");
    const box = container.getBoundingClientRect();
    // The placement sets the menu's own top and left; the menu's margin is the stylesheet's.
    return { position: getComputedStyle(menu).position, open: container.classList.contains("open"), top: Math.round(parseFloat(menu.style.top) - (box.top + container.offsetHeight)) || 0, left: Math.round(parseFloat(menu.style.left) - box.left) || 0 };
  });
  assert.deepEqual(placement, { position: "fixed", open: true, top: 0, left: 0 });
  assert.equal(await row.getByText("Remove", { exact: true }).isVisible(), true);
  // Scrolling the window closes an open action menu.
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => !document.querySelector(".entity-grid .dropdown.action.open"));
  // jQuery UI datepicker and tabs from the preform bundle's local equivalent.
  const widgets = await page.evaluate(() => {
    const $ = window.jQuery;
    $("#reportDate").datepicker("setDate", new Date(2026, 9, 20));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    $("#reportDate").datepicker("show");
    const chooser = document.querySelector(".paqvilo-mirage-datepicker-chooser");
    document.querySelector('#tabs a[href="#second"]').click();
    return {
      value: $("#reportDate").val(),
      date: $("#reportDate").datepicker("getDate").getDate(),
      min: chooser.min === `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`,
      formatted: $.datepicker.formatDate("DD, d MM yy", new Date(2026, 9, 8)),
      tabs: [getComputedStyle(document.getElementById("first")).display, getComputedStyle(document.getElementById("second")).display, $("#tabs").tabs("option", "active")],
    };
  });
  assert.deepEqual(widgets, { value: "20-10-2026", date: 20, min: true, formatted: "Thursday, 8 October 2026", tabs: ["none", "block", 1] });
  assert.deepEqual(errors, []);
});
