import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssetCache } from "../lib/asset-cache.mjs";
import {
  captureObservedStylesheets,
  resolveObservedStylesheet,
} from "../lib/observed-stylesheets.mjs";
const origin = "https://portal.example";
test("explicit mapped native stylesheet is served only while source/cache/origin bindings match", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-observed-style-"));
  try {
    const sourceDir = path.join(dir, "source");
    await fs.mkdir(sourceDir);
    const file = path.join(sourceDir, "theme.css");
    await fs.writeFile(file, "body{color:#1e1e1e}");
    const resource = { url: "/styles/theme.css", file },
      portal = { sourceDir, webFiles: [resource] },
      cache = await new AssetCache({
        directory: path.join(dir, "assets"),
        origin,
      }).init(),
      calls = [];
    const live = {
      origin,
      context: {},
      request: async (p, opts) => {
        calls.push({ p, method: opts.method });
        return {
          status: 200,
          headers: { "content-type": "text/css; charset=utf-8" },
          body: Buffer.from("body{color:#666}"),
        };
      },
    };
    const report = await captureObservedStylesheets(cache, live, {
      portal,
      paths: [resource.url],
    });
    assert.equal(report.complete, true);
    assert.deepEqual(calls, [{ p: resource.url, method: "GET" }]);
    assert.equal(
      report.diagnostics[0].code,
      "OBSERVED_STYLESHEET_VERSION_DIFFERENCE",
    );
    const active = await resolveObservedStylesheet(
      portal,
      resource,
      report.baselines,
      { cache, origin },
    );
    assert.equal(active.state, "observed");
    assert.equal(active.body.toString(), "body{color:#666}");
    assert.equal(active.contentType, "text/css; charset=utf-8");
    assert.equal(await fs.readFile(file, "utf8"), "body{color:#1e1e1e}");
    await fs.writeFile(file, "body{color:green}");
    assert.equal(
      (
        await resolveObservedStylesheet(portal, resource, report.baselines, {
          cache,
          origin,
        })
      ).state,
      "source-edited",
    );
    await fs.writeFile(file, "body{color:#1e1e1e}");
    assert.equal(
      (
        await resolveObservedStylesheet(portal, resource, report.baselines, {
          cache,
          origin: "https://other.example",
        })
      ).state,
      "origin-changed",
    );
    assert.equal(
      (
        await resolveObservedStylesheet(
          portal,
          resource,
          [...report.baselines, ...report.baselines],
          { cache, origin },
        )
      ).state,
      "ambiguous",
    );
    assert.equal(
      (
        await resolveObservedStylesheet(
          portal,
          resource,
          [{ ...report.baselines[0], cachePath: "/scripts/evil.js" }],
          { cache, origin },
        )
      ).state,
      "invalid",
    );
    assert.equal(
      (
        await resolveObservedStylesheet(
          portal,
          resource,
          [{ ...report.baselines[0], contentType: "text/html" }],
          { cache, origin },
        )
      ).state,
      "invalid",
    );
    await fs.writeFile(
      path.join(dir, "assets", report.baselines[0].sha256 + ".bin"),
      "body{color:red}",
    );
    assert.equal(
      (
        await resolveObservedStylesheet(portal, resource, report.baselines, {
          cache,
          origin,
        })
      ).state,
      "cache-unavailable",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("stylesheet observation failsclosed for unmapped/scripts/nonCSS and never issues writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-observed-style-"));
  try {
    const file = path.join(dir, "app.js");
    await fs.writeFile(file, "alert(1)");
    const portal = { sourceDir: dir, webFiles: [{ url: "/app.js", file }] },
      cache = await new AssetCache({
        directory: path.join(dir, "cache"),
        origin,
      }).init();
    let calls = 0;
    const live = {
      origin,
      context: {},
      request: async () => {
        calls++;
        throw Error("must not call");
      },
    };
    const report = await captureObservedStylesheets(cache, live, {
      portal,
      paths: ["/app.js", "/unknown.css", "/theme.css?token=x"],
    });
    assert.equal(report.failures.length, 3);
    assert.equal(report.baselines.length, 0);
    assert.equal(calls, 0);
    await assert.rejects(
      captureObservedStylesheets(
        cache,
        { origin },
        { portal, paths: ["/app.js"] },
      ),
      (e) => e.code === "OBSERVED_STYLESHEET_DISCONNECTED",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
