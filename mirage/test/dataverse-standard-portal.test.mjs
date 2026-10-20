// A standard table seeded for the Dataverse API stays invisible to the portal Web API: a known table that the site has
// not enabled answers 404 9004010C, as in Power Pages. Invented site and loopback only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";

test("a seeded standard table is not enabled on the portal Web API", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-dataverse-standard-portal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: Standard portal\n");
  await fs.writeFile(path.join(directory, "home.webpage.yml"), "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n");
  const app = await createSimulator({ sourceDir: directory, watch: false, dataverse: { enabled: true } });
  t.after(() => app.close());
  assert.ok(app.state().dataverse.enabled);
  const response = await fetch(`${app.url}/_api/accounts`, { headers: { accept: "application/json" } });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "9004010C");
});

test("a seeded plug-in and process table is not enabled on the portal Web API", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-dataverse-standard-portal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: Standard portal\n");
  await fs.writeFile(path.join(directory, "home.webpage.yml"), "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n");
  const app = await createSimulator({ sourceDir: directory, watch: false, dataverse: { enabled: true } });
  t.after(() => app.close());
  for (const table of ["workflows", "pluginassemblies"]) {
    const response = await fetch(`${app.url}/_api/${table}`, { headers: { accept: "application/json" } });
    assert.equal(response.status, 404, table);
    assert.equal((await response.json()).error.code, "9004010C", table);
  }
});
