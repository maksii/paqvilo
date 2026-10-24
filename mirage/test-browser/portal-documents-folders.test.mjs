// The local SharePoint document grid's subfolders (website users can create subfolders; New folder depends on table
// permissions): New folder, navigation with the breadcrumb, upload into the open folder and folder delete.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";
import { signInContext } from "../testing/session.mjs";
import { ownedFixture } from "../testing/owned-fixture.mjs";

const SITE = "77777777-7777-4777-8777-777777777711";
const CASE = "77777777-7777-4777-8777-777777777712";
const FORM = "77777777-7777-4777-8777-777777777713";
const CONTACT = "77777777-7777-4777-8777-777777777714";
const entity = (name) => `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>`;

test("the document grid creates, opens, fills and deletes subfolders", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "portal-documents-folders-"));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    "solution/Other/Solution.xml": "<ImportExportXml><SolutionManifest><UniqueName>InventedDocs</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>",
    "solution/Entities/x_case/Entity.xml": entity("x_case"),
    "portal/website.yml": `adx_websiteid: ${SITE}\nadx_name: Example`,
    "portal/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: form",
    "portal/FormPage.pagetemplate.yml": "adx_pagetemplateid: form\nadx_webtemplateid: formcontent",
    "portal/FormContent.webtemplate.yml": "adx_webtemplateid: formcontent\nadx_name: Form content",
    "portal/FormContent.webtemplate.source.html": '{% entityform name: "Case" %}',
    "portal/Case.basicform.yml": `adx_entityformid: ${FORM}\nadx_name: Case\nadx_entityname: x_case\nadx_mode: 100000001\nadx_recordsourcetype: 756150001\nadx_recordidquerystringparametername: id`,
  };
  for (const [name, body] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), body); }
  const initial = {
    version: 1,
    mappings: { x_case: { entitySet: "x_cases", idColumn: "x_caseid", nameColumn: "x_name" } },
    tables: {
      contact: [{ contactid: CONTACT, fullname: "Invented Visitor", statecode: 0 }],
      x_case: [{ x_caseid: CASE, x_name: "Invented case", statecode: 0, statuscode: 1 }],
      sharepointsite: [{ sharepointsiteid: SITE, name: "Default Site", absoluteurl: "https://site.example.test/sites/invented", isdefault: true, statecode: 0, statuscode: 1 }],
    },
    permissions: [
      { id: "case", entity: "x_case", scope: "global", roles: ["Member"], operations: ["read", "appendTo", "update"] },
      { id: "docs", entity: "sharepointdocumentlocation", scope: "parent", roles: ["Member"], operations: ["read", "create", "update", "append", "delete"], parentPermissionId: "case", relationship: { entity: "x_case", from: "regardingobjectid", to: "x_caseid" } },
    ],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local", pageMode: "local", permissionSource: "configured", live: { allowWrites: false }, endpoints: [],
      componentSchemas: { Case: { entity: "x_case", mode: 100000001, fields: [{ name: "x_name", label: "Name" }],
        layout: [{ name: "tab", columns: [{ sections: [{ name: "s", rows: [[{ name: "x_name" }], [{ type: "subgrid", id: "docs", entity: "sharepointdocumentlocation", label: "Documents" }]] }] }] }] } },
    },
  };
  const app = await createSimulator({ sourceDir: path.join(root, "portal"), solutionRoots: [path.join(root, "solution")], stateFile: path.join(root, "state.json"), port: 0, watch: false, initial });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, app, CONTACT, { roles: ["Member"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept("Contracts"));
  await page.route("**/*", (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(`${app.url}/?id=${CASE}`);
  const grid = page.locator("[data-pp-documents]");
  await grid.locator("[data-pp-documents-new-folder]").click();
  const folder = grid.locator('[data-pp-documents-folder="Contracts"]');
  await folder.waitFor();
  await folder.click();
  await grid.locator('[data-pp-documents-path] [aria-current="location"]', { hasText: "Contracts" }).waitFor();
  await grid.locator("[data-pp-documents-upload]").setInputFiles({ name: "signed.txt", mimeType: "text/plain", buffer: Buffer.from("signed") });
  await grid.locator("tbody a", { hasText: "signed.txt" }).waitFor();
  assert.match(await grid.locator("tbody a", { hasText: "signed.txt" }).getAttribute("href"), /\/signed\.txt\?folder=Contracts$/);
  await grid.locator("[data-pp-documents-path] button", { hasText: "Documents" }).click();
  await folder.waitFor();
  assert.equal(await grid.locator("tbody a", { hasText: "signed.txt" }).count(), 0, "the file stays in its folder");
  await grid.locator("tbody tr", { has: page.locator('[data-pp-documents-folder="Contracts"]') }).locator("button", { hasText: "Delete" }).click();
  await grid.locator(".message", { hasText: "There are no documents." }).waitFor();
  assert.deepEqual(errors, []);
});
