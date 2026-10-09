import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

test(
  "online frame selection permits only the selected embed and leaves parent API/scripts local",
  { timeout: 30000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sim-frame-policy-"));
    const files = {
      "website.yml": "adx_websiteid: site\nadx_name: Frame policy",
      "web-pages/Home.webpage.yml":
        "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: template",
      "page-templates/Main.pagetemplate.yml":
        "adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
      "web-templates/Main.webtemplate.yml":
        "adx_webtemplateid: main\nadx_name: Main",
      "web-templates/Main.webtemplate.source.html": `<!doctype html><html><head><title>Frame policy</title></head><body><script>window.policyViolations=[];window.addEventListener('securitypolicyviolation',e=>policyViolations.push(e.violatedDirective));fetch('https://embed.example.test/parent-api').catch(()=>{});</script><script src="https://embed.example.test/parent-script.js"></script><iframe title="Selected report" src="https://embed.example.test/report"></iframe><iframe title="Unselected report" src="https://other.example.test/report"></iframe></body></html>`,
    };
    for (const [file, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), body);
    }
    let app, browser;
    t.after(async () => {
      await browser?.close();
      await app?.close();
      const resolved = await fs.realpath(dir);
      assert.ok(resolved.startsWith(await fs.realpath(os.tmpdir())));
      await fs.rm(resolved, { recursive: true, force: true });
    });
    app = await createSimulator({
      sourceDir: dir,
      stateFile: path.join(dir, "state.json"),
      watch: false,
      port: 0,
    });
    const state = await (
      await fetch(app.url + "/__sim/api/state?summary=1")
    ).json();
    const configured = await fetch(app.url + "/__sim/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-sim-csrf": state.csrf },
      // Loopback confinement is an explicit opt-in; the selected embed is its exception.
      body: JSON.stringify({
        confinePortalPages: true,
        externalFrameOrigins: ["https://embed.example.test"],
      }),
    });
    assert.equal(configured.status, 200);
    browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    const page = await browser.newPage(),
      remote = [];
    await page.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin === app.url) return route.continue();
      remote.push({ method: request.method(), url: url.href });
      if (url.href === "https://embed.example.test/report")
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><h1>Selected online report</h1>",
        });
      return route.abort();
    });
    await page.goto(app.url, { waitUntil: "load" });
    await page
      .frameLocator('iframe[title="Selected report"]')
      .getByRole("heading", { name: "Selected online report" })
      .waitFor();
    await page.waitForFunction(() =>
      ["script-src-elem", "connect-src", "frame-src"].every((d) =>
        policyViolations.includes(d),
      ),
    );
    assert.deepEqual(remote, [
      { method: "GET", url: "https://embed.example.test/report" },
    ]);
    const after = await (
      await fetch(app.url + "/__sim/api/state?summary=1")
    ).json();
    assert.equal(after.config.mode, "local");
    assert.equal(after.config.pageMode, "local");
    assert.equal(after.config.externalAssets, false);
    assert.equal(after.config.confinePortalPages, true);
  },
);
