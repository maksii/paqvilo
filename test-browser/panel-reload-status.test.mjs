// @test-kind contract: the Lense panel's wording of a Mirage source reload is Paqvilo's own designed user interface.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
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

// Mirage status reports a reload as pending from the first source notification, before any reload runs; queued is
// only true behind a running reload.
const cases = [
  { status: { reloading: false, pendingReload: false }, text: '' },
  { status: { reloading: true, pendingReload: false }, text: ' · reloading sources' },
  { status: { reloading: false, pendingReload: true }, text: ' · source change waiting to reload' },
  { status: { reloading: true, pendingReload: true }, text: ' · reloading sources · another reload queued' },
];

test('the Mirage status card names a pending source change apart from a reload queued behind a running one', async (t) => {
  const fx = createFixture();
  ownedFixture(t).remove(async () => fx.cleanup());
  const server = http.createServer((req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><h1>Invented fixture</h1>'),
  );
  const origin = await listenOwnedServer(t, server);
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const session = new OverlaySession({
    sourceDir: fx.dir,
    origin,
    site: structuredClone(SITE),
    siteName: 'fixture',
    envName: 'local',
    stateDir: fx.dir,
  });
  for (const { status, text } of cases) {
    const context = await browser.newContext();
    let tweaks;
    await context.route('**/__paqvilo/api/**', (route) => {
      const action = new URL(route.request().url()).pathname.split('/').at(-1);
      return route.fulfill({ json: action === 'tweaks' ? tweaks : { ok: true } });
    });
    const page = await context.newPage();
    await page.goto(origin);
    const panel = enablePanel(context, session);
    await panel.draw(page);
    const state = panel.stateFor(page),
      scope = page.locator('#paqvilo-panel');
    tweaks = {
      ok: true,
      personas: [],
      personaIndex: [],
      personaCatalog: { groups: [] },
      session: { supported: false },
      status: { revision: 4, ...status },
      permissionMode: 'enforce',
      presets: [],
    };
    state.mirageMode = true;
    state.mirage = { active: true, version: 1, status: {} };
    await scope.locator('.pill').click();
    await page.evaluate(panelUi, state);
    await scope.locator('[role=tab][data-v=tweaks]').click();
    const revision = scope
      .locator('.card')
      .filter({ hasText: 'Mirage status' })
      .locator('.srcs')
      .filter({ hasText: 'Revision' })
      .locator('.dim')
      .first();
    await revision.waitFor();
    assert.equal(await revision.innerText(), `4${text}`, JSON.stringify(status));
    await panel.dispose();
    await context.close();
  }
});
