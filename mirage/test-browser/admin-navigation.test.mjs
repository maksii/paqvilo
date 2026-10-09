import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";

test(
  "admin paginates large tables, lazily inspects details and requests filtered audit only on demand",
  { timeout: 60000 },
  async (t) => {
    const mappings = Array.from({ length: 85 }, (_, i) => ({
      id: `entity${i}`,
      logicalName: `entity${i}`,
      entitySet: `entities${i}`,
      idColumn: `entity${i}id`,
    }));
    const workspace = {
      csrf: "fixture-csrf",
      config: {
        mappings,
        plugins: [],
        endpoints: [],
        permissions: [],
        presets: [],
        identity: {},
      },
      data: {
        entity0: Array.from({ length: 81 }, (_, i) => ({
          entity0id: `row${i}`,
          name: `Record ${i}`,
        })),
      },
      status: {
        pages: [],
        permissionModel: {
          tree: Array.from({ length: 100 }, (_, i) => ({
            id: `grant${i}`,
            name: `Grant ${i}`,
            entity: "entity0",
            enabled: true,
            scope: "global",
            operations: ["read"],
            roles: ["Reader"],
          })),
        },
      },
      diagnostics: [],
    };
    const audit = Array.from({ length: 43 }, (_, i) => ({
      id: `audit${i}`,
      sequence: i + 1,
      correlationId: `correlation${i}`,
      startedAt: "2026-10-07T10:00:00Z",
      durationMs: i,
      kind: i % 2 ? "api" : "liquid-fetchxml",
      provider: "local",
      method: "GET",
      path: "/mock",
      entity: "entity0",
      identity: { contactId: "contact1", roles: ["Reader"] },
      status: i % 2 ? 200 : 403,
      rowCount: i,
      outcome: i % 2 ? "success" : "denied",
      query: { select: ["name"] },
      error:
        i % 2
          ? undefined
          : { code: "PermissionDenied", message: "Access denied" },
    }));
    const calls = [];
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        calls.push(url.pathname + url.search);
        if (url.pathname.startsWith("/__sim/api")) {
          res.setHeader("content-type", "application/json");
          if (url.pathname.endsWith("/state"))
            return res.end(JSON.stringify(workspace));
          if (url.pathname.endsWith("/records/contact"))
            return res.end(
              JSON.stringify({
                items: [],
                total: 0,
                page: 1,
                pageSize: 100,
                pageCount: 1,
              }),
            );
          if (url.pathname.endsWith("/audit")) {
            const page = Number(url.searchParams.get("page") || 1),
              size = Number(url.searchParams.get("pageSize") || 20),
              items = audit.filter(
                (item) =>
                  !url.searchParams.get("outcome") ||
                  item.outcome === url.searchParams.get("outcome"),
              );
            return res.end(
              JSON.stringify({
                items: items.slice((page - 1) * size, page * size),
                total: items.length,
                page,
                pageSize: size,
                pageCount: Math.ceil(items.length / size),
                retained: audit.length,
                dropped: 0,
              }),
            );
          }
          if (url.pathname.endsWith("/audit/export"))
            return res.end(
              JSON.stringify({
                items: audit.filter(
                  (item) =>
                    !url.searchParams.get("outcome") ||
                    item.outcome === url.searchParams.get("outcome"),
                ),
              }),
            );
          res.writeHead(404).end("{}");
          return;
        }
        const file =
          url.pathname === "/__sim/"
            ? "index.html"
            : url.pathname.split("/").at(-1);
        res.setHeader(
          "content-type",
          file.endsWith(".mjs")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        res.end(
          await fs.readFile(new URL(`../admin/${file}`, import.meta.url)),
        );
      } catch (error) {
        res.writeHead(500).end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(async () => {
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const page = await browser.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto(origin + "/__sim/#mappings");
    await page
      .getByRole("heading", { name: "Entity mappings", exact: true })
      .waitFor();
    assert.equal(await page.locator("tbody tr").count(), 10);
    assert.ok(!calls.some((path) => path.includes("/audit")));
    await page.getByRole("button", { name: "Next", exact: true }).click();
    assert.equal(
      await page.locator("tbody tr").first().innerText(),
      "entity10\tentities10\tentity10id\tEditDelete",
    );
    await page
      .getByRole("searchbox", { name: "Search mappings", exact: true })
      .fill("entity84");
    assert.equal(await page.locator("tbody tr").count(), 1);
    assert.match(await page.locator("tbody").innerText(), /entity84/);
    workspace.status.richTextConfigurations = [
      {
        version: 1,
        kind: "rich-text-json",
        url: "/rte.js",
        sourceFile: "rte.webfile.js",
        sourceSha256: "a".repeat(64),
        sha256: "b".repeat(64),
        cachePath: "/__sim-static/richtext-config/fixture.json",
        observedPath: "/_webresource/rte.js",
        origin: "https://portal.example.test",
        capturedAt: "2026-10-07T10:00:00Z",
        status: "eligible",
      },
    ];
    await page.locator("#refresh").click();
    await page
      .getByRole("heading", { name: "Versioned rich-text JSON baselines" })
      .waitFor();
    assert.equal(
      await page.getByText("a".repeat(64), { exact: false }).count(),
      0,
    );
    await page
      .getByText("Inspect versioned provenance", { exact: true })
      .click();
    await page.getByText("a".repeat(64), { exact: false }).waitFor();
    workspace.status.richTextConfigurations[0].status = "stale";
    await page.locator("#refresh").click();
    await page.getByText("Local source wins", { exact: true }).waitFor();
    await page
      .getByRole("link", { name: "Data records", exact: false })
      .click();
    await page
      .getByRole("heading", { name: "Data records", exact: true })
      .waitFor();
    assert.equal(await page.locator("tbody tr").count(), 20);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    assert.match(await page.locator("tbody").innerText(), /Record 20/);
    await page
      .getByRole("link", { name: "Identity & permissions", exact: false })
      .click();
    await page
      .getByRole("heading", {
        name: "Effective permission hierarchy",
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator("tbody tr").count(), 10);
    assert.equal(await page.locator("#identity-form").count(), 0);
    assert.equal(
      await page
        .locator('[data-disclosure="raw-permissions"]')
        .getAttribute("open"),
      null,
    );
    await page
      .getByText("Advanced: configured identity (sign-in default and scripts)", { exact: true })
      .click();
    await page.locator("#identity-form").waitFor();
    await page
      .getByText("Advanced: configured identity (sign-in default and scripts)", { exact: true })
      .click();
    await page
      .getByRole("link", { name: "Request audit", exact: false })
      .click();
    await page.getByText("43 retained", { exact: false }).waitFor();
    assert.equal(await page.locator("tbody tr").count(), 10);
    if (process.env.PAQVILO_MIRAGE_EVIDENCE_DIR) {
      await fs.mkdir(process.env.PAQVILO_MIRAGE_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(
          process.env.PAQVILO_MIRAGE_EVIDENCE_DIR,
          "audit-ten-rows-desktop.png",
        ),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: path.join(
          process.env.PAQVILO_MIRAGE_EVIDENCE_DIR,
          "audit-ten-rows-mobile.png",
        ),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    assert.equal(await page.locator("#inspection-json").innerText(), "");
    await page.getByRole("button", { name: "Inspect request" }).first().click();
    assert.match(
      await page.locator("#inspection-json").innerText(),
      /correlation0/,
    );
    await page.getByRole("button", { name: "Close request details" }).click();
    await page.locator('[data-audit-filter="outcome"]').selectOption("denied");
    await page.getByText("22 results", { exact: false }).waitFor();
    assert.ok(calls.some((path) => path.includes("outcome=denied")));
    assert.equal(await page.locator("tbody tr").count(), 10);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByText("Page 2 of 3", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByText("Page 3 of 3", { exact: false }).waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 2,
    );
    assert.equal(await page.locator("tbody tr").count(), 2);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export filtered JSON" }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "simulator-audit.json");
    assert.ok(
      calls.some(
        (path) =>
          path.includes("/audit/export") && path.includes("outcome=denied"),
      ),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(failures, []);
  },
);
