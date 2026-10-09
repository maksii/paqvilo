import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";

// Synthetic loopback page: a deferred grid with two views (as in a lookup modal) and page
// script that selects a view and sorts with jQuery's .trigger("click"), which dispatches no
// native click on links. The platform bundle binds these controls with jQuery, so the grid
// loads the chosen view; lib/entity-grid-compat.js must do the same.
const layouts = ["First", "Second"].map((name, index) => ({
  Id: `view-${index + 1}`,
  ViewName: name,
  Configuration: { ViewDisplayName: name },
  Columns: [{ LogicalName: "name", Name: "Name", Width: 100, WidthAsPercent: 100 }],
  Base64SecureConfiguration: `secure-${index + 1}`,
  SortExpression: "name ASC",
}));
const PAGE = `<!doctype html><html lang="en"><head><title>Grid</title></head><body>
<div id="antiforgerytoken"><input type="hidden" name="__RequestVerificationToken" value="token"></div>
<div class="entity-grid" data-get-url="/grid-data" data-defer-loading="true" data-select-mode="Single" data-view-layouts='${JSON.stringify(layouts)}'><div class="view-grid"></div><div class="view-pagination"></div></div>
<script src="/jquery.js"></script><script src="/grid.js"></script>
</body></html>`;

test("jQuery-triggered clicks on grid view and sort links reach the grid", async (t) => {
  const jquery = await fs.readFile(new URL("../node_modules/jquery/dist/jquery.min.js", import.meta.url));
  const grid = await fs.readFile(new URL("../lib/entity-grid-compat.js", import.meta.url));
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/page") return res.end(PAGE);
    if (req.url === "/jquery.js" || req.url === "/grid.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(req.url === "/jquery.js" ? jquery : grid);
    }
    if (req.url === "/grid-data" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        posts.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ Records: [], ItemCount: 0, PageNumber: 1, PageSize: 10, PageCount: 1, MoreRecords: false }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    // A preconnected socket that never sent a request would hold server.close open.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Wait for the expected grid requests (a slow runner can take longer than a fixed pause), then
  // give a duplicate request a moment to show up before the exact count is asserted.
  const postsReach = async (count) => {
    for (const deadline = Date.now() + 10_000; posts.length < count && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 25));
    await new Promise((resolve) => setTimeout(resolve, 300));
  };
  await page.goto(`http://127.0.0.1:${server.address().port}/page`);
  await page.locator(".view-select [aria-label='Second']").waitFor({ state: "attached" });
  // A deferred grid does not load until asked to.
  assert.deepEqual(posts, []);
  await page.evaluate(() => window.jQuery(".view-select [aria-label='Second']").trigger("click"));
  await page.waitForFunction(() => document.querySelector(".entity-grid").getAttribute("data-selected-view") === "view-2");
  await postsReach(1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].base64SecureConfiguration, "secure-2");
  await page.evaluate(() => window.jQuery(".view-grid table thead th a").first().trigger("click"));
  await page.waitForFunction((count) => window.__gridPosts === undefined && document.querySelectorAll(".view-grid table").length > 0, posts.length);
  await postsReach(2);
  assert.equal(posts.length, 2);
  assert.match(String(posts[1].sortExpression), /^name (ASC|DESC)$/);
  assert.deepEqual(errors, []);
});

// Bootstrap 3 modal semantics that matter here: show/hide events and the "in" class, with no
// aria-hidden changes (the cached platform bootstrap bundle has none in its modal plugin).
const BOOTSTRAP3_MODAL = `(function ($) {
  $.fn.modal = function (option) {
    return this.each(function () {
      var $el = $(this);
      if (option === "hide") {
        if (!$el.hasClass("in")) return;
        $el.trigger($.Event("hide.bs.modal"));
        $el.removeClass("in").hide();
        $el.trigger("hidden.bs.modal");
        return;
      }
      var show = $.Event("show.bs.modal");
      $el.trigger(show);
      if (show.isDefaultPrevented()) return;
      $el.show().addClass("in");
      $el.trigger("shown.bs.modal");
    });
  };
  $(document).on("click", "[data-dismiss=modal]", function () { $(this).closest(".modal").modal("hide"); });
})(jQuery);`;

test("a grid confirmation dialog is exposed to assistive technology while shown, as on the platform", async (t) => {
  const jquery = await fs.readFile(new URL("../node_modules/jquery/dist/jquery.min.js", import.meta.url));
  const grid = await fs.readFile(new URL("../lib/entity-grid-compat.js", import.meta.url));
  const layout = {
    Id: "view-1",
    ViewName: "Contacts",
    Configuration: { ViewDisplayName: "Contacts", ItemActionLinks: [{ Type: 4, Enabled: true, Label: "Remove", Tooltip: "Remove" }] },
    Columns: [
      { LogicalName: "name", Name: "Name", Width: 90, WidthAsPercent: 90 },
      { LogicalName: "", Name: "", Type: 2, Width: 10, WidthAsPercent: 10 },
    ],
    Base64SecureConfiguration: "secure-1",
  };
  const page = `<!doctype html><html lang="en"><head><title>Grid</title></head><body>
<div id="antiforgerytoken"><input type="hidden" name="__RequestVerificationToken" value="token"></div>
<div class="entity-grid" data-get-url="/grid-data" data-enable-actions="true" data-view-layouts='${JSON.stringify([layout])}'><div class="view-grid"></div><div class="view-pagination"></div>
<section aria-hidden="true" aria-label="Delete" class="modal fade modal-delete" data-backdrop="static" role="dialog" tabindex="-1" style="display:none"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h1 class="modal-title">Delete</h1></div><div class="modal-body">Are you sure you want to delete this record?</div><div class="modal-footer"><button type="button" class="primary btn btn-primary">Delete</button><button type="button" class="cancel btn btn-default" data-dismiss="modal">Cancel</button></div></div></div></section>
</div>
<script src="/jquery.js"></script><script src="/bootstrap-modal.js"></script><script src="/grid.js"></script>
</body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === "/page") return res.end(page);
    const scripts = { "/jquery.js": jquery, "/bootstrap-modal.js": BOOTSTRAP3_MODAL, "/grid.js": grid };
    if (scripts[req.url]) {
      res.setHeader("content-type", "text/javascript");
      return res.end(scripts[req.url]);
    }
    if (req.url === "/grid-data" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          Records: [{ Id: "r0000000-0000-4000-8000-000000000001", EntityName: "contact", CanDelete: true, Attributes: [{ Name: "name", Value: "Blair", DisplayValue: "Blair" }] }],
          ItemCount: 1, PageNumber: 1, PageSize: 10, PageCount: 1, MoreRecords: false,
        }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    // A preconnected socket that never sent a request would hold server.close open.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(`http://127.0.0.1:${server.address().port}/page`);
  await tab.locator("tr[data-id] button[data-toggle='dropdown']").click();
  await tab.locator("tr[data-id] a.delete-link").click();
  const confirm = tab.getByRole("dialog").getByRole("button", { name: "Delete" });
  await confirm.waitFor({ timeout: 5000 });
  assert.equal(await tab.locator(".modal-delete").getAttribute("aria-hidden"), "false");
  await tab.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await tab.waitForFunction(() => document.querySelector(".modal-delete").getAttribute("aria-hidden") === "true");
  assert.equal(await tab.getByRole("dialog").count(), 0);
  assert.deepEqual(errors, []);
});
