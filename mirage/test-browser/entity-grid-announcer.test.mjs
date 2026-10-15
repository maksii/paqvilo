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
const layout = (search, configuration = {}) => [{ Id: "view-1", ViewName: "Items", Configuration: { Search: { Enabled: search }, ...configuration }, Columns: [{ LogicalName: "name", Name: "Name", Width: 100, WidthAsPercent: 100 }], ColumnsTotalWidth: 120, Base64SecureConfiguration: "secure", SortExpression: "name ASC" }];
// The subgrid: pixel column widths and a download action (Wave M evidence: note-add live DOM).
const DOWNLOAD = { ViewActionLinks: [{ Type: 8, Enabled: true, Label: "Download items", Tooltip: "Download the items" }] };
const grid = (attributes, search, configuration) => `<div class="entity-grid ${attributes}" data-get-url="/grid-data" data-select-mode="None" data-view-layouts='${JSON.stringify(layout(search, configuration))}'><div class="view-grid"></div><div class="view-empty message"></div><div class="view-loading message"></div><div class="view-pagination"></div></div>`;
const PAGE = `<!doctype html><html lang="en"><head><title>Grids</title><link rel="stylesheet" href="/app.BootstrapV5.css"><script src="/app.BootstrapV5.bundle.js"></script></head><body>
<div id="antiforgerytoken"><input type="hidden" name="__RequestVerificationToken" value="token"></div>
<div class="entity-notes" data-url-get="/notes-data" data-url-add="/notes-add" data-bs-target='{"Id":"n1","LogicalName":"sample"}'><div class="notes"></div><div class="notes-empty"></div><div class="notes-loading"></div><div class="notes-pagination" data-pages="1"></div><a class="addnote" href="#">Add note</a><section class="modal modal-addnote" data-bs-backdrop="static"><div class="modal-body"><textarea name="text"></textarea><input type="file" name="file" accept="*" aria-label="Choose File" tabindex="0"></div><div class="modal-footer"><button class="primary" type="button">Add note</button></div></section></div>
<div class="subgrid">${grid('subgrid" data-defer-loading="false" data-enable-actions="true" data-column-width-style="Pixels', false, DOWNLOAD)}</div>
<div class="entity-associate"><section class="modal modal-associate" data-bs-backdrop="static"><div class="modal-body">${grid('associate-lookup" data-defer-loading="true', true)}<div class="selected-records"></div></div><div class="modal-footer"><button class="primary btn btn-primary" type="button">OK</button></div></section></div>
<script src="/grid.js"></script>
</body></html>`;

test("Bootstrap 5 grids share one record-count announcer per id and post a null natural-language filter", async (t) => {
  const script = await fs.readFile(new URL("../lib/entity-grid-compat.js", import.meta.url));
  const posts = [];
  const order = [];
  let notesType = null;
  const server = http.createServer((req, res) => {
    if (req.url === "/page") return res.end(PAGE);
    if (req.url === "/grid.js" || req.url === "/app.BootstrapV5.bundle.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(req.url === "/grid.js" ? script : "");
    }
    if (req.url === "/notes-add" && req.method === "POST") return res.end("");
    if (req.url === "/app.BootstrapV5.css") return res.end("");
    if (req.url === "/notes-data" && req.method === "POST") {
      order.push("notes");
      notesType = req.headers["content-type"];
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ Records: [{ Id: "note-1", UnformattedText: "A note", CreatedOnDisplay: "2026-01-01T00:00:00Z" }], PageCount: 1 }));
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
  // The Bootstrap 5 notes control posts a bare application/json (live requests).
  assert.equal(notesType, "application/json");
  // A shown notes list keeps style="" and a single page hides the pager (live DOM).
  await page.locator(".entity-notes .note").waitFor();
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".entity-notes .notes").getAttribute("style"), document.querySelector(".notes-pagination").style.display]), ["", "none"]);

  await page.evaluate(() => document.querySelector(".modal-associate").dispatchEvent(new CustomEvent("show.bs.modal")));
  assert.equal(await page.locator(".modal-associate .modal-footer .btn-primary").getAttribute("disabled"), "disabled");
  await page.waitForFunction(() => document.querySelector("#SearchCountTextundefined")?.textContent === "5 records found");
  assert.deepEqual(await announcers(), [["SearchCountTextundefined", "associate-lookup", "5 records found"]]);
  // It follows the dialog grid's toolbar.
  assert.equal(await page.evaluate(() => document.querySelector("#SearchCountTextundefined").previousElementSibling.className), "view-toolbar grid-actions clearfix");
  // The Bootstrap 5 subgrid: a download button with a left margin, a table fixed to the pixel widths.
  assert.equal(await page.locator(".subgrid .view-toolbar button.entitylist-download").evaluate((b) => [b.type, b.title, b.getAttribute("style")].join("|")), "button|Download the items|margin-left: 8px;");
  assert.equal(await page.locator(".subgrid .view-grid > table").getAttribute("style"), "width:120px !important; max-width:120px !important;");
  // Adding a note: the dialog announcer leaves with the dialog, the dialog gets an empty note and a
  // fresh file input without aria-label or tabindex.
  await page.locator(".addnote").click();
  await page.locator("#modal-status-announcer").waitFor({ state: "attached" });
  await page.locator(".modal-addnote textarea").fill("A note");
  await page.locator(".modal-addnote .primary").click();
  await page.locator("#modal-status-announcer").waitFor({ state: "detached" });
  assert.deepEqual(await page.locator(".modal-addnote").evaluate((m) => [m.querySelector("textarea").value, m.querySelector("input[type=file]").outerHTML]), ["", '<input type="file" name="file" accept="*">']);
  assert.deepEqual(errors, []);
});
