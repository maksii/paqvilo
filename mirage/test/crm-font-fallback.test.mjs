import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssetCache } from "../lib/asset-cache.mjs";
import { createSimulator } from "../server.mjs";
import { inventedCrmFont } from "./fixtures/crm-font.mjs";
import { ownedFixture } from "../testing/owned-fixture.mjs";

// Refused sources, glyph coverage and wrong families are covered in crm-platform-font-alias.test.mjs.
const origin = "https://portal.example.test";
const sourcePath = "/resource/powerappsportal/fonts/CRMMDL2.woff";
const targetPath = "/uclient/resources/styles/CRMMDL2.woff";

test("CRM MDL2 public font fallback is fetched from the CDN without credentials and served offline by the simulator", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-crm-font-"));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = inventedCrmFont(), requests = [];
  const assets = path.join(directory, "assets");
  const cache = await new AssetCache({
    directory: assets,
    origin,
    fetchImpl: async (url, options) => {
      requests.push({ url, credentials: options.credentials });
      return new Response(bytes, { headers: { "content-type": "font/woff" } });
    },
  }).init();
  const result = await cache.capturePublicAlias({ sourcePath, targetPath, requiredCodepoints: [0xe001] });
  const alias = result.captured.find((item) => item.path === targetPath);
  assert.deepEqual([alias.sourceOrigin, alias.fallback.fontFamily, alias.fallback.requiredCodepoints], ["https://content.powerapps.com", "CRM MDL2 Assets", [0xe001]]);
  assert.deepEqual(requests, [{ url: "https://content.powerapps.com" + sourcePath, credentials: "omit" }]);

  const sourceDir = path.join(directory, "portal");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "Home.webpage.yml"), "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n");
  const app = await createSimulator({ sourceDir, stateFile: path.join(directory, "state.json"), origin, watch: false });
  ownedFixture(t).add(() => app.close());
  const response = await fetch(`${app.url}${targetPath}`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-sim-asset-fallback"), "microsoft-public-cdn-font");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
