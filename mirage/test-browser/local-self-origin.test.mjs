import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { injectRuntime } from "../lib/platform.mjs";

test("exported hostname-based native modal URLs retain the local port and same-origin document access", async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/frame") {
      res.end('<input id="native-field" value="Local modal data">');
      return;
    }
    // injectRuntime references the runtime's native platform scripts (served by the
    // mirage server); this synthetic server answers them with an empty script.
    if (req.url.startsWith("/__sim-static/")) {
      res.setHeader("content-type", "application/javascript");
      res.end("");
      return;
    }
    res.end(
      injectRuntime(
        "<html><head></head><body><button id=\"open\" onclick=\"const frame=document.createElement('iframe');frame.id='modal';frame.setAttribute('src',location.protocol+'//'+location.hostname+'/frame');document.body.append(frame);\">Open native form</button></body></html>",
        "token",
        1,
        {},
        "trace",
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (r) =>
    r.request().url().startsWith(origin) ? r.continue() : r.abort(),
  );
  await page.goto(origin);
  await page.locator("#open").click();
  assert.equal(
    await page.frameLocator("#modal").locator("#native-field").inputValue(),
    "Local modal data",
  );
  assert.equal(
    await page
      .locator("#modal")
      .evaluate(
        (frame) => frame.contentDocument.querySelectorAll("input").length,
      ),
    1,
  );
  assert.equal(
    await page.locator("#modal").getAttribute("src"),
    origin + "/frame",
  );
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "property-modal";
    frame.src = location.protocol + "//" + location.hostname + "/frame";
    document.body.append(frame);
  });
  assert.equal(
    await page
      .frameLocator("#property-modal")
      .locator("#native-field")
      .inputValue(),
    "Local modal data",
  );
  assert.deepEqual(errors, []);
});
