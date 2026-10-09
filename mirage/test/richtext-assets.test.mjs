import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { officeFontPath } from "../lib/asset-cache.mjs";
import {
  captureRichTextAssets,
  extractManagedRichTextControls,
  observeManagedResources,
} from "../lib/richtext-assets.mjs";

const base = "/webresources/msdyn_/RichTextEditorControl/",
  editor = base + "libs/ckeditor_latest/",
  control = "MscrmControls.RichTextEditor.RichTextEditorControl";
const live = {
  origin: "https://portal.example.test",
  status: () => ({ connected: true }),
};
function cacheFixture({
  failure,
  config = {
    defaultSupportedProps: {
      skin: "superowa",
      extraPlugins: "bundled,customplugin",
    },
  },
} = {}) {
  const calls = [],
    bodies = new Map();
  return {
    calls,
    async capture(paths) {
      const captured = [],
        failures = [];
      for (const path of paths) {
        calls.push(path);
        if (path === failure) {
          failures.push({
            path,
            code: "ASSET_HTTP",
            message: "Static capture returned HTTP 404.",
          });
          continue;
        }
        const body = path.endsWith("RTEGlobalConfiguration.json")
          ? JSON.stringify(config)
          : path.endsWith("ckeditor.js")
            ? 'CKEDITOR={timestamp:"O7L9"};CKEDITOR.plugins.add("bundled",{});'
            : path.endsWith(".json")
              ? "{}"
              : "static fixture";
        bodies.set(path, Buffer.from(body));
        captured.push({ path, bytes: body.length });
      }
      return { captured, failures };
    },
    async capturePublic(paths) {
      return this.capture(paths);
    },
    async capturePublicAlias({ sourcePath, targetPath, requiredCodepoints }) {
      calls.push(sourcePath);
      const fallback = {
        kind: "microsoft-public-cdn-font",
        sourcePath,
        cssFamily: "CRMMDL2",
        fontFamily: "CRM MDL2 Assets",
        postScriptName: "CRMMDL2Assets",
        requiredCodepoints,
      };
      const item = { path: targetPath, fallback };
      bodies.set(targetPath, Buffer.from("public CRM font"));
      return {
        captured: [
          { path: sourcePath, bytes: 15 },
          item,
        ],
        failures: [],
      };
    },
    async get(path) {
      return bodies.has(path) ? { body: bodies.get(path) } : null;
    },
  };
}

test("rich text discovery includes nested advanced steps and skips disconnected/no-control capture explicitly", async () => {
  const cache = cacheFixture();
  let result = await captureRichTextAssets(cache, live, {
    schemas: { form: { fields: [{ name: "name" }] } },
  });
  assert.equal(result.assetsComplete, true);
  assert.equal(result.skipped, "NO_RICH_TEXT_FIELDS");
  assert.deepEqual(cache.calls, []);
  result = await captureRichTextAssets(
    cache,
    { ...live, status: () => ({ connected: false }) },
    {
      schemas: {
        form: {
          steps: { second: { fields: [{ richText: { name: control } }] } },
        },
      },
    },
  );
  assert.equal(result.required, true);
  assert.equal(result.complete, false);
  assert.equal(result.skipped, "LIVE_DISCONNECTED");
  assert.deepEqual(cache.calls, []);
});

test("capture derives bounded plugins and exact timestamp sprite URLs without executing script", async () => {
  const cache = cacheFixture(),
    result = await captureRichTextAssets(cache, live, {
      schemas: {
        form: { steps: [{ fields: [{ richText: { name: control } }] }] },
      },
    });
  assert.equal(result.assetsComplete, true);
  assert.ok(cache.calls.includes(editor + "plugins/customplugin/plugin.js"));
  assert.ok(!cache.calls.includes(editor + "plugins/bundled/plugin.js"));
  assert.ok(cache.calls.includes(editor + "contents.css"));
  assert.ok(cache.calls.includes(editor + "plugins/icons.png?t=O7L9"));
  assert.ok(!cache.calls.includes(editor + "lang/en.js"));
  assert.ok(
    !cache.calls.includes(editor + "lang/editor-language-resources.js"),
  );
  assert.equal(result.nativeReady, false);
  assert.equal(result.complete, false);
  assert.ok(cache.calls.every((path) => path.startsWith(base)));
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "RICHTEXT_MANAGED_MANIFEST_MISSING",
    ),
  );
});

test("required rich text failures remain explicit and unconfigured or hostile paths are excluded", async () => {
  const cache = cacheFixture({ failure: editor + "contents.css" }),
    result = await captureRichTextAssets(cache, live, {
      schemas: { fields: [{ richText: true }] },
      observedResources: [
        "/_api/contacts?access_token=secret",
        "https://evil.example/script.js",
      ],
    });
  assert.equal(result.complete, false);
  assert.ok(
    result.failures.some(
      (error) =>
        error.path === editor + "contents.css" && error.code === "ASSET_HTTP",
    ),
  );
  assert.equal(
    result.failures.filter(
      (error) => error.code === "RICHTEXT_RESOURCE_EXCLUDED",
    ).length,
    2,
  );
  assert.ok(!JSON.stringify(result).includes("access_token"));
  assert.ok(
    !cache.calls.some(
      (path) => path.startsWith("/_api/") || path.startsWith("https:"),
    ),
  );
});

test("source-owned JSON configuration is read from its discovered file, never fetched as an arbitrary endpoint", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-rte-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.js");
  await fs.writeFile(
    file,
    JSON.stringify({ defaultSupportedProps: { extraPlugins: "sourceplugin" } }),
  );
  const cache = cacheFixture(),
    result = await captureRichTextAssets(cache, live, {
      schemas: {
        fields: [
          { richText: { name: control, configUrl: "/WebResources/source.js" } },
        ],
      },
      portal: { webFiles: [{ name: "source.js", file }] },
    });
  assert.equal(result.assetsComplete, true);
  assert.ok(cache.calls.includes(editor + "plugins/sourceplugin/plugin.js"));
  assert.ok(!cache.calls.includes(editor + "plugins/customplugin/plugin.js"));
  assert.ok(!cache.calls.includes("/WebResources/source.js"));
});

test("static PCF definitions preserve observed script order and exclude context/business attributes", async () => {
  const manifest = {
    Name: control,
    Properties: [{ Name: "value", DefaultValue: "" }],
    Resources: [
      { Type: 0, Path: "11111111-1111-1111-1111-111111111111" },
      { Type: 1, Path: "22222222-2222-2222-2222-222222222222" },
      { Type: 2, Path: "99999999-9999-9999-9999-999999999999" },
    ],
  };
  const encoded = JSON.stringify(manifest).replaceAll('"', "&quot;");
  const html = `<script src="/resource/powerappsportal/dist/pcf-dependency.bundle-native.js"></script><span data-pcf-control="${encoded}" data-pcf-controlcontext='{"ControlProperties":{"value":"private record text"}}'></span><script src="/_pcfwebresource/11111111-1111-1111-1111-111111111111"></script><script src="/resource/powerappsportal/dist/pcf.bundle-native.js"></script>`;
  const extracted = extractManagedRichTextControls(html),
    definition = extracted.managedControls[control];
  assert.equal(definition.manifest.Name, control);
  assert.ok(!JSON.stringify(extracted).includes("private record text"));
  assert.deepEqual(definition.scripts, [
    "/resource/powerappsportal/dist/pcf-dependency.bundle-native.js",
    "/resource/powerappsportal/dist/pcf.bundle-native.js",
    "/_pcfwebresource/11111111-1111-1111-1111-111111111111",
  ]);
  const cache = cacheFixture(),
    result = await captureRichTextAssets(cache, live, {
      schemas: { fields: [{ richText: { name: control } }] },
      html,
    });
  assert.equal(result.assetsComplete, true);
  assert.ok(
    cache.calls.includes(
      "/_pcfwebresource/22222222-2222-2222-2222-222222222222",
    ),
  );
  assert.ok(
    !cache.calls.includes(
      "/_pcfwebresource/99999999-9999-9999-9999-999999999999",
    ),
  );
  assert.ok(
    !result.diagnostics.some(
      (d) => d.code === "RICHTEXT_MANAGED_MANIFEST_MISSING",
    ),
  );
});

test("observed approved public PCF bundles normalize locally while loader and unrelated origins stay excluded", () => {
  const manifest = { Name: control, Properties: [], Resources: [] };
  const html = `<span data-pcf-control='${JSON.stringify(manifest)}'></span><script src="https://content.powerapps.com/resource/powerappsportal/dist/pcf.bundle-v1.js"></script><script src="https://content.powerapps.com/resource/powerappsportal/dist/pcf-loader.bundle-v1.js"></script><script src="https://evil.example/resource/powerappsportal/dist/pcf.bundle-v1.js"></script>`;
  assert.deepEqual(
    extractManagedRichTextControls(html).managedControls[control].scripts,
    ["/resource/powerappsportal/dist/pcf.bundle-v1.js"],
  );
});

test("existing same-origin performance observation captures Office fonts and orders telemetry without business reads or navigation", async () => {
  const font =
      "https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/fonts/segoeui-west-european/segoeui-regular.woff2",
    icon =
      "https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/icons/fabric-icons.woff";
  let foreignReads = 0,
    reads = 0;
  const connected = {
    ...live,
    context: {
      pages: () => [
        {
          url: () => live.origin + "/known-editor",
          evaluate: async () => {
            reads++;
            return [
              font,
              icon,
              "https://content.powerapps.com/resource/powerappsportal/dist/client-telemetry.bundle-abc.js",
              "https://content.powerapps.com/resource/powerappsportal/dist/pcf.bundle-abc.js",
              "https://content.powerapps.com/resource/powerappsportal/dist/client-telemetry-wrapper.bundle-abc.js",
              "https://content.powerapps.com/resource/powerappsportal/dist/pcf-dependency.bundle-abc.js",
              "https://content.powerapps.com/resource/powerappsportal/dist/pcf-extended.bundle-abc.js",
              {
                name:
                  live.origin +
                  "/_pcfwebresource/11111111-1111-1111-1111-111111111111",
                type: "script",
              },
              "https://evil.example/private.woff2",
            ];
          },
        },
        { url: () => "https://evil.example", evaluate: () => foreignReads++ },
      ],
    },
  };
  const observed = await observeManagedResources(connected);
  assert.equal(reads, 1);
  assert.equal(foreignReads, 0);
  assert.deepEqual(observed.fonts, [font, icon]);
  const cache = cacheFixture();
  cache.captureOfficeFonts = async (urls) => ({
    captured: urls.map((url) => ({ path: officeFontPath(url), bytes: 1 })),
    failures: [],
  });
  const manifest = {
    Name: control,
    Properties: [],
    Resources: [
      { Type: 0, Path: "11111111-1111-1111-1111-111111111111" },
      { Type: 1, Path: "22222222-2222-2222-2222-222222222222" },
    ],
  };
  const result = await captureRichTextAssets(cache, connected, {
    schemas: { fields: [{ richText: true }] },
    html: `<span data-pcf-control='${JSON.stringify(manifest)}'></span>`,
  });
  assert.equal(result.assetsComplete, true);
  assert.equal(result.nativeReady, true);
  assert.equal(result.complete, true);
  assert.equal(
    result.managedControls[control].scripts[0],
    "/resource/powerappsportal/dist/client-telemetry.bundle-abc.js",
  );
  assert.equal(
    result.managedControls[control].scripts.at(-1),
    "/_pcfwebresource/11111111-1111-1111-1111-111111111111",
  );
  assert.match(
    result.managedControls[control].fabricConfig.fontBaseUrl,
    /^\/__sim-static\/office-fonts\/res-1.cdn.office.net\/files\/fabric-cdn-prod_20230815.002\/assets$/,
  );
  assert.match(
    result.managedControls[control].fabricConfig.iconBaseUrl,
    /\/assets\/icons\/$/,
  );
  assert.ok(!JSON.stringify(result).includes("evil.example"));
});

test("explicit managed editor path is GET-only and missing manifests/failures stay diagnostic", async () => {
  const requests = [],
    cache = cacheFixture(),
    manifest = { Name: control, Properties: [], Resources: [] };
  const bridge = {
    ...live,
    request: async (path, options) => {
      requests.push({ path, options });
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from(
          `<span data-pcf-control='${JSON.stringify(manifest)}' data-pcf-controlcontext='{"value":"never persist"}'></span>`,
        ),
      };
    },
  };
  const result = await captureRichTextAssets(cache, bridge, {
    schemas: { fields: [{ richText: true }] },
    managedControlPath: "/known-editor/?recordid=synthetic",
  });
  assert.equal(result.assetsComplete, true);
  assert.deepEqual(requests, [
    { path: "/known-editor/?recordid=synthetic", options: { method: "GET" } },
  ]);
  assert.ok(!JSON.stringify(result).includes("never persist"));
  const invalid = await captureRichTextAssets(cache, bridge, {
    schemas: { fields: [{ richText: true }] },
    managedControlPath: "/known-editor/?access_token=private",
  });
  assert.equal(invalid.complete, false);
  assert.equal(requests.length, 1);
  assert.ok(!JSON.stringify(invalid).includes("private"));
});

test("managed vendor language registration is derived statically without inventing a native language endpoint", async () => {
  const languagePath = "/_pcfwebresource/11111111-1111-1111-1111-111111111111",
    cache = cacheFixture(),
    get = cache.get.bind(cache);
  cache.get = async (path) =>
    path === languagePath
      ? {
          body: Buffer.from(
            'CKEDITOR.lang[ "en" ] = {dir:"ltr"}; CKEDITOR.lang.fr={dir:"ltr"};',
          ),
        }
      : get(path);
  const manifest = {
    Name: control,
    Properties: [],
    Resources: [{ Type: 0, Path: languagePath.split("/").at(-1) }],
  };
  const result = await captureRichTextAssets(cache, live, {
    schemas: { fields: [{ richText: true }] },
    html: `<span data-pcf-control='${JSON.stringify(manifest)}'></span>`,
  });
  assert.deepEqual(result.bundledLanguages, ["en", "fr"]);
  assert.equal(result.assetsComplete, true);
  assert.ok(
    !cache.calls.some(
      (path) =>
        /\/lang\/(?:en|editor-language-resources)\.js$/.test(path) &&
        !path.includes("/plugins/"),
    ),
  );
  assert.ok(cache.calls.includes(editor + "plugins/superimage/lang/en.js"));
});

test("native readiness cannot borrow cached Office fonts from another portal origin", async () => {
  const cache = cacheFixture(),
    fontBaseUrl =
      "/__sim-static/office-fonts/res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets",
    iconBaseUrl =
      "/__sim-static/office-fonts/res.cdn.office.net/files/fabric-cdn-prod_20241209.001/assets/icons/";
  const assets = [
    {
      path: fontBaseUrl + "/fonts/segoeui.woff2",
      origin: "https://other.example.test",
    },
    {
      path: iconBaseUrl + "fabric-icons.woff",
      origin: "https://other.example.test",
    },
  ];
  cache.manifest = () => ({ assets });
  const manifest = {
      Name: control,
      Properties: [],
      Resources: [
        { Type: 0, Path: "11111111-1111-1111-1111-111111111111" },
        { Type: 1, Path: "22222222-2222-2222-2222-222222222222" },
      ],
    },
    scripts = [
      "client-telemetry",
      "client-telemetry-wrapper",
      "pcf-dependency",
      "pcf",
      "pcf-extended",
    ].map(
      (name) => "/resource/powerappsportal/dist/" + name + ".bundle-abc.js",
    );
  const options = {
    schemas: { fields: [{ richText: true }] },
    managedControls: {
      [control]: {
        manifest,
        scripts,
        fabricConfig: { fontBaseUrl, iconBaseUrl },
      },
    },
  };
  let result = await captureRichTextAssets(cache, live, options);
  assert.equal(result.assetsComplete, true);
  assert.equal(result.nativeReady, false);
  for (const asset of assets) asset.origin = live.origin;
  result = await captureRichTextAssets(cache, live, options);
  assert.equal(result.nativeReady, true);
});

test("native stylesheet CRM icon font uses an explicit Microsoft CDN fallback only for its exact family and path", async () => {
  const font = "/uclient/resources/styles/CRMMDL2.woff",
    style = "/_pcfwebresource/22222222-2222-2222-2222-222222222222";
  for (const stylePath of [editor + "skins/superowa/editor.css", style]) {
    const cache = cacheFixture({ failure: font }),
      get = cache.get.bind(cache);
    cache.get = async (path) =>
      path === stylePath
        ? {
            body: Buffer.from(
              `@font-face{font-family:'CRMMDL2';src:url("${font}") format('woff')}`,
            ),
          }
        : get(path);
    const manifest = {
      Name: control,
      Properties: [],
      Resources: [{ Type: 1, Path: style.split("/").at(-1) }],
    };
    const result = await captureRichTextAssets(cache, live, {
      schemas: { fields: [{ richText: true }] },
      html: `<span data-pcf-control='${JSON.stringify(manifest)}'></span>`,
    });
    assert.deepEqual(result.cssDependencies, [font]);
    assert.equal(cache.calls.filter((path) => path === font).length, 1);
    assert.equal(result.assetsComplete, true);
    assert.equal(result.nativeReady, false);
    assert.deepEqual(result.nativeAssetFailures.map((item) => item.code), ["ASSET_HTTP"]);
    assert.equal(result.assetFallbacks[0].fontFamily, "CRM MDL2 Assets");
    assert.equal(result.diagnostics.some((item) => item.code === "RICHTEXT_NATIVE_FONT_FALLBACK"), true);
  }
  const cache = cacheFixture({ failure: font }),
    get = cache.get.bind(cache);
  cache.get = async (path) =>
    path === editor + "skins/superowa/editor.css"
      ? { body: Buffer.from(`@font-face{font-family:'CRMMDL2';src:url(${font})}`) }
      : get(path);
  const failed = await captureRichTextAssets(cache, live, {
    schemas: { fields: [{ richText: true }] },
    observedResources: ["/uclient/resources/styles/unrelated.woff"],
  });
  assert.equal(failed.assetsComplete, false);
  assert.equal(failed.nativeReady, false);
  assert.ok(
    failed.nativeAssetFailures.some((f) => f.path === font && f.code === "ASSET_HTTP"),
  );
  assert.ok(!cache.calls.includes("/uclient/resources/styles/unrelated.woff"));
  const plain = cacheFixture();
  await captureRichTextAssets(plain, live, {
    schemas: { fields: [{ richText: true }] },
  });
  assert.ok(!plain.calls.includes(font));
  const unrelated = cacheFixture(), unrelatedGet = unrelated.get.bind(unrelated);
  unrelated.get = async (path) =>
    path === editor + "skins/superowa/editor.css"
      ? { body: Buffer.from(`@font-face{font-family:'Other';src:url(${font})}`) }
      : unrelatedGet(path);
  const ignored = await captureRichTextAssets(unrelated, live, {
    schemas: { fields: [{ richText: true }] },
  });
  assert.deepEqual(ignored.cssDependencies, []);
  assert.ok(!unrelated.calls.includes(font));
});
