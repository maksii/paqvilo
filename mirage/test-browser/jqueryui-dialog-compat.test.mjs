import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory, ownedClose, ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const require = createRequire(import.meta.url);
const browser = sharedBrowser();

async function dialogPage(t, html) {
  const page = await browser.page(t, { viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.addScriptTag({ path: require.resolve('jquery/dist/jquery.js') });
  await page.addScriptTag({ path: fileURLToPath(new URL('../lib/jqueryui-dialog-compat.js', import.meta.url)) });
  return page;
}

// @test-kind observation: the consumer's native jQuery UI dialog shows authored hidden content, and jQuery UI 1.11.4 ui/dialog.js restores original display on destroy
test('jQuery UI dialogs reveal initially hidden content and restore its display on destroy', async (t) => {
  const page = await dialogPage(
    t,
    '<div id="confirm" hidden style="display:none!important">Review these details before continuing.</div>',
  );
  const content = page.locator('#confirm');
  const dialog = page.getByRole('dialog');
  const overlay = page.locator('.ui-widget-overlay');

  await page.evaluate(() => window.$('#confirm').dialog({ modal: true }));
  assert.equal(await content.isVisible(), true, 'default open reveals content');
  await page.evaluate(() => window.$('#confirm').dialog('destroy'));
  assert.equal(await content.isVisible(), false, 'destroy restores the initial display');

  await page.evaluate(() => {
    window.$('#confirm').dialog({
      modal: true,
      autoOpen: false,
      buttons: {
        Continue() {
          this.dataset.confirmed = 'yes';
          window.$(this).dialog('close');
        },
      },
    });
  });
  assert.equal(await content.isVisible(), false);
  assert.equal(await overlay.count(), 0);
  await page.evaluate(() => window.$('#confirm').dialog('open'));
  assert.equal(await content.isVisible(), true, 'explicit open reveals content');
  assert.equal(await overlay.count(), 1);
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);

  await dialog.getByRole('button', { name: 'Continue' }).click();
  assert.equal(await content.getAttribute('data-confirmed'), 'yes');
  assert.equal(await content.isVisible(), false);
  assert.equal(await overlay.count(), 0);
  await page.evaluate(() => window.$('#confirm').dialog('open'));
  assert.equal(await content.isVisible(), true, 'reopen reveals content');

  await page.evaluate(() => window.$('#confirm').dialog('destroy'));
  assert.equal(await content.isVisible(), false);
  assert.equal(await content.getAttribute('hidden'), '');
  assert.equal(await content.evaluate((element) => element.style.getPropertyPriority('display')), 'important');
  assert.equal(await dialog.count(), 0);
  assert.equal(await overlay.count(), 0);
});

// @test-kind observation: jQuery UI 1.11.4 dialog.js and widget.js allow a close veto but remove the overlay unconditionally on destroy
test('close vetoes leave the dialog open and destroy always removes the backdrop', async (t) => {
  const page = await dialogPage(t, '<button id="launch">Launch</button><div id="confirm" hidden>Confirm</div>');
  const result = await page.evaluate(() => {
    const $ = window.jQuery;
    const dialog = $('#confirm');
    const closeEvents = [];
    dialog.on('dialogclose', (event) => closeEvents.push(event.type));
    dialog.dialog({ modal: true, beforeClose: (event) => event.preventDefault() });
    dialog.dialog('close');
    const optionVeto = dialog.dialog('isOpen');
    dialog.dialog('option', 'beforeClose', null);

    dialog.on('dialogbeforeclose', (event) => event.preventDefault());
    dialog.dialog('close');
    const listenerVeto = dialog.dialog('isOpen');
    dialog.off('dialogbeforeclose').dialog('close');
    const closed = !dialog.dialog('isOpen');

    dialog
      .dialog('option', 'beforeClose', () => false)
      .dialog('open')
      .dialog('destroy');
    const detached = $(document.createElement('div')).dialog({ modal: true }).dialog('destroy');
    return {
      optionVeto,
      listenerVeto,
      closed,
      closeEvents,
      overlays: document.querySelectorAll('.ui-widget-overlay').length,
      hidden: dialog[0].hidden,
      detached: detached[0].parentNode === null,
    };
  });
  assert.deepEqual(result, {
    optionVeto: true,
    listenerVeto: true,
    closed: true,
    closeEvents: ['dialogclose'],
    overlays: 0,
    hidden: true,
    detached: true,
  });
});

// @test-kind observation: jQuery UI 1.11.4 dialog.js restores opener focus and honors Escape already handled by a child
test('a scoped jQuery copy can open a dialog, preserve authored focus and restore the opener', async (t) => {
  const page = await dialogPage(
    t,
    '<button id="launch">Launch</button><div id="confirm" style="display:none"><input id="selection"></div>',
  );
  const launch = page.getByRole('button', { name: 'Launch' });
  const input = page.locator('#selection');
  await launch.focus();
  const hasWidget = await page.evaluate(() => {
    const $ = window.jQuery.noConflict(true);
    const dialog = $('#confirm');
    dialog.dialog({ modal: true, open: () => $('#selection').trigger('focus') });
    $('#selection').one('keydown', (event) => event.preventDefault());
    return dialog.dialog('widget').hasClass('ui-dialog');
  });
  assert.equal(hasWidget, true);
  assert.equal(await input.evaluate((element) => document.activeElement === element), true);
  await input.press('Escape');
  assert.equal(await input.isVisible(), true);
  await input.press('Escape');
  assert.equal(await input.isVisible(), false);
  assert.equal(await launch.evaluate((element) => document.activeElement === element), true);
});

// @test-kind observation: jQuery UI 1.11.4 dialog.js places each new modal overlay above earlier dialog siblings
test('a newer modal backdrop blocks interaction with an earlier dialog', async (t) => {
  const page = await dialogPage(t, '<div id="first">First</div><div id="second">Second</div>');
  const result = await page.evaluate(() => {
    const $ = window.jQuery;
    const first = $('#first').dialog({ modal: true, width: 500 });
    const second = $('#second').dialog({ modal: true, width: 200 });
    const firstWrapper = first.dialog('widget')[0];
    const { left, top, height } = firstWrapper.getBoundingClientRect();
    const hit = () => document.elementFromPoint(left + 20, top + height / 2);
    const blocked = hit().classList.contains('ui-widget-overlay');
    second.dialog('close');
    return { blocked, reachable: firstWrapper.contains(hit()) };
  });
  assert.deepEqual(result, { blocked: true, reachable: true });
});

// @test-kind contract: the default dims by 30 percent and respects authored colors, opacity and style policy
test('jQuery UI dialog backdrops dim under a same-origin style policy and use authored overlay styles', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'dialog-overlay-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Test',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': `<!doctype html><html><head><link rel="stylesheet" href="/theme.css"></head>
      <body><div id="confirm">Confirm</div><script>$('#confirm').dialog({ modal: true });</script></body></html>`,
    'Csp.sitesetting.yml':
      'adx_sitesettingid: csp\nadx_name: HTTP/Content-Security-Policy\nadx_value: "style-src \'self\'"',
  };
  await Promise.all(Object.entries(files).map(([name, contents]) => fs.writeFile(path.join(root, name), contents)));
  const app = ownedClose(t, await createSimulator({ sourceDir: root, watch: false }));
  const page = await browser.page(t, { viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  await page.route(`${app.url}/theme.css`, (route) =>
    route.fulfill({
      contentType: 'text/css',
      body: `body { background: #fff }
        body[data-overlay="black"] .ui-widget-overlay { background: #000; opacity: .5 }
        @layer theme { body[data-overlay="red"] .ui-widget-overlay { background: #f00; opacity: .5 } }`,
    }),
  );
  const stylesheetUrl = `${app.url}/__sim-static/jqueryui-dialog-compat.css`;
  const stylesheetResponses = [];
  page.on('response', (item) => {
    if (item.url() === stylesheetUrl) stylesheetResponses.push(item.status());
  });
  const response = await page.goto(app.url);
  assert.equal(response.headers()['content-security-policy'], "style-src 'self'");
  assert.deepEqual(stylesheetResponses, [200]);
  assert.equal(await page.locator('.ui-widget-overlay').count(), 1);
  const sampleBackdrop = async (expected) => {
    const { data } = PNG.sync.read(await page.screenshot({ clip: { x: 5, y: 5, width: 1, height: 1 } }));
    const rgb = [...data.subarray(0, 3)];
    assert.ok(
      rgb.every((channel, index) => Math.abs(channel - expected[index]) <= 1),
      `expected RGB near ${expected}, got ${rgb}`,
    );
  };
  await sampleBackdrop([179, 179, 179]);

  await page.evaluate(() => window.$('#confirm').dialog('close').dialog('open'));
  assert.equal(await page.locator(`link[href="${stylesheetUrl}"]`).count(), 1);
  await page.locator('body').evaluate((body) => {
    body.dataset.overlay = 'black';
  });
  await sampleBackdrop([127, 127, 127]);

  await page.locator('body').evaluate((body) => {
    body.dataset.overlay = 'red';
  });
  await sampleBackdrop([255, 127, 127]);
});
