import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createSimulator } from '../server.mjs';
import { AssetCache } from '../lib/asset-cache.mjs';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { inventedCrmFont } from '../test/fixtures/crm-font.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('a platform WOFF2 URL explicitly aliased to verified WOFF loads and paints its invented glyph', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'crm-alias-browser-'));
  const owner = ownedFixture(t);
  let app, browser;
  owner.add(() => browser?.close());
  owner.add(() => app?.close());
  owner.remove(() => fs.rm(root, { recursive: true, force: true }));
  const origin = 'https://portal.example.test';
  const targetPath = '/resource/powerappsportal/fonts/CRMMDL2.woff2';
  const cache = await new AssetCache({
    directory: path.join(root, 'assets'),
    origin,
    fetchImpl: async () => new Response(inventedCrmFont(), { headers: { 'content-type': 'font/woff' } }),
  }).init();
  const report = await cache.capturePublicAlias({
    sourcePath: '/resource/powerappsportal/fonts/CRMMDL2.woff',
    targetPath,
    requiredCodepoints: [0xe001],
  });
  assert.deepEqual(report.failures, []);
  const portal = path.join(root, 'portal');
  await fs.mkdir(portal);
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented font fixture',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': `<style>@font-face{font-family:QualifiedCRM;src:url('${targetPath}') format('woff2')}#glyph{font:64px QualifiedCRM}</style><span id="glyph">&#xe001;</span>`,
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(portal, name), body);
  app = await createSimulator({ sourceDir: portal, stateFile: path.join(root, 'state.json'), origin, watch: false });
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === targetPath);
  await page.goto(app.url);
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  assert.equal(response.headers()['content-type'], 'font/woff');
  assert.equal(response.headers()['x-sim-asset-source-format'], 'woff');
  assert.deepEqual(await response.body(), inventedCrmFont());
  const painted = await page.evaluate(async (fontBytes) => {
    const faces = await document.fonts.load('64px QualifiedCRM', '\ue001');
    // Font hinting can round the 600/1000-em advance to a whole pixel on Linux.
    // Compare the CSS alias with an independently loaded copy on this renderer.
    const reference = new FontFace('ReferenceCRM', new Uint8Array(fontBytes));
    document.fonts.add(await reference.load());
    const paint = (family) => {
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      const context = canvas.getContext('2d');
      context.font = `64px ${family}`;
      context.fillText('\ue001', 10, 70);
      const rgba = context.getImageData(0, 0, 100, 100).data;
      return {
        width: context.measureText('\ue001').width,
        ink: Array.from(rgba).filter((value, index) => index % 4 === 3 && value > 0).length,
        rgba,
      };
    };
    const alias = paint('QualifiedCRM'),
      expected = paint('ReferenceCRM'),
      missing = paint('UnavailableInventedCRM');
    return {
      faces: faces.map((face) => ({ family: face.family, status: face.status })),
      width: alias.width,
      ink: alias.ink,
      expectedWidth: expected.width,
      expectedInk: expected.ink,
      samePixels: alias.rgba.every((value, index) => value === expected.rgba[index]),
      differsFromMissing: alias.rgba.some((value, index) => value !== missing.rgba[index]),
    };
  }, Array.from(inventedCrmFont()));
  assert.deepEqual(painted.faces, [{ family: 'QualifiedCRM', status: 'loaded' }]);
  assert.equal(painted.width, painted.expectedWidth, JSON.stringify(painted));
  assert.equal(painted.ink, painted.expectedInk, JSON.stringify(painted));
  assert.equal(painted.samePixels, true, JSON.stringify(painted));
  assert.equal(
    painted.differsFromMissing,
    true,
    'The control must distinguish a missing font from the invented triangle.',
  );
  assert.ok(painted.ink > 100 && painted.ink < 1000, JSON.stringify(painted));
  assert.deepEqual(errors, []);
});
