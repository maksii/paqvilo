import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { injectRuntimeCompatibility } from "../lib/source-dependencies.mjs";

const require = createRequire(import.meta.url);
const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
const BUNDLE = "/resource/powerappsportal/dist/bootstrap.bundle-105a4995b8.js";
// Synthetic stand-in for a captured Bootstrap 3 bundle: the real plugin owns the dropdown data API.
const bundle = `(function($){function Dropdown(){}function toggle(e){e.preventDefault();var p=$(this).parent();p.toggleClass('open');$(this).attr('aria-expanded',String(p.hasClass('open')));window.bundleToggles=(window.bundleToggles||0)+1;}$.fn.dropdown=function(){return this.each(function(){toggle.call(this,{preventDefault:function(){}});});};$.fn.dropdown.Constructor=Dropdown;$(document).on('click.bs.dropdown.data-api','[data-toggle="dropdown"]',toggle);})(window.jQuery);`;
const header = '<ul class="nav navbar-nav"><li class="dropdown"><a href="#" class="dropdown-toggle" data-toggle="dropdown" aria-expanded="false">PMS</a><ul class="dropdown-menu"><li><a href="/owned-products/">Owned products</a></li></ul></li></ul>';
const jquery = '<script src="/scripts/jquery.min.js"></script>';
const compat = '<script src="/__sim-static/vendor/bootstrap-plugins-compat.js"></script>';
const dependencies = { bootstrapPlugins: true };
const pages = {
  // Sample shell shape: jQuery included twice and the platform bundle at the end of the body.
  "/native": injectRuntimeCompatibility(`<!doctype html><html><head>${jquery}${jquery}</head><body>${header}<script src="${BUNDLE}"></script></body></html>`, dependencies),
  // Source-only page: the local adapter is the only dropdown implementation.
  "/local": injectRuntimeCompatibility(`<!doctype html><html><head>${jquery}${jquery}</head><body>${header}</body></html>`, dependencies),
  // A repeated adapter include and a later jQuery replacement must neither double-bind nor lose the plugin.
  "/repeated": `<!doctype html><html><head>${jquery}${compat}${compat}${jquery}</head><body>${header}</body></html>`,
};

test("header dropdowns open once with a captured native bundle, duplicate jQuery includes or repeated adapters", async (t) => {
  const files = {
    "/scripts/jquery.min.js": await fs.readFile(path.join(path.dirname(require.resolve("jquery/package.json")), "dist", "jquery.min.js")),
    "/__sim-static/vendor/bootstrap-plugins-compat.js": await fs.readFile(path.join(lib, "bootstrap-plugins-compat.js")),
    [BUNDLE]: Buffer.from(bundle),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (pages[url.pathname]) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(pages[url.pathname]);
    }
    if (files[url.pathname]) {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(files[url.pathname]);
    }
    res.writeHead(404);
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
  assert.equal((pages["/native"].match(/bootstrap-plugins-compat/g) ?? []).length, 0);
  assert.equal((pages["/local"].match(/bootstrap-plugins-compat/g) ?? []).length, 1);
  for (const route of Object.keys(pages)) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}${route}`);
    const menu = page.getByRole("link", { name: "Owned products", exact: true });
    await page.getByRole("link", { name: "PMS", exact: true }).click();
    assert.equal(await page.locator("li.dropdown").getAttribute("class"), "dropdown open", route);
    assert.equal(await page.locator("a.dropdown-toggle").getAttribute("aria-expanded"), "true", route);
    await page.getByRole("link", { name: "PMS", exact: true }).click();
    assert.equal(await page.locator("li.dropdown").getAttribute("class"), "dropdown", route);
    const state = await page.evaluate(() => ({ local: Boolean(window.jQuery.fn.dropdown.__ppSimCompat), bundleToggles: window.bundleToggles ?? 0 }));
    assert.deepEqual(state, route === "/native" ? { local: false, bundleToggles: 2 } : { local: true, bundleToggles: 0 }, route);
    assert.equal(await menu.count(), 1);
    assert.deepEqual(errors, [], route);
    await page.close();
  }
});

test("local jQuery UI dialogs render the widget DOM that portal confirm dialogs query", async (t) => {
  const files = {
    "/scripts/jquery.min.js": await fs.readFile(path.join(path.dirname(require.resolve("jquery/package.json")), "dist", "jquery.min.js")),
    "/xrm-adx/js/jquery-ui-1.11.4.min.js": await fs.readFile(path.join(lib, "jqueryui-dialog-compat.js")),
  };
  // Shape of a portal confirm helper: buttons object, dialogClass, open callback styling and a close button override.
  const confirm = `window.showConfirm=function(msg,ok,cancel){$('#confirm').html('<div class="confrim-dialog-cntr">'+msg+'</div>');$('#confirm').dialog({modal:true,width:340,dialogClass:'confirmContainer',draggable:false,resizable:false,buttons:{No:function(){cancel(this);},Yes:function(){ok(this);}},open:function(){$('.ui-dialog').find(".ui-dialog-buttonset button:contains('Yes')").addClass('sample-btn sample-btn-primary');$('.ui-dialog').find(".ui-dialog-buttonset button:contains('No')").addClass('sample-btn sample-btn-secondary noConfirmdelete');$('.ui-dialog-titlebar').find('span').text('Confirmation');}});$('.ui-dialog-titlebar-close').off().on('click',function(){$(this).closest('.confirmContainer').find('.noConfirmdelete').click();});};`;
  const html = `<!doctype html><html><head>${jquery}<script src="/xrm-adx/js/jquery-ui-1.11.4.min.js"></script></head><body><div id="confirm"></div><script>${confirm}</script></body></html>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(html);
    }
    if (files[url.pathname]) {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(files[url.pathname]);
    }
    res.writeHead(404);
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
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => {
    window.answers = [];
    window.showConfirm("Remove this section?", (dialog) => { window.answers.push("yes"); $(dialog).dialog("close"); }, (dialog) => { window.answers.push("no"); $(dialog).dialog("close"); });
  });
  const dialog = page.locator(".ui-dialog.confirmContainer");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await page.locator(".ui-widget-overlay").count(), 1);
  assert.equal(await dialog.locator(".ui-dialog-title").innerText(), "Confirmation");
  assert.equal(await dialog.locator(".ui-dialog-content .confrim-dialog-cntr").innerText(), "Remove this section?");
  assert.deepEqual(await dialog.locator(".ui-dialog-buttonset button").allInnerTexts(), ["No", "Yes"]);
  assert.equal(await dialog.locator("button.sample-btn-primary").innerText(), "Yes");
  await dialog.getByRole("button", { name: "Yes" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".ui-widget-overlay").count(), 0);
  // Re-initialising the same element reopens it; the title-bar close routes to "No".
  await page.evaluate(() => window.showConfirm("Again?", () => window.answers.push("yes"), (dialog) => { window.answers.push("no"); $(dialog).dialog("close"); }));
  await dialog.waitFor({ state: "visible" });
  await dialog.locator(".ui-dialog-titlebar-close").click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.answers), ["yes", "no"]);
  assert.equal(await page.locator(".ui-dialog").count(), 1);
  assert.deepEqual(errors, []);
});
