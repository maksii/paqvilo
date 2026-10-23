import { ownedFixture, drainFixture } from '../mirage/testing/owned-fixture.mjs';
// Two loopback portals prove the selector without visiting any configured environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { createFixture, SITE } from '../test/fixture.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { panelUi, removePanelUi } from '../lense/panel-ui.mjs';

test('portal selector stays inert until chosen and preserves origin-specific panel identity', { timeout: 60_000 }, async (t) => {
  const fixture = createFixture();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-panel-targets-'));
  const servers = [];
  const panels = [];
  const sessions = new Map();
  const requests = [[], []];
  let browser;
  ownedFixture(t).add(async () => { await drainFixture(panels.map(panel => () => panel.dispose()), { concurrent: true }); });
  ownedFixture(t).add(async () => { await browser?.close(); });
  ownedFixture(t).add(async () => { await drainFixture([...servers].map(server => async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); })); });
  ownedFixture(t).remove(async () => { fixture.cleanup(); });
  ownedFixture(t).remove(async () => { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }); });
  const serve = async (index) => {
    const server = http.createServer((request, response) => {
      requests[index].push(request.url);
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Portal ${index}</title><h1>Portal ${index}</h1>`);
    });
    server.on('connect', (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const first = await serve(0); const second = await serve(1);
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true, proxy: { server: first, bypass: '127.0.0.1,localhost' }, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  context.setDefaultTimeout(10_000);
  await context.route('**/__paqvilo/api/**', (route) => {
    const url = new URL(route.request().url());
    return sessions.get(url.origin).api(route, url.pathname.split('/').at(-1));
  });
  const targets = [
    { siteName: 'alpha', envName: 'dev', origin: first, startPath: '/home/?item=one&item=two', caution: false },
    { siteName: 'beta', envName: 'uat', origin: second, startPath: '/start/?filter=ready#section', caution: true },
    { siteName: 'invalid', envName: 'script', origin: 'javascript:alert(1)', startPath: '/' },
    { siteName: 'invalid', envName: 'credentials', origin: 'https://user:secret@example.invalid', startPath: '/' },
    { siteName: 'invalid', envName: 'authority', origin: first, startPath: '//example.invalid/' },
    { siteName: 'invalid', envName: 'backslash', origin: first, startPath: '/\\example.invalid/' },
  ];
  const makePanel = (target) => {
    const session = new OverlaySession({ sourceDir: fixture.dir, origin: target.origin, site: structuredClone(SITE), sourceMaps: false, siteName: target.siteName, envName: target.envName, caution: target.caution, stateDir: work, devTargets: targets });
    sessions.set(target.origin, session);
    const panel = enablePanel(context, session); panels.push(panel); return panel;
  };
  const alpha = makePanel(targets[0]); const beta = makePanel(targets[1]);
  const page = await context.newPage();
  await page.goto(first + '/current');
  await alpha.draw(page);
  await page.locator('#paqvilo-panel .pill').click();
  const selector = page.getByLabel('Portal / environment', { exact: true });
  assert.deepEqual(await selector.locator('option').allTextContents(), ['alpha @ dev', 'beta @ uat']);
  assert.equal(await selector.inputValue(), '0');
  await selector.focus(); await selector.press('ArrowDown'); await selector.press('ArrowUp'); await selector.press('b');
  assert.equal(page.url(), first + '/current', 'keyboard option selection does not commit navigation');
  assert.equal(await selector.locator('optgroup').count(), 2, 'empty remote group is omitted');
  assert.deepEqual(requests[1], [], 'panel rendering must not probe or navigate other targets');
  await selector.evaluate((node) => { node.add(new Option('Injected URL', 'https://example.invalid/')); node.value = 'https://example.invalid/'; node.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(page.url(), first + '/current', 'forged select options cannot become navigation URLs');
  const oldState = alpha.stateFor(page);
  await selector.selectOption('1');assert.equal(page.url(),first+'/current');
  await page.locator('#paqvilo-panel [data-act="tab"][data-v="issues"]').click();
  let dialogs=0;page.on('dialog',dialog=>{dialogs++;void dialog.dismiss();});
  await page.locator('[data-target-go]').click();
  assert.equal(await page.getByRole('alertdialog').isVisible(),true);
  await page.locator('[data-target-cancel]').click();assert.equal(page.url(),first+'/current');
  assert.equal(await selector.inputValue(),'0','cancel restores the actual target');
  await selector.selectOption('1');await page.locator('[data-target-go]').click();
  await page.route('**/__paqvilo/api/ui',route=>route.abort());
  await page.locator('[data-target-confirm]').click();
  await page.waitForFunction(()=>document.getElementById('paqvilo-panel').shadowRoot.activeElement?.matches('[data-target-go]'));
  assert.equal(await selector.inputValue(),'0');assert.equal(page.url(),first+'/current');
  assert.match(await page.locator('#paqvilo-panel .toast').innerText(),/dev loop does not answer/);
  await page.unroute('**/__paqvilo/api/ui');
  await selector.selectOption('1');await page.locator('[data-target-go]').click();
  await Promise.all([page.waitForURL(second + '/start/?filter=ready#section'), page.locator('[data-target-confirm]').click()]);
  assert.equal(dialogs,0,'target confirmations never use page dialogs');
  await beta.draw(page);
  assert.equal(await page.locator('#paqvilo-panel').getAttribute('data-label'), 'beta @ uat');
  assert.equal(await page.locator('#paqvilo-panel .pill').isVisible(), false, 'target switch preserves the open panel');
  assert.equal(await page.locator('#paqvilo-panel [role="tab"][aria-selected="true"]').getAttribute('data-v'), 'issues');
  assert.ok(requests[1].includes('/start/?filter=ready'));
  await page.evaluate(panelUi, oldState);
  assert.equal(await page.locator('#paqvilo-panel').getAttribute('data-label'), 'beta @ uat', 'old-origin draw is rejected inside the page');
  await page.evaluate(removePanelUi, { token: oldState.token });
  assert.equal(await page.locator('#paqvilo-panel').getAttribute('data-label'), 'beta @ uat', 'old-origin cleanup cannot remove the current panel');
  if (await page.locator('#paqvilo-panel .pill').isVisible()) await page.locator('#paqvilo-panel .pill').click();
  assert.equal(await page.getByLabel('Portal / environment', { exact: true }).inputValue(), '1');
  await Promise.all([page.waitForURL(first + '/home/?item=one&item=two'), page.getByLabel('Portal / environment', { exact: true }).selectOption('0').then(()=>page.locator('[data-target-go]').click())]);
  await alpha.draw(page);
  assert.equal(await page.locator('#paqvilo-panel').getAttribute('data-label'), 'alpha @ dev');
});
