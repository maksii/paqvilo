// @test-kind contract: the publishing preview toggle in Lense Tweaks and in Mirage admin (/_sim/) is Paqvilo's own user interface over the local POST /_sim/api/session/preview route (mirage/lib/publishing-preview.mjs)
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { SITE } from '../test/fixture.mjs';
import { PREVIEW_CONTACT as CONTACT, publishingPreviewSite } from '../mirage/test/fixtures/publishing-preview-site.mjs';
import { signInContext } from '../mirage/testing/session.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';

async function browserFor(t) {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  return browser.newContext({ viewport: { width: 1400, height: 1000 } });
}

const previewCookie = async (context, url) =>
  (await context.cookies(url)).find((cookie) => cookie.name === 'adxPreviewUnpublishedEntities')?.value ?? null;

test('Tweaks turns publishing preview off and on for a contact with the preview right, and offers nothing to one without it', async (t) => {
  const { app, dir } = await publishingPreviewSite(t);
  const context = await browserFor(t);
  await signInContext(context, app, CONTACT, { roles: ['Editor'] });
  const session = new OverlaySession({
    sourceDir: dir,
    origin: app.url,
    site: structuredClone(SITE),
    sourceMaps: false,
    siteName: 'Invented preview',
    envName: 'local',
    stateDir: dir,
    browser: {},
    mirage: true,
    mirageSourceRoots: [dir],
  });
  const page = await context.newPage(),
    errors = [];
  const detach = await attachSession(context, session),
    panel = enablePanel(context, session, { open: async () => null });
  ownedFixture(t).add(async () => {
    await panel.dispose();
  });
  ownedFixture(t).add(async () => {
    await detach();
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const first = await page.goto(`${app.url}/draft/`);
  assert.equal(first.status(), 200, 'preview is on without the cookie');
  const root = page.locator('#paqvilo-panel');
  const openTweaks = async () => {
    await root.locator('.pill:visible, .wrap.open').first().waitFor();
    if (await root.locator('.pill').isVisible()) await root.locator('.pill').click();
    await root.locator('[data-act="tab"][data-v="tweaks"]').click();
  };
  await openTweaks();
  const card = root.locator('.card').filter({ hasText: 'Publishing preview' });
  const on = card.locator('[data-act="preview"][data-v="on"]'),
    off = card.locator('[data-act="preview"][data-v="off"]');
  await on.and(page.locator('[aria-pressed="true"]')).waitFor();
  assert.equal(await off.getAttribute('aria-pressed'), 'false');

  // Off: the cookie is false, and the reloaded draft page is refused as it is for a visitor without the right.
  const [hidden] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), off.click()]);
  assert.equal(hidden.status(), 403, 'the draft page is hidden with preview off');
  assert.equal(await previewCookie(context, app.url), 'false');
  await openTweaks();
  await off.and(page.locator('[aria-pressed="true"]')).waitFor();

  // On again: the draft page is back.
  const [shown] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), on.click()]);
  assert.equal(shown.status(), 200);
  assert.equal(await previewCookie(context, app.url), 'true');

  // A contact without the right gets no toggle.
  await signInContext(context, app, CONTACT, { roles: ['Reader'] });
  await page.goto(`${app.url}/`);
  await openTweaks();
  await root.locator('.card').filter({ hasText: 'Browser session' }).getByText('Reader', { exact: false }).waitFor();
  assert.equal(await card.count(), 0, 'no publishing preview card without the right');
  assert.deepEqual(errors, []);
});

test('Mirage admin turns publishing preview off, back to the default, and shows nothing to a contact without the right', async (t) => {
  const { app } = await publishingPreviewSite(t);
  const context = await browserFor(t);
  await signInContext(context, app, CONTACT, { roles: ['Editor'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const draft = async () => (await context.request.get(`${app.url}/draft/`, { maxRedirects: 0 })).status();
  await page.goto(`${app.url}/_sim/#access`);
  const panel = page.locator('[data-panel="publishing-preview"]');
  await panel.locator('.badge').getByText('Preview on', { exact: true }).waitFor();
  assert.equal(await panel.locator('[data-enabled="null"]').count(), 0, 'no cookie to clear yet');

  await panel.getByRole('button', { name: 'Turn preview off' }).click();
  await panel.locator('.badge').getByText('Preview off', { exact: true }).waitFor();
  assert.equal(await previewCookie(context, app.url), 'false');
  assert.equal(await draft(), 403);

  await panel.getByRole('button', { name: 'Use the default' }).click();
  await panel.locator('.badge').getByText('Preview on', { exact: true }).waitFor();
  assert.equal(await previewCookie(context, app.url), null, 'the cookie is cleared');
  assert.equal(await draft(), 200);

  await signInContext(context, app, CONTACT, { roles: ['Reader'] });
  await page.reload();
  await page.locator('[data-panel="session"]').getByText('Reader', { exact: false }).first().waitFor();
  assert.equal(await panel.locator('section').count(), 0, 'no publishing preview panel without the right');
  assert.deepEqual(errors, []);
});
