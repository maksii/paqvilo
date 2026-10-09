import test from "node:test";
import assert from "node:assert/strict";
import { registerShellConventions } from "../lib/extensions.mjs";
// A neutral footer logo container class (packs declare their own).
registerShellConventions("test", { footerLogoClass: "site-footer-logos" });
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AssetCache } from "../lib/asset-cache.mjs";
import {
  capturePortalShell,
  extractShellReferences,
} from "../lib/shell-capture.mjs";

const origin = "https://portal.example.test",
  cdn = "https://content.powerapps.com";
const htmlResponse = (html) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: Buffer.from(html),
});
const page = (head, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test("UTF-16 PAC stylesheet attachments capture their browser font dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-utf16-"));
  try {
    const file = join(directory, "bootstrap.css");
    await writeFile(
      file,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('@font-face{src:url("fonts/icons.woff2")}', "utf16le"),
      ]),
    );
    const live = livePage(
      page(
        '<link rel="stylesheet" href="/bootstrap.css"><script src="/jquery.min.js"></script>',
      ),
      {
        "/jquery.min.js": {
          type: "text/javascript",
          body: "window.jQuery={};",
        },
        "/fonts/icons.woff2": { type: "font/woff2", body: "font fixture" },
      },
    );
    const cache = await new AssetCache({
      directory: join(directory, "assets"),
      origin,
    }).init();
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
      portal: { webFiles: [{ url: "/bootstrap.css", file }] },
    });
    assert.equal(result.complete, true);
    assert.ok(
      result.captured.some((item) => item.path === "/fonts/icons.woff2"),
    );
    assert.equal(
      (await cache.get("/fonts/icons.woff2", { origin })).body.toString(),
      "font fixture",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed Moment dependency keeps its native phase before page content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-moment-"));
  try {
    const moment =
      "/resource/powerappsportal/dist/preform.moment_2_29_4.bundle-example.js";
    const live = livePage(
      page(
        '<link rel="stylesheet" href="/style.css"><script src="/jquery.js"></script>',
        `<script src="${moment}"></script>`,
      ),
      {
        "/style.css": { type: "text/css", body: "body{}" },
        "/jquery.js": { type: "text/javascript", body: "window.jQuery={};" },
        [moment]: {
          type: "text/javascript",
          body: "window.moment=function(){};",
        },
      },
    );
    const cache = await new AssetCache({
      directory: join(directory, "cache"),
      origin,
    }).init();
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.shellProfile.beforeContentScripts, [moment]);
    assert.ok(result.captured.some((item) => item.path === moment));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GUID-addressed PCF resources cache only verified static script or stylesheet responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-pcf-cache-"));
  try {
    const css = "/_pcfwebresource/11111111-1111-1111-1111-111111111111";
    const js = "/_pcfwebresource/22222222-2222-2222-2222-222222222222";
    const bad = "/_pcfwebresource/33333333-3333-3333-3333-333333333333";
    const live = livePage("", {
      [css]: { type: "text/css", body: ".editor{}" },
      [js]: { type: "application/x-javascript", body: "window.editor={};" },
      [bad]: { type: "text/html", body: "<html>Sign in</html>" },
    });
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await cache.capture(
      [css, js, bad, "/_pcfwebresource/not-a-guid", "/arbitrary.pcf"],
      live,
    );
    assert.equal(result.captured.length, 2);
    assert.equal(result.failures.length, 3);
    const reopened = await new AssetCache({ directory, origin }).init();
    assert.equal(
      (await reopened.get(css, { origin })).body.toString(),
      ".editor{}",
    );
    assert.equal(
      (await reopened.get(js, { origin })).body.toString(),
      "window.editor={};",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
function livePage(html, assets = {}) {
  const calls = [];
  return {
    origin,
    context: {},
    calls,
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/workspace/") return htmlResponse(html);
      const asset = assets[path];
      return asset
        ? {
            status: 200,
            headers: { "content-type": asset.type },
            body: Buffer.from(asset.body),
          }
        : {
            status: 404,
            headers: { "content-type": "text/plain" },
            body: Buffer.from("Missing"),
          };
    },
  };
}

test("observed shell capture preserves order, source assets and safe platform resources without persisting page or inline data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-"));
  try {
    const localCss = join(directory, "local.css");
    await writeFile(localCss, "body{background:url(/local.png)}");
    const localJs = join(directory, "jquery.js"),
      localPng = join(directory, "local.png");
    await writeFile(localJs, "window.syntheticJquery=true;");
    await writeFile(localPng, Buffer.from([1, 2, 3]));
    const html = page(
      '<link rel="stylesheet" href="/bootstrap.min.css"><link href="https://content.powerapps.com/resource/powerappsportal/dist/preform.css" rel="stylesheet"><link rel="stylesheet" href="/theme.css?version=1&amp;locale=en"><script src="/jquery-3.3.1.min.js"></script><script>const secret="INLINE_TOKEN_DO_NOT_SAVE"; const fake="<link rel=stylesheet href=/fake.css>";</script>',
      '<script src="/source-business.js"></script><script src="https://content.powerapps.com/resource/powerappsportal/dist/bootstrap.bundle.js" defer></script><input name="__RequestVerificationToken" value="PAGE_TOKEN_DO_NOT_SAVE">',
    );
    const live = livePage(html);
    const fetched = [];
    const cache = await new AssetCache({
      directory: join(directory, "cache"),
      origin,
      fetchImpl: async (url, options) => {
        fetched.push({ url, options });
        return url.endsWith(".css")
          ? new Response("@font-face{src:url(../fonts/font.woff)}", {
              headers: { "content-type": "text/css" },
            })
          : url.endsWith(".woff")
            ? new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "font/woff" },
              })
            : new Response("window.bootstrapExample=true;", {
                headers: { "content-type": "application/javascript" },
              });
      },
    }).init();
    const portal = {
      webFiles: [
        { url: "/bootstrap.min.css", file: localCss },
        { url: "/theme.css", file: localCss },
        { url: "/jquery-3.3.1.min.js", file: localJs },
        { url: "/local.png", file: localPng },
      ],
      templates: {},
      snippets: {},
    };
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
      portal,
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.shellProfile.stylesheets, [
      "/bootstrap.min.css",
      "/resource/powerappsportal/dist/preform.css",
      "/theme.css?version=1&locale=en",
    ]);
    assert.deepEqual(result.shellProfile.headScripts, ["/jquery-3.3.1.min.js"]);
    assert.deepEqual(result.shellProfile.afterFooterScripts, [
      {
        src: "/resource/powerappsportal/dist/bootstrap.bundle.js",
        defer: true,
      },
    ]);
    assert.equal(result.captured.length, 3);
    assert.deepEqual(live.calls, [
      { path: "/workspace/", options: { method: "GET" } },
    ]);
    assert.equal(
      fetched.every((c) => c.options.credentials === "omit"),
      true,
    );
    assert.equal(
      result.diagnostics.some(
        (d) => d.code === "SHELL_BUSINESS_SCRIPT_EXCLUDED",
      ),
      true,
    );
    const manifest = await readFile(
      join(directory, "cache", "manifest.json"),
      "utf8",
    );
    for (const secret of [
      "INLINE_TOKEN_DO_NOT_SAVE",
      "PAGE_TOKEN_DO_NOT_SAVE",
      "source-business.js",
      "fake.css",
    ])
      assert.equal(manifest.includes(secret), false);
    assert.equal(
      fetched.some(
        (c) => !c.url.startsWith(cdn + "/resource/powerappsportal/"),
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shell capture excludes exported template references and follows same-origin CSS font dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-"));
  try {
    const html = page(
      '<link href="/platform.css" rel="stylesheet" media="screen"><script src="/jquery.min.js"></script>',
      '<script src="/bootstrap.bundle.js" async type="module"></script>',
    );
    const live = livePage(html, {
      "/platform.css": {
        type: "text/css",
        body: "@font-face{src:url(/font.woff?#iefix)}",
      },
      "/font.woff": { type: "font/woff", body: Buffer.from([3, 4]) },
      "/jquery.min.js": {
        type: "application/javascript",
        body: "window.localjQuery=true;",
      },
      "/bootstrap.bundle.js": {
        type: "application/javascript",
        body: "window.localBootstrap=true;",
      },
    });
    const cache = await new AssetCache({ directory, origin }).init();
    const portal = {
      snippets: { "Head/Bottom": '<script src="/jquery.min.js"></script>' },
      templates: {},
    };
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
      portal,
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.shellProfile.stylesheets, [
      { href: "/platform.css", media: "screen" },
    ]);
    assert.deepEqual(result.shellProfile.headScripts, []);
    assert.deepEqual(result.shellProfile.afterFooterScripts, [
      { src: "/bootstrap.bundle.js", async: true, type: "module" },
    ]);
    assert.equal(
      result.captured.some((a) => a.path === "/font.woff?"),
      false,
    );
    assert.equal(
      result.captured.some((a) => a.path === "/font.woff"),
      true,
    );
    assert.equal(
      result.diagnostics.some((d) => d.code === "SHELL_LOCAL_SOURCE_REFERENCE"),
      true,
    );
    assert.equal(
      live.calls.every((c) => c.options.method === "GET"),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing, non-static, credential and cross-origin shell resources produce explicit failures without fetching excluded URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-"));
  try {
    const html = page(
      '<link rel="stylesheet" href="/missing.css"><link rel="stylesheet" href="/style-endpoint"><link rel="stylesheet" href="https://other.test/style.css"><script src="/jquery.min.js?access_token=SECRET_VALUE"></script><script src="https://content.powerapps.com/elsewhere/bootstrap.js"></script>',
    );
    const live = livePage(html);
    const cache = await new AssetCache({
      directory,
      origin,
      fetchImpl: () => {
        throw new Error("CDN fetch must not occur");
      },
    }).init();
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
    });
    assert.equal(result.complete, false);
    assert.equal(
      result.failures.some((f) => f.code === "ASSET_HTTP"),
      true,
    );
    assert.equal(
      result.failures.some((f) => f.code === "SHELL_RESOURCE_TYPE"),
      true,
    );
    assert.equal(
      result.failures.some((f) => f.code === "SHELL_RESOURCE_ORIGIN"),
      true,
    );
    assert.equal(
      result.failures.some((f) => f.code === "SHELL_RESOURCE_CREDENTIAL"),
      true,
    );
    assert.equal(
      result.failures.some((f) => f.code === "SHELL_JQUERY_MISSING"),
      true,
    );
    assert.equal(JSON.stringify(result).includes("SECRET_VALUE"), false);
    assert.deepEqual(
      live.calls.map((c) => c.path),
      ["/workspace/", "/missing.css"],
    );
    assert.equal(cache.manifest().assets.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shell capture rejects disconnected browsers, non-HTML responses and sign-in pages before any static capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-"));
  try {
    const cache = await new AssetCache({ directory, origin }).init();
    await assert.rejects(
      capturePortalShell(cache, { origin }, { path: "/workspace/" }),
      (e) => e.status === 409,
    );
    const live = livePage(
      '<html><head><title>Sign in</title></head><body><form action="/SignIn"><input type="password"></form></body></html>',
    );
    await assert.rejects(
      capturePortalShell(cache, live, { path: "/workspace/" }),
      (e) => e.status === 401,
    );
    const jsonLive = {
      origin,
      context: {},
      request: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
      }),
    };
    await assert.rejects(
      capturePortalShell(cache, jsonLive, { path: "/workspace/" }),
      (e) => e.status === 502,
    );
    await assert.rejects(
      capturePortalShell(cache, live, { path: "/../workspace/" }),
      (e) => e.status === 400,
    );
    assert.equal(cache.manifest().assets.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("password markup in source scripts or hidden portal controls does not mark an observed business page as sign-in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-"));
  try {
    const html = page(
      '<title>Workspace</title><link href="/theme.css" rel="stylesheet"><script src="/jquery.min.js"></script><script>const literal="<title>Sign in</title><input type=password>";</script>',
      '<div hidden><input type="password" id="portal-managed-control"></div>',
    );
    const live = livePage(html, {
      "/theme.css": { type: "text/css", body: "body{color:black}" },
      "/jquery.min.js": {
        type: "application/javascript",
        body: "window.jqueryExample=true;",
      },
    });
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
    });
    assert.equal(result.complete, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("known platform ResourceManager label dictionaries are captured as JavaScript without a jQuery assumption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-"));
  try {
    const manager =
      "/_portal/11111111-1111-1111-1111-111111111111/Resources/ResourceManager";
    const live = livePage(
      page(
        `<script src="${manager}?version=123"></script><link href="/theme.css" rel="stylesheet"><script src="/scripts/jquery.min.js"></script>`,
      ),
      {
        [manager + "?version=123"]: {
          type: "application/javascript",
          body: 'window.ResourceManager={label:"Synthetic label"};',
        },
        "/theme.css": { type: "text/css", body: "body{color:black}" },
        "/scripts/jquery.min.js": {
          type: "application/javascript",
          body: "window.syntheticJquery=true;",
        },
      },
    );
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.shellProfile.headScripts, [
      manager + "?version=123",
      "/scripts/jquery.min.js",
    ]);
    const restored = await new AssetCache({ directory, origin }).init();
    assert.match(
      (await restored.get(manager + "?version=123")).body.toString(),
      /ResourceManager/,
    );
    assert.equal(
      await restored.get("/_portal/other/Resources/ResourceManager"),
      null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTML browser parsing handles unquoted apostrophes without swallowing following runtime references", () => {
  const html = page(
    '<link rel="stylesheet" href="/theme.css">',
    '<a href=/account title=User\'s>Account</a><script src="/scripts/jquery.min.js" type="text/javascript"></script><script src="/xrm-adx/js/jquery-ui-1.11.4.min.js"></script><!--<script src="/comment.js"></script>--><template><script src="/inert.js"></script></template><script>const fake="<script src=/literal.js>";</script>',
  );
  const refs = extractShellReferences(html);
  assert.deepEqual(
    refs.filter((r) => r.kind === "script").map((r) => r.value),
    ["/scripts/jquery.min.js", "/xrm-adx/js/jquery-ui-1.11.4.min.js"],
  );
  assert.equal(
    refs
      .filter((r) => r.kind === "script")
      .every((r) => r.position === "bodyScripts"),
    true,
  );
});

test("excluded managed platform scripts are identified without claiming their source is exported business code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-"));
  try {
    const live = livePage(
      page(
        '<link href="/theme.css" rel="stylesheet"><script src="/jquery.min.js"></script>',
        '<script src="https://content.powerapps.com/resource/powerappsportal/dist/pcf.bundle.js"></script>',
      ),
      {
        "/theme.css": { type: "text/css", body: "body{color:black}" },
        "/jquery.min.js": {
          type: "application/javascript",
          body: "window.jqueryExample=true;",
        },
      },
    );
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
    });
    const excluded = result.diagnostics.find(
      (d) => d.code === "SHELL_PLATFORM_SCRIPT_EXCLUDED",
    );
    assert.ok(excluded);
    assert.match(excluded.message, /no runtime parity/);
    assert.equal(
      result.diagnostics.some(
        (d) => d.code === "SHELL_BUSINESS_SCRIPT_EXCLUDED",
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("metadata-only exported scripts are captured and CSS dependency failures remain explicit on a ready shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-metadata-"));
  try {
    const html = page(
      '<link rel="stylesheet" href="/theme.css"><script src="/jquery.min.js"></script><script src="/exported.js"></script>',
    );
    const live = livePage(html, {
      "/theme.css": {
        type: "text/css",
        body: "@font-face{font-family:unused;src:url(/obsolete.woff)}",
      },
      "/jquery.min.js": {
        type: "text/javascript",
        body: "window.syntheticJquery=true;",
      },
      "/exported.js": {
        type: "text/javascript",
        body: "window.syntheticBusiness=true;",
      },
      "/scripts/deferred.js": {
        type: "text/javascript",
        body: "window.syntheticDeferred=true;",
      },
    });
    const portal = {
      webFiles: [{ url: "/jquery.min.js" }, { url: "/exported.js" }],
      snippets: { "Head/Bottom": '<script src="/exported.js"></script>' },
      pages: [{ id: "scripts", url: "/scripts/" }],
      records: [
        {
          kind: "webfile",
          adx_partialurl: "deferred.js",
          adx_parentpageid: "scripts",
        },
      ],
      forms: [{ js: '$.getScript("/scripts/deferred.js", function() {});' }],
    };
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
      portal,
    });
    assert.equal(result.ready, true);
    assert.equal(result.complete, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].path, "/obsolete.woff");
    assert.equal(result.failures[0].dependency, true);
    assert.ok(await cache.get("/jquery.min.js"));
    assert.ok(await cache.get("/exported.js"));
    assert.ok(await cache.get("/scripts/deferred.js"));
    assert.equal(
      result.shellProfile.headScripts.includes("/exported.js"),
      false,
    );
    const missing = livePage(html, {
      "/theme.css": { type: "text/css", body: "body{}" },
      "/exported.js": {
        type: "text/javascript",
        body: "window.syntheticBusiness=true;",
      },
    });
    const failed = await capturePortalShell(cache, missing, {
      path: "/workspace/",
      portal,
    });
    assert.equal(failed.ready, false);
    assert.ok(
      failed.failures.some(
        (f) => f.path === "/jquery.min.js" && f.dependency === false,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shell capture binds observed footer sizing and notification presentation without native item content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-shell-static-widgets-"));
  try {
    const sourceCss = ".site-footer-logos svg {max-height:5rem}",
      file = join(directory, "theme.css");
    await writeFile(file, sourceCss);
    const footer =
      '<footer><section class="site-footer-logos"><svg><path d="M0 0"/></svg></section></footer>';
    const header =
      '<header><ul><li class="userProfileHolder">Local identity</li></ul></header>';
    const widget =
      '<li class="userProfileHolder"><a href="#"><svg width="14" height="16"><path d="M1 1"/></svg><span class="notificationsCount" style="font-size:12px">3</span></a><ul class="alerts-dropdown"><li>PRIVATE NATIVE CONTENT</li></ul></li>';
    const live = livePage(
      page(
        '<link rel="stylesheet" href="/theme.css"><script src="/jquery.js"></script>',
        footer + widget,
      ),
      {
        "/theme.css": {
          type: "text/css",
          body: ".site-footer-logos svg {width:auto;max-height:5rem}",
        },
        "/jquery.js": { type: "text/javascript", body: "window.jQuery={};" },
      },
    );
    const cache = await new AssetCache({
      directory: join(directory, "cache"),
      origin,
    }).init();
    const result = await capturePortalShell(cache, live, {
      path: "/workspace/",
      portal: {
        website: {
          adx_footerwebtemplateid: "footer",
          adx_headerwebtemplateid: "header",
        },
        templates: { footer: { source: footer }, header: { source: header } },
        webFiles: [{ url: "/theme.css", file }],
      },
    });
    assert.equal(result.complete, true);
    assert.equal(result.shellProfile.footerLogos.layout.svgWidth, "auto");
    assert.ok(result.shellProfile.headerNotifications);
    assert.doesNotMatch(
      JSON.stringify(result.shellProfile),
      /PRIVATE|Local identity/,
    );
    assert.equal(await cache.get("/theme.css", { origin }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
