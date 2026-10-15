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
/** The invented list site in a browser: the page, its grid and the collected page errors. */
// The create privilege enables the create links (live: without it they render disabled).
async function launch(t, { search = true, configured = true, operations = ["read", "create", "update", "delete"] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap5-list-browser-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const jquery = await fs.readFile(path.join(path.dirname(require.resolve("jquery/package.json")), "dist", "jquery.min.js"));
  const settings = {
    ViewActions: [{ Type: "CrmEntityFormView-CreateAction", TargetType: 1, RedirectWebpageId: CREATE, ButtonLabel: [{ LCID: 1033, Value: "New account" }] }],
    ItemActions: [
      { Type: "CrmEntityFormView-DetailsAction", TargetType: 1, RedirectWebpageId: CREATE, ButtonLabel: [{ LCID: 1033, Value: "View" }] },
      { Type: "CrmEntityFormView-EditAction", TargetType: 1, RedirectWebpageId: CREATE, ButtonLabel: [{ LCID: 1033, Value: "Edit" }] },
      { Type: "CrmEntityFormView-DeleteAction", ButtonLabel: [{ LCID: 1033, Value: "Delete" }] },
    ],
  };
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Accounts`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: list",
    "Create.webpage.yml": `adx_webpageid: ${CREATE}\nadx_name: Create\nadx_partialurl: create\nadx_parentpageid: home\nadx_pagetemplateid: list`,
    "ListPage.pagetemplate.yml": "adx_pagetemplateid: list\nadx_webtemplateid: listcontent",
    "ListContent.webtemplate.yml": "adx_webtemplateid: listcontent\nadx_name: List content",
    "ListContent.webtemplate.source.html": `<script src="/jquery.min.js"></script><script src="/resource/powerappsportal/dist/app.BootstrapV5.bundle.js"></script>{% include 'entity_list' key: 'Accounts' %}`,
    "Accounts.list.yml": `adx_entitylistid: ${LIST}\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 3\nadx_searchenabled: ${search}\nadx_webpageforcreate: ${CREATE}\nadx_createbuttonlabel: New account${configured ? `\nadx_settings: '${JSON.stringify(settings)}'` : ""}`,
    "jquery.min.js.webfile.yml": "adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js",
    "sitesetting.yml": '- adx_sitesettingid: 5e300000-0000-4000-8000-000000000011\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, "jquery.min.js"), jquery);
  const initial = {
    version: 1,
    mappings: { account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" } },
    tables: { contact: [{ contactid: CONTACT, fullname: "Grace" }], account: [account(1, { city: "Oslo" }), account(2), account(3, { city: "Rome" }), account(4)] },
    permissions: [{ id: "account", entity: "account", scope: "global", roles: ["Member"], operations }],
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
  const gridBodies = [];
  page.on("request", (request) => request.url().includes("/_services/entity-grid-data.json/") && gridBodies.push(request.postDataJSON()));
  await page.route("**/*", (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(`${app.url}/`);
  const grid = page.locator(".entity-grid");
  return { page, grid, errors, gridBodies };
}

test("Bootstrap 5 lists: platform toolbar, record cells, row menus, pager and empty search", async (t) => {
  const { page, grid, errors, gridBodies } = await launch(t);
  await grid.locator("tbody tr").first().waitFor();
  // The entity_list template's grid posts its (empty) data-nl-search-filter (live requests).
  assert.equal(gridBodies[0].nlSearchFilter, "");

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

  // Opening a dialog appends the Bootstrap 5 status announcer to the body.
  assert.equal(await page.locator("#modal-status-announcer").count(), 0);
  await menu.locator("a.delete-link").evaluate((link) => link.click());
  await grid.locator(".modal-delete.show").waitFor();
  assert.equal(await page.locator("body > .modal-backdrop + #modal-status-announcer.sr-only[role='status']").innerText(), "Dialog opened");
  await page.keyboard.press("Escape");

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

// A list without search or grid settings: the record-count announcer still follows the grid and the
// dialogs carry the platform defaults.
test("Bootstrap 5 lists without settings: announcer and default dialogs", async (t) => {
  const { grid, errors } = await launch(t, { search: false, configured: false });
  await grid.locator("tbody tr").first().waitFor();
  assert.equal(await grid.getAttribute("data-column-width-style"), "");
  assert.equal(await grid.locator(":scope > #SearchCountTextnull.visually-hidden").innerText(), "4 records found");
  assert.equal(await grid.locator(".modal-form-insert .form-loading > span.fa-spinner.fa-spin.fa-4x").count(), 1);
  assert.equal(await grid.locator(".modal-error .modal-body > p").innerText(), "We're sorry, an error has occurred.");
  assert.equal(await grid.locator(".modal-deactivate .modal-body > p").innerText(), "Are you sure you want to deactivate this record?");
  assert.equal(await grid.locator(".modal-resolvecase input.resolution-input").getAttribute("aria-label"), "Resolution (required)");
  assert.deepEqual(await grid.locator(".modal-delete .modal-footer button").evaluateAll((els) => els.map((el) => el.className)), ["primary btn btn-primary ", "cancel btn btn-default "]);
  assert.deepEqual(errors, []);
});

// A list the user may not read: the access-denied message, no record-count announcer and a hidden pager (live DOM).
test("Bootstrap 5 lists without read permission: access denied, no announcer, hidden pager", async (t) => {
  const { grid, errors } = await launch(t, { operations: ["update"] });
  await grid.locator(".view-access-denied").waitFor({ state: "visible" });
  assert.equal(await grid.locator("[id^='SearchCountText']").count(), 0);
  assert.equal(await grid.locator(".view-pagination").evaluate((pager) => pager.style.display), "none");
  assert.deepEqual(errors, []);
});

// Sorting re-marks the existing header in place (live DOM): the clicked column gets "sort-asc sort"
// and a bare arrow, the previous column loses its arrow and classes, hints stay, links keep style="".
test("Bootstrap 5 lists: a header sort re-marks the header in place", async (t) => {
  const { grid, errors, gridBodies } = await launch(t);
  await grid.locator("tbody tr").first().waitFor();
  const headers = grid.locator("thead th");
  // Sort by Name, then by City: Name loses its arrow and classes but keeps its text and hint.
  await headers.nth(0).locator("a").click();
  await grid.locator("thead th.sort-asc").nth(0).waitFor();
  await grid.page().waitForFunction(() => document.querySelector(".entity-grid thead th a")?.getAttribute("style") === "");
  await headers.nth(1).locator("a").click();
  await grid.page().waitForFunction(() => document.querySelectorAll(".entity-grid thead th")[1].classList.contains("sort"));
  await grid.locator("thead th.sort-asc").nth(0).waitFor();
  await grid.page().waitForFunction(() => document.querySelector(".entity-grid thead th a")?.getAttribute("style") === "");
  assert.equal(gridBodies.at(-1).sortExpression, "city ASC");
  assert.deepEqual(await headers.nth(1).evaluate((th) => [th.className, th.getAttribute("aria-sort"), th.querySelector("a").innerHTML]), ["sort-enabled sort-asc sort", "ascending", 'City <span class="fa fa-arrow-up"></span><span class="visually-hidden sort-hint">. sort descending</span>']);
  assert.deepEqual(await headers.nth(0).evaluate((th) => [th.className, th.hasAttribute("aria-sort"), th.querySelector("a").innerHTML]), ["sort-enabled", false, 'Name <span class="visually-hidden sort-hint">. sort descending</span>']);
  assert.deepEqual(errors, []);
});
