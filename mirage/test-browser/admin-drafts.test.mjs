// Unsaved admin form input must survive asynchronous re-renders (lazy contact loading,
// workspace refreshes). Uses a disposable loopback simulator; no portal requests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-admin-drafts-"));
  await fs.writeFile(path.join(directory, "Home.webpage.yml"), "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n");
  await fs.writeFile(path.join(directory, "Home.webpage.copy.html"), "<h1>Draft fixture {{ user.name | escape }}</h1>");
  await fs.writeFile(path.join(directory, "webrole.yml"), "- adx_webroleid: reviewer\n  adx_name: Reviewer\n- adx_webroleid: editor\n  adx_name: Editor\n");
  const app = await createSimulator({
    sourceDir: directory,
    stateFile: path.join(directory, "state.json"),
    watch: false,
    initial: {
      version: 1,
      mappings: { contact: { entitySet: "contacts", idColumn: "contactid" } },
      tables: { contact: [{ contactid: "alex", fullname: "Alex Local" }] },
      permissions: [],
      plugins: [],
      presets: {},
      settings: { permissionMode: "permissive" },
      simulator: { mode: "local", pageMode: "local", identity: { roles: [] }, live: {}, endpoints: [] },
    },
  });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(async () => {
    await browser.close();
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { app, page, errors };
}

test("manual identity input survives the lazy contact re-render that previously discarded it", { timeout: 60_000 }, async (t) => {
  const { app, page, errors } = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = 0;
  // Hold the first contact page until the user has typed, reproducing a slow response.
  await page.route("**/__sim/api/records/contact?**", async (route) => {
    const response = await route.fetch();
    if (held++ === 0) await gate;
    await route.fulfill({ response });
  });
  await page.goto(app.adminUrl + "#access");
  await page.getByRole("heading", { name: "Identity & permissions" }).waitFor();
  await page.getByText("Advanced: configured identity (sign-in default and scripts)", { exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Draft survivor");
  await page.getByLabel("Web roles", { exact: true }).fill("Reviewer");
  release();
  // The delayed contacts arrive and the whole view renders again.
  await page.locator("#persona-contact").waitFor();
  assert.equal(await page.getByLabel("Display name", { exact: true }).inputValue(), "Draft survivor");
  assert.equal(await page.getByLabel("Web roles", { exact: true }).inputValue(), "Reviewer");
  assert.equal(await page.locator('[data-role-choice="Reviewer"]').isChecked(), true);
  await page.getByRole("button", { name: "Save identity" }).click();
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
  assert.equal(app.state().config.identity.name, "Draft survivor");
  assert.deepEqual(app.state().config.identity.roles, ["Reviewer"]);
  // After a successful save the form shows the saved values, not a stale draft.
  await page.locator("#refresh").click();
  await page.locator("#persona-contact").waitFor();
  assert.equal(await page.getByLabel("Display name", { exact: true }).inputValue(), "Draft survivor");
  assert.deepEqual(errors, []);
});

test("contact membership checkboxes survive a workspace refresh until saved, and reset when another contact is chosen", { timeout: 60_000 }, async (t) => {
  const { app, page, errors } = await fixture(t);
  await page.goto(app.adminUrl + "#access");
  const memberships = page.getByRole("group", { name: "Contact web-role memberships", exact: true });
  await memberships.getByLabel("Editor", { exact: true }).check();
  await page.locator("#refresh").click();
  await page.getByText("Workspace refreshed.", { exact: true }).waitFor();
  await page.locator("#persona-contact").waitFor();
  assert.equal(await memberships.getByLabel("Editor", { exact: true }).isChecked(), true, "unsaved membership choice is kept");
  await page.getByRole("button", { name: "Save contact roles", exact: true }).click();
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
  assert.deepEqual(app.state().config.contactRoles, [{ contactId: "alex", roleId: "editor" }]);
  assert.equal(await memberships.getByLabel("Editor", { exact: true }).isChecked(), true);
  assert.equal(await memberships.getByLabel("Reviewer", { exact: true }).isChecked(), false);
  await memberships.getByLabel("Reviewer", { exact: true }).check();
  await page.getByRole("button", { name: "Save contact roles", exact: true }).click();
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
  assert.deepEqual(app.state().config.contactRoles.map((row) => row.roleId).sort(), ["editor", "reviewer"]);
  assert.deepEqual(errors, []);
});
