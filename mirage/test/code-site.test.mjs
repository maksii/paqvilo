// @test-kind contract: a native Power Pages build manifest supplies the SPA entry, public assets, and local client context.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { CODE_SITE_MISSING_FILE_DOCUMENT } from '../lib/code-site.mjs';
import { importPortal } from '../lib/importer.mjs';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const webAppManifest = '{"name":"Invented installable app","start_url":"/","display":"standalone"}\n';
const write = async (root, relative, contents) => {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
};

// @test-kind observation: hosted session F5 served an uploaded code site (pac pages upload-code-site; four runs, captures code-site-serve-a..d and code-site-folder-redirect-a/b): the root renders the Home page with the landing page as its copy, application routes render with the landing page in place of the page content, build files are raw web files with case-insensitive paths and the captured types and caching, build folders are pages, and a missing static file is a plain 404
test('a compiled-only code site is served as the hosted platform serves the uploaded build', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-compiled-site-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(
    root,
    'powerpages.config.json',
    JSON.stringify({
      siteName: 'Invented code site',
      compiledPath: 'dist',
      defaultLandingPage: 'app/main.html',
      bundleFilePatterns: ['app-*.js'],
    }),
  );
  const landing =
    '<!DOCTYPE html><html lang="en-US"><head><title>App</title><link rel="manifest" href="/assets/app.webmanifest"><script type="module" src="/assets/app.js"></script></head><body><main>Build entry</main></body></html>';
  await write(root, 'dist/app/main.html', landing);
  await write(root, 'dist/assets/app.js', 'export const feature = "bundled";');
  await write(root, 'dist/assets/app.webmanifest', webAppManifest);
  await write(root, 'dist/assets/data.json', '{"invented":true}');
  const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  await write(root, 'dist/assets/feature.wasm', wasm);
  await write(root, 'dist/.private', 'invented build dotfile');
  await write(root, 'outside.txt', 'invented project file');
  const portal = await importPortal(root);
  assert.equal(portal.source.dialect, 'code-site-project');
  assert.equal(portal.isSpaSite, true);
  assert.equal(portal.website.name, 'Invented code site');
  // Every build folder is a web page; the landing page is the Home page copy.
  assert.deepEqual(
    portal.pages.map((page) => [page.url, page.name]),
    [
      ['/', 'Invented code site'],
      ['/app/', 'app'],
      ['/assets/', 'assets'],
    ],
  );
  assert.equal(portal.pages[0].html, landing);

  const app = await createSimulator({ sourceDir: root, watch: false, requirePortalSource: true });
  try {
    const home = await fetch(app.url + '/');
    assert.equal(home.status, 200);
    assert.notEqual(home.headers.get('x-sim-route'), 'code-site-app');
    const homeHtml = await home.text();
    assert.ok(
      homeHtml.includes(`<div class="xrm-attribute-value">${landing}</div>`),
      'the landing page is the Home copy',
    );
    assert.match(homeHtml, /"isSpaSite":"True"/);
    assert.doesNotMatch(homeHtml, /<base href=/);
    // Application routes, extensions that are not static file types and the landing page's name without its folder.
    for (const route of ['/reports/current/', '/Reports/Current', '/reports?tab=1', '/route.with.dot', '/main.html']) {
      const response = await fetch(app.url + route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('x-sim-route'), 'code-site-app', route);
      const html = await response.text();
      assert.ok(html.includes(landing), route);
      assert.doesNotMatch(html, /id="mainContent"|class="page-copy"/, route);
      assert.match(html, /"isSpaSite":"True"/, route);
    }
    // The landing page's own address is a raw web file.
    const raw = await fetch(app.url + '/app/main.html');
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('x-sim-resource-provider'), 'code-site-build');
    assert.equal(raw.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(raw.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
    assert.equal(raw.headers.get('content-disposition'), "inline;filename*=UTF-8''main.html");
    assert.equal(raw.headers.get('etag'), null);
    assert.equal(await raw.text(), landing);
    // Build folders: the trailing-slash redirect, then the folder page without the app.
    const folder = await fetch(app.url + '/assets', { redirect: 'manual' });
    assert.ok([301, 302].includes(folder.status), String(folder.status));
    assert.equal(folder.headers.get('location'), '/assets/');
    const folderPage = await fetch(app.url + '/assets/');
    assert.equal(folderPage.status, 200);
    assert.doesNotMatch(await folderPage.text(), /Build entry/);
    // Captured types and caching: public with an ETag, or private without one; compressible types are gzipped.
    const asset = await fetch(app.url + '/assets/app.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(asset.headers.get('x-sim-resource-provider'), 'code-site-build');
    assert.equal(asset.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(asset.headers.get('content-encoding'), 'gzip');
    assert.equal(asset.headers.get('content-disposition'), "inline;filename*=UTF-8''app.js");
    const source = 'export const feature = "bundled";';
    assert.equal(asset.headers.get('etag'), createHash('sha256').update(source).digest('base64'));
    assert.equal(await asset.text(), source);
    // Paths are case-insensitive: another spelling is the same file, cached privately without an ETag.
    const variant = await fetch(app.url + '/ASSETS/APP.JS');
    assert.equal(variant.status, 200);
    assert.equal(variant.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(variant.headers.get('etag'), null);
    assert.equal(await variant.text(), source);
    const data = await fetch(app.url + '/assets/data.json');
    assert.deepEqual(
      [data.headers.get('content-type'), data.headers.get('cache-control'), data.headers.get('etag')],
      ['application/json', 'private, max-age=3600', null],
    );
    assert.equal(await data.text(), '{"invented":true}');
    const manifest = await fetch(app.url + '/assets/app.webmanifest');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('content-type'), 'application/octet-stream');
    assert.equal(manifest.headers.get('content-encoding'), null);
    assert.equal(await manifest.text(), webAppManifest);
    // WebAssembly is served as application/octet-stream, so streaming instantiation fails as it does online.
    const binary = await fetch(app.url + '/assets/feature.wasm');
    assert.equal(binary.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(new Uint8Array(await binary.clone().arrayBuffer()), wasm);
    await assert.rejects(WebAssembly.instantiateStreaming(binary), TypeError);
    const head = await fetch(app.url + '/reports/current/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    // A missing file of a static type answers the platform's plain 404 document.
    for (const route of ['/assets/missing.js', '/missing.css', '/outside.txt']) {
      const missing = await fetch(app.url + route);
      assert.equal(missing.status, 404, route);
      assert.equal(missing.headers.get('x-sim-route'), 'code-site-missing-file', route);
      assert.equal(await missing.text(), CODE_SITE_MISSING_FILE_DOCUMENT, route);
    }
    for (const route of ['/.private', '/_api/unknowns']) {
      const refused = await fetch(app.url + route, { redirect: 'manual' });
      assert.ok(refused.status >= 400, route);
      assert.notEqual(refused.headers.get('x-sim-route'), 'code-site-app', route);
    }
  } finally {
    await app.close();
  }
});

// @test-kind security: an application route shows the Home page copy (the landing page); a visitor who may not read Home gets the root's answer there and never the landing page (hosted handling of a restricted Home is not captured: fail closed)
test('a restricted Home page keeps its landing page from application routes', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-restricted-code-site-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const page = (id, name, partial, parent) =>
    [`adx_webpageid: ${id}`, `adx_name: ${name}`, `adx_partialurl: ${partial}`, 'adx_pagetemplateid: studio']
      .concat(parent ? [`adx_parentpageid: ${parent}`] : ['adx_isroot: true'])
      .join('\n');
  const files = {
    'website.yml': 'adx_websiteid: invented-site\nadx_name: Invented restricted code site',
    'web-pages/home/Home.webpage.yml': page('home', 'Home', '/', null),
    'web-pages/not-found/Page-Not-Found.webpage.yml': page('notfound', 'Page Not Found', 'page-not-found', 'home'),
    'page-templates/Studio.pagetemplate.yml':
      'adx_pagetemplateid: studio\nadx_webtemplateid: studio\nadx_usewebsiteheaderandfooter: true',
    'web-templates/Studio.webtemplate.yml': 'adx_webtemplateid: studio\nadx_name: Studio',
    'web-templates/Studio.webtemplate.source.html': "<div>{% editable page 'adx_copy' type: 'html' %}</div>",
    'sitemarker.yml':
      '- adx_sitemarkerid: m-home\n  adx_name: Home\n  adx_pageid: home\n- adx_sitemarkerid: m-404\n  adx_name: Page Not Found\n  adx_pageid: notfound',
    'webrole.yml': '- adx_webroleid: member\n  adx_name: Member',
    'webpagerule.yml':
      '- adx_webpageaccesscontrolruleid: lock\n  adx_name: Members only\n  adx_webpageid: home\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member',
    'powerpages.config.json': JSON.stringify({ compiledPath: 'dist', defaultLandingPage: 'index.html' }),
    'dist/index.html': '<!doctype html><html><body><p id="invented-secret">Members landing</p></body></html>',
  };
  for (const [relative, contents] of Object.entries(files)) await write(root, relative, contents);
  const app = await createSimulator({ sourceDir: root, watch: false, requirePortalSource: true });
  try {
    const home = await fetch(app.url + '/', { redirect: 'manual' });
    const homeBody = await home.text();
    assert.ok([302, 403].includes(home.status), String(home.status));
    assert.doesNotMatch(homeBody, /Members landing/);
    for (const route of ['/dashboard/x', '/route.with.dot']) {
      const response = await fetch(app.url + route, { redirect: 'manual' });
      const body = await response.text();
      assert.equal(response.status, home.status, route);
      assert.doesNotMatch(body, /Members landing/, route);
      assert.notEqual(response.headers.get('x-sim-route'), 'code-site-app', route);
    }
  } finally {
    await app.close();
  }
});

// @test-kind observation+security: hosted session F5 (captures code-site-serve-a..d): an application route renders the Page Not Found page with HTTP 200 and the landing page after the anti-forgery holder in place of the page content; under the platform default policy the landing page's inline script carries the response nonce on rendered pages, and a raw web file carries a fresh nonce no script has, so its inline script is blocked as online
test('an exported code site renders application routes as its Page Not Found page with the landing page', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-exported-code-site-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const page = (id, name, partial, parent) =>
    [`adx_webpageid: ${id}`, `adx_name: ${name}`, `adx_partialurl: ${partial}`, 'adx_pagetemplateid: studio']
      .concat(parent ? [`adx_parentpageid: ${parent}`] : ['adx_isroot: true'])
      .join('\n');
  const files = {
    'website.yml':
      'adx_websiteid: invented-site\nadx_name: Invented exported code site\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer',
    'web-pages/home/Home.webpage.yml': page('home', 'Home', '/', null),
    'web-pages/home/Home.webpage.copy.html': '<p>Copy before the upload</p>',
    'web-pages/not-found/Page-Not-Found.webpage.yml': page('notfound', 'Page Not Found', 'page-not-found', 'home'),
    'page-templates/Studio.pagetemplate.yml':
      'adx_pagetemplateid: studio\nadx_webtemplateid: studio\nadx_usewebsiteheaderandfooter: true',
    'web-templates/Studio.webtemplate.yml': 'adx_webtemplateid: studio\nadx_name: Default studio template',
    'web-templates/Studio.webtemplate.source.html':
      '<div id="mainContent" class="wrapper-body" role="main"><div class="page-copy">{% editable page \'adx_copy\' type: \'html\', liquid: true %}</div></div>',
    'web-templates/Header.webtemplate.yml': 'adx_webtemplateid: header\nadx_name: Header',
    'web-templates/Header.webtemplate.source.html': '<div></div>',
    'web-templates/Footer.webtemplate.yml': 'adx_webtemplateid: footer\nadx_name: Footer',
    'web-templates/Footer.webtemplate.source.html': '<div></div>',
    'sitemarker.yml':
      '- adx_sitemarkerid: m-home\n  adx_name: Home\n  adx_pageid: home\n- adx_sitemarkerid: m-404\n  adx_name: Page Not Found\n  adx_pageid: notfound',
    'powerpages.config.json': JSON.stringify({ compiledPath: 'dist', defaultLandingPage: 'index.html' }),
    'dist/index.html':
      '<!doctype html><html><head><title>Landing</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div><script>document.documentElement.dataset.inline = \'ran\';</script></body></html>',
    'dist/assets/app.js': 'window.inventedApp = true;',
  };
  for (const [relative, contents] of Object.entries(files)) await write(root, relative, contents);
  const landing = files['dist/index.html'];
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    requirePortalSource: true,
    observed: { defaultContentSecurityPolicy: 'platform', evidence: 'Invented code site capture' },
  });
  try {
    const nonceOf = (response) => /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy'))?.[1];
    // The landing page's inline script with the response's nonce (a local source-debugging comment may follow its code).
    const inline = (nonce) => `<script nonce="${nonce}">document.documentElement.dataset.inline = 'ran';`;
    const home = await fetch(app.url + '/');
    const homeHtml = await home.text();
    assert.equal(home.status, 200);
    const copyStart = homeHtml.indexOf('<div class="xrm-attribute-value"><!doctype html><html><head><title>Landing');
    assert.ok(copyStart > 0, 'the landing page is the Home copy');
    assert.ok(homeHtml.indexOf(inline(nonceOf(home))) > copyStart, 'nonced landing script');
    assert.doesNotMatch(homeHtml, /Copy before the upload/);
    assert.match(home.headers.get('content-security-policy'), /'unsafe-hashes'(?: 'sha256-[^']+')+ {2}; style-src/);
    const route = await fetch(app.url + '/dashboard/settings');
    const routeHtml = await route.text();
    assert.equal(route.status, 200);
    assert.equal(route.headers.get('x-sim-route'), 'code-site-app');
    assert.match(routeHtml, /<title>Page Not Found<\/title>/);
    assert.ok(routeHtml.includes(inline(nonceOf(route))), 'nonced landing on the application route');
    assert.doesNotMatch(routeHtml, /class="page-copy"/);
    // The landing page's authored external script gets no nonce: its host is the policy's to allow ('self').
    assert.ok(
      routeHtml.includes('<script type="module" src="/assets/app.js"></script>'),
      'external script without nonce',
    );
    assert.ok(routeHtml.indexOf('<div id="antiforgerytoken"') < routeHtml.indexOf(inline(nonceOf(route))));
    assert.notEqual(nonceOf(route), nonceOf(home));
    // The raw landing file: its bytes, a fresh nonce and the literal 'inject-hashes'.
    const raw = await fetch(app.url + '/index.html');
    assert.equal(await raw.text(), landing);
    assert.ok(nonceOf(raw));
    assert.match(raw.headers.get('content-security-policy'), /'unsafe-hashes' 'inject-hashes'; style-src/);
    const missing = await fetch(app.url + '/missing.png');
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), CODE_SITE_MISSING_FILE_DOCUMENT);
    assert.match(missing.headers.get('content-security-policy'), /'inject-hashes'; style-src/);
  } finally {
    await app.close();
  }
});

// @test-kind contract+security: a compiled site's cold browser HEAD neither issues a binding nor advertises the wrong GET length.
test('paired browser HEAD on a compiled site preserves its GET representation metadata', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-code-site-head-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(
    root,
    'powerpages.config.json',
    JSON.stringify({
      siteName: 'Invented paired site',
      compiledPath: 'dist',
      defaultLandingPage: 'index.html',
    }),
  );
  await write(
    root,
    'dist/index.html',
    '<!doctype html><html><head><title>App</title></head><body>Build ✓</body></html>',
  );
  const app = await createSimulator({
    sourceDir: root,
    port: 0,
    watch: false,
    requirePortalSource: true,
    identityProvider: { pairedBrowserTokens: true },
    observed: {
      evidence: 'Invented response metadata',
      headers: { page: { 'Content-Length': '1' } },
    },
  });
  try {
    const route = app.url + '/reports/current/';
    const browser = { 'sec-fetch-site': 'same-origin' };
    const head = await fetch(route, { method: 'HEAD', headers: browser });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('x-sim-route'), 'code-site-app');
    assert.equal(head.headers.getSetCookie().length, 0);
    assert.equal(await head.text(), '');

    const document = await fetch(route, { headers: browser });
    assert.equal(document.status, 200);
    const bytes = Buffer.byteLength(await document.text());
    assert.equal(Number(document.headers.get('content-length')), bytes);
    assert.equal(head.headers.get('content-length'), null, 'an unbound HEAD must omit Content-Length');
    const binding = document.headers.getSetCookie().find((cookie) => cookie.includes('-request-binding-'));
    assert.ok(binding);
    const boundHead = await fetch(route, { method: 'HEAD', headers: { ...browser, cookie: binding.split(';')[0] } });
    assert.equal(Number(boundHead.headers.get('content-length')), bytes);
    assert.equal(boundHead.headers.getSetCookie().length, 0);

    const tool = await fetch(route);
    const toolHead = await fetch(route, { method: 'HEAD' });
    assert.equal(Number(toolHead.headers.get('content-length')), Buffer.byteLength(await tool.text()));
    assert.equal(toolHead.headers.getSetCookie().length, 0);
  } finally {
    await app.close();
  }
});

test('a source-exported web app manifest without a stored MIME type keeps its registered type and bytes', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-exported-webmanifest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, 'website.yml', 'adx_websiteid: site\nadx_name: Invented template site');
  await write(root, 'Home.webpage.yml', 'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /');
  await write(
    root,
    'app.webmanifest.webfile.yml',
    'adx_webfileid: app-manifest\nadx_name: App manifest\nadx_parentpageid: home\nadx_partialurl: app.webmanifest',
  );
  await write(root, 'app.webmanifest', webAppManifest);
  const app = await createSimulator({ sourceDir: root, watch: false, requirePortalSource: true });
  try {
    const response = await fetch(app.url + '/app.webmanifest');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/manifest\+json\b/);
    assert.equal(await response.text(), webAppManifest);
  } finally {
    await app.close();
  }
});

test('a malformed code-site manifest cannot select a file outside the build output', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-code-site-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(
    root,
    'powerpages.config.json',
    JSON.stringify({ compiledPath: 'dist', defaultLandingPage: '../index.html' }),
  );
  await write(root, 'dist/file.css', 'body { color: red; }');
  await write(root, 'index.html', '<p>Outside the build</p>');
  const portal = await importPortal(root);
  assert.equal(portal.isSpaSite, false);
  assert.deepEqual(portal.pages, []);
  assert.ok(portal.diagnostics.some((row) => row.code === 'CODE_SITE_COMPILED_UNAVAILABLE'));
});
