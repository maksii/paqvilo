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

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

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
  context.setDefaultTimeout(10000);
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
  return { page, context, session, panel, origin };
}

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
  const deadline = Date.now() + 5000;
  while (panel.stateFor(page).problems.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  const rows = panel.stateFor(page).problems;
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
  const bodyDeadline = Date.now() + 5000;
  while (!panel.stateFor(page).problems.some((row) => row.text.endsWith('/error-hanging')) && Date.now() < bodyDeadline)
    await page.waitForTimeout(20);
  assert.equal(panel.stateFor(page).problems.find((row) => row.text.endsWith('/error-hanging'))?.status, 400);
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
  await new Promise((r) => setTimeout(r, 75));
  assert.equal(settled, false);
  await dialog.accept();
  assert.equal(await result, true);
  config.browser.headless = true;
  const events = [];
  session.on('dialog', (event) => events.push(event));
  assert.equal(await page.evaluate(() => confirm('Automated invented item?')), false);
  const deadline = Date.now() + 1000;
  while (events.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
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
  await new Promise((r) => setTimeout(r, 30));
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
    page.waitForFunction(
      () => {
        const a = document.querySelector('#moving').getBoundingClientRect(),
          b = document.querySelector('#paqvilo-panel').shadowRoot.querySelector('.pill').getBoundingClientRect();
        return !(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      },
      null,
      { timeout: 3000 },
    );
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
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#paqvilo-panel').shadowRoot.querySelector('.pill').getBoundingClientRect();
      return b.x > 500 && b.y > 250;
    },
    null,
    { timeout: 3000 },
  );
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
    assert.equal(await page.evaluate(() => window.pickedElement.id), 'pick-target');
    assert.match(await page.locator('#paqvilo-panel .body').innerText(), /Selected:/);
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
  const deadline = Date.now() + 5000;
  while (
    panel.stateFor(page).problems.filter((item) => /CORS policy/.test(item.text)).length < 2 &&
    Date.now() < deadline
  )
    await page.waitForTimeout(20);
  const rows = panel.stateFor(page).problems,
    cors = rows.filter((item) => /CORS policy/.test(item.text));
  assert.equal(cors.length, 2, JSON.stringify(rows));
  assert.ok(
    cors.every((item) => item.where === '/' && !item.line),
    JSON.stringify(cors),
  );
  assert.match(rows.find((item) => item.text === 'First line script').where, /:1/);
});
