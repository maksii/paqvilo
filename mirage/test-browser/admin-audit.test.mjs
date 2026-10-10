import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";
import { signInContext } from "../testing/session.mjs";

test(
  "real simulator admin lazy records and audit show API/Liquid correlation, valid-token denial and sanitized export",
  { timeout: 60000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "pp-admin-audit-"),
    );
    const files = {
      "website.yml": "adx_websiteid: site\nadx_name: Audit fixture",
      "sitesetting.yml":
        "- adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_name: Webapi/contact/fields\n  adx_value: '*'",
      "Home.webpage.yml":
        "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: template",
      "Main.pagetemplate.yml":
        "adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
      "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
      "Main.webtemplate.source.html":
        '<!doctype html><html><head><title>Audit fixture</title></head><body>{% fetchxml records %}<fetch><entity name="contact"><attribute name="fullname"/></entity></fetch>{% endfetchxml %}<h1>Visible contacts: {{ records.results.entities.size }}</h1></body></html>',
    };
    for (const [name, contents] of Object.entries(files))
      await fs.writeFile(path.join(directory, name), contents);
    const app = await createSimulator({
      sourceDir: directory,
      stateFile: path.join(directory, "state.json"),
      watch: false,
      // The contact field list is the wildcard, which hosted sites reject unless exempt.
      observed: { webApiWildcard: "exempt", evidence: "synthetic fixture with a wildcard field list" },
      initial: {
        version: 1,
        mappings: { contact: { entitySet: "contacts", idColumn: "contactid" } },
        tables: {
          contact: Array.from({ length: 81 }, (_, i) => ({
            contactid: `contact${i}`,
            fullname: `Synthetic member ${i}`,
          })),
        },
        permissions: [
          {
            id: "read",
            entity: "contact",
            scope: "global",
            roles: ["Reader"],
            operations: ["read"],
          },
        ],
        plugins: [],
        presets: {},
        settings: { permissionMode: "enforce" },
        simulator: {
          mode: "local",
          pageMode: "local",
          identity: { id: "contact0", roles: ["Reader"] },
          live: {},
          endpoints: [],
        },
      },
    });
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(async () => {
      await browser.close();
      await app.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const context = await browser.newContext({ serviceWorkers: "block" }),
      page = await context.newPage(),
      calls = [],
      errors = [];
    // Portal requests of this context run as the Reader (a session role override).
    await signInContext(context, app, "contact0", { roles: ["Reader"] });
    page.on("request", (request) =>
      calls.push(
        new URL(request.url()).pathname + new URL(request.url()).search,
      ),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.adminUrl);
    await page
      .getByRole("heading", { name: "Your local portal workspace" })
      .waitFor();
    assert.ok(calls.includes("/__sim/api/state?summary=1"));
    assert.ok(
      !calls.some((url) => url.includes("/records/") || url.includes("/audit")),
    );
    await page
      .getByRole("link", { name: "Data records", exact: false })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 20,
    );
    assert.ok(
      calls.includes("/__sim/api/records/contact?page=1&pageSize=20&search="),
    );
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("tbody")
        ?.textContent.includes("Synthetic member 20"),
    );
    await page
      .getByRole("searchbox", { name: "Search record values" })
      .fill("member 80");
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 1,
    );
    assert.match(
      await page.locator("tbody").innerText(),
      /Synthetic member 80/,
    );
    assert.ok(calls.some((url) => url.includes("search=member+80")));
    const rendered = await context.request.get(
      app.url + "/?access_token=DO_NOT_RETAIN",
    );
    assert.equal(rendered.status(), 200);
    assert.match(await rendered.text(), /Visible contacts: 81/);
    const parentId = rendered.headers()["x-sim-trace-id"];
    const api = await context.request.get(
      app.url + "/_api/contacts?$select=fullname&$top=1",
      { headers: { "X-Sim-Parent-Trace": parentId } },
    );
    assert.equal(api.status(), 200);
    const denied = await context.request.post(app.url + "/_api/contacts", {
      headers: { __RequestVerificationToken: app.state().csrf },
      data: { fullname: "WRITE_BODY_MUST_NOT_RETAIN" },
    });
    assert.equal(denied.status(), 403);
    assert.equal((await denied.json()).error.code, "90040103");
    await page
      .getByRole("link", { name: "Request audit", exact: false })
      .click();
    await page
      .locator("tbody")
      .getByText("liquid-fetchxml", { exact: true })
      .waitFor();
    await page.locator('[data-audit-filter="kind"]').selectOption("api");
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 2,
    );
    await page.locator('[data-audit-filter="outcome"]').selectOption("denied");
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 1,
    );
    // The row shows the simulator code (X-Sim-Error-Code) and the Power Pages envelope code.
    await page
      .locator("tbody tr .row-detail")
      .getByText("PermissionDenied · portal 90040103", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Inspect request" }).click();
    await page
      .locator("#inspection-json")
      .getByText("PermissionDenied", { exact: false })
      .waitFor();
    assert.match(await page.locator("#inspection-json").innerText(), /Reader/);
    assert.match(await page.locator("#inspection-json").innerText(), /"portalCode": "90040103"/);
    await page.getByRole("button", { name: "Close request details" }).click();
    const exported = await (
        await context.request.get(app.url + "/__sim/api/audit/export")
      ).json(),
      liquid = exported.items.find((item) => item.kind === "liquid-fetchxml"),
      read = exported.items.find(
        (item) => item.kind === "api" && item.method === "GET",
      );
    assert.equal(liquid.parentId, parentId);
    assert.equal(read.correlationId, liquid.correlationId);
    assert.equal(liquid.rowCount, 81);
    assert.equal(read.rowCount, 1);
    assert.equal(read.identity.contactId, "contact0");
    assert.deepEqual(read.identity.roles, ["Reader"]);
    assert.ok(
      exported.items.every(
        (item) =>
          item.provider === "local" && typeof item.durationMs === "number",
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(exported),
      /DO_NOT_RETAIN|WRITE_BODY_MUST_NOT_RETAIN/,
    );
    if (process.env.PAQVILO_MIRAGE_EVIDENCE_DIR) {
      await fs.mkdir(process.env.PAQVILO_MIRAGE_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.PAQVILO_MIRAGE_EVIDENCE_DIR, "audit-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: path.join(process.env.PAQVILO_MIRAGE_EVIDENCE_DIR, "audit-mobile.png"),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    await page
      .getByRole("button", { name: "Clear audit", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Clear audit", exact: true })
      .last()
      .click();
    await page.getByText("0 retained", { exact: false }).waitFor();
    const hostile = '"><img src=x onerror="window.auditInjected=true">';
    await page.goto(app.adminUrl + '#audit?kind=' + encodeURIComponent(hostile));
    await page.locator('[data-audit-filter="kind"]').waitFor();
    assert.equal(await page.locator('[data-audit-filter="kind"]').inputValue(), hostile);
    assert.equal(await page.locator('#content img').count(), 0);
    assert.equal(await page.evaluate(() => window.auditInjected), undefined);
    assert.ok((await page.locator('[data-audit-filter="kind"]').innerText()).includes(hostile));
    // Invalid hash names cannot dispatch inherited Object methods or become HTML.
    await page.goto(app.adminUrl + '#__proto__');
    await page.reload();
    await page.getByRole('heading', { name: 'Your local portal workspace' }).waitFor();
    assert.deepEqual(errors, []);
  },
);
