import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inventoryWebApi } from "../webapi-inventory.mjs";

// A site's own Web API client object is named by the caller (--client-wrapper); the inventory has
// no built-in project wrapper (independent review M3).
test("client wrapper calls count as requests only for the wrappers the caller names", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-inventory-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_name: Inventory\nadx_websiteid: site",
    "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main",
    "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main",
    "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/Main.webtemplate.source.html":
      "<script>App.WebApi._get('/_api/contacts?$select=fullname'); App.WebApi.post('/_api/contacts', {}); Other.Api._delete('/_api/contacts(1)'); AppXWebApi._patch('/_api/x');</script>",
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const methods = async (clientWrappers) =>
    (await inventoryWebApi(dir, { clientWrappers })).supportMatrix.filter((row) => row.feature.startsWith("method.")).map((row) => [row.feature, row.uses]);
  assert.deepEqual(await methods([]), []);
  // The name is literal: App.WebApi does not match AppXWebApi.
  assert.deepEqual(await methods(["App.WebApi"]), [["method.GET", 1], ["method.POST", 1]]);
  assert.deepEqual(await methods(["App.WebApi", "Other.Api"]), [["method.DELETE", 1], ["method.GET", 1], ["method.POST", 1]]);
});
