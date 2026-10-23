import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../mirage/lib/browser-launch.mjs";
import { ownedFixture } from "../mirage/testing/owned-fixture.mjs";
import { panelUi } from "../lense/panel-ui.mjs";
import { modelDrivenPanelData } from "../lense/model-driven-panel.mjs";

for (const modelDriven of [false, true]) {
  test(
    `${modelDriven ? "model-driven" : "Power Pages"} shell contains dragged panel after viewport shrink and restores preferred desktop position`,
    { timeout: 15000 },
    async (t) => {
      const owner = ownedFixture(t);
      const server = http.createServer((request, response) =>
        response
          .writeHead(200, {
            "content-type": request.url.startsWith("/__paqvilo/")
              ? "application/json"
              : "text/html",
          })
          .end(
            request.url.startsWith("/__paqvilo/")
              ? '{"ok":true}'
              : "<!doctype html><title>Invented placement</title><h1>Placement sentinel</h1>",
          ),
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      let browser;
      owner.add(() => browser?.close());
      owner.add(async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      });
      browser = await chromium.launch(browserLaunchOptions());
      const context = await browser.newContext({
        viewport: { width: 1280, height: 960 },
      });
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(() => {
        window.__paqviloModelPanelApi = async () => ({ ok: true });
      });
      const data = modelDrivenPanelData(
        {
          origin,
          token: "invented-placement",
          resources: [],
          diagnostics: [],
          revision: 1,
          resourceCount: 0,
        },
        { cfg: {}, ui: { open: true } },
      );
      await page.evaluate(panelUi, {
        ...data,
        modelDriven,
        ...(modelDriven
          ? {}
          : {
              transport: undefined,
              capabilities: { actions: false, targets: false },
            }),
      });
      const panel = page.locator("#paqvilo-panel .panel");
      const bounds = () =>
        panel.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            vw: innerWidth,
            vh: innerHeight,
          };
        });
      const before = await bounds(),
        brand = await page.locator("#paqvilo-panel .head .brand").boundingBox();
      await page.mouse.move(
        brand.x + brand.width / 2,
        brand.y + brand.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        brand.x + brand.width / 2 + 110,
        brand.y + brand.height / 2 - 70,
        { steps: 10 },
      );
      await page.mouse.up();
      const preferred = await bounds();
      assert.ok(
        preferred.left > before.left + 50,
        "actual pointer drag moved the shell",
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(
        () => {
          const r = document
            .getElementById("paqvilo-panel")
            .shadowRoot.querySelector(".panel")
            .getBoundingClientRect();
          return (
            r.left >= 0 &&
            r.right <= innerWidth &&
            r.top >= 0 &&
            r.bottom <= innerHeight
          );
        },
        null,
        { timeout: 1000 },
      );
      assert.deepEqual(
        await page
          .locator("#paqvilo-panel .head [data-act]")
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => {
                const r = node.getBoundingClientRect();
                return r.width && (r.left < 0 || r.right > innerWidth);
              })
              .map((node) => node.dataset.act),
          ),
        [],
      );
      await page.setViewportSize({ width: 1280, height: 960 });
      await page.waitForFunction(
        (preferred) => {
          const r = document
            .getElementById("paqvilo-panel")
            .shadowRoot.querySelector(".panel")
            .getBoundingClientRect();
          return (
            Math.abs(r.left - preferred.left) < 1 &&
            Math.abs(r.top - preferred.top) < 1
          );
        },
        preferred,
        { timeout: 1000 },
      );
    },
  );
}
