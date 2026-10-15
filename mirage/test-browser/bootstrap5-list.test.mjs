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
const SITE = "7c2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c4e";
const CONTACT = "c3000000-0000-4000-8000-000000000011";
const LIST = "3d000000-0000-4000-8000-000000000011";
const CREATE = "3e000000-0000-4000-8000-000000000011";
const account = (index, extra = {}) => ({ accountid: `a3000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`, name: `Account ${index}`, ...extra });

// Invented Bootstrap 5 site (Site/BootstrapV5Enabled) with one account list: three rows per
// page, search, a create page and item actions. Nothing leaves loopback.
test("Bootstrap 5 lists: platform toolbar, record cells, row menus, pager and empty search", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap5-list-browser-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const jquery = await fs.readFile(path.join(path.dirname(require.resolve("jquery/package.json")), "dist", "jquery.min.js"));
  const settings = {
    ViewActions: [{ Type: "CrmEntityFormView-CreateAction", TargetType: 1, RedirectWebpageId: CREATE, ButtonLabel: [{ LCID: 1033, Value: "New account" }] }],
    ItemActions: [
      { Type: "CrmEntityFormView-DetailsAction", TargetType: 1, RedirectWebpageId: CREATE, ButtonLabel: [{ LCID: 1033, Value: "View" }] },
      { Type: "CrmEntityFormView-EditAction", TargetType: 1, RedirectWebpageId: CREATE, ButtonLabel: [{ LCID: 1033, Value: "Edit" }] },
    ],
  };
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Accounts`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: list",
    "Create.webpage.yml": `adx_webpageid: ${CREATE}\nadx_name: Create\nadx_partialurl: create\nadx_parentpageid: home\nadx_pagetemplateid: list`,
    "ListPage.pagetemplate.yml": "adx_pagetemplateid: list\nadx_webtemplateid: listcontent",
    "ListContent.webtemplate.yml": "adx_webtemplateid: listcontent\nadx_name: List content",
    "ListContent.webtemplate.source.html": `<script src="/jquery.min.js"></script><script src="/resource/powerappsportal/dist/app.BootstrapV5.bundle.js"></script>{% include 'entity_list' key: 'Accounts' %}`,
    "Accounts.list.yml": `adx_entitylistid: ${LIST}\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 3\nadx_searchenabled: true\nadx_webpageforcreate: ${CREATE}\nadx_createbuttonlabel: New account\nadx_settings: '${JSON.stringify(settings)}'`,
    "jquery.min.js.webfile.yml": "adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js",
    "sitesetting.yml": '- adx_sitesettingid: 5e300000-0000-4000-8000-000000000011\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, "jquery.min.js"), jquery);
  const initial = {
    version: 1,
    mappings: { account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" } },
    tables: { contact: [{ contactid: CONTACT, fullname: "Grace" }], account: [account(1, { city: "Oslo" }), account(2), account(3, { city: "Rome" }), account(4)] },
    permissions: [{ id: "account", entity: "account", scope: "global", roles: ["Member"], operations: ["read", "update"] }],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: CONTACT, contactId: CONTACT, roles: ["Member"] },
      live: { origin: null },
      endpoints: [],
      componentSchemas: { Accounts: { entity: "account", fields: [{ name: "name", label: "Name" }, { name: "city", label: "City" }] } },
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(`${app.url}/`);
  const grid = page.locator(".entity-grid");
  await grid.locator("tbody tr").first().waitFor();

  // Toolbar: the create page button, then search and the configured create action.
  assert.equal(await grid.locator(".view-toolbar > a.btn.insert-Action-link.btn-primary.float-end.action").getAttribute("title"), "Create");
  assert.equal(await grid.locator(".view-toolbar > .float-end.toolbar-actions > .input-group.float-start > a.create-action").getAttribute("role"), "link");
  assert.equal(await grid.locator(":scope > #SearchCountTextnull.visually-hidden").innerText(), "4 records found");
  assert.equal(await grid.locator(".view-grid > table").getAttribute("class"), "table");
  assert.match(await grid.locator("thead th").first().getAttribute("style"), /^width:\d+(\.\d+)?%;$/);

  // Cells: an absent value is an unlabelled cell; the primary link opens the edit page.
  const second = grid.locator("tbody tr").nth(1);
  assert.deepEqual(await second.locator("td").nth(1).evaluate((cell) => cell.getAttributeNames().sort()), ["aria-label", "data-th"]);
  const link = grid.locator("tbody tr").first().locator("td").first().locator("a.details-link");
  assert.deepEqual([await link.getAttribute("data-bs-toggle"), await link.getAttribute("title")], ["tooltip", "View details"]);
  const menu = grid.locator("tbody tr").first().locator(".dropdown.action");
  assert.equal(await menu.locator("button").getAttribute("class"), "btn btn-default btn-md aria-exp");
  assert.equal(await menu.locator("a.details-link").getAttribute("class"), "details-link dropdown-item");

  // Pager: Bootstrap 5 page items with < and >.
  assert.deepEqual(await grid.locator(".view-pagination .pagination li").evaluateAll((items) => items.map((item) => [item.className, item.textContent])), [
    ["page-item disabled", "<"],
    ["page-item active", "1"],
    ["page-item", "2"],
    ["page-item", ">"],
  ]);

  // A search without results drops a leading wildcard, removes the body and announces the empty message.
  await grid.locator("input.query").fill("*Zzz");
  assert.equal(await grid.locator("input.query").inputValue(), "Zzz");
  await grid.locator("input.query").press("Enter");
  await grid.locator(".view-empty[role='status']").waitFor();
  assert.equal(await grid.locator(".view-grid table tbody").count(), 0);
  assert.equal(await grid.locator(".view-pagination").evaluate((pager) => pager.style.display), "none");
  assert.equal(await grid.locator(".view-pagination li").count(), 4);
  assert.deepEqual(errors, []);
});
