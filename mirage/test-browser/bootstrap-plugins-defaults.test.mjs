import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";

// Synthetic loopback pages with jQuery and the local Bootstrap adapter only (no Bootstrap).
// Plugin calls follow Bootstrap 3.4.1; the data API also takes Bootstrap 5 data-bs-* markup.
const SIGN_IN = `<div class='modal fade' id='SignInModal' tabindex='-1' role='dialog' data-keyboard="false" data-backdrop="static">
  <div class='modal-dialog' role='document'><div class='modal-content'>
    <div class="modal-header"><button type="button" class="close" data-dismiss="modal" aria-label="Close"><span aria-hidden="true">&times;</span></button><h4 class="modal-title">Sign in</h4></div>
    <div class='modal-body'><form action="/Account/Login/ExternalLogin" method="post" class="welcome-signin"><button id="modal-signin-button" name="provider" type="submit">Sign in with work account</button></form></div>
  </div></div></div>`;
const PAGES = {
  "/modal": `<!doctype html><html lang="en"><head><title>Modal</title></head><body>
<header><button type="button" id="nav-btn-signIn">Sign in</button><a href="#" id="toggleSignIn" data-toggle="modal" data-target="#SignInModal">Sign in (data API)</a></header>
<div class="modal fade" id="quiet" tabindex="-1" role="dialog" data-show="false"><div class="modal-dialog"><div class="modal-content"><div class="modal-body">Quiet</div></div></div></div>
<div class="modal fade" id="plain" tabindex="-1" role="dialog"><div class="modal-dialog"><div class="modal-content"><div class="modal-body">Plain <input id="plainInput" aria-label="Plain input"></div></div></div></div>
<button type="button" id="bs5Open" data-bs-toggle="modal" data-bs-target="#bs5">Open</button>
<div class="modal fade" id="bs5" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-body">Five <button type="button" data-bs-dismiss="modal">Close five</button></div></div></div></div>
<footer></footer>
<style>.modal { display: none; }</style>
<script src="/jquery.js"></script><script src="/compat.js"></script>
<script>
// The sign-in pattern of a source portal: create the modal on first use, then call .modal().
$('#nav-btn-signIn').on('click', function () {
  if (!document.querySelector('#SignInModal')) document.querySelector('footer').insertAdjacentHTML('beforeend', ${JSON.stringify(SIGN_IN)});
  $('#SignInModal').modal();
});
</script></body></html>`,
  "/controls": `<!doctype html><html lang="en"><head><title>Controls</title></head><body>
<div id="c1" class="collapse">One</div><div id="c2" class="collapse">Two</div>
<a href="#c3" id="c3Toggle" class="collapsed" data-toggle="collapse" aria-expanded="false">Three</a><div id="c3" class="collapse">Three body</div>
<button type="button" id="c4Toggle" data-bs-toggle="collapse" data-bs-target="#c4">Four</button><div id="c4" class="collapse">Four body</div>
<ul class="nav"><li class="dropdown" id="d1"><a href="#" class="dropdown-toggle" data-toggle="dropdown" aria-expanded="false">First</a><ul class="dropdown-menu"><li><a href="#" id="d1Item">Item</a></li></ul></li>
<li class="dropdown" id="d2"><a href="#" class="dropdown-toggle" data-toggle="dropdown" aria-expanded="false">Second</a><ul class="dropdown-menu"><li><a href="#">Other</a></li></ul></li></ul>
<div class="dropdown"><button type="button" id="d5" data-bs-toggle="dropdown" aria-expanded="false">Five</button><ul class="dropdown-menu"><li><a href="#">Five item</a></li></ul></div>
<ul class="nav nav-tabs" role="tablist"><li role="presentation" class="active"><a href="#p1" role="tab" data-toggle="tab">One tab</a></li><li role="presentation"><a href="#p2" role="tab" data-toggle="tab">Two tab</a></li></ul>
<div class="tab-content"><div role="tabpanel" class="tab-pane active" id="p1">Pane one</div><div role="tabpanel" class="tab-pane" id="p2">Pane two</div></div>
<button type="button" id="pop" data-content="Popover body">Popover</button>
<div class="alert alert-warning fade in" id="a1">Warning <button type="button" class="close" data-dismiss="alert" aria-label="Close">x</button></div>
<div class="alert alert-info show" id="a2">Info <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close info"></button></div>
<div class="alert alert-danger" id="a3">Danger</div>
<p id="outside">Outside</p>
<style>.collapse:not(.in):not(.show), .tab-pane:not(.active), .dropdown-menu { display: none; } .open > .dropdown-menu, .dropdown-menu.show { display: block; }</style>
<script src="/jquery.js"></script><script src="/compat.js"></script>
<script>window.events = []; $(document).on('show.bs.tab shown.bs.tab hide.bs.tab hidden.bs.tab close.bs.alert closed.bs.alert', function (e) { window.events.push(e.type + ':' + (e.target.id || e.target.textContent.trim()) + (e.relatedTarget ? '<' + e.relatedTarget.textContent.trim() : '')); });</script>
</body></html>`,
};

async function open(t) {
  const jquery = await fs.readFile(new URL("../node_modules/jquery/dist/jquery.min.js", import.meta.url));
  const compat = await fs.readFile(new URL("../lib/bootstrap-plugins-compat.js", import.meta.url));
  const server = http.createServer((req, res) => {
    if (PAGES[req.url]) {
      res.setHeader("content-type", "text/html");
      return res.end(PAGES[req.url]);
    }
    if (req.url === "/jquery.js" || req.url === "/compat.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(req.url === "/jquery.js" ? jquery : compat);
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
  return { page, errors, origin: `http://127.0.0.1:${server.address().port}` };
}

test("a modal opens on .modal() without arguments and through the data API, as with Bootstrap 3.4.1", async (t) => {
  const { page, errors, origin } = await open(t);
  await page.goto(`${origin}/modal`);
  const signIn = page.getByRole("dialog").filter({ hasText: "Sign in with work account" });
  const state = () => page.evaluate(() => ({ backdrops: document.querySelectorAll(".modal-backdrop").length, modalOpen: document.body.classList.contains("modal-open") }));
  await page.locator("#nav-btn-signIn").click();
  await signIn.waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#SignInModal").evaluate((node) => node.classList.contains("in")), true);
  assert.deepEqual(await state(), { backdrops: 1, modalOpen: true });
  // data-keyboard="false" and data-backdrop="static": Escape and a click beside the dialog keep it open.
  await page.locator("#modal-signin-button").press("Escape");
  await page.locator("#SignInModal").evaluate((node) => node.click());
  assert.equal(await signIn.isVisible(), true);
  // Another .modal() while shown keeps it shown: without a command Bootstrap shows, never toggles.
  await page.evaluate(() => window.jQuery("#SignInModal").modal());
  assert.equal(await signIn.isVisible(), true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(await signIn.isVisible(), false);
  assert.deepEqual(await state(), { backdrops: 0, modalOpen: false });
  // The source handler runs again on the next click and the existing modal opens again.
  await page.locator("#nav-btn-signIn").click();
  assert.equal(await signIn.isVisible(), true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // data-toggle="modal" on a link opens the same modal; the page does not follow the link.
  await page.locator("#toggleSignIn").click();
  assert.equal(await signIn.isVisible(), true);
  assert.equal(new URL(page.url()).hash, "");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // data-show="false": no show without a command; "toggle" and an options object follow Bootstrap.
  const quiet = page.locator("#quiet");
  await page.evaluate(() => window.jQuery("#quiet").modal());
  assert.equal(await quiet.isVisible(), false);
  await page.evaluate(() => window.jQuery("#quiet").modal("toggle"));
  assert.equal(await quiet.isVisible(), true);
  await page.evaluate(() => window.jQuery("#quiet").modal("toggle"));
  assert.equal(await quiet.isVisible(), false);
  // An options object merges over data-show="false", so it still does not show (the second argument is the related target).
  await page.evaluate(() => window.jQuery("#quiet").modal({ backdrop: "static", keyboard: false }, "show"));
  assert.equal(await quiet.isVisible(), false);
  // Without data-show, the options object shows the modal and its first options stay (keyboard: false).
  await page.evaluate(() => window.jQuery("#plain").modal({ backdrop: "static", keyboard: false }, "show"));
  assert.equal(await page.locator("#plain").isVisible(), true);
  await page.locator("#plainInput").press("Escape");
  assert.equal(await page.locator("#plain").isVisible(), true);
  await page.evaluate(() => window.jQuery("#plain").modal("hide"));
  assert.equal(await page.locator("#plain").isVisible(), false);
  // Bootstrap 5 data API.
  await page.locator("#bs5Open").click();
  assert.equal(await page.getByRole("dialog").filter({ hasText: "Five" }).isVisible(), true);
  await page.getByRole("button", { name: "Close five" }).click();
  assert.equal(await page.locator("#bs5").isVisible(), false);
  assert.deepEqual(await state(), { backdrops: 0, modalOpen: false });
  assert.deepEqual(errors, []);
});

test("collapse, dropdown, tab, popover and alert calls follow Bootstrap 3.4.1 defaults; the data API takes data-bs-*", async (t) => {
  const { page, errors, origin } = await open(t);
  await page.goto(`${origin}/controls`);
  const shown = (selector) => page.locator(selector).isVisible();
  // A new collapse toggles once; later calls without a command do nothing; toggle:false only initialises.
  await page.evaluate(() => window.jQuery("#c1").collapse());
  assert.equal(await shown("#c1"), true);
  await page.evaluate(() => window.jQuery("#c1").collapse());
  assert.equal(await shown("#c1"), true);
  await page.evaluate(() => window.jQuery("#c1").collapse("toggle"));
  assert.equal(await shown("#c1"), false);
  await page.evaluate(() => window.jQuery("#c2").collapse({ toggle: false }));
  assert.equal(await shown("#c2"), false);
  await page.evaluate(() => {
    window.jQuery("#c2").one("show.bs.collapse", (e) => e.preventDefault());
    window.jQuery("#c2").collapse("show");
  });
  assert.equal(await shown("#c2"), false);
  await page.evaluate(() => window.jQuery("#c2").collapse("show"));
  assert.equal(await shown("#c2"), true);
  // Data API: the trigger follows its target (aria-expanded, collapsed); Bootstrap 5 triggers too.
  const trigger = () => page.locator("#c3Toggle").evaluate((node) => [node.getAttribute("aria-expanded"), node.classList.contains("collapsed")]);
  await page.locator("#c3Toggle").click();
  assert.equal(await shown("#c3"), true);
  assert.deepEqual(await trigger(), ["true", false]);
  await page.locator("#c3Toggle").click();
  assert.equal(await shown("#c3"), false);
  assert.deepEqual(await trigger(), ["false", true]);
  await page.locator("#c4Toggle").click();
  assert.equal(await page.locator("#c4").evaluate((node) => node.classList.contains("show")), true);
  // A dropdown call without a command only initialises; clicks toggle; other clicks and menus close it.
  const isOpen = (id) => page.locator(id).evaluate((node) => node.classList.contains("open"));
  await page.evaluate(() => window.jQuery("#d1 .dropdown-toggle").dropdown());
  assert.equal(await isOpen("#d1"), false);
  await page.getByRole("link", { name: "First" }).click();
  assert.equal(await isOpen("#d1"), true);
  assert.equal(await page.getByRole("link", { name: "First" }).getAttribute("aria-expanded"), "true");
  await page.locator("#outside").click();
  assert.equal(await isOpen("#d1"), false);
  await page.getByRole("link", { name: "First" }).click();
  await page.getByRole("link", { name: "Second" }).click();
  assert.deepEqual([await isOpen("#d1"), await isOpen("#d2")], [false, true]);
  await page.getByRole("link", { name: "Second" }).click();
  assert.equal(await isOpen("#d2"), false);
  await page.locator("#d5").click();
  assert.deepEqual(
    await page.locator("#d5").evaluate((node) => [node.classList.contains("show"), node.nextElementSibling.classList.contains("show"), node.getAttribute("aria-expanded")]),
    [true, true, "true"],
  );
  await page.locator("#outside").click();
  assert.equal(await page.locator("#d5").evaluate((node) => node.classList.contains("show")), false);
  // Tabs: a call without a command initialises; showing marks the <li> active and swaps panes.
  await page.evaluate(() => window.jQuery('a[href="#p2"]').tab());
  assert.equal(await shown("#p2"), false);
  await page.getByRole("tab", { name: "Two tab" }).click();
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".nav-tabs > li")].map((li) => li.className)), ["", "active"]);
  assert.deepEqual([await shown("#p1"), await shown("#p2")], [false, true]);
  assert.equal(await page.getByRole("tab", { name: "Two tab" }).getAttribute("aria-selected"), "true");
  // Popovers bind once however often they are initialised.
  await page.evaluate(() => {
    window.jQuery("#pop").popover();
    window.jQuery("#pop").popover();
  });
  await page.locator("#pop").click();
  assert.equal(await page.locator(".paqvilo-mirage-popover").count(), 1);
  await page.locator("#pop").click();
  assert.equal(await page.locator(".paqvilo-mirage-popover").count(), 0);
  // Alerts: data-dismiss/data-bs-dismiss close their alert; .alert() only initialises; "close" closes.
  await page.locator("#a1 [data-dismiss=alert]").click();
  await page.getByRole("button", { name: "Close info" }).click();
  await page.evaluate(() => window.jQuery("#a3").alert());
  assert.equal(await page.locator("#a3").count(), 1);
  await page.evaluate(() => window.jQuery("#a3").alert("close"));
  assert.equal(await page.locator(".alert").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.events), [
    "hide:One tab<Two tab",
    "show:Two tab<One tab",
    "hidden:One tab<Two tab",
    "shown:Two tab<One tab",
    "close:a1",
    "close:a2",
    "close:a3",
  ]);
  assert.deepEqual(errors, []);
});
