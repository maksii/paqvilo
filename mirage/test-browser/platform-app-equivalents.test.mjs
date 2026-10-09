import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";

// Synthetic loopback page for the local app bundle equivalent (lib/platform-app-compat.js):
// a read-only and an editable form, an ad and a poll placement. Nothing leaves loopback.
const PAGE = `<!doctype html><html lang="en"><head><title>App</title></head><body>
<div class="entity-form form-readonly" readonly="readonly" id="ro">
  <div class="control" data-logical-name="account"><div><input id="account_name" class="text form-control lookup form-control  readonly" readonly="readonly"></div></div>
  <div class="control" data-logical-name="kind"><select id="kind" class="aspNetDisabled form-control picklist" disabled="disabled" readonly="readonly"><option value="" label="Select" aria-label="Select"></option><option value="1">One</option></select></div>
  <div class="control" data-logical-name="name"><input id="name" class="text form-control" readonly="readonly"></div>
</div>
<div class="entity-form" id="edit">
  <div class="control" data-logical-name="owner"><div><input id="owner_name" class="text form-control lookup form-control  readonly" readonly=""></div></div>
</div>
<div class="ad" data-url="/ad">placeholder</div>
<div class="poll" data-url="/poll" data-submit-url="/submit"></div>
<script>window.shell = { ajaxSafePost: (options) => fetch(options.url, { method: options.type, body: options.data, headers: { "content-type": options.contentType } }).then((response) => response.text()) };</script>
<script src="/app.js"></script>
</body></html>`;
const POLL = `<div class="poll-questionpanel" data-id="poll-1" data-name="Question"><h5 class="poll-question">Question?</h5><ul class="list-unstyled poll-options"><li class="radio"><label for="poll_option_a"><input type="radio" id="poll_option_a" name="Question" value="a">A</label></li></ul><button class="poll-submit" type="button">Submit</button><button class="poll-viewresults" type="button">View results</button></div><div class="poll-resultspanel">Results</div>`;

test("app bundle equivalent: read-only control focus, ad and poll placements", async (t) => {
  const app = await fs.readFile(new URL("../lib/platform-app-compat.js", import.meta.url), "utf8");
  const submitted = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/page") return res.end(PAGE);
    if (req.url === "/app.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(app);
    }
    if (req.url === "/ad") return res.end(`  <div><a class="ad-link" href="/" title="">Ad</a></div>  `);
    if (req.url === "/poll") return res.end(POLL);
    if (req.url === "/submit" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        submitted.push(JSON.parse(body));
        res.end(`<div class="poll-resultspanel">Thanks<button class="poll-return" type="button">Back</button></div>`);
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/page`);
  // Read-only lookups and option sets inside a read-only form become focusable containers.
  assert.equal(await page.getAttribute('[data-logical-name="account"]', "tabindex"), "0");
  assert.equal(await page.getAttribute('[data-logical-name="kind"]', "tabindex"), "0");
  assert.equal(await page.getAttribute('[data-logical-name="name"]', "tabindex"), null);
  assert.equal(await page.getAttribute('[data-logical-name="owner"]', "tabindex"), null);
  // The ad placement shows the loaded markup.
  await page.locator(".ad a.ad-link").waitFor();
  assert.equal(await page.locator(".ad").isVisible(), true);
  // The poll shows its question, then submits the checked option and shows the results.
  await page.locator(".poll .poll-questionpanel").waitFor();
  assert.equal(await page.locator(".poll .poll-resultspanel").isVisible(), false);
  await page.check("#poll_option_a");
  await page.click(".poll-submit");
  await page.getByText("Thanks").waitFor();
  assert.deepEqual(submitted, [{ pollId: "poll-1", optionId: "a" }]);
  assert.deepEqual(errors, []);
});
