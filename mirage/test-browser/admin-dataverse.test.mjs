// The /_sim/ Dataverse API view: registration shows a secret once, later admin reads never carry it,
// and a runtime without the API renders the disabled state. Uses a disposable loopback simulator.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-admin-dataverse-"));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: Dataverse admin\n");
  const app = await createSimulator({ sourceDir: directory, watch: false, ...options });
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

test("registering an application shows its secret once and later reads carry only the hint", { timeout: 60_000 }, async (t) => {
  const { app, page, errors } = await fixture(t, { dataverse: { enabled: true } });
  await page.goto(app.adminUrl + "#dataverse");
  await page.getByRole("heading", { name: "Dataverse API" }).waitFor();
  await page.getByText(app.state().dataverse.origin, { exact: true }).waitFor();
  await page.getByLabel("Display name", { exact: true }).fill("Browser client");
  await page.getByRole("button", { name: "Register application" }).click();
  const secret = (await page.locator("#dv-secret").textContent()).trim();
  assert.ok(secret.length >= 20, "a client secret is shown once");
  await page.getByRole("button", { name: "Copy secret" }).waitFor();
  await page.getByText("not shown again").waitFor();
  const appRow = page.getByRole("row", { name: /Browser client/ }).first();
  await appRow.getByRole("button", { name: "Add secret" }).waitFor();
  assert.match(await appRow.textContent(), new RegExp(secret.slice(0, 3) + "…"), "the listing shows only the hint");
  await page.getByRole("row", { name: /Browser client/ }).nth(1).getByRole("button", { name: "Disable" }).waitFor();
  const listing = await (await fetch(`${app.url}/_sim/api/dataverse`)).json();
  const entry = listing.applications.find((item) => item.displayName === "Browser client");
  assert.equal(entry.secrets[0].hint, secret.slice(0, 3));
  assert.equal(JSON.stringify(listing).includes(secret), false, "the admin read never carries the secret");
  assert.ok(listing.users.some((user) => user.fullname === "Browser client"), "the application user is listed");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.locator("#refresh").click();
  await page.getByText("Workspace refreshed.", { exact: true }).waitFor();
  await page.getByRole("row", { name: /Browser client/ }).first().waitFor();
  assert.equal((await page.locator("#content").textContent()).includes(secret), false, "the secret is gone after dismissal");
  await page.getByRole("row", { name: /Browser client/ }).nth(1).getByRole("button", { name: "Disable" }).click();
  await page.getByText("User disabled.", { exact: true }).waitFor();
  const after = await (await fetch(`${app.url}/_sim/api/dataverse`)).json();
  assert.equal(after.users.find((user) => user.fullname === "Browser client").isdisabled, true);
  assert.deepEqual(errors, []);
});

test("a runtime without the Dataverse API renders the disabled state", { timeout: 60_000 }, async (t) => {
  const { app, page, errors } = await fixture(t);
  await page.goto(app.adminUrl + "#dataverse");
  await page.getByText("Dataverse API is disabled for this runtime", { exact: true }).waitFor();
  assert.equal(await page.locator("#dv-app-form").count(), 0);
  assert.deepEqual(errors, []);
});

test("user, role, secret and certificate forms round-trip through the admin endpoints", { timeout: 60_000 }, async (t) => {
  const { app, page, errors } = await fixture(t, { dataverse: { enabled: true } });
  const { generateKeyPairSync } = await import("node:crypto");
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await page.goto(app.adminUrl + "#dataverse");
  await page.getByRole("heading", { name: "Dataverse API" }).waitFor();
  await page.getByLabel("Full name", { exact: true }).fill("Maker User");
  await page.getByLabel("Sign-in name (domainname)", { exact: true }).fill("maker@example.test");
  await page.getByLabel(/Password for ROPC sign-in/).fill("correct horse battery");
  await page.locator("#dv-user-form").getByLabel("System Customizer", { exact: true }).check();
  await page.getByRole("button", { name: "Create user" }).click();
  await page.getByText("User created.", { exact: true }).waitFor();
  const userRow = page.getByRole("row", { name: /Maker User/ });
  await userRow.getByText("Password set", { exact: true }).waitFor();
  assert.equal(await userRow.getByLabel("System Customizer", { exact: true }).isChecked(), true);
  await userRow.getByLabel("System Customizer", { exact: true }).uncheck();
  await userRow.getByLabel("Basic User", { exact: true }).check();
  await userRow.getByRole("button", { name: "Save roles" }).click();
  await page.getByText("Roles saved.", { exact: true }).waitFor();
  let listing = await (await fetch(`${app.url}/_sim/api/dataverse`)).json();
  const user = listing.users.find((item) => item.fullname === "Maker User");
  assert.deepEqual(user.roles, ["Basic User"]);
  assert.equal(user.passwordSet, true);
  assert.equal(JSON.stringify(listing).includes("correct horse battery"), false);

  await page.getByLabel("Display name", { exact: true }).fill("Cert client");
  await page.getByRole("button", { name: "Register application" }).click();
  const first = (await page.locator("#dv-secret").textContent()).trim();
  const appRow = page.getByRole("row", { name: /Cert client/ }).first();
  await appRow.getByRole("button", { name: "Add secret" }).click();
  await page.getByText("Secret added. Copy it now.", { exact: true }).waitFor();
  const second = (await page.locator("#dv-secret").textContent()).trim();
  assert.notEqual(second, first);
  await appRow.getByRole("button", { name: "Remove" }).first().click();
  await page.getByText("Secret removed.", { exact: true }).waitFor();
  await page.getByLabel("Public key (PEM)", { exact: true }).fill(publicKey.export({ type: "spki", format: "pem" }));
  await page.getByRole("button", { name: "Add certificate" }).click();
  await page.getByText("Certificate added.", { exact: true }).waitFor();
  listing = await (await fetch(`${app.url}/_sim/api/dataverse`)).json();
  const registration = listing.applications.find((item) => item.displayName === "Cert client");
  assert.equal(registration.secrets.length, 1);
  assert.match(registration.certificates[0].thumbprint, /^[0-9A-F]{40}$/);
  await appRow.getByText(registration.certificates[0].thumbprint, { exact: true }).waitFor();
  await appRow.getByRole("button", { name: "Remove" }).last().click();
  await page.getByRole("button", { name: "Remove application" }).click();
  await page.getByText("Application removed.", { exact: true }).waitFor();
  listing = await (await fetch(`${app.url}/_sim/api/dataverse`)).json();
  assert.equal(listing.applications.some((item) => item.displayName === "Cert client"), false);
  assert.equal(listing.users.some((item) => item.fullname === "Cert client"), false);
  assert.deepEqual(errors, []);
});
