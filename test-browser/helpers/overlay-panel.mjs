// A Lense overlay session with its panel, in a headless browser that reaches the invented loopback portal only.
import { chromium } from 'playwright-core';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { browserChannel } from '../../mirage/lib/browser-launch.mjs';
import { OverlaySession } from '../../lense/session.mjs';
import { attachSession } from '../../lense/browser.mjs';
import { enablePanel } from '../../lense/panel.mjs';
import { SITE } from '../../test/fixture.mjs';

/**
 * Opens `fx` (a fixture of test/fixture.mjs) as the sources of the portal that `start()` brings up; `start` resolves
 * to the portal's origin and runs after every cleanup is registered. The panel, the session, the browser and then the
 * `close` callbacks are released in that order, and the fixture is removed last. `allow` names other origins the page
 * may reach, `args` adds browser switches and `session` adds session options.
 */
export async function overlayPanel(
  t,
  fx,
  start,
  { allow = () => [], args = [], session: extra = {}, close = [] } = {},
) {
  let browser, panel, detach;
  ownedFixture(t).add(async () => {
    await panel?.dispose();
  });
  ownedFixture(t).add(async () => {
    await detach?.();
  });
  ownedFixture(t).add(async () => {
    await browser?.close();
  });
  for (const release of close) ownedFixture(t).add(release);
  ownedFixture(t).remove(async () => {
    fx.cleanup();
  });
  const origin = await start();
  const reachable = new Set([origin, ...allow()]);
  const channel = browserChannel();
  browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', ...args],
  });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await context.route('**/*', (route) =>
    reachable.has(new URL(route.request().url()).origin) ? route.fallback() : route.abort(),
  );
  const session = new OverlaySession({
    sourceDir: fx.dir,
    origin,
    site: structuredClone(SITE),
    sourceMaps: false,
    siteName: 'Invented',
    envName: 'loopback',
    stateDir: fx.dir,
    browser: {},
    ...extra,
  });
  const page = await context.newPage();
  detach = await attachSession(context, session);
  panel = enablePanel(context, session);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { origin, context, session, page, panel, errors };
}
