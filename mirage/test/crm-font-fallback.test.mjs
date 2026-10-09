import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssetCache } from "../lib/asset-cache.mjs";
import { createSimulator } from "../server.mjs";

const origin = "https://portal.example.test";

function utf16be(value) {
  const bytes = Buffer.from(value, "utf16le");
  for (let index = 0; index < bytes.length; index += 2) {
    const first = bytes[index];
    bytes[index] = bytes[index + 1];
    bytes[index + 1] = first;
  }
  return bytes;
}

function crmWoffFixture() {
  const names = [
    { id: 1, value: "CRM MDL2 Assets" },
    { id: 6, value: "CRMMDL2Assets" },
  ];
  const strings = names.map(({ value }) => utf16be(value));
  const name = Buffer.alloc(6 + names.length * 12 + strings.reduce((sum, value) => sum + value.length, 0));
  name.writeUInt16BE(0, 0);
  name.writeUInt16BE(names.length, 2);
  name.writeUInt16BE(6 + names.length * 12, 4);
  let stringOffset = 0;
  names.forEach((item, index) => {
    const offset = 6 + index * 12, bytes = strings[index];
    name.writeUInt16BE(3, offset);
    name.writeUInt16BE(1, offset + 2);
    name.writeUInt16BE(0x409, offset + 4);
    name.writeUInt16BE(item.id, offset + 6);
    name.writeUInt16BE(bytes.length, offset + 8);
    name.writeUInt16BE(stringOffset, offset + 10);
    bytes.copy(name, 6 + names.length * 12 + stringOffset);
    stringOffset += bytes.length;
  });

  const format4 = Buffer.alloc(32);
  format4.writeUInt16BE(4, 0);
  format4.writeUInt16BE(format4.length, 2);
  format4.writeUInt16BE(4, 6); // two segments
  format4.writeUInt16BE(0xe001, 14);
  format4.writeUInt16BE(0xffff, 16);
  format4.writeUInt16BE(0, 18);
  format4.writeUInt16BE(0xe001, 20);
  format4.writeUInt16BE(0xffff, 22);
  format4.writeInt16BE(1, 24);
  format4.writeInt16BE(1, 26);
  const cmap = Buffer.alloc(12 + format4.length);
  cmap.writeUInt16BE(0, 0);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(1, 6);
  cmap.writeUInt32BE(12, 8);
  format4.copy(cmap, 12);

  const tables = [
    { tag: "cmap", bytes: cmap },
    { tag: "name", bytes: name },
  ];
  const total = 44 + tables.length * 20 + tables.reduce((sum, item) => sum + item.bytes.length, 0);
  const font = Buffer.alloc(total);
  font.write("wOFF", 0, "ascii");
  font.writeUInt32BE(0x00010000, 4);
  font.writeUInt32BE(total, 8);
  font.writeUInt16BE(tables.length, 12);
  let dataOffset = 44 + tables.length * 20;
  tables.forEach((item, index) => {
    const directory = 44 + index * 20;
    font.write(item.tag, directory, "ascii");
    font.writeUInt32BE(dataOffset, directory + 4);
    font.writeUInt32BE(item.bytes.length, directory + 8);
    font.writeUInt32BE(item.bytes.length, directory + 12);
    item.bytes.copy(font, dataOffset);
    dataOffset += item.bytes.length;
  });
  return font;
}

test("CRM MDL2 public font fallback is source-bound, glyph-checked, and reusable offline", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-crm-font-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = crmWoffFixture(), requests = [];
  const cache = await new AssetCache({
    directory,
    origin,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(bytes, { headers: { "content-type": "font/woff" } });
    },
  }).init();
  const result = await cache.capturePublicAlias({
    sourcePath: "/resource/powerappsportal/fonts/CRMMDL2.woff",
    targetPath: "/uclient/resources/styles/CRMMDL2.woff",
    requiredCodepoints: [0xe001],
  });
  const alias = result.captured.find((item) => item.path === "/uclient/resources/styles/CRMMDL2.woff");
  assert.ok(alias);
  assert.equal(alias.fallback.fontFamily, "CRM MDL2 Assets");
  assert.equal(alias.fallback.postScriptName, "CRMMDL2Assets");
  assert.deepEqual(alias.fallback.requiredCodepoints, [0xe001]);
  assert.equal(alias.sourceOrigin, "https://content.powerapps.com");
  assert.equal(requests[0].url, "https://content.powerapps.com/resource/powerappsportal/fonts/CRMMDL2.woff");
  assert.equal(requests[0].options.credentials, "omit");

  const restored = await new AssetCache({
    directory,
    origin,
    fetchImpl: async () => { throw new Error("offline cache must not fetch"); },
  }).init();
  const served = await restored.get("/uclient/resources/styles/CRMMDL2.woff");
  assert.equal(served.status, 200);
  assert.equal(served.headers["x-sim-asset-fallback"], "microsoft-public-cdn-font");
  assert.deepEqual(served.body, bytes);
  const sourceDir = path.join(directory, "portal");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "Home.webpage.yml"), "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n");
  const serverCache = await new AssetCache({
    directory: path.join(directory, "assets"),
    origin,
    fetchImpl: async () => new Response(bytes, { headers: { "content-type": "font/woff" } }),
  }).init();
  await serverCache.capturePublicAlias({
    sourcePath: "/resource/powerappsportal/fonts/CRMMDL2.woff",
    targetPath: "/uclient/resources/styles/CRMMDL2.woff",
    requiredCodepoints: [0xe001],
  });
  const app = await createSimulator({
    sourceDir,
    stateFile: path.join(directory, "state.json"),
    origin,
    watch: false,
  });
  t.after(() => app.close());
  assert.equal(app.state().config.live.origin, origin);
  const reloaded = await new AssetCache({ directory: path.join(directory, "assets"), origin: app.state().config.live.origin }).init();
  assert.equal((await reloaded.get("/uclient/resources/styles/CRMMDL2.woff"))?.status, 200);
  const response = await fetch(`${app.url}/uclient/resources/styles/CRMMDL2.woff`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-sim-asset-fallback"), "microsoft-public-cdn-font");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await assert.rejects(
    restored.capturePublicAlias({ sourcePath: "/other/font.woff", targetPath: "/uclient/resources/styles/CRMMDL2.woff" }),
    /observed CRM MDL2 native font path/,
  );

  const incomplete = await new AssetCache({
    directory: path.join(directory, "incomplete"),
    origin,
    fetchImpl: async () => new Response(bytes, { headers: { "content-type": "font/woff" } }),
  }).init();
  const failed = await incomplete.capturePublicAlias({
    sourcePath: "/resource/powerappsportal/fonts/CRMMDL2.woff",
    targetPath: "/uclient/resources/styles/CRMMDL2.woff",
    requiredCodepoints: [0xe002],
  });
  assert.equal(failed.captured.some((item) => item.path === "/uclient/resources/styles/CRMMDL2.woff"), false);
  assert.equal(failed.failures[0].code, "ASSET_FONT_GLYPH_COVERAGE");
});
