import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssetCache, officeFontPath } from "../lib/asset-cache.mjs";

test("observed public Office fonts are mirrored without credentials and remain source-origin confined", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-fonts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source =
    "https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/fonts/segoeui-west-european/segoeui-regular.woff2";
  const requests = [],
    bytes = Buffer.from("synthetic-font");
  const cache = await new AssetCache({
    directory: dir,
    origin: "https://portal.example.test",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        status: 200,
        url,
        headers: new Headers({ "content-type": "font/woff2" }),
        arrayBuffer: async () => bytes,
      };
    },
  }).init();
  const result = await cache.captureOfficeFonts([source]);
  assert.equal(result.failures.length, 0);
  assert.equal(result.captured[0].sourceOrigin, "https://res-1.cdn.office.net");
  assert.deepEqual((await cache.get(officeFontPath(source))).body, bytes);
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.redirect, "manual");
  for (const url of [
    "https://evil.example/font.woff2",
    source + "?token=secret",
    source.replace("/fonts/", "/api/"),
    "https://user:pass@res.cdn.office.net/files/fabric-cdn-prod_1.1/assets/icons/a.woff",
  ])
    assert.throws(() => officeFontPath(url));
  const restored = await new AssetCache({
    directory: dir,
    origin: "https://portal.example.test",
  }).init();
  assert.deepEqual((await restored.get(officeFontPath(source))).body, bytes);
  cache.fetchImpl = async () => ({
    status: 302,
    headers: new Headers({ location: "https://evil.example/font.woff2" }),
  });
  assert.equal(
    (await cache.captureOfficeFonts([source])).failures[0].code,
    "ASSET_REDIRECT",
  );
});
