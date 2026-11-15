import fs from 'node:fs';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { createFixture, SITE } from '../../test/fixture.mjs';
import { fakeBrowser } from '../../test/fake-browser.mjs';
import { OverlaySession } from '../../lense/session.mjs';
import { enablePanel } from '../../lense/panel.mjs';
import { ownCloseSteps } from './owned-server.mjs';
import { PROFILE_RELEASE_RETRIES } from './profile-cleanup.mjs';

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

// A Mirage simulator and its work directory, owned by the test. The closers release the panel and browser
// resources in order before the simulator closes, and the work directory is removed last.
export function ownMirageSession(t, { app, work, closers }) {
  ownCloseSteps(t, [...closers, () => app.close()]);
  ownedFixture(t).remove(async () => {
    fs.rmSync(work, { recursive: true, force: true, ...PROFILE_RELEASE_RETRIES });
  });
}
