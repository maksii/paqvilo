import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { simulatorFixture, parentId, pendingId } from '../test/fixtures/subgrid.mjs';
import { signInContext } from '../testing/session.mjs';

test('fallback grids scroll wide columns without losing labels, action menus or modal edits', async t => {
  const app = await simulatorFixture(t);
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage();
  await page.route('**/*', route => route.request().url().startsWith(app.url) ? route.continue() : route.abort());
  await page.goto(`${app.url}/?id=${parentId}`);
  const row = page.locator(`#Children tr[data-id="${pendingId}"]`);
  await row.waitFor();
  await page.addStyleTag({ content: '#Children .view-grid table{min-width:800px}.dropdown-menu{display:none;list-style:none;min-width:180px;padding:4px 0;margin:2px 0}.open>.dropdown-menu{display:block}.dropdown-menu a{display:block;padding:12px}' });
  const grid = page.locator('#Children .view-grid');
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(dimensions.width <= dimensions.viewport, JSON.stringify(dimensions));
  assert.ok(await grid.evaluate(element => element.scrollWidth > element.clientWidth));
  assert.ok(await page.locator('#Children .sr-only').count(), 'screen-reader labels remain in the grid');
  const toggle = row.locator('.dropdown.action>button');
  await toggle.click(); // Scrolls the action column into the actual narrow grid.
  const item = row.getByRole('menuitem', { name: 'Notify', exact: true });
  const hit = await item.evaluate(element => { const box = element.getBoundingClientRect(); return { visible: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('[role="menuitem"]') === element, right: box.right, bottom: box.bottom }; });
  assert.equal(hit.visible, true, JSON.stringify(hit));
  assert.ok(hit.right <= 390 && hit.bottom <= 844);
  await item.click();
  const frame = page.frameLocator('#Children section.modal-form-edit iframe');
  await frame.getByLabel('Message', { exact: true }).fill('Mobile grid edit persisted');
  await frame.locator('#UpdateButton').click();
  await page.locator('#Children section.modal-form-edit').waitFor({ state: 'hidden' });
  assert.equal(app.store.snapshot().tables.child.find(entry => entry.childkey === pendingId).notice, 'Mobile grid edit persisted');
  assert.ok(await page.locator('#Children .sr-only').count());
});
