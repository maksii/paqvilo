import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { createFixture, SITE } from '../../test/fixture.mjs';
import { fakeBrowser } from '../../test/fake-browser.mjs';
import { OverlaySession } from '../../lense/session.mjs';
import { enablePanel } from '../../lense/panel.mjs';

// A panel state for an invented site and a fresh browser context, both owned by the test.
// The caller routes the page; nothing listens on the loopback origin.
export async function panelSession(t, browser, origin) {
  const source = createFixture(),
    fake = fakeBrowser(),
    fakeTab = fake.openTab(origin + '/');
  const session = new OverlaySession({
    origin,
    sourceDir: source.dir,
    site: structuredClone(SITE),
    siteName: 'Invented',
    envName: 'loopback',
    stateDir: source.dir,
  });
  const controller = enablePanel(fake.context, session),
    state = controller.stateFor(fakeTab.page);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  ownedFixture(t).add(async () => {
    await controller.dispose();
  });
  ownedFixture(t).add(async () => {
    await context.close();
  });
  ownedFixture(t).remove(async () => {
    source.cleanup();
  });
  return { state, page: await context.newPage() };
}
