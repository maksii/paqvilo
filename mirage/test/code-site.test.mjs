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
    '<!DOCTYPE html><html lang="en-US"><head><title>App</title><script type="module" src="./assets/app.js"></script></head><body><main>Build entry</main></body></html>',
  );
  await write(root, 'dist/assets/app.js', 'export const feature = "bundled";');
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
      assert.match(html, /"isSpaSite":"True"/);
      assert.match(html, /<main>Build entry<\/main>/);
    }
    const asset = await fetch(app.url + '/assets/app.js');
    assert.equal(asset.headers.get('x-sim-resource-provider'), 'code-site-build');
    assert.match(asset.headers.get('content-type'), /^application\/javascript\b/);
    assert.equal(await asset.text(), 'export const feature = "bundled";');
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
