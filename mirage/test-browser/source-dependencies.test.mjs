import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

test("source-only page JavaScript receives local jQuery, Moment and plugin compatibility before execution", { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-only-dependencies-"));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const files = {
    "website.yml": "adx_websiteid: site\nadx_name: Test",
    "web-pages/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main",
    "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
    "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/Main.webtemplate.source.html": "<!doctype html><html><head><title>Local</title></head><body><main>Source only</main></body></html>",
    "web-pages/Home.webpage.custom_javascript.js": [
      "$(function(){",
      "  if (false) { jQuery('<div>').datetimepicker(); jQuery('<div>').dialog(); jQuery('<div>').tooltip(); }",
      "  window.sourceDependencyResult = {",
      "    jquery: typeof window.jQuery,",
      "    moment: moment.utc('2025-01-02').format('YYYY-MM-DD'),",
      "    datepicker: typeof jQuery.fn.datetimepicker,",
      "    dialog: typeof jQuery.fn.dialog,",
      "    tooltip: typeof jQuery.fn.tooltip,",
      "    dateFormat: new Date(0).format('yyyy'),",
      "  };",
      "});",
    ].join("\n"),
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  app = await createSimulator({ sourceDir: root, watch: false });
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const page = await browser.newPage();
  const errors = [];
  const failures = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.setDefaultNavigationTimeout(5000);
  await page.route("**/*", (route) =>
    route.request().url().startsWith(app.url) ? route.continue() : route.abort(),
  );
  await page.goto(app.url);
  await page.waitForFunction(() => window.sourceDependencyResult, null, { timeout: 5000 }).catch(async (cause) => {
    throw new Error(`${cause.message}; page errors: ${errors.join(" | ")}; request failures: ${failures.join(" | ")}; page: ${(await page.content()).slice(0, 3000)}`);
  });
  assert.deepEqual(await page.evaluate(() => window.sourceDependencyResult), {
    jquery: "function",
    moment: "2025-01-02",
    datepicker: "function",
    dialog: "function",
    tooltip: "function",
    dateFormat: "1970",
  });
  assert.deepEqual(errors, []);
});
