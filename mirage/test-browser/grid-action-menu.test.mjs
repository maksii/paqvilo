import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { simulatorFixture, parentId, pendingId } from "../test/fixtures/subgrid.mjs";
import { signInContext } from "../testing/session.mjs";

test("native row actions fit the viewport, open Edit naturally, and remain keyboard accessible in a small RTL viewport", async (t) => {
  const app = await simulatorFixture(t);
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 500, height: 360 } });
  await signInContext(context, app, "editor", { roles: ["Editor"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(app.url) ? route.continue() : route.abort());
  await page.goto(`${app.url}/?id=${parentId}`);
  const row = page.locator(`#Children tr[data-id="${pendingId}"]`);
  await row.waitFor();
  // Authored layout places the real toggle at the bottom right, with actual menu
  // sizing. Geometry is measured by the browser rather than patched by the test.
  await page.addStyleTag({ content: `
    .dropdown-menu { display:none; padding:4px 0; margin:2px 0; min-width:180px; list-style:none; }
    .open > .dropdown-menu { display:block; }
    .dropdown-menu a { display:block; padding:18px 12px; }
    #Children tr[data-id="${pendingId}"] .dropdown.action { position:fixed; bottom:12px; right:6px; width:32px; height:32px; }
  ` });
  const toggle = row.locator(".dropdown.action > button");
  const menu = row.locator(".dropdown-menu");
  const bounds = () => menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const button = element.parentElement.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, above: rect.bottom <= button.top, height: rect.height, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflow: getComputedStyle(element).overflowY, rightStyle: element.style.right };
  });
  await toggle.click();
  const normal = await bounds();
  assert.equal(normal.above, true);
  assert.ok(normal.top >= 4 && normal.bottom <= 356 && normal.left >= 4 && normal.right <= 496, JSON.stringify(normal));
  const beforeClickScroll = await page.evaluate(() => window.scrollY);
  await row.getByRole("menuitem", { name: "Notify", exact: true }).click();
  assert.equal(await page.evaluate(() => window.scrollY), beforeClickScroll);
  const frame = page.frameLocator("#Children section.modal-form-edit iframe");
  await frame.getByLabel("Message", { exact: true }).fill("Viewport-safe edit");
  await frame.locator("#UpdateButton").click();
  await page.waitForFunction(() => window.gridLoads >= 2);
  assert.equal(app.store.snapshot().tables.child.find((entry) => entry.childkey === pendingId).message, "Viewport-safe edit");
  await page.locator("#Children section.modal-form-edit").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 150, height: 96 });
  await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"));
  // Resize can schedule a window scroll/resize event. Let that existing event
  // settle before opening; it correctly closes menus left open during resizing.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await toggle.click();
  const small = await bounds();
  assert.ok(small.top >= 4 && small.bottom <= 92 && small.left >= 4 && small.right <= 146, JSON.stringify(small));
  assert.ok(small.scrollHeight > small.clientHeight);
  assert.equal(small.overflow, "auto");
  assert.notEqual(small.rightStyle, "auto");
  await toggle.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await row.getByRole("menuitem", { name: "Remove", exact: true }).evaluate((element) => document.activeElement === element), true);
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Tab");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await menu.isVisible(), false);
  assert.deepEqual(errors, []);
});

test('a deep authored grid menu survives queued scroll and one-pixel completion drift, then closes on cumulative movement', async t => {
  const app = await simulatorFixture(t);
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 700, height: 360 } });
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage();
  await page.goto(`${app.url}/?id=${parentId}`);
  const row = page.locator(`#Children tr[data-id="${pendingId}"]`);
  await row.waitFor();
  await page.addStyleTag({ content: `#Children { margin-top:1500px; } .dropdown-menu{display:none;list-style:none;margin:2px 0;padding:4px 0;min-width:180px}.open>.dropdown-menu{display:block}.dropdown-menu a{display:block;padding:18px 12px}` });
  const toggle = row.locator('.dropdown.action > button');
  await toggle.click(); // Playwright naturally scrolls the real deep toggle into view.
  const scroll = await page.evaluate(() => window.scrollY);
  assert.ok(scroll > 1000);
  // Reproduce a queued scroll notification whose position the show handler has
  // already measured. No geometry is replaced and the edit remains a real click.
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => new Promise(resolve => {
    window.addEventListener('scroll', resolve, { once: true });
    window.scrollBy(0, -1);
  }));
  assert.equal(await page.evaluate(() => window.scrollY), scroll - 1);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'one-pixel completion drift must not dismiss the real menu');
  const rect = await row.locator('.dropdown-menu').boundingBox();
  assert.ok(rect && rect.y >= 4 && rect.y + rect.height <= 356);
  await row.getByRole('menuitem', { name: 'Notify', exact: true }).click();
  const frame = page.frameLocator('#Children section.modal-form-edit iframe');
  await frame.getByLabel('Message', { exact: true }).fill('Deep grid edit');
  await frame.locator('#UpdateButton').click();
  await page.locator('#Children section.modal-form-edit').waitFor({ state: 'hidden' });
  assert.equal(app.store.snapshot().tables.child.find(entry => entry.childkey === pendingId).message, 'Deep grid edit');
  await toggle.click();
  await page.evaluate(() => new Promise(resolve => {
    window.addEventListener('scroll', resolve, { once: true });
    window.scrollBy(0, -1);
  }));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => window.scrollBy(0, -1));
  await page.waitForFunction(() => !document.querySelector('.entity-grid .dropdown.action.open'));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
});
