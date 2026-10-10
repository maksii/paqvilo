// Invented exports and loopback only. Real short page routes are not language prefixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession, refreshPages } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { createFixture, HOME_ID, SITE } from '../test/fixture.mjs';

test('live overlays and panel source identity preserve native short routes alongside exported language routes', { timeout: 60_000 }, async (t) => {
  const fx = createFixture();
  const homeCSS = 'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css';
  const original = fx.read(homeCSS);
  for (const slug of ['it', 'ui']) {
    fx.write(`web-pages/${slug}/${slug}.webpage.yml`, `adx_webpageid: route-${slug}\nadx_name: Native ${slug}\nadx_partialurl: ${slug}\nadx_parentpageid: ${HOME_ID}`);
    fx.write(`web-pages/${slug}/${slug}.webpage.custom_css.css`, original);
  }
  fx.write('websitelanguage.yml', '- adx_websitelanguageid: fr\n  adx_name: French - France\n  adx_languagecode: fr-FR');
  fx.commit();
  fx.write(homeCSS, original.replace('color: red', 'color: green'));
  fx.write('web-pages/it/it.webpage.custom_css.css', original.replace('color: red', 'color: navy'));
  const server = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><style>${original}</style></head><body><p class="hero">Fixture</p></body></html>`));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, panel, detach;
  t.after(async () => {
    panel?.dispose(); await detach?.(); await browser?.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fx.cleanup();
  });
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true, args: ['--disable-background-networking', '--disable-sync'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
  const session = new OverlaySession({ sourceDir: fx.dir, origin, site: structuredClone(SITE), sourceMaps: false, siteName: 'Fixture', envName: 'loopback', stateDir: fx.dir });
  detach = await attachSession(context, session);
  panel = enablePanel(context, session);
  const pages = [];
  for (const [route, expectedPath, color] of [['/', '/', 'rgb(0, 128, 0)'], ['/it', '/it', 'rgb(0, 0, 128)'], ['/ui', '/ui', 'rgb(255, 0, 0)'], ['/fr-FR/it', '/it', 'rgb(0, 0, 128)']]) {
    const page = await context.newPage(); pages.push(page);
    await page.goto(origin + route);
    assert.equal(await page.locator('.hero').evaluate((node) => getComputedStyle(node).color), color);
    assert.equal(panel.stateFor(page).page.path, expectedPath);
  }
  const unknown = await context.newPage(); await unknown.goto(origin + '/zz-ZZ/');
  assert.equal(await unknown.locator('.hero').evaluate((node) => getComputedStyle(node).color), 'rgb(255, 0, 0)');
  assert.equal(panel.stateFor(unknown).page, null);
  fx.write(homeCSS, original.replace('color: red', 'color: purple'));
  session.refresh([fx.file(homeCSS)]);
  await refreshPages(context, session, [fx.file(homeCSS)]);
  assert.equal(await pages[0].locator('.hero').evaluate((node) => getComputedStyle(node).color), 'rgb(128, 0, 128)');
  assert.equal(await pages[1].locator('.hero').evaluate((node) => getComputedStyle(node).color), 'rgb(0, 0, 128)');
  assert.equal(await pages[2].locator('.hero').evaluate((node) => getComputedStyle(node).color), 'rgb(255, 0, 0)');
});
