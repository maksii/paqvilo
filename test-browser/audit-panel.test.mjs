import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
// Adversarial panel checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { createFixture, SITE } from '../test/fixture.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { panelUi } from '../lense/panel-ui.mjs';

test(
  'panel preserves row focus, editable slash input, filtered facets and translucent-theme contrast',
  { timeout: 60000 },
  async (t) => {
    const fx = createFixture();
    let browser, panel;
    const server = http.createServer((_req, res) =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><style>html{background:white}body{background:rgba(0,0,0,.5)}.btn-primary{background:rgb(20,20,20);color:white}</style><h1>Invented fixture</h1><input id="portal-input">',
        ),
    );
    ownedFixture(t).add(async () => {
      await panel?.dispose();
    });
    ownedFixture(t).add(async () => {
      await browser?.close();
    });
    ownedFixture(t).add(async () => {
      server.closeAllConnections();
    });
    ownedFixture(t).add(async () => {
      await new Promise((resolve) => server.close(resolve));
    });
    ownedFixture(t).remove(async () => {
      fx.cleanup();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      channel: process.platform === 'win32' ? 'msedge' : undefined,
      headless: true,
      args: ['--disable-background-networking'],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    let tweaks;
    const applied = [];
    await context.route('**/__paqvilo/api/**', (route) => {
      const action = new URL(route.request().url()).pathname.split('/').at(-1);
      if (['preset', 'scenario'].includes(action)) applied.push(action);
      return route.fulfill({ json: action === 'tweaks' ? tweaks : { ok: true } });
    });
    const session = new OverlaySession({
      sourceDir: fx.dir,
      origin,
      site: structuredClone(SITE),
      siteName: 'fixture',
      envName: 'local',
      stateDir: fx.dir,
    });
    await page.goto(origin);
    await page.evaluate(() => {
      window.auditPanelAdds = [];
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.target.closest?.('#paqvilo-panel,#paqvilo-xray')) continue;
          for (const node of record.addedNodes)
            if (node.nodeType === 1 && !node.closest('#paqvilo-panel,#paqvilo-xray'))
              window.auditPanelAdds.push(node.tagName);
        }
      }).observe(document.documentElement, { subtree: true, childList: true });
    });
    panel = enablePanel(context, session);
    await panel.draw(page);
    const state = panel.stateFor(page),
      scope = page.locator('#paqvilo-panel');
    state.ui = { open: true, tab: 'overrides' };
    state.items = [
      { group: 'js', kind: 'web-file', rel: 'first.js' },
      { group: 'js', kind: 'web-file', rel: 'second.js' },
    ];
    // The initial UI preference is accepted once, so use the actual pill to open the existing instance.
    await scope.locator('.pill').click();
    await page.evaluate(panelUi, state);
    await scope.locator('[data-rel="second.js"] [data-act="open"]').focus();
    state.items[0].count = 2;
    await page.evaluate(panelUi, state);
    assert.equal(
      await page.evaluate(
        () => document.querySelector('#paqvilo-panel').shadowRoot.activeElement.closest('[data-rel]').dataset.rel,
      ),
      'second.js',
    );
    const contrast = await scope.locator('[role=tab][aria-selected=true]').evaluate((node) => {
      const rgb = (color) =>
          color
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number),
        luma = (values) =>
          values
            .map((value) => {
              value /= 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luma(rgb(getComputedStyle(node).color)),
        b = luma(rgb(getComputedStyle(node.closest('.wrap')).getPropertyValue('--bg')));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert.ok(contrast >= 4.5, String(contrast));
    assert.deepEqual(
      await page.evaluate(() => window.auditPanelAdds),
      [],
      'theme probes and panel DOM stay in their owned hosts',
    );
    const people = [
      { contactId: 'a', key: 'a', name: 'Alpha/One', group: 'g1', roles: ['Reader'], active: true },
      { contactId: 'b', key: 'b', name: 'Beta', group: 'g2', roles: ['Writer'], active: true },
      { contactId: 'c', key: 'c', name: 'Inactive', group: 'empty', roles: ['Ghost'], active: false },
      ...Array.from({ length: 110 }, (_, i) => ({
        contactId: 'extra' + i,
        key: 'extra' + i,
        name: 'Extra ' + i,
        group: 'g2',
        roles: ['Writer'],
        active: true,
      })),
    ];
    tweaks = {
      ok: true,
      personas: people,
      personaIndex: people.map((person) => ({
        key: person.key,
        text: person.name.toLowerCase(),
        roles: person.roles.map((value) => value.toLowerCase()),
        tags: [],
        accounts: [],
        group: person.group,
      })),
      personaCatalog: {
        groups: [
          { id: 'g1', label: 'Group one' },
          { id: 'g2', label: 'Group two' },
          { id: 'empty', label: 'Empty group' },
        ],
      },
      session: { supported: true },
      status: {},
      permissionMode: 'enforce',
      presets: [{ id: 'invented', name: 'Invented preset' }],
    };
    state.mirageMode = true;
    state.mirage = { active: true, version: 1, status: {} };
    await page.evaluate(panelUi, state);
    await scope.locator('[role=tab][data-v=tweaks]').click();
    await scope.locator('.pp-persona-filter-disclosure>summary').click();
    const search = scope.locator('[data-panel-persona-query]');
    await search.fill('Alpha');
    await search.press('/');
    assert.equal(await search.inputValue(), 'Alpha/');
    assert.equal(await search.evaluate((node) => node.getRootNode().activeElement === node), true);
    assert.deepEqual(await scope.locator('[data-panel-persona-facet=groups] option').allTextContents(), ['Group one']);
    assert.deepEqual(await scope.locator('[data-panel-persona-facet=roles] option').allTextContents(), ['Reader']);
    assert.equal(await scope.locator('.search').isVisible(), false);
    assert.equal(
      await scope.locator('.pp-persona-filter-disclosure').evaluate((node) => node.open),
      true,
      'typing preserves a manually opened filter disclosure',
    );
    await page.evaluate(panelUi, state);
    assert.equal(
      await scope.locator('[data-panel-persona-facet=roles]').isVisible(),
      true,
      'a later panel render preserves that disclosure too',
    );
    await scope.locator('[data-act=persona-clear]').click();
    assert.equal(await search.inputValue(), '', 'clearing a directly refreshed picker invalidates its render cache');
    assert.equal(await scope.locator('.pp-persona-row').count(), 50);
    await scope.locator('.pp-persona-filter-disclosure>summary').click();
    const rolesOnly = scope.locator('[data-panel-persona-roles-only]');
    await rolesOnly.focus();
    await rolesOnly.press('Space');
    assert.equal(await rolesOnly.isChecked(), true);
    assert.equal(
      await rolesOnly.evaluate((node) => node.getRootNode().activeElement === node),
      true,
      'checkbox focus survives picker refresh',
    );
    const more = scope.locator('[data-act=persona-page][data-direction="1"]');
    await more.focus();
    await more.press('Enter');
    assert.equal(
      await more.evaluate((node) => node.getRootNode().activeElement === node),
      true,
      'a surviving paging action keeps keyboard focus',
    );
    await more.press('Enter');
    assert.equal(await more.count(), 0);
    assert.equal(
      await scope
        .locator('[role=tab][aria-selected=true]')
        .evaluate((node) => node.getRootNode().activeElement === node),
      true,
      'a paging action removed at the last page returns focus inside the panel',
    );
    await scope.locator('[data-act=ask][data-kind=preset]').click();
    const cancel = scope.locator('[data-act=confirm-no]');
    assert.equal(await cancel.evaluate((node) => node.getRootNode().activeElement === node), true);
    const confirmationBounds = await cancel.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const body = node.getRootNode().querySelector('.body').getBoundingClientRect();
      const banner = node.closest('[role=alertdialog]').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, bannerTop: banner.top, bodyTop: body.top, bodyBottom: body.bottom };
    });
    assert.ok(
      confirmationBounds.top >= confirmationBounds.bodyTop - 1 &&
        confirmationBounds.bottom <= confirmationBounds.bodyBottom + 1,
      JSON.stringify(confirmationBounds),
    );
    assert.ok(confirmationBounds.bannerTop >= confirmationBounds.bodyTop - 1, 'the confirmation text is revealed too');
    await cancel.press('Enter');
    assert.equal(await scope.locator('[role=alertdialog]').count(), 0);
    assert.deepEqual(applied, [], 'asking and cancelling never applies a preset');
    await page.keyboard.press('Escape');
    assert.equal(
      await scope.locator('.pill').isVisible(),
      true,
      'Escape remains usable after the paging button disappears',
    );
    const modern = await context.newPage();
    await modern.goto(origin);
    await modern.addStyleTag({
      content: 'html,body{background:color(display-p3 1 1 1)}.btn-primary{background:color(display-p3 .9 .9 .9)}',
    });
    await panel.draw(modern);
    const modernScope = modern.locator('#paqvilo-panel');
    await modernScope.locator('.pill').click();
    assert.equal(
      await modernScope.locator('.wrap').evaluate((node) => getComputedStyle(node).getPropertyValue('--bg').trim()),
      'rgb(255,255,255)',
    );
    assert.equal(
      await modernScope.locator('[role=tab][aria-selected=true]').evaluate((node) => getComputedStyle(node).color),
      'rgb(0, 0, 0)',
      'modern CSS colours still receive a contrasting active-tab foreground',
    );
  },
);
