import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";
import { signInContext } from "../testing/session.mjs";

test(
  "admin contact memberships refresh Liquid/source scripts and isolate companies for API reads and writes",
  { timeout: 45000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-personas-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(directory, "Home.webpage.yml"),
      "adx_webpageid: home\nadx_name: Persona portal\nadx_partialurl: /\n",
    );
    await fs.writeFile(
      path.join(directory, "sitesetting.yml"),
      "- adx_name: Webapi/application/enabled\n  adx_value: true\n- adx_name: Webapi/application/fields\n  adx_value: applicationid,name,companyid\n",
    );
    await fs.writeFile(
      path.join(directory, "Home.webpage.copy.html"),
      '<h1>{{ user.fullname }}</h1><input id="userroles" type="hidden" value="{{ user.roles | join: \'|\' }}"><div id="roles"></div><script>document.getElementById("roles").textContent=document.getElementById("userroles").value;</script>{% fetchxml applications %}<fetch><entity name="application"><attribute name="name"/></entity></fetch>{% endfetchxml %}<div id="apps">{% for row in applications.results.entities %}<p>{{row.name}}</p>{% endfor %}</div>',
    );
    await fs.writeFile(
      path.join(directory, "webrole.yml"),
      "- adx_webroleid: auth\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true\n- adx_webroleid: manager\n  adx_name: Review Manager\n- adx_webroleid: contributor\n  adx_name: Review Contributor\n- adx_webroleid: coordinator\n  adx_name: Review Coordinator\n",
    );
    const initial = {
      version: 1,
      mappings: {
        contact: { entitySet: "contacts", idColumn: "contactid" },
        account: { entitySet: "accounts", idColumn: "accountid" },
        application: { entitySet: "applications", idColumn: "applicationid" },
      },
      tables: {
        contact: [
          {
            contactid: "alex",
            fullname: "Alex Local",
            parentcustomerid: { id: "helios", logical_name: "account" },
          },
          {
            contactid: "blair",
            fullname: "Blair Local",
            parentcustomerid: { id: "boreal", logical_name: "account" },
          },
        ],
        account: [
          { accountid: "helios", name: "Helios" },
          { accountid: "boreal", name: "Boreal" },
        ],
        application: [
          {
            applicationid: "app-a",
            companyid: "helios",
            name: "Helios application",
          },
          {
            applicationid: "app-b",
            companyid: "boreal",
            name: "Boreal application",
          },
        ],
      },
      permissions: [
        {
          id: "read-own",
          entity: "application",
          roles: ["Authenticated Users"],
          scope: "account",
          field: "companyid",
          operations: ["read"],
        },
        {
          id: "edit-own",
          entity: "application",
          roles: ["Review Manager", "Review Coordinator"],
          scope: "account",
          field: "companyid",
          operations: ["update", "create"],
        },
      ],
      settings: { permissionMode: "enforce" },
      simulator: {
        mode: "local",
        pageMode: "local",
        permissionSource: "configured",
        identity: { contactId: "alex", roleSource: "memberships", roles: [] },
        contactRoles: [
          { contactId: "alex", roleId: "manager" },
          { contactId: "blair", roleId: "coordinator" },
        ],
        live: { allowWrites: false },
        endpoints: [],
      },
    };
    const app = await createSimulator({
      sourceDir: directory,
      stateFile: path.join(directory, "state.json"),
      watch: false,
      initial,
    });
    t.after(() => app.close());
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(() => browser.close());
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) =>
      route.request().url().startsWith(app.url)
        ? route.continue()
        : route.abort(),
    );
    const portal = await context.newPage(),
      admin = await context.newPage(),
      errors = [];
    for (const page of [portal, admin])
      page.on("pageerror", (error) => errors.push(error.message));
    // Portal pages render for this browser's own session (a cookie). Requests through the
    // browser context carry it; plain fetch() calls would be anonymous.
    const asBrowser = (route, options = {}) =>
      context.request.fetch(app.url + route, {
        failOnStatusCode: false,
        ...options,
      });
    await signInContext(context, app, "alex");
    await admin.goto(app.url + "/__sim/#access");
    await admin
      .getByText("Signed in as Alex Local", { exact: true })
      .waitFor();
    await portal.goto(app.url);
    await portal
      .locator("#apps")
      .filter({ hasText: "Helios application" })
      .waitFor();
    assert.equal(
      await portal.locator("#apps").innerText(),
      "Helios application",
    );
    await admin
      .getByLabel("Persona for this browser", { exact: true })
      .selectOption("blair");
    await admin
      .getByRole("button", { name: "Sign in as Blair Local", exact: true })
      .click();
    // The admin runs the portal's sign-in and comes back to this view signed in.
    await admin.getByText("Signed in as Blair Local", { exact: true }).waitFor();
    await portal.reload();
    await portal
      .getByRole("heading", { name: "Blair Local", exact: true })
      .waitFor();
    await portal
      .locator("#roles")
      .filter({ hasText: "Review Coordinator" })
      .waitFor();
    assert.equal(
      await portal.locator("#apps").innerText(),
      "Boreal application",
    );
    let api = await asBrowser("/_api/applications");
    assert.deepEqual(
      (await api.json()).value.map((row) => row.applicationid),
      ["app-b"],
    );
    const token = app.state().csrf;
    api = await asBrowser("/_api/applications(app-a)", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        __RequestVerificationToken: token,
      },
      data: JSON.stringify({ name: "Unpermitted other company edit" }),
    });
    assert.equal(api.status(), 403);
    assert.equal((await api.json()).error.code, "90040102");
    assert.equal(
      app.store.snapshot().tables.application[0].name,
      "Helios application",
    );
    await admin
      .getByLabel("Local contact", { exact: true })
      .selectOption("blair");
    await admin
      .getByRole("group", { name: "Contact web-role memberships", exact: true })
      .getByLabel("Review Coordinator", { exact: true })
      .uncheck();
    await admin
      .getByRole("group", { name: "Contact web-role memberships", exact: true })
      .getByLabel("Review Contributor", { exact: true })
      .check();
    await admin
      .getByRole("button", { name: "Save contact roles", exact: true })
      .click();
    await admin.getByText("Configuration saved.", { exact: true }).waitFor();
    await portal
      .locator("#roles")
      .filter({ hasText: "Review Contributor" })
      .waitFor();
    api = await asBrowser("/_api/applications(app-b)", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        __RequestVerificationToken: token,
      },
      data: JSON.stringify({ name: "Contributor edit denied" }),
    });
    assert.equal(api.status(), 403);
    assert.equal((await api.json()).error.code, "90040102");
    assert.equal(
      app.store.snapshot().tables.application[1].name,
      "Boreal application",
    );
    const session = await (await asBrowser("/_sim/api/session")).json();
    assert.deepEqual(
      [session.contactId, session.accountId],
      ["blair", "boreal"],
    );
    const state = app.state();
    assert.equal(
      state.config.identity.contactId,
      "alex",
      "the sign-in page default is unchanged",
    );
    assert.deepEqual(
      state.config.contactRoles.filter((row) => row.contactId === "blair"),
      [{ contactId: "blair", roleId: "contributor" }],
    );
    await admin
      .getByRole("heading", { name: "Effective permission hierarchy" })
      .waitFor();
    assert.deepEqual(errors, []);
    if (process.env.PAQVILO_MIRAGE_ADMIN_EVIDENCE) {
      await fs.mkdir(process.env.PAQVILO_MIRAGE_ADMIN_EVIDENCE, { recursive: true });
      await admin.setViewportSize({ width: 390, height: 844 });
      await admin.screenshot({
        path: path.join(
          process.env.PAQVILO_MIRAGE_ADMIN_EVIDENCE,
          "admin-personas-mobile.png",
        ),
        fullPage: true,
      });
    }
  },
);
