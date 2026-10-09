// Admin acceptance uses a disposable loopback API; no portal or environment requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";

test(
  "admin: record and configuration CRUD, routing, identity, presets, errors, safe diagnostics, responsive layout",
  { timeout: 90_000 },
  async (t) => {
    const workspace = {
      csrf: "synthetic-admin-token",
      config: {
        mode: "local",
        pageMode: "local",
        live: {},
        identity: { roles: [] },
        mappings: [
          {
            id: "contact",
            logicalName: "contact",
            entitySet: "contacts",
            idColumn: "contactid",
          },
        ],
        plugins: [],
        endpoints: [],
        permissions: [],
        presets: [],
      },
      data: {
        contact: [
          { contactid: "c1", firstname: "Initial", lastname: "Contact" },
        ],
      },
      status: {
        webRoles: [
          { id: "tester", name: "Tester" },
          { id: "reviewer", name: "Reviewer" },
          { id: "authority", name: "Authority" },
        ],
        pages: [{ path: "/workspace/", name: "My workspace" }],
        repo: "synthetic PAC checkout",
      },
      diagnostics: [
        {
          severity: "warning",
          code: "unsupported",
          message: "<script>window.injected = true</script>",
        },
      ],
    };
    const mutations = [];
    const server = http.createServer((req, res) => {
      Promise.resolve()
        .then(async () => {
          if (!req.url.startsWith("/")) {
            res.writeHead(403).end();
            return;
          }
          const url = new URL(req.url, "http://127.0.0.1");
          if (
            url.pathname === "/__sim/" ||
            ["/__sim/app.mjs", "/__sim/style.css"].includes(url.pathname)
          ) {
            const file =
              url.pathname === "/__sim/"
                ? "index.html"
                : url.pathname.split("/").at(-1);
            res.setHeader(
              "Content-Type",
              file.endsWith(".mjs")
                ? "text/javascript"
                : file.endsWith(".css")
                  ? "text/css"
                  : "text/html",
            );
            res.end(
              fs.readFileSync(new URL(`../admin/${file}`, import.meta.url)),
            );
            return;
          }
          res.setHeader("Content-Type", "application/json");
          const route = url.pathname
            .slice("/__sim/api".length)
            .split("/")
            .filter(Boolean)
            .map(decodeURIComponent);
          let body = {};
          if (req.method !== "GET") {
            if (req.headers["x-sim-csrf"] !== workspace.csrf) {
              res
                .writeHead(403)
                .end(
                  JSON.stringify({ error: "Missing simulator CSRF token." }),
                );
              return;
            }
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
            mutations.push({ method: req.method, route, body });
          }
          if (route[0] === "state") {
            res.end(JSON.stringify(workspace));
            return;
          }
          if (route[0] === "config") Object.assign(workspace.config, body);
          else if (route[0] === "live") workspace.status.liveConnected = true;
          else if (route[0] === "assets" && route[1] === "capture-shell") {
            if (body.path === "/denied/") {
              res.writeHead(409).end(
                JSON.stringify({
                  error: "Page shell capture incomplete.",
                  report: {
                    captured: [],
                    failures: [
                      {
                        path: "/missing.js",
                        message: "Static file unavailable.",
                      },
                    ],
                  },
                }),
              );
              return;
            }
            workspace.config.shellProfile = {
              stylesheets: ["/captured.css"],
              headScripts: ["/captured.js"],
              bodyScripts: [],
            };
            res.end(
              JSON.stringify({
                complete: true,
                pagePath: body.path,
                shellProfile: workspace.config.shellProfile,
                captured: ["/captured.css", "/captured.js"],
                failures: [],
                diagnostics: [],
              }),
            );
            return;
          } else if (route[0] === "assets") {
            res.end(JSON.stringify({ captured: body.paths }));
            return;
          } else if (route[0] === "presets" && route[2] === "apply") {
            const preset = workspace.config.presets.find(
              (entry) => entry.id === route[1],
            );
            Object.assign(workspace.data, preset.tables);
          } else if (route[0] === "records") {
            const records = (workspace.data[route[1]] ||= []);
            if (body.lastname === "Rejected") {
              res
                .writeHead(400)
                .end(JSON.stringify({ error: "Plugin rejected this value." }));
              return;
            }
            if (req.method === "POST") records.push(body);
            if (req.method === "PATCH")
              Object.assign(
                records.find((entry) => entry.contactid === route[2]),
                body,
              );
            if (req.method === "DELETE")
              workspace.data[route[1]] = records.filter(
                (entry) => entry.contactid !== route[2],
              );
          } else {
            const items = workspace.config[route[0]];
            if (!items) {
              res
                .writeHead(404)
                .end(JSON.stringify({ error: "Unknown route" }));
              return;
            }
            if (req.method === "POST") items.push(body);
            if (req.method === "PATCH")
              Object.assign(
                items.find((entry) => entry.id === route[1]),
                body,
              );
            if (req.method === "DELETE")
              workspace.config[route[0]] = items.filter(
                (entry) => entry.id !== route[1],
              );
          }
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((error) => {
          res.writeHead(500).end(JSON.stringify({ error: error.message }));
        });
    });
    server.on("connect", (_req, socket) => {
      socket.on("error", () => {});
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch(browserLaunchOptions({
      headless: true,
      proxy: { server: origin, bypass: "127.0.0.1,localhost" },
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      ],
    }));
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1440, height: 960 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const pageErrors = [];
    const unexpected = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    context.on("request", (req) => {
      if (!req.url().startsWith(origin)) unexpected.push(req.url());
    });
    await page.goto(`${origin}/__sim/`);
    await page
      .getByRole("heading", { name: "Your local portal workspace" })
      .waitFor();
    await page.getByText("Discovered pages", { exact: true }).waitFor();
    const evidenceDir = process.env.PAQVILO_MIRAGE_ADMIN_EVIDENCE;
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({
        path: path.join(evidenceDir, "admin-desktop.png"),
        fullPage: true,
      });
    }
    await page.getByRole("link", { name: "Data records", exact: true }).click();
    await page
      .getByRole("button", { name: "Create record", exact: true })
      .click();
    const editor = page.locator("#editor");
    await page.locator("#editor-json").fill("{invalid");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await page.locator("#editor-error").waitFor({ state: "visible" });
    assert.equal(workspace.data.contact.length, 1);
    await page.locator("#editor-json").fill(
      JSON.stringify({
        contactid: "c2",
        firstname: "Created",
        lastname: "Contact",
      }),
    );
    await editor.getByRole("button", { name: "Save changes" }).click();
    await editor.waitFor({ state: "hidden" });
    assert.equal(workspace.data.contact.length, 2);
    const created = page.getByRole("row").filter({ hasText: "Created" });
    await created.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator("#editor-json").fill(
      JSON.stringify({
        contactid: "c2",
        firstname: "Updated",
        lastname: "Rejected",
      }),
    );
    await editor.getByRole("button", { name: "Save changes" }).click();
    await page
      .getByText("Plugin rejected this value.", { exact: true })
      .waitFor();
    assert.equal(workspace.data.contact[1].firstname, "Created");
    await page.locator("#editor-json").fill(
      JSON.stringify({
        contactid: "c2",
        firstname: "Updated",
        lastname: "Contact",
      }),
    );
    await editor.getByRole("button", { name: "Save changes" }).click();
    await editor.waitFor({ state: "hidden" });
    await page.locator("#record-search").fill("updated");
    assert.equal(await page.locator("tbody tr").count(), 1);
    await page.getByRole("button", { name: "Delete c2" }).click();
    await page
      .locator("#confirm")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.locator("#confirm").waitFor({ state: "hidden" });
    assert.equal(workspace.data.contact.length, 1);

    const cases = [
      [
        "Endpoints",
        "Add endpoint",
        {
          id: "endpoint1",
          path: "/custom",
          method: "GET",
          mode: "local",
          status: 200,
          body: { hello: "world" },
        },
        "endpoints",
      ],
      [
        "Entity mappings",
        "Add mapping",
        {
          id: "account",
          logicalName: "account",
          entitySet: "accounts",
          idColumn: "accountid",
        },
        "mappings",
      ],
      [
        "Plugins & presets",
        "Add plugin",
        {
          id: "plugin1",
          name: "Compute name",
          entity: "contact",
          operations: ["create"],
          set: {
            fullname: {
              op: "concat",
              args: ["$record.firstname", " ", "$record.lastname"],
            },
          },
        },
        "plugins",
      ],
      [
        "Identity & permissions",
        "Add permission",
        {
          id: "permission1",
          entity: "contact",
          roles: ["Tester"],
          operations: ["read"],
          scope: "self",
        },
        "permissions",
      ],
    ];
    for (const [view, action, item, collection] of cases) {
      await page.getByRole("link", { name: view, exact: true }).click();
      if (collection === "permissions")
        await page
          .getByText("Edit local table permission rules (0)", { exact: true })
          .click();
      await page
        .getByRole("button", { name: action, exact: true })
        .first()
        .click();
      await page.locator("#editor-json").fill(JSON.stringify(item));
      await editor.getByRole("button", { name: "Save changes" }).click();
      await editor.waitFor({ state: "hidden" });
      assert.ok(
        workspace.config[collection].some((entry) => entry.id === item.id),
      );
      const tableRow = page.locator("tbody tr").filter({
        has: page.locator(`[data-edit="${collection}"][data-id="${item.id}"]`),
      });
      await tableRow.getByRole("button", { name: "Edit", exact: true }).click();
      await page
        .locator("#editor-json")
        .fill(
          JSON.stringify({ ...item, description: "Updated configuration" }),
        );
      await editor.getByRole("button", { name: "Save changes" }).click();
      await editor.waitFor({ state: "hidden" });
      assert.equal(
        workspace.config[collection].find((entry) => entry.id === item.id)
          .description,
        "Updated configuration",
      );
      await page
        .getByRole("button", { name: `Delete ${item.id}`, exact: true })
        .click();
      await page
        .locator("#confirm")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await page.locator("#confirm").waitFor({ state: "hidden" });
      assert.ok(
        !workspace.config[collection].some((entry) => entry.id === item.id),
      );
    }

    await page
      .getByRole("link", { name: "Plugins & presets", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add preset", exact: true })
      .first()
      .click();
    await page.locator("#editor-json").fill(
      JSON.stringify({
        id: "preset1",
        name: "Contact demo",
        tables: {
          contact: [
            {
              contactid: "preset-contact",
              firstname: "Preset",
              lastname: "Contact",
            },
          ],
        },
      }),
    );
    await editor.getByRole("button", { name: "Save changes" }).click();
    await editor.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page
      .locator("#confirm")
      .getByRole("button", { name: "Apply preset", exact: true })
      .click();
    await page.locator("#confirm").waitFor({ state: "hidden" });
    assert.equal(workspace.data.contact[0].contactid, "preset-contact");

    await page
      .getByRole("link", { name: "Identity & permissions", exact: true })
      .click();
    await page
      .getByText("Advanced: configured identity (sign-in default and scripts)", { exact: true })
      .click();
    await page.getByLabel("Contact ID", { exact: true }).fill("tester-contact");
    await page.getByLabel("Display name", { exact: true }).fill("Local tester");
    await page
      .getByLabel("Web roles", { exact: true })
      .fill("Tester, Reviewer");
    await page.getByLabel("Permission enforcement").selectOption("enforce");
    await page.getByRole("button", { name: "Save identity" }).click();
    await page.getByText("Configuration saved.", { exact: true }).waitFor();
    assert.equal(workspace.config.identity.contactId, "tester-contact");
    assert.deepEqual(workspace.config.identity.roles, ["Tester", "Reviewer"]);
    await page
      .getByRole("group", { name: "Available web roles", exact: true })
      .getByLabel("Authority", { exact: true })
      .check();
    await page
      .getByRole("group", { name: "Available web roles", exact: true })
      .getByLabel("Reviewer", { exact: true })
      .uncheck();
    await page.getByRole("button", { name: "Save identity" }).click();
    await page.getByText("Configuration saved.", { exact: true }).waitFor();
    assert.deepEqual(workspace.config.identity.roles, ["Tester", "Authority"]);
    await page
      .getByLabel("Available preset", { exact: true })
      .selectOption("preset1");
    await page
      .getByRole("button", { name: "Apply selected preset", exact: true })
      .click();
    await page
      .locator("#confirm")
      .getByRole("button", { name: "Apply preset", exact: true })
      .click();
    await page.locator("#confirm").waitFor({ state: "hidden" });
    assert.equal(workspace.data.contact[0].contactid, "preset-contact");
    assert.equal(workspace.config.permissionMode, "enforce");

    await page
      .getByRole("link", { name: "Entity mappings", exact: true })
      .click();
    workspace.status.solutionMetadata = {
      roots: [],
      forms: 0,
      views: 0,
      unresolved: 0,
    };
    await page.locator("#refresh").click();
    await page.getByText("No solution sources", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("Import reported", { exact: true }).count(),
      0,
    );
    workspace.status.solutionMetadata = {
      counts: { entities: 2, forms: 3, views: 4 },
      sources: ["synthetic solution root"],
      unresolved: [
        { code: "missing-view", message: "Example unresolved view" },
      ],
    };
    await page.locator("#refresh").click();
    await page
      .getByRole("heading", { name: "Imported solution metadata", exact: true })
      .waitFor();
    await page.getByText("Metadata sources", { exact: true }).click();
    await page
      .getByText("synthetic solution root", { exact: false })
      .first()
      .waitFor();
    await page
      .getByRole("button", { name: "Edit schemas", exact: true })
      .click();
    const schemas = {
      "Contact form": {
        entity: "contact",
        fields: [{ name: "firstname", label: "First name", required: true }],
      },
    };
    await page.locator("#editor-json").fill(JSON.stringify(schemas));
    await editor.getByRole("button", { name: "Save changes" }).click();
    await editor.waitFor({ state: "hidden" });
    assert.deepEqual(workspace.config.componentSchemas, schemas);

    await page
      .getByRole("link", { name: "Live connection", exact: true })
      .click();
    await page.getByRole("button", { name: "Edit shell profile" }).click();
    const shellProfile = {
      stylesheets: ["/theme.css"],
      headScripts: ["/jquery.min.js"],
      bodyScripts: [{ src: "/portal.js", defer: true }],
    };
    await page.locator("#editor-json").fill(JSON.stringify(shellProfile));
    await editor.getByRole("button", { name: "Save changes" }).click();
    await editor.waitFor({ state: "hidden" });
    assert.deepEqual(workspace.config.shellProfile, shellProfile);
    await page
      .getByLabel("Data provider", { exact: true })
      .selectOption("live");
    await page
      .getByLabel("Page provider", { exact: true })
      .selectOption("local");
    await page
      .getByLabel("Environment origin", { exact: true })
      .fill("https://synthetic.invalid");
    const embeds=page.getByLabel("Online embedded content",{exact:true});
    assert.equal(await embeds.inputValue(),"");
    // Embedded-content exceptions apply to confined pages only, so confinement is switched on first.
    assert.equal(await embeds.isDisabled(),true);
    await page.getByLabel(/Confine local pages to loopback/).check();
    await embeds.fill("https://app.powerbi.com/private-report");
    await page.getByRole("button",{name:"Save routing"}).click();
    await page.getByText("Online embedded content requires exact HTTPS origins without credentials, paths, queries or fragments.",{exact:true}).waitFor();
    assert.equal(workspace.config.mode,"local","Invalid embed settings must not partially save routing.");
    assert.equal(workspace.config.externalFrameOrigins,undefined);
    await embeds.fill("https://app.powerbi.com\nhttps://app.powerbi.com/\nhttps://embed.synthetic.invalid");
    await page.getByRole("button", { name: "Save routing" }).click();
    await page.getByText("Live data selected", { exact: true }).waitFor();
    assert.equal(workspace.config.mode, "live");
    assert.equal(workspace.config.pageMode, "local");
    assert.equal(workspace.config.live.allowWrites, false);
    assert.deepEqual(workspace.config.externalFrameOrigins,["https://app.powerbi.com","https://embed.synthetic.invalid"]);
    assert.equal(workspace.config.externalAssets,false,"Frame origins remain independent of the broad external asset setting.");
    assert.equal(workspace.config.confinePortalPages,true);
    await page.getByRole("link", { name: "Data records", exact: true }).click();
    await page
      .getByText("This editor changes local records.", { exact: false })
      .waitFor();
    await page
      .getByRole("link", { name: "Live connection", exact: true })
      .click();
    await page.getByRole("button", { name: "Connect browser" }).click();
    await page.getByText("Connected", { exact: true }).waitFor();
    assert.ok(
      mutations.some(
        (item) =>
          item.route.join("/") === "live/connect" &&
          item.body.cdpUrl === "http://127.0.0.1:9222",
      ),
    );
    await page
      .getByLabel("Portal page path", { exact: true })
      .fill("/workspace/");
    await page
      .getByRole("button", { name: "Capture and replace shell", exact: true })
      .click();
    await page
      .getByText("Page shell replaced. Captured 2 static files.", {
        exact: true,
      })
      .waitFor();
    assert.equal(workspace.config.shellProfile.stylesheets[0], "/captured.css");
    assert.match(
      await page.locator("#shell-capture-report").innerText(),
      /captured\.css/,
    );
    assert.ok(
      mutations.some(
        (item) =>
          item.route.join("/") === "assets/capture-shell" &&
          item.body.path === "/workspace/",
      ),
    );
    await page.getByLabel("Portal page path", { exact: true }).fill("/denied/");
    await page
      .getByRole("button", { name: "Capture and replace shell", exact: true })
      .click();
    await page
      .getByText("Page shell capture incomplete.", { exact: true })
      .waitFor();
    assert.match(
      await page.locator("#shell-capture-report").innerText(),
      /Static file unavailable/,
    );
    assert.equal(workspace.config.shellProfile.stylesheets[0], "/captured.css");
    await page
      .getByLabel("Static file paths")
      .fill("/static/theme.css\n/static/portal.js");
    await page
      .getByRole("button", { name: "Capture assets", exact: true })
      .click();
    await page
      .getByText("Captured 2 files for 2 requested paths.", { exact: true })
      .waitFor();
    assert.ok(
      mutations.some(
        (item) =>
          item.route.join("/") === "assets/capture" &&
          item.body.paths.length === 2,
      ),
    );

    await page.getByLabel("Static file paths").fill("/static/theme.css");
    await page
      .getByLabel("Observe selected stylesheet versions", { exact: true })
      .check();
    await page
      .getByRole("button", { name: "Capture assets", exact: true })
      .click();
    await page
      .getByText("Captured 1 files for 1 requested paths.", { exact: true })
      .waitFor();
    assert.ok(
      mutations.some(
        (item) =>
          item.route.join("/") === "assets/capture-stylesheets" &&
          item.body.paths[0] === "/static/theme.css",
      ),
    );
    await page
      .locator("#snippet-composition-form")
      .locator("..")
      .locator("summary")
      .first()
      .click();
    await page
      .getByLabel("Observed page path", { exact: true })
      .fill("/owned-products/");
    await page
      .getByLabel("Parent snippet name", { exact: true })
      .fill("Empty state");
    await page
      .getByLabel("Existing action snippet name", { exact: true })
      .fill("Create action");
    await page
      .getByRole("button", { name: "Observe static composition", exact: true })
      .click();
    await page
      .getByText("Observed composition verified against both local snippets.", {
        exact: true,
      })
      .waitFor();
    assert.ok(
      mutations.some(
        (item) =>
          item.route.join("/") === "assets/capture-snippet-composition" &&
          item.body.path === "/owned-products/" &&
          item.body.parentName === "Empty state" &&
          item.body.childName === "Create action",
      ),
    );

    await page
      .getByRole("link", { name: "Render & diagnostics", exact: true })
      .click();
    await page.locator(".diagnostic-group summary").click();
    await page
      .getByText("<script>window.injected = true</script>", { exact: true })
      .waitFor();
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.ok(
      await page
        .getByText("Exact portal parity has not been established", {
          exact: false,
        })
        .count(),
    );
    workspace.evidence = {
      passed: true,
      verified: true,
      stale: true,
      path: "/workspace/",
      pixels: { different: 0, total: 100, fraction: 0 },
    };
    await page.locator("#refresh").click();
    await page.getByText("Stale evidence", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("Evidence reported", { exact: true }).count(),
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    if (evidenceDir)
      await page.screenshot({
        path: path.join(evidenceDir, "admin-mobile.png"),
        fullPage: true,
      });
    await page
      .getByRole("link", { name: "Live connection", exact: true })
      .click();
    await page
      .getByLabel("Data provider", { exact: true })
      .selectOption("local");
    await page
      .getByLabel("Page provider", { exact: true })
      .selectOption("live");
    await page.getByRole("button", { name: "Save routing" }).click();
    await page.getByText("Local data selected", { exact: true }).waitFor();
    assert.equal(workspace.config.mode, "local");
    assert.equal(workspace.config.pageMode, "live");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page
      .getByText("Live page passthrough is online output", { exact: false })
      .waitFor();
    if (evidenceDir)
      await page.screenshot({
        path: path.join(evidenceDir, "admin-mobile-routing.png"),
        fullPage: true,
      });
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unexpected, []);
  },
);

test(
  "admin integrates with the simulator CSRF, persistence, plugin validation, identity, and local Liquid",
  { timeout: 60_000 },
  async (t) => {
    const { createSimulator } = await import("../server.mjs");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paqvilo-mirage-admin-"));
    const source = path.join(directory, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, "Home.webpage.yml"),
      "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\n",
    );
    fs.writeFileSync(
      path.join(source, "Home.webpage.copy.html"),
      '<h1>Local portal {{ user.name | escape }}</h1><input id="userroles" type="hidden" value="{{ user.roles | join: \'|\' }}"><script>window.portalRoles = document.getElementById("userroles").value;</script>',
    );
    const simulator = await createSimulator({
      sourceDir: source,
      stateFile: path.join(directory, "state.json"),
      watch: false,
      initial: {
        version: 1,
        mappings: {
          contact: {
            entitySet: "contacts",
            idColumn: "contactid",
            relationships: {},
          },
        },
        tables: { contact: [] },
        permissions: [],
        plugins: [],
        presets: {},
        settings: { permissionMode: "permissive" },
        simulator: {
          mode: "local",
          pageMode: "local",
          identity: { roles: [] },
          // This test drives the configured identity form: let cookie-less portal requests use
          // it (the documented opt-in for offline tooling) instead of a sign-in session.
          identityScope: "configured",
          live: { allowWrites: false },
          endpoints: [],
        },
      },
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await simulator.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    browser = await chromium.launch(browserLaunchOptions({
      headless: true,
      proxy: { server: simulator.url, bypass: "127.0.0.1,localhost" },
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      ],
    }));
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(simulator.adminUrl);
    await page
      .getByRole("heading", { name: "Your local portal workspace" })
      .waitFor();
    await page
      .getByRole("link", { name: "Plugins & presets", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add plugin", exact: true })
      .first()
      .click();
    await page.locator("#editor-json").fill(
      JSON.stringify({
        id: "last-name",
        entity: "contact",
        operations: ["create"],
        validate: [
          {
            field: "lastname",
            required: true,
            message: "Last name is required.",
          },
        ],
        set: {
          fullname: {
            op: "concat",
            args: ["$record.firstname", " ", "$record.lastname"],
          },
        },
      }),
    );
    await page
      .locator("#editor")
      .getByRole("button", { name: "Save changes" })
      .click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    assert.equal(simulator.state().config.plugins.length, 1);
    await page.getByRole("link", { name: "Data records", exact: true }).click();
    await page
      .getByRole("button", { name: "Create record", exact: true })
      .first()
      .click();
    await page
      .locator("#editor-json")
      .fill(JSON.stringify({ contactid: "acceptance", firstname: "Ada" }));
    await page
      .locator("#editor")
      .getByRole("button", { name: "Save changes" })
      .click();
    await page.locator("#editor-error").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#editor-error").innerText(),
      /Last name is required/,
    );
    assert.equal(simulator.state().data.contact.length, 0);
    await page.locator("#editor-json").fill(
      JSON.stringify({
        contactid: "acceptance",
        firstname: "Ada",
        lastname: "Lovelace",
      }),
    );
    await page
      .locator("#editor")
      .getByRole("button", { name: "Save changes" })
      .click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    assert.equal(simulator.state().data.contact[0].fullname, "Ada Lovelace");
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(directory, "state.json"), "utf8"),
    );
    assert.equal(onDisk.tables.contact[0].fullname, "Ada Lovelace");
    await page
      .getByRole("link", { name: "Identity & permissions", exact: true })
      .click();
    await page
      .getByText("Advanced: configured identity (sign-in default and scripts)", { exact: true })
      .click();
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Acceptance tester");
    await page.getByRole("button", { name: "Save identity" }).click();
    await page.getByText("Configuration saved.", { exact: true }).waitFor();
    assert.equal(simulator.state().config.identity.name, "Acceptance tester");
    const portal = await context.newPage();
    await portal.goto(simulator.url);
    await portal
      .getByRole("heading", { name: "Local portal Acceptance tester" })
      .waitFor();
    await page
      .getByLabel("Web roles", { exact: true })
      .fill("Tester, Reviewer");
    await page
      .getByRole("button", { name: "Save identity", exact: true })
      .click();
    await portal.waitForFunction(
      () => window.portalRoles === "Tester|Reviewer",
    );
    assert.equal(
      await portal.locator("#userroles").inputValue(),
      "Tester|Reviewer",
    );
    assert.deepEqual(errors, []);
  },
);
