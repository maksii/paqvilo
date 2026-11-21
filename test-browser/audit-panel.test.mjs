// @test-kind contract: the Lense panel keeps row focus, slash input and facet filtering for the invented portal fixture, and its DOM stays in its own host.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
// Adversarial panel checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { listenOwnedServer } from './helpers/owned-server.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createFixture, SITE } from '../test/fixture.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { panelUi } from '../lense/panel-ui.mjs';

test('panel preserves row focus, editable slash input and filtered facets', async (t) => {
  const fx = createFixture();
  let browser, panel;
  const server = http.createServer((req, res) =>
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><h1>Invented fixture</h1><input id="portal-input">'),
  );
  ownedFixture(t).add(async () => {
    await panel?.dispose();
  });
  ownedFixture(t).add(async () => {
    await browser?.close();
  });
  ownedFixture(t).remove(async () => {
    fx.cleanup();
  });
  const origin = await listenOwnedServer(t, server);
  // The lane's selected browser (PAQVILO_BROWSER), not always Edge on Windows.
  browser = await chromium.launch(browserLaunchOptions({ headless: true, args: ['--disable-background-networking'] }));
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
  await scope.locator('[data-rel="second.js"] .main[data-act="open"]').focus();
  state.items[0].count = 2;
  await page.evaluate(panelUi, state);
  assert.equal(
    await page.evaluate(
      () => document.querySelector('#paqvilo-panel').shadowRoot.activeElement.closest('[data-rel]').dataset.rel,
    ),
    'second.js',
  );
  assert.deepEqual(await page.evaluate(() => window.auditPanelAdds), [], 'panel DOM stays in its owned host');
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
  // The filter icon button opens the filter chips beside the persona search.
  await scope.locator('[data-act=persona-filters]').click();
  const search = scope.locator('[data-panel-persona-query]');
  await search.fill('Alpha');
  await search.press('/');
  assert.equal(await search.inputValue(), 'Alpha/');
  assert.equal(await search.evaluate((node) => node.getRootNode().activeElement === node), true);
  const facet = (name) => scope.locator(`[data-act=persona-facet][data-facet=${name}]`);
  assert.deepEqual(await facet('groups').allTextContents(), ['Group one']);
  assert.deepEqual(await facet('roles').allTextContents(), ['Reader']);
  assert.equal(await scope.locator('.tools .search').isVisible(), false);
  assert.equal(
    await scope.locator('[data-panel-persona-facets]').count(),
    1,
    'typing preserves a manually opened filter area',
  );
  await page.evaluate(panelUi, state);
  assert.equal(await facet('roles').isVisible(), true, 'a later panel render preserves that filter area too');
  await scope.locator('[data-act=persona-clear]').click();
  assert.equal(await search.inputValue(), '', 'clearing a directly refreshed picker invalidates its render cache');
  // 112 personas are paged by 50; the groups with rows on this page are open.
  await scope.locator('[data-panel-persona-count]').filter({ hasText: '1–50 of 112 personas' }).waitFor();
  assert.equal(await scope.locator('[data-panel-persona-row]').count(), 50);
  await scope.locator('[data-act=persona-filters]').click();
  const rolesOnly = scope.locator('[data-act=persona-any][data-facet=roles]');
  await rolesOnly.focus();
  await rolesOnly.press('Space');
  assert.equal(await rolesOnly.getAttribute('aria-pressed'), 'true');
  assert.equal(
    await rolesOnly.evaluate((node) => node.getRootNode().activeElement === node),
    true,
    'filter chip focus survives picker refresh',
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
      .locator('[data-act=persona-page][data-direction="-1"]')
      .evaluate((node) => node.getRootNode().activeElement === node),
    true,
    'a paging action removed at the last page moves focus to the remaining paging action, not to the tab',
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
});
