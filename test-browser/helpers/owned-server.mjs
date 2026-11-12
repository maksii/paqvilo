import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { drainFixture, ownedFixture } from '../../mirage/testing/owned-fixture.mjs';

/** Own both shutdown steps before starting a synthetic loopback HTTP fixture. */
export async function listenOwnedServer(t, server) {
  const owner = ownedFixture(t);
  owner.add(() => server.closeAllConnections());
  owner.add(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Listens on a synthetic loopback server and returns its origin with a service-worker-blocked browser context that may
 * reach only that origin. The browser closes with the test before the server does, and both are owned by the test.
 */
export async function listenLoopbackContext(t, server) {
  let browser;
  ownedFixture(t).add(() => browser?.close());
  const origin = await listenOwnedServer(t, server);
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    proxy: { server: origin, bypass: '127.0.0.1,localhost' },
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  return { origin, context };
}

/** Own the shutdown of every server in the list: each closes its sockets, then stops listening, when the test ends. */
export function ownDrainedServers(t, servers) {
  ownedFixture(t).add(async () => {
    await drainFixture(
      [...servers].map((server) => async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }),
    );
  });
}

/** Own late-bound shutdown steps, run in the order given. */
export function ownCloseSteps(t, closers) {
  const owner = ownedFixture(t);
  for (const close of closers) owner.add(close);
}
