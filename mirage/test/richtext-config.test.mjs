import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AssetCache } from "../lib/asset-cache.mjs";
import {
  captureRichTextConfiguration,
  resolveRichTextConfiguration,
  richTextConfigurationStatus,
  validateRichTextConfiguration,
} from "../lib/richtext-config.mjs";
import { captureRichTextAssets } from "../lib/richtext-assets.mjs";
import { createSimulator } from "../server.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pp-rte-baseline-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "exported.js"),
    source = {
      defaultSupportedProps: { extraPlugins: "specialchar", height: 145 },
    },
    observed = {
      defaultSupportedProps: {
        extraPlugins: "specialchar,autogrow",
        height: 195,
        autoGrow_onStartup: true,
      },
    };
  await fs.writeFile(file, JSON.stringify(source));
  const resource = {
      file,
      name: "exported.js",
      url: "/exported.js",
      metadata: { adx_filename: "sample_eafRTEConfiguration.js" },
    },
    portal = { sourceDir: directory, webFiles: [resource] },
    origin = "https://portal.example.test",
    requests = [];
  const live = {
    origin,
    request: async (path, options) => {
      requests.push({ path, options });
      return {
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: Buffer.from(JSON.stringify(observed)),
      };
    },
  };
  const cache = new AssetCache({
    directory: path.join(directory, "assets"),
    origin,
  });
  await cache.init();
  return {
    directory,
    file,
    source,
    observed,
    resource,
    portal,
    live,
    cache,
    requests,
  };
}

test("observed static JSON is bound to the exact exported source SHA and captured integrity, with local edits winning immediately", async (t) => {
  const f = await fixture(t),
    capture = await captureRichTextConfiguration(f.cache, f.live, {
      portal: f.portal,
      resource: f.resource,
      configUrl: "/WebResources/sample_eafRTEConfiguration.js",
    });
  assert.deepEqual(f.requests, [
    {
      path: "/_webresource/sample_eafrteconfiguration.js",
      options: { method: "GET" },
    },
  ]);
  assert.equal(capture.failures.length, 0);
  assert.match(capture.baseline.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(capture.baseline.sha256, /^[a-f0-9]{64}$/);
  assert.equal(capture.baseline.sourceFile, "exported.js");
  assert.equal(capture.baseline.observedContentType, "application/javascript");
  assert.match(
    capture.baseline.cachePath,
    /^\/__sim-static\/richtext-config\/[a-f0-9]{64}\.json$/,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), f.source);
  let resolved = await resolveRichTextConfiguration(
    f.portal,
    f.resource,
    [capture.baseline],
    { cache: f.cache, origin: f.live.origin },
  );
  assert.deepEqual(resolved.configuration, f.observed);
  assert.equal(
    richTextConfigurationStatus(f.portal, [capture.baseline], f.live.origin)[0]
      .status,
    "eligible",
  );
  await fs.writeFile(
    f.file,
    JSON.stringify({ defaultSupportedProps: { height: 220 } }),
  );
  resolved = await resolveRichTextConfiguration(
    f.portal,
    f.resource,
    [capture.baseline],
    { cache: f.cache, origin: f.live.origin },
  );
  assert.equal(resolved.body, undefined);
  assert.equal(resolved.diagnostic.code, "RICHTEXT_CONFIG_SOURCE_CHANGED");
  assert.equal(
    richTextConfigurationStatus(f.portal, [capture.baseline], f.live.origin)[0]
      .status,
    "stale",
  );
  await fs.writeFile(f.file, JSON.stringify(f.source));
  resolved = await resolveRichTextConfiguration(
    f.portal,
    f.resource,
    [capture.baseline],
    { cache: f.cache, origin: "https://other.example.test" },
  );
  assert.equal(resolved.diagnostic.code, "RICHTEXT_CONFIG_ORIGIN_CHANGED");
  resolved = await resolveRichTextConfiguration(
    f.portal,
    f.resource,
    [{ ...capture.baseline, sha256: "0".repeat(64) }],
    { cache: f.cache, origin: f.live.origin },
  );
  assert.equal(resolved.diagnostic.code, "RICHTEXT_CONFIG_CACHE_INVALID");
  const script = "window.arbitraryScript = true;";
  await fs.writeFile(f.file, script);
  resolved = await resolveRichTextConfiguration(
    f.portal,
    f.resource,
    [
      {
        ...capture.baseline,
        sourceSha256: createHash("sha256").update(script).digest("hex"),
      },
    ],
    { cache: f.cache, origin: f.live.origin },
  );
  assert.equal(resolved.body, undefined);
  assert.equal(resolved.diagnostic.code, "RICHTEXT_CONFIG_BASELINE_INVALID");
});

test("only bounded inert rich-text JSON is accepted; wrappers, credentials, HTML and unrelated objects fail before persistence", async () => {
  for (const value of [
    "<html>Sign in</html>",
    'window.config={"defaultSupportedProps":{}}',
    '{"records":[{"fullname":"business value"}]}',
    '{"defaultSupportedProps":{"access_token":"private"}}',
    '{"defaultSupportedProps":{"constructor":{}}}',
  ])
    assert.throws(() => validateRichTextConfiguration(Buffer.from(value)));
  assert.deepEqual(
    validateRichTextConfiguration(
      Buffer.from('{"defaultSupportedProps":{"height":195}}'),
    ).defaultSupportedProps,
    { height: 195 },
  );
  assert.equal(
    richTextConfigurationStatus({}, {}).at(0).diagnostic.code,
    "RICHTEXT_CONFIG_BASELINE_INVALID",
  );
  assert.equal(richTextConfigurationStatus({}, [null]).at(0).status, "invalid");
});

test("rich-text dependency capture uses the observed active JSON plugin list without modifying source", async (t) => {
  const f = await fixture(t),
    calls = [],
    bodies = new Map();
  const cache = {
    async capture(paths, bridge) {
      if (paths[0].startsWith("/__sim-static/richtext-config/"))
        return f.cache.capture(paths, bridge);
      calls.push(...paths);
      for (const path of paths)
        bodies.set(
          path,
          Buffer.from(
            path.endsWith("RTEGlobalConfiguration.json")
              ? "{}"
              : path.endsWith("ckeditor.js")
                ? 'CKEDITOR.plugins.add("specialchar",{});'
                : "static",
          ),
        );
      return {
        captured: paths.map((path) => ({ path, sha256: "0".repeat(64) })),
        failures: [],
      };
    },
    async get(path) {
      if (path.startsWith("/__sim-static/"))
        return f.cache.get(path, { origin: f.live.origin });
      return bodies.has(path) ? { body: bodies.get(path) } : null;
    },
  };
  const result = await captureRichTextAssets(cache, f.live, {
    schemas: {
      fields: [
        {
          richText: {
            name: "MscrmControls.RichTextEditor.RichTextEditorControl",
            configUrl: "/WebResources/sample_eafRTEConfiguration.js",
          },
        },
      ],
    },
    portal: f.portal,
    captureConfigurations: true,
  });
  assert.equal(result.configurationBaselines.length, 1);
  assert.ok(calls.some((path) => path.endsWith("/plugins/autogrow/plugin.js")));
  assert.equal(result.assetsComplete, true);
  assert.equal(result.nativeReady, false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), f.source);
});

test("HTTP mapped local configuration serves validated observation until source edits and reports provenance/staleness", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.directory, "website.yml"),
    "adx_websiteid: site\nadx_name: Baseline fixture",
  );
  await fs.writeFile(
    path.join(f.directory, "Home.webpage.yml"),
    "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /",
  );
  await fs.writeFile(
    path.join(f.directory, "Config.webfile.yml"),
    "adx_webfileid: config\nadx_name: exported.js\nadx_partialurl: exported.js\nadx_filename: sample_eafRTEConfiguration.js\nadx_parentpageid: home",
  );
  await fs.writeFile(
    path.join(f.directory, "Config.webfile.js"),
    JSON.stringify(f.source),
  );
  const app = await createSimulator({
    sourceDir: f.directory,
    stateFile: path.join(f.directory, "state.json"),
    origin: f.live.origin,
    watch: false,
  });
  t.after(() => app.close());
  const resource = app.portal.webFiles.find(
    (file) => file.url === "/exported.js",
  );
  assert.ok(resource);
  const capture = await captureRichTextConfiguration(f.cache, f.live, {
    portal: app.portal,
    resource,
    configUrl: "/WebResources/sample_eafRTEConfiguration.js",
  });
  const response = await fetch(app.url + "/__sim/api/config", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-sim-csrf": app.state().csrf,
    },
    body: JSON.stringify({
      live: { origin: f.live.origin },
      shellProfile: { richTextConfigurations: [capture.baseline] },
    }),
  });
  assert.equal(response.status, 200);
  // Reload the cache manifest captured through the independent same-directory fixture cache.
  await app.close();
  const reopened = await createSimulator({
    sourceDir: f.directory,
    stateFile: path.join(f.directory, "state.json"),
    origin: f.live.origin,
    watch: false,
  });
  t.after(() => reopened.close());
  let served = await fetch(reopened.url + "/exported.js");
  assert.equal(
    served.status,
    200,
    served.status === 200 ? "" : await served.text(),
  );
  assert.equal(
    served.headers.get("x-sim-resource-provider"),
    "observed-richtext-json",
  );
  assert.equal(served.headers.get("content-type"), "application/json");
  assert.deepEqual(await served.json(), f.observed);
  const state = await (
    await fetch(reopened.url + "/__sim/api/state?summary=1")
  ).json();
  assert.equal(state.status.richTextConfigurations[0].status, "eligible");
  assert.equal(
    state.status.richTextConfigurations[0].observedPath,
    "/_webresource/sample_eafrteconfiguration.js",
  );
  await fs.writeFile(
    resource.file,
    JSON.stringify({ defaultSupportedProps: { height: 260 } }),
  );
  served = await fetch(reopened.url + "/exported.js");
  assert.equal(served.headers.get("x-sim-resource-provider"), null);
  assert.deepEqual(await served.json(), {
    defaultSupportedProps: { height: 260 },
  });
  const stale = await (
    await fetch(reopened.url + "/__sim/api/state?summary=1")
  ).json();
  assert.equal(stale.status.richTextConfigurations[0].status, "stale");
  assert.ok(
    stale.diagnostics.some(
      (diagnostic) => diagnostic.code === "RICHTEXT_CONFIG_SOURCE_CHANGED",
    ),
  );
});
