import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";

// Synthetic loopback Bootstrap 5 page: a subgrid and a deferred dialog grid (as in an associate
// dialog) with search. Live evidence: the page holds one SearchCountTextundefined announcer, which
// the dialog grid takes over when it loads; grids outside the entity_list template post a null
// natural-language filter; the associate dialog opens with OK disabled="disabled".
const layout = (search) => [{ Id: "view-1", ViewName: "Items", Configuration: { Search: { Enabled: search } }, Columns: [{ LogicalName: "name", Name: "Name", Width: 100, WidthAsPercent: 100 }], Base64SecureConfiguration: "secure", SortExpression: "name ASC" }];
const grid = (attributes, search) => `<div class="entity-grid ${attributes}" data-get-url="/grid-data" data-select-mode="None" data-view-layouts='${JSON.stringify(layout(search))}'><div class="view-grid"></div><div class="view-empty message"></div><div class="view-loading message"></div><div class="view-pagination"></div></div>`;
const PAGE = `<!doctype html><html lang="en"><head><title>Grids</title><script src="/app.BootstrapV5.bundle.js"></script></head><body>
<div id="antiforgerytoken"><input type="hidden" name="__RequestVerificationToken" value="token"></div>
<div class="entity-notes" data-url-get="/notes-data"><div class="notes"></div><div class="notes-empty"></div><div class="notes-loading"></div></div>
<div class="subgrid">${grid('subgrid" data-defer-loading="false', false)}</div>
<div class="entity-associate"><section class="modal modal-associate" data-bs-backdrop="static"><div class="modal-body">${grid('associate-lookup" data-defer-loading="true', true)}<div class="selected-records"></div></div><div class="modal-footer"><button class="primary btn btn-primary" type="button">OK</button></div></section></div>
<script src="/grid.js"></script>
</body></html>`;

test("Bootstrap 5 grids share one record-count announcer per id and post a null natural-language filter", async (t) => {
  const script = await fs.readFile(new URL("../lib/entity-grid-compat.js", import.meta.url));
  const posts = [];
  const order = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/page") return res.end(PAGE);
    if (req.url === "/grid.js" || req.url === "/app.BootstrapV5.bundle.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(req.url === "/grid.js" ? script : "");
    }
    if (req.url === "/notes-data" && req.method === "POST") {
      order.push("notes");
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ Records: [] }));
    }
    if (req.url === "/grid-data" && req.method === "POST") {
      order.push("grid");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        posts.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ Records: [], ItemCount: posts.length === 1 ? 2 : 5, PageNumber: 1, PageSize: 10, PageCount: 1, MoreRecords: false }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/page`);

  const announcers = () => page.evaluate(() => [...document.querySelectorAll("[id^='SearchCountText']")].map((node) => [node.id, node.parentElement.classList[1], node.textContent]));
  await page.waitForFunction(() => document.querySelector(".subgrid > .entity-grid > #SearchCountTextundefined")?.textContent === "2 records found");
  assert.equal(posts[0].nlSearchFilter, null);
  // Notes load before the grids (live: the notes POST precedes the subgrid POST).
  assert.deepEqual(order, ["notes", "grid"]);

  await page.evaluate(() => document.querySelector(".modal-associate").dispatchEvent(new CustomEvent("show.bs.modal")));
  assert.equal(await page.locator(".modal-associate .modal-footer .btn-primary").getAttribute("disabled"), "disabled");
  await page.waitForFunction(() => document.querySelector("#SearchCountTextundefined")?.textContent === "5 records found");
  assert.deepEqual(await announcers(), [["SearchCountTextundefined", "associate-lookup", "5 records found"]]);
  // It follows the dialog grid's toolbar.
  assert.equal(await page.evaluate(() => document.querySelector("#SearchCountTextundefined").previousElementSibling.className), "view-toolbar grid-actions clearfix");
  assert.deepEqual(errors, []);
});
