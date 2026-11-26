// @test-kind contract: a native Power Pages build manifest supplies the SPA entry, public assets, and local client context.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codeSiteDocument } from '../lib/code-site.mjs';
import { importPortal } from '../lib/importer.mjs';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const webAppManifest = '{"name":"Invented installable app","start_url":"/","display":"standalone"}\n';
const write = async (root, relative, contents) => {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
};

test('the compiled document uses a real URL base on deep client routes', () => {
  const html =
    '<!doctype html><!-- <head> and <base href="/comment/"> -->' +
    '<html><head data-label="a > b"><base target="_blank">' +
    '<script>window.example = "<base href=/script/>";</script>' +
    '<script src="./assets/app.js"></script></head><body></body></html>';
  const expected = html.replace('<head data-label="a > b">', '<head data-label="a > b"><base href="/">');
  assert.equal(codeSiteDocument(html), expected);
  const authored = html.replace('<base target="_blank">', '<base href="/app/" target="_blank">');
  assert.equal(codeSiteDocument(authored), authored);
  assert.equal(
    codeSiteDocument('<!doctype html><html><meta charset="utf-8"><p>App</p>'),
    '<!doctype html><html><base href="/"><meta charset="utf-8"><p>App</p>',
  );
});

test('a compiled-only code site serves its configured entry on root and client routes', async (t) => {
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
  await write(
    root,
    'dist/app/main.html',
    '<!DOCTYPE html><html lang="en-US"><head><title>App</title><link rel="manifest" href="./assets/app.webmanifest"><script type="module" src="./assets/app.js"></script></head><body><main>Build entry</main></body></html>',
  );
  await write(root, 'dist/assets/app.js', 'export const feature = "bundled";');
  await write(root, 'dist/assets/app.webmanifest', webAppManifest);
  const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  await write(root, 'dist/assets/feature.wasm', wasm);
  await write(root, 'dist/.private', 'invented build dotfile');
  await write(root, 'outside.txt', 'invented project file');
  const portal = await importPortal(root);
  assert.equal(portal.source.dialect, 'code-site-project');
  assert.equal(portal.isSpaSite, true);
  assert.equal(portal.website.name, 'Invented code site');
  assert.deepEqual(
    portal.pages.map((page) => page.url),
    ['/'],
  );

  const app = await createSimulator({ sourceDir: root, watch: false, requirePortalSource: true });
  try {
    for (const route of ['/', '/reports/current/', '/app/main.html']) {
      const response = await fetch(app.url + route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('x-sim-route'), 'code-site-app');
      const html = await response.text();
      assert.match(html, /<base href="\/">/);
      assert.match(html, /<link rel="manifest" href="\.\/assets\/app\.webmanifest">/);
      assert.match(html, /"isSpaSite":"True"/);
      assert.match(html, /<main>Build entry<\/main>/);
    }
    const asset = await fetch(app.url + '/assets/app.js');
    assert.equal(asset.headers.get('x-sim-resource-provider'), 'code-site-build');
    assert.match(asset.headers.get('content-type'), /^application\/javascript\b/);
    assert.equal(await asset.text(), 'export const feature = "bundled";');
    const manifest = await fetch(app.url + '/assets/app.webmanifest');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('x-sim-resource-provider'), 'code-site-build');
    assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json\b/);
    assert.equal(await manifest.text(), webAppManifest);
    const binary = await fetch(app.url + '/assets/feature.wasm');
    assert.equal(binary.headers.get('x-sim-resource-provider'), 'code-site-build');
    assert.deepEqual(new Uint8Array(await binary.clone().arrayBuffer()), wasm);
    const { instance } = await WebAssembly.instantiateStreaming(binary);
    assert.ok(instance instanceof WebAssembly.Instance);
    const head = await fetch(app.url + '/reports/current/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const route of ['/assets/missing.js', '/outside.txt', '/.private', '/_api/unknowns']) {
      const missing = await fetch(app.url + route, { redirect: 'manual' });
      assert.ok(missing.status >= 400, route);
      assert.equal(missing.headers.get('x-sim-route') === 'code-site-app', false);
    }
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
