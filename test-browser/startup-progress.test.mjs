import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { startupProgress, waitForStartupPage } from '../lense/startup-progress.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
async function newContext(t) {
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  return context;
}

test('startup separates delayed navigation, delayed usable application, failures and sign-in redirects', async (t) => {
  // Each delayed step is held until the progress has reported the phase it waits in, so a waiting report is
  // observed however fast or slow the machine is.
  let reported = Promise.resolve(),
    report = () => {},
    hangReceived = () => {};
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/signin' }).end();
      return;
    }
    if (req.url === '/hang') return hangReceived();
    if (req.url === '/app-data' || req.url === '/app-ready') {
      reported.then(() => res.end('Invented data'));
      return;
    }
    const page = () =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><p id="notice">${req.url === '/main.aspx?error' ? 'Invented catalogue failure' : ''}</p>${req.url.startsWith('/main.aspx') ? `<script>fetch('/app-ready').then(() => document.documentElement.dataset.mirageAppState = '${req.url.includes('error') ? 'error' : 'ready'}')</script>` : req.url === '/slow-app' ? '<script>fetch("/app-data")</script>' : ''}`,
        );
    if (req.url === '/slow-origin') reported.then(page);
    else page();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const context = await newContext(t);
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
  });
  ownedFixture(t).add(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await context.newPage();
  // `held` names the phase whose first waiting report releases the held step of this run.
  const run = async (pathname, settings, held) => {
    reported = new Promise((resolve) => (report = resolve));
    const events = [],
      progress = startupProgress({
        structured: true,
        intervalMs: 20,
        write: (line) => {
          const event = JSON.parse(line);
          events.push(event);
          if (event.phase === held && event.status === 'waiting') report();
        },
      });
    try {
      const loaded = await waitForStartupPage(page, origin + pathname, { progress, ...settings });
      return { events, loaded };
    } finally {
      progress.close();
    }
  };
  const slow = await run('/slow-origin', {}, 'document navigation');
  assert.ok(slow.events.some((event) => event.phase === 'document navigation' && event.status === 'waiting'));
  assert.match(slow.events.at(-1).detail, /application readiness remain unverified/);
  const data = await run('/slow-app', {}, 'page resources');
  assert.ok(data.events.some((event) => event.phase === 'page resources' && event.status === 'waiting'));
  const app = await run('/main.aspx', { modelDriven: true }, 'application data');
  assert.ok(app.events.some((event) => event.phase === 'application data' && event.status === 'waiting'));
  assert.equal(app.events.at(-1).detail, 'application and initial view usable');
  assert.ok(
    app.events.every((event, index) => index === 0 || event.totalElapsedMs >= app.events[index - 1].totalElapsedMs),
  );
  await assert.rejects(
    run('/main.aspx?error', { modelDriven: true }, 'application data'),
    /Invented catalogue failure/,
  );
  const redirect = await run('/redirect', { modelDriven: true });
  assert.equal(new URL(page.url()).pathname, '/signin');
  assert.doesNotMatch(redirect.events.at(-1).detail, /usable/);
  await assert.rejects(run('/hang', { timeout: 100 }), /Timeout/);
  await page.goto(origin);
  // Stopping while the request is in flight ends the wait without a load.
  const inFlight = new Promise((resolve) => (hangReceived = resolve));
  const cancelled = await run('/hang', { stopped: inFlight, timeout: 1000 });
  assert.equal(cancelled.loaded, false);
  const closingPage = await context.newPage();
  await closingPage.route('**/main.aspx', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Still loading application</p>' }),
  );
  const progress = startupProgress({ write() {} });
  const closing = waitForStartupPage(closingPage, origin + '/main.aspx', {
    progress,
    modelDriven: true,
    timeout: 1000,
  });
  await closingPage.locator('p').waitFor();
  await closingPage.close();
  assert.equal(await closing, false, 'closing during a readiness wait is normal dev shutdown');
  progress.close();
});

function hideOrphanTerminalEvents(page) {
  const bindings = new Map();
  return new Proxy(page, {
    get(target, key) {
      if (key === 'on')
        return (event, handler) => {
          const wrapper = ['requestfinished', 'requestfailed'].includes(event)
            ? (r) => {
                if (!new URL(r.url()).pathname.startsWith('/orphan')) handler(r);
              }
            : handler;
          bindings.set(handler + event, wrapper);
          target.on(event, wrapper);
        };
      if (key === 'off') return (event, handler) => target.off(event, bindings.get(handler + event) ?? handler);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
test('real browser replacement finishes after current data despite missing old terminal protocol event', async (t) => {
  let essentialFinished = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/orphan') return;
    if (req.url === '/essential') {
      setTimeout(() => {
        essentialFinished = true;
        res.end('current');
      }, 220);
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        req.url === '/first'
          ? '<script>fetch("/orphan")</script><p>first</p>'
          : '<script>fetch("/essential")</script><p>second</p>',
      );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const context = await newContext(t);
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
  });
  ownedFixture(t).add(async () => {
    await new Promise((r) => server.close(r));
  });
  const page = await context.newPage(),
    origin = 'http://127.0.0.1:' + server.address().port;
  const wrapped = hideOrphanTerminalEvents(page);
  const loading = waitForStartupPage(wrapped, origin + '/first', {
    timeout: 3000,
  });
  await page.locator('p').waitFor();
  await page.goto(origin + '/second', { waitUntil: 'domcontentloaded' });
  assert.equal(await loading, true);
  assert.equal(essentialFinished, true, 'current document request must really finish');
  assert.equal(await page.locator('p').textContent(), 'second');
  await assert.rejects(
    waitForStartupPage(wrapped, origin + '/first', { timeout: 200 }),
    /did not settle/,
    'a current document orphan remains a failure',
  );
});
test('real browser detached frame orphan cannot hide current parent fetch', async (t) => {
  // The parent removes the child frame once the server has its fetch, and its own data answers only after the
  // removal, so the orphan exists while the parent request is still current.
  let parentFinished = false,
    orphanReceived,
    frameRemoved;
  const orphan = new Promise((resolve) => (orphanReceived = resolve)),
    removed = new Promise((resolve) => (frameRemoved = resolve));
  const server = http.createServer((req, res) => {
    if (req.url === '/orphan-child') return orphanReceived();
    if (req.url === '/child-fetch-received') return orphan.then(() => res.end());
    if (req.url === '/frame-removed') {
      frameRemoved();
      return res.end();
    }
    if (req.url === '/parent-essential') {
      removed.then(() => {
        parentFinished = true;
        res.end('data');
      });
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        req.url === '/child'
          ? '<script>fetch("/orphan-child")</script>'
          : '<iframe src="/child"></iframe><script>fetch("/parent-essential");fetch("/child-fetch-received").then(()=>{document.querySelector("iframe").remove();return fetch("/frame-removed")})</script>',
      );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const context = await newContext(t);
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
  });
  ownedFixture(t).add(async () => {
    await new Promise((r) => server.close(r));
  });
  const page = await context.newPage();
  assert.equal(
    await waitForStartupPage(hideOrphanTerminalEvents(page), 'http://127.0.0.1:' + server.address().port, {
      timeout: 3000,
    }),
    true,
  );
  assert.equal(parentFinished, true);
});

test('native app startup completes with worker terminal events missing and an ongoing background request', async (t) => {
  const owner = ownedFixture(t);
  const server = http.createServer((req, res) => {
    if (req.url === '/background') return;
    if (req.url === '/orphan-worker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end('postMessage("worker started");');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><p>Native app document</p><script>
      const worker = new Worker('/orphan-worker.js');
      worker.onmessage = () => window.workerStarted = true;
      fetch('/background');
    </script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  owner.add(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const context = await newContext(t),
    page = await context.newPage(),
    progress = startupProgress({ write() {} });
  owner.add(() => progress.close());
  assert.equal(
    await waitForStartupPage(hideOrphanTerminalEvents(page), `http://127.0.0.1:${server.address().port}/main.aspx`, {
      nativeModelDriven: true,
      timeout: 3000,
      progress,
    }),
    true,
  );
  await page.waitForFunction(() => window.workerStarted);
  assert.match(progress.events.at(-1).detail, /native application readiness remain unverified/);
  assert.doesNotMatch(progress.events.at(-1).detail, /usable/);
});
