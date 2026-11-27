// A Lense overlay session in a headless browser whose only route to anything is one loopback server, used as its proxy.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { browserChannel } from '../../mirage/lib/browser-launch.mjs';
import { listenOwnedServer } from './owned-server.mjs';
import { PROFILE_RELEASE_RETRIES } from './profile-cleanup.mjs';
import { OverlaySession } from '../../lense/session.mjs';
import { attachSession } from '../../lense/browser.mjs';
import { SITE } from '../../test/fixture.mjs';

/**
 * `server` stands for the online portal: the browser sends every request to it as its proxy, tunnels are refused and
 * no other name resolves. The browser profile and the session state live under `work`, which is removed after
 * `cleanup` once the session is detached and the browser closed. `session` gives the session's own options
 * (sourceDir, siteName and what the test adds). Returns the session's faults as they are reported.
 */
export async function proxiedOverlay(t, server, { work, cleanup = () => {}, session: options }) {
  server.on('connect', (_request, socket) => {
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  let context, detach;
  ownedFixture(t).add(async () => {
    await detach?.();
  });
  ownedFixture(t).add(async () => {
    await context?.close();
  });
  const origin = await listenOwnedServer(t, server);
  ownedFixture(t).remove(async () => {
    cleanup();
    fs.rmSync(work, { recursive: true, force: true, ...PROFILE_RELEASE_RETRIES });
  });
  const channel = browserChannel();
  context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    serviceWorkers: 'block',
    proxy: { server: origin, bypass: '127.0.0.1,localhost' },
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-domain-reliability',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
  });
  const session = new OverlaySession({
    origin,
    site: structuredClone(SITE),
    envName: 'isolated',
    stateDir: path.join(work, 'state'),
    browser: { bypassCSP: false },
    ...options,
  });
  const faults = [];
  session.on('fault', (error) => faults.push(error.message));
  detach = await attachSession(context, session);
  return { origin, session, page: context.pages()[0], faults };
}
