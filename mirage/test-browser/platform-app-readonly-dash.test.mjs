import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

// An empty read-only form box shows the muted dash; a box with a placeholder shows its
// placeholder instead (live read-only contact form: the phone boxes carry no dash).
test('empty read-only boxes get the dash unless they carry a placeholder', async t => {
  const compat = await fs.readFile(new URL('../lib/platform-app-compat.js', import.meta.url), 'utf8');
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://portal.test/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div class="crmEntityFormView"><div class="control"><input id="title" type="text" readonly="readonly"></div><div class="control"><input id="phone" type="text" readonly="readonly" placeholder="Provide a telephone number"></div></div><script src="/app.js"></script></body></html>' });
    if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: compat });
    return route.fulfill({ status: 404, body: '' });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://portal.test/');
  await page.waitForLoadState('load');
  assert.deepEqual(errors, []);
  await page.waitForFunction(() => document.getElementById('title').nextElementSibling?.textContent === '—');
  assert.equal(await page.locator('#phone').evaluate(box => box.nextElementSibling), null);
  assert.equal(await page.locator('#phone').evaluate(box => box.parentElement.style.position), '');
});
