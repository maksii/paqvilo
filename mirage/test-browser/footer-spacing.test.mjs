import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

test('footer spacing ignores clipped and modal controls, repairs visible occlusion and restores source styles', async (t) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<!doctype html><body style="position:relative;min-height:600px;margin:0;padding-bottom:120px;box-sizing:border-box">
    <div style="height:400px"></div><div style="height:80px;overflow:auto"><a id="visible" href="#">Visible</a><div style="height:80px"></div><a id="clipped" href="#">Clipped</a></div>
    <div class="modal" style="position:fixed;top:520px;z-index:100"><button>Modal</button></div>
    <div style="position:sticky;top:520px;z-index:100"><button>Sticky</button></div>
    <footer style="position:absolute;bottom:0;left:0;right:0;height:120px;background:white;z-index:1">Footer</footer></body>`);
  await page.addScriptTag({
    content: await fs.readFile(new URL('../lib/footer-spacing-compat.js', import.meta.url), 'utf8'),
  });
  assert.equal(await page.locator('footer').evaluate((element) => getComputedStyle(element).position), 'absolute');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'covered';
    button.textContent = 'Covered';
    button.style.cssText = 'position:absolute;top:540px;left:20px';
    document.body.append(button);
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('footer')).position === 'static');
  assert.equal(await page.evaluate(() => window.__portalSimulation.compatibility.footerSpacingControl), 'covered');
  await page.locator('#covered').evaluate((element) => {
    element.style.zIndex = '200';
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('footer')).position === 'absolute');
  await page.locator('#covered').evaluate((element) => {
    element.style.zIndex = '0';
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('footer')).position === 'static');
  await page.locator('#covered').evaluate((element) => {
    element.style.top = '100px';
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('footer')).position === 'absolute');
  assert.equal(await page.locator('footer').evaluate((element) => element.style.marginTop), '');
  assert.equal(await page.evaluate(() => window.__portalSimulation.compatibility.footerSpacingMode), 'source');
  assert.deepEqual(errors, []);
});

test('structural form fallback provides full-width fields and input groups without a capture', async (t) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  t.after(() => page.close());
  await page.setContent(
    '<div class="crmEntityFormView"><table class="section"><tr><td class="cell"><div class="info"><label>Name</label></div><div class="control"><input class="form-control"></div></td><td class="cell"><div class="info"><label>Date</label></div><div class="control input-group"><input class="form-control"><span class="input-group-addon">Date</span></div></td></tr></table></div>',
  );
  await page.addStyleTag({
    content: await fs.readFile(new URL('../lib/platform-chrome.css', import.meta.url), 'utf8'),
  });
  const widths = await page.locator('td.cell').evaluateAll((cells) =>
    cells.map((cell) => ({
      width: cell.clientWidth,
      info: cell.querySelector('.info').clientWidth,
      control: cell.querySelector('.control').clientWidth,
      input: cell.querySelector('input').clientWidth,
    })),
  );
  for (const cell of widths) {
    assert.ok(cell.width > 350);
    assert.ok(cell.info > 300);
    assert.equal(cell.info, cell.control);
    assert.ok(cell.input > 250);
  }
});

test('fixed footer repair rechecks viewport overlap on scroll and preserves root styles', async (t) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  t.after(() => page.close());
  await page.setContent(
    '<html style="--test-marker: 1"><body style="height:1600px;margin:0"><div style="height:540px"></div><button id="action">Action</button><footer style="position:fixed;bottom:0;left:0;right:0;height:120px;background:white;z-index:1">Footer</footer></body></html>',
  );
  const original = await page.locator('html').getAttribute('style');
  await page.addScriptTag({
    content: await fs.readFile(new URL('../lib/footer-spacing-compat.js', import.meta.url), 'utf8'),
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('footer')).position === 'static');
  await page.evaluate(() => scrollTo(0, 200));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('footer')).position === 'fixed');
  assert.equal(await page.locator('html').getAttribute('style'), original);
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('footer')).position === 'static');
  assert.equal(await page.locator('html').getAttribute('style'), original);
});
