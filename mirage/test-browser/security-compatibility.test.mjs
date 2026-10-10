import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

test('readonly links and grid frames reject executable URLs; the published sample PCF renders formatted values as text', async (t) => {
  const files = new Map(await Promise.all([
    ['form.js', new URL('../lib/crmentityformview-compat.js', import.meta.url)],
    ['grid.js', new URL('../lib/entity-grid-compat.js', import.meta.url)],
    ['pcf.js', new URL('../../examples/project/code-solution/Controls/exa_ExamplePages.ExampleLinearInput/bundle.js', import.meta.url)],
  ].map(async ([name, file]) => [name, await fs.readFile(file)])));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const body = files.get(req.url.slice(1));
    if (body) { res.setHeader('content-type', 'text/javascript'); return res.end(body); }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/frame') return res.end('<form id="EntityFormControl">Local form</form>');
    res.end('<!doctype html><html><body><div class="entity-form" id="form"></div><div class="modal" id="modal"><div class="form-loading"></div><iframe src="about:blank"></iframe></div><div id="pcf"></div><script src="/form.js"></script><script src="/grid.js"></script><script src="/pcf.js"></script></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.ComponentFramework = { registerControl(_name, constructor) { window.SampleControl = constructor; } };
    document.addEventListener('DOMContentLoaded', () => {
      const form = document.getElementById('form');
      if (!form) return;
      for (const [id, type, value] of [
        ['bad', 'url', 'javascript:window.linkInjected=true'],
        ['encoded', 'url', 'java\nscript:window.linkInjected=true'],
        ['data', 'url', 'data:text/html,<script>alert(1)</script>'],
        ['good', 'url', '/details'], ['ftp', 'url', 'ftp://fixture.invalid/file'],
        ['email', 'email', 'reader@example.invalid'],
      ]) {
        const wrapper = document.createElement('div'), input = document.createElement('input');
        input.id = id; input.type = type; input.readOnly = true; input.value = value;
        wrapper.append(input); form.append(wrapper);
      }
    }, { once: true });
  });
  await page.goto(origin + '/page');
  for (const id of ['bad', 'encoded', 'data']) {
    assert.equal(await page.locator(`#${id}`).locator('..').locator('a').count(), 0);
    assert.equal(await page.locator(`#${id}`).isVisible(), true);
  }
  assert.equal(await page.locator('#good').locator('..').locator('a').getAttribute('href'), origin + '/details');
  assert.equal(await page.locator('#ftp').locator('..').locator('a').getAttribute('href'), 'ftp://fixture.invalid/file');
  assert.equal(await page.locator('#email').locator('..').locator('a').getAttribute('href'), 'mailto:reader@example.invalid');
  for (const value of ['javascript:window.frameInjected=true', 'data:text/html,<script>alert(1)</script>', 'https://fixture.invalid/form']) {
    await page.evaluate((src) => window.__portalSimulation.nativeGrid.EntityGrid.prototype.openFormModal.call({}, document.getElementById('modal'), src), value);
    assert.equal(await page.locator('#modal iframe').getAttribute('src'), 'about:blank');
  }
  await page.evaluate(() => window.__portalSimulation.nativeGrid.EntityGrid.prototype.openFormModal.call({}, document.getElementById('modal'), '/frame'));
  await page.locator('#modal iframe').contentFrame().getByText('Local form').waitFor();
  const result = await page.evaluate(() => {
    const hostile = '<img src=x onerror="window.pcfInjected=true">';
    const context = { parameters: { controlValue: { raw: 2, formatted: hostile } } };
    const control = new window.SampleControl(); let notifications = 0;
    const container = document.getElementById('pcf');
    control.init(context, () => notifications++, {}, container);
    const first = container.querySelector('label').textContent;
    control.updateView({ parameters: { controlValue: { raw: 43, formatted: hostile } } });
    const second = container.querySelector('label').textContent;
    const images = container.querySelectorAll('img').length;
    const input = container.querySelector('input'); input.value = '33'; input.dispatchEvent(new Event('input'));
    const output = control.getOutputs(), label = container.querySelector('label').textContent;
    control.destroy(); input.dispatchEvent(new Event('input'));
    return { first, second, images, output, label, notifications, injected: window.pcfInjected || window.frameInjected || window.linkInjected };
  });
  assert.equal(result.images, 0); assert.ok(result.first.startsWith('<img')); assert.equal(result.second, result.first);
  assert.deepEqual(result.output, { controlValue: 33 }); assert.equal(result.label, '33'); assert.equal(result.notifications, 1);
  assert.equal(result.injected, undefined); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.ok(requests.includes('/frame'));
});
