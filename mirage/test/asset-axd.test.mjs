import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetCache, isAspNetResourcePath } from "../lib/asset-cache.mjs";
import {
  capturePortalAspNetResources,
  capturePortalShell,
} from "../lib/shell-capture.mjs";

const origin = "https://portal.example.test";
const a = "/WebResource.axd?d=abcdefghijklmnop0123456789&t=638941941234567890";
const b = "/ScriptResource.axd?d=abcdefghijklmnop_0123456789&t=2b19ac10";
const html = `<html><head><link rel="stylesheet" href="/style.css"><script src="/jquery.js"></script></head><body><script src="${a.replaceAll("&", "&amp;")}"></script><script src="${b.replaceAll("&", "&amp;")}"></script></body></html>`;
const bytes = "window.Sys={CultureInfo:{InvariantCulture:{}}};";
function bridge(
  markup = html,
  resource = {
    status: 200,
    headers: { "content-type": "application/x-javascript" },
    body: Buffer.from(bytes),
  },
) {
  const calls = [];
  return {
    origin,
    context: {},
    calls,
    request: async (path, { method }) => {
      assert.equal(method, "GET");
      calls.push(path);
      if (path === "/native-form/")
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: Buffer.from(markup),
        };
      if (path === "/style.css")
        return {
          status: 200,
          headers: { "content-type": "text/css" },
          body: Buffer.from("body{}"),
        };
      if (path === "/jquery.js")
        return {
          status: 200,
          headers: { "content-type": "text/javascript" },
          body: Buffer.from("window.jQuery={};"),
        };
      return resource;
    },
  };
}
test("native HTML observed AXD scripts preserve exact opaque URLs, order, MIME and hash provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pp-axd-"));
  try {
    const cache = await new AssetCache({ directory: dir, origin }).init(),
      live = bridge();
    const result = await capturePortalAspNetResources(cache, live, {
      path: "/native-form/",
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.bodyScripts, [a, b]);
    assert.deepEqual(live.calls, ["/native-form/", a, b]);
    assert.equal((await cache.get(b)).body.toString(), bytes);
    assert.equal(
      await cache.get("/ScriptResource.axd?d=abcdefghijklmnop_NEW&t=2b19ac10"),
      null,
    );
    const restored = await new AssetCache({ directory: dir, origin }).init();
    assert.equal(
      (await restored.get(a)).headers["content-type"],
      "application/x-javascript",
    );
    const manifest = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    );
    assert.match(
      manifest.assets[0].aspNetObservation.htmlSha256,
      /^[a-f\d]{64}$/,
    );
    assert.equal(
      manifest.assets[0].aspNetObservation.pagePath,
      "/native-form/",
    );
    assert.equal(JSON.stringify(manifest).includes("<html"), false);
    await writeFile(join(dir, result.captured[0].sha256 + ".bin"), "tampered");
    await assert.rejects(restored.get(a), (e) => e.code === "ASSET_INTEGRITY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("AXD capture rejects unobserved requests, query credentials/duplicates, redirects, signin/empty bytes and invalid script MIME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pp-axd-deny-"));
  try {
    const cache = await new AssetCache({ directory: dir, origin }).init(),
      live = bridge();
    assert.equal(
      (await cache.capture([a], live)).failures[0].code,
      "ASSET_AXD_OBSERVATION",
    );
    assert.equal(live.calls.length, 0);
    for (const path of [
      a + "&token=SECRET",
      a + "&d=anotherhash",
      a + "&_=123",
      a.replace("WebResource", "Other"),
      a.replace("d=", "x="),
      "/WebResource.axd",
    ]) {
      assert.equal(isAspNetResourcePath(path), false);
      await assert.rejects(cache.get(path));
    }
    for (const resource of [
      { status: 302, headers: { location: b }, body: Buffer.from("") },
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<html>signin</html>"),
      },
      {
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: Buffer.from("<!doctype html>signin"),
      },
      {
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: Buffer.from(""),
      },
      {
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: Buffer.from('const authorization="Bearer CREDENTIAL_VALUE";'),
      },
    ]) {
      const result = await capturePortalAspNetResources(
        cache,
        bridge(html, resource),
        { path: "/native-form/" },
      );
      assert.equal(result.complete, false);
      assert.equal(result.captured.length, 0);
    }
    assert.equal(cache.manifest().assets.length, 0);
    for (const src of [
      "https://foreign.example.test" + a,
      a + "&token=SECRET",
      a + "&d=duplicate",
    ]) {
      const denied = bridge(
        `<html><body><script src="${src.replaceAll("&", "&amp;")}"></script><script src="${b.replaceAll("&", "&amp;")}"></script></body></html>`,
      );
      await assert.rejects(
        capturePortalAspNetResources(cache, denied, { path: "/native-form/" }),
      );
      assert.deepEqual(denied.calls, ["/native-form/"]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("shell capture includes native AXD body ordering and never treats comments/templates as observed resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pp-axd-shell-"));
  try {
    const cache = await new AssetCache({ directory: dir, origin }).init();
    const result = await capturePortalShell(cache, bridge(), {
      path: "/native-form/",
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.shellProfile.bodyScripts, [a, b]);
    await assert.rejects(
      capturePortalAspNetResources(
        cache,
        bridge(
          `<html><head></head><body><!--<script src="${a}"></script>--><template><script src="${b}"></script></template></body></html>`,
        ),
        { path: "/native-form/" },
      ),
      (e) => e.code === "SHELL_ASPNET_MISSING",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
