import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createFixture, SITE } from '../test/fixture.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { devDialogs } from '../lense/dev-dialogs.mjs';

// Every browser action and awaited panel signal in this file shares Playwright's per-context bound.
const ACTION_TIMEOUT_MS = 10_000;
const UNANSWERED_DIALOG_MS = 75;

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

// Panel problems are recorded from Playwright and DevTools listeners without a public
// signal, so poll the recorded list for the expected rows within the shared action bound.
async function problems(panel, page, ready) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (!ready(panel.stateFor(page).problems) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return panel.stateFor(page).problems;
}

async function fixture(t, html = '<h1>Invented page</h1>', contextOptions = {}) {
  const fx = createFixture();
  let context, panel;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/error')) {
      if (req.url === '/error-hanging') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.write('{"error":');
        return;
      }
      const body = JSON.stringify({
        error: {
          message: req.url === '/error-large' ? 'x'.repeat(40000) : '<img src=x onerror=alert(1)> Missing parent',
          innererror: { message: 'Internal cause' },
        },
      });
      res.writeHead(400, {
        'content-type': 'application/json',
        ...(req.url === '/error-sized' ? { 'content-length': Buffer.byteLength(body) } : {}),
      });
      res.write(body.slice(0, 40));
      setTimeout(() => res.end(body.slice(40)), 15);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>' + html);
  });
  ownedFixture(t).add(() => context?.unrouteAll({ behavior: 'wait' }));
  ownedFixture(t).add(async () => {
    await panel?.dispose();
  });
  ownedFixture(t).add(async () => {
    await context?.close();
  });
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
  });
  ownedFixture(t).add(async () => {
    await new Promise((r) => server.close(r));
  });
  ownedFixture(t).remove(async () => {
    fx.cleanup();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  context = await browser.newContext({ viewport: { width: 1000, height: 700 }, ...contextOptions });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const session = new OverlaySession({
    sourceDir: fx.dir,
    origin,
    site: structuredClone(SITE),
    sourceMaps: false,
    siteName: 'invented',
    envName: 'local',
  });
  panel = enablePanel(context, session);
  await context.route('**/__paqvilo/api/**', (route) =>
    session.api(route, new URL(route.request().url()).pathname.split('/').at(-1)),
  );
  const page = await context.newPage();
  await page.goto(origin);
  await panel.ready;
  await panel.draw(page);
  return { page, context, session, panel, origin, fx };
}

test(
  'panel fixture drains an API request held before dispatch before retiring its API',
  { timeout: 30000 },
  async (t) => {
    const held = Promise.withResolvers(),
      release = Promise.withResolvers(),
      boundary = Promise.withResolvers(),
      dispatched = Promise.withResolvers(),
      hooks = [],
      errors = [];
    let cleanup, replyStatus;
    const owner = ownedFixture(t);
    owner.add(() => release.resolve());
    owner.add(() => (cleanup ??= hooks[0]?.()));
    const newContext = browser.newContext.bind(browser);
    t.mock.method(browser, 'newContext', async (...args) => {
      const context = await newContext(...args),
        route = context.route.bind(context),
        unrouteAll = context.unrouteAll.bind(context);
      t.mock.method(context, 'unrouteAll', (...options) => {
        boundary.resolve('transport draining');
        return unrouteAll(...options);
      });
      t.mock.method(context, 'route', (pattern, delegate, ...options) =>
        route(
          pattern,
          async (requestRoute) => {
            if (!requestRoute.request().url().endsWith('/retiring-probe')) return delegate(requestRoute);
            held.resolve();
            await release.promise;
            const fulfill = requestRoute.fulfill.bind(requestRoute);
            t.mock.method(requestRoute, 'fulfill', (response) => {
              replyStatus = response.status;
              return fulfill(response);
            });
            try {
              await delegate(requestRoute);
            } catch (error) {
              errors.push(error);
              await requestRoute.abort().catch(() => {});
            } finally {
              dispatched.resolve();
            }
          },
          ...options,
        ),
      );
      return context;
    });
    const { page, session, panel } = await fixture({ after: (hook) => hooks.push(hook) });
    const dispose = panel.dispose.bind(panel);
    t.mock.method(panel, 'dispose', () => {
      boundary.resolve('panel retiring');
      return dispose();
    });
    const request = page.evaluate(() => fetch('/__paqvilo/api/retiring-probe').catch(() => {})).catch(() => {});
    await held.promise;
    cleanup = hooks[0]();
    // Release at the first actual ownership boundary: the previous order already retired session.api here.
    await boundary.promise;
    release.resolve();
    await dispatched.promise;
    await cleanup;
    await request;
    assert.deepEqual(errors, [], 'an accepted route cannot dereference an already-retired panel API');
    assert.equal(replyStatus, 403, 'the held unauthenticated request still receives its ordinary refusal');
    assert.equal(session.api, null, 'the panel API is retired after transport draining');
    assert.equal(page.isClosed(), true);
  },
);

test('Issues reports changed Liquid when markup previews are disabled and clears it after reverting', async (t) => {
  const { page, panel, session, fx } = await fixture(t);
  const rel = 'web-templates/header/Header.webtemplate.source.html';
  const before = fx.read(rel);
  session.cfg.site.markup.enabled = false;
  fx.write(rel, before.replace('{% if user %}', '{% if user.roles %}'));
  await session.refresh([fx.file(rel)]);
  await panel.draw(page);
  const scope = page.locator('#paqvilo-panel');
  await scope.locator('.pill').click();
  await scope.locator('[role=tab][data-v=issues]').click();
  await scope.getByText(/web-template preview is disabled.*deploy/).waitFor();
  assert.equal(await scope.getByText('No issues on this page', { exact: true }).count(), 0);
  fx.write(rel, before);
  await session.refresh([fx.file(rel)]);
  await panel.draw(page);
  await scope.getByText('No issues on this page', { exact: true }).waitFor();
});

test('recent save notifications do not replay when Online/Local recreates the panel', async (t) => {
  const { page, panel, session } = await fixture(t);
  session.emit('refreshed', { files: [], how: 'css' });
  await panel.draw(page);
  await page.locator('#paqvilo-panel .float').filter({ hasText: 'Styles swapped' }).waitFor();
  session.bypass = true;
  await page.reload();
  await panel.draw(page);
  assert.equal(await page.locator('#paqvilo-panel .float').innerText(), '');
  session.bypass = false;
  await page.reload();
  await panel.draw(page);
  assert.equal(await page.locator('#paqvilo-panel .float').innerText(), '');
});

test('chunked and sized JSON failures retain escaped details; oversized bodies keep only HTTP metadata', async (t) => {
  const { page, panel } = await fixture(t);
  for (const route of ['/error-small', '/error-large', '/error-sized']) {
    const original = page.waitForResponse((response) => new URL(response.url()).pathname === route);
    await page.evaluate(async (route) => {
      await (await fetch(route)).text();
    }, route);
    if (route === '/error-large')
      assert.ok(
        (await (await original).body()).length > 32768,
        'bounded observer does not truncate the page or another protocol client',
      );
    else await original;
  }
  const rows = await problems(panel, page, (list) => list.length >= 3);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.text.endsWith('/error-large')).where, '');
  for (const route of ['/error-small', '/error-sized'])
    assert.match(rows.find((row) => row.text.endsWith(route)).where, /<img.*Missing parent · Internal cause/);
  await page.evaluate(() => {
    window.hangingDone = false;
    void fetch('/error-hanging')
      .then((response) => response.text())
      .then(() => (window.hangingDone = true))
      .catch(() => {});
  });
  const hanging = await problems(panel, page, (list) => list.some((row) => row.text.endsWith('/error-hanging')));
  assert.equal(hanging.find((row) => row.text.endsWith('/error-hanging'))?.status, 400);
  assert.equal(
    await page.evaluate(() => window.hangingDone),
    false,
    'observation must not cancel or finish the original stalled response',
  );
  await panel.draw(page);
  await page.locator('#paqvilo-panel .pill').click();
  await page.locator('#paqvilo-panel [data-v=issues]').click();
  assert.equal(await page.locator('#paqvilo-panel img').count(), 0);
  assert.match(await page.locator('#paqvilo-panel .body').innerText(), /<img src=x onerror=alert\(1\)> Missing parent/);
});

test('interactive dialogs await an answer and headless dismissals produce one panel activity event', async (t) => {
  const { page, context, session, panel, origin } = await fixture(t);
  const config = { origin, browser: { headless: false } };
  const stop = devDialogs(context, { configs: new Map([[origin, config]]), sessionFor: () => session });
  t.after(stop);
  let settled = false;
  const dialogEvent = page.waitForEvent('dialog');
  const result = page
    .evaluate(() => confirm('Publish invented item?'))
    .then((value) => {
      settled = true;
      return value;
    });
  const dialog = await dialogEvent;
  // No event marks "nobody answered"; an automated answer would settle within this short window.
  await new Promise((r) => setTimeout(r, UNANSWERED_DIALOG_MS));
  assert.equal(settled, false);
  await dialog.accept();
  assert.equal(await result, true);
  config.browser.headless = true;
  const events = [];
  session.on('dialog', (event) => events.push(event));
  // The page resumes when the browser receives the dismissal; the activity event is emitted
  // once Node has the acknowledgement, so wait for that event instead of a fixed delay.
  const recorded = async (count) => {
    const signal = AbortSignal.timeout(ACTION_TIMEOUT_MS);
    while (events.length < count) await once(session, 'dialog', { signal });
  };
  assert.equal(await page.evaluate(() => confirm('Automated invented item?')), false);
  await recorded(1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'confirm');
  assert.equal(events[0].message, 'Automated invented item?');
  assert.equal(panel.stateFor(page).activity.filter((row) => row.type === 'dialog').length, 1);
  await panel.draw(page);
  await page.locator('#paqvilo-panel .pill').click();
  await page.locator('#paqvilo-panel [data-v=activity]').click();
  assert.match(await page.locator('#paqvilo-panel .body').innerText(), /DIALOG/);
  assert.equal(await page.evaluate(() => prompt('Invented prompt')), null);
  await page.evaluate(() => alert('Invented alert'));
  await recorded(3);
  assert.deepEqual(
    events.map((row) => row.type),
    ['confirm', 'prompt', 'alert'],
  );
  await page.evaluate(() =>
    addEventListener('beforeunload', (event) => {
      event.preventDefault();
      event.returnValue = '';
    }),
  );
  await page.locator('h1').click();
  await page.goto(origin + '/after');
  assert.equal(events.at(-1).type, 'beforeunload');
  assert.equal(
    events.at(-1).disposition,
    'accepted',
    'headless navigation preserves Playwright before-unload behavior',
  );
  assert.equal(panel.stateFor(page).activity.find((row) => row.type === 'dialog').text, 'beforeunload dialog accepted');
  stop();
  const detachPolicy = devDialogs(context, {
    configs: new Map([[origin, config]]),
    sessionFor: () => session,
    attached: true,
  });
  t.after(detachPolicy);
  const attachedOpened = page.waitForEvent('dialog'),
    attachedResult = page.evaluate(() => confirm('User-owned attached browser'));
  const attachedDialog = await attachedOpened;
  await attachedDialog.accept();
  assert.equal(await attachedResult, true, 'configuration cannot auto-answer dialogs in a user-owned attached browser');
});

test('collapsed pill relocates after scroll/resize and selects the least obstructed corner', async (t) => {
  const { page } = await fixture(
    t,
    '<style>body{height:2200px;margin:0}a{position:absolute;left:12px;top:1000px;width:280px;height:40px;background:red}</style><a id="moving" href="#clicked">Moving link</a>',
  );
  const clear = () =>
    page.waitForFunction(() => {
      const a = document.querySelector('#moving').getBoundingClientRect(),
        b = document.querySelector('#paqvilo-panel').shadowRoot.querySelector('.pill').getBoundingClientRect();
      return !(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
    });
  await page.evaluate(() => scrollTo(0, 350));
  await clear();
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.evaluate(() => scrollTo(0, 550));
  await clear();
  await page.evaluate(() => {
    document.querySelector('#moving').remove();
    for (const [corner, count] of [
      ['lt', 3],
      ['rt', 2],
      ['lb', 2],
      ['rb', 1],
    ])
      for (let i = 0; i < count; i++) {
        const a = document.createElement('button');
        a.textContent = corner + i;
        a.style.cssText =
          'position:fixed;width:240px;height:40px;' +
          (corner[0] === 'l' ? 'left:12px;' : 'right:12px;') +
          (corner[1] === 't' ? 'top:12px;' : 'bottom:12px;');
        document.body.append(a);
      }
    dispatchEvent(new Event('resize'));
  });
  // The bottom-right corner holds one control and wins over corners with two or three.
  await page.waitForFunction(() => {
    const b = document.querySelector('#paqvilo-panel').shadowRoot.querySelector('.pill').getBoundingClientRect();
    return b.x > 500 && b.y > 250;
  });
  await page.keyboard.press('Alt+Shift+L');
  const notice = page.locator('#paqvilo-panel .float');
  assert.equal(await notice.getAttribute('role'), 'status');
  assert.match(await notice.ariaSnapshot(), /status.*paqvilo is hidden/);
});

test('one-shot element picks consume fast and slow gestures before opening panel details', async (t) => {
  const { page } = await fixture(
    t,
    '<button id="pick-target" style="position:absolute;left:100px;top:250px">Pick me</button>',
    { hasTouch: true },
  );
  await page.evaluate(() => {
    window.pickEvents = [];
    document.addEventListener('paqvilo-xray', (event) => {
      if (event.detail.action === 'selected') window.pickedElement = event.detail.element;
    });
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'focus', 'focusin', 'focusout'])
      for (const [target, capture] of [
        [window, true],
        [document, false],
      ])
        target.addEventListener(
          type,
          (event) => {
            if (window.recordPick) window.pickEvents.push(type + ':' + event.target.localName);
          },
          capture,
        );
  });
  for (const delay of [0, 400, 'touch']) {
    await page.locator('#paqvilo-panel .pill').click();
    await page.locator('#paqvilo-panel [data-v=runtime]').click();
    await page.getByRole('button', { name: 'Select an element', exact: true }).click();
    const box = await page.locator('#pick-target').boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.evaluate(() => {
      window.pickEvents = [];
      window.recordPick = true;
    });
    if (delay === 'touch') await page.touchscreen.tap(box.x + 10, box.y + 10);
    else {
      await page.mouse.down();
      if (delay) await page.waitForTimeout(delay);
      await page.mouse.up();
    }
    await page.waitForFunction(
      () => document.getElementById('paqvilo-panel').shadowRoot.querySelector('.panel').getClientRects().length > 0,
    );
    assert.deepEqual(
      await page.evaluate(() => {
        window.recordPick = false;
        return window.pickEvents;
      }),
      [],
      String(delay),
    );
    assert.deepEqual(await page.evaluate(() => window.pickedElement), { tag: 'button' });
    assert.equal(
      await page.evaluate(
        () => document.getElementById('paqvilo-xray').__px.selectedNode() === document.getElementById('pick-target'),
      ),
      true,
      'the retained browser-only anchor is the actual picked node without serializing its unknown runtime ID',
    );
    const summary = page.locator('#paqvilo-panel [data-selected-identity]');
    await summary.waitFor();
    assert.match(await summary.innerText(), /Selected:/);
    await page.locator('#paqvilo-panel [data-act=close]').click();
  }
});

test('browser CORS console errors keep the page path without a synthetic line; script line one stays real', async (t) => {
  const other = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end('invented'),
  );
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(async () => {
    other.closeAllConnections();
    await new Promise((r) => other.close(r));
  });
  const external = 'http://127.0.0.1:' + other.address().port;
  const { page, panel } = await fixture(
    t,
    `<style>@font-face{font-family:Invented;src:url('${external}/font.woff2')}h1{font-family:Invented}</style><h1>Font</h1><script>console.error('First line script');fetch('${external}/data').catch(()=>{});</script>`,
  );
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  const rows = await problems(panel, page, (list) => list.filter((item) => /CORS policy/.test(item.text)).length >= 2),
    cors = rows.filter((item) => /CORS policy/.test(item.text));
  assert.equal(cors.length, 2, JSON.stringify(rows));
  assert.ok(
    cors.every((item) => item.where === '/' && !item.line),
    JSON.stringify(cors),
  );
  assert.match(rows.find((item) => item.text === 'First line script').where, /:1/);
});
