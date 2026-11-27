// @test-kind contract+security: a portal page in an out-of-process frame (nested in a cross-site frame) is served by Lense with local changes applied, gets its provenance registry and keeps them across reload, re-navigation and re-insertion; the cross-site frame gets no registry
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { listenOwnedServer } from './helpers/owned-server.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { createFixture, SITE } from '../test/fixture.mjs';

const HEADER = 'web-templates/header/Header.webtemplate.source.html';
const APP = 'web-files/app.js';
const PROCESS_MODELS = {
  isolated: { args: ['--site-per-process'], outOfProcess: true },
  shared: { args: ['--disable-site-isolation-trials'], outOfProcess: false },
};
// What the page reads of Lense's instrumentation in one frame: whether it holds a portal provenance registry, and how
// many response marks are left (the registry removes them all as it reads them).
const instrumentation = (frame) =>
  frame.evaluate(() => ({
    registry: Object.getOwnPropertyNames(window).some((name) => name.startsWith('__paqviloPortal_')),
    marks: document.querySelectorAll('[data-paqvilo-source]').length,
  }));

async function scenario(t, { args, outOfProcess }) {
  const fx = createFixture();
  fx.write(HEADER, '<h1 id="title">Baseline title</h1>\n');
  fx.write(APP, 'window.webFile = "baseline";\n');
  fx.commit();
  const portalPage = `<!doctype html><html><head><title>Nested portal page</title><script src="/scripts/app.js"></script></head><body>${fx.read(HEADER)}<p id="plain">Portal page</p></body></html>`;
  const requests = [];
  const frames = http.createServer((request, response) => response.writeHead(404).end());
  const framePort = new URL(await listenOwnedServer(t, frames)).port;
  const crossSite = `http://localhost:${framePort}/frame`;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    requests.push(pathname);
    if (pathname === '/scripts/app.js')
      return response.writeHead(200, { 'content-type': 'application/javascript' }).end('window.webFile = "baseline";');
    if (pathname === '/')
      return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(portalPage);
    if (pathname === '/top/')
      return response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>Top</title><iframe id="cross" src="${crossSite}" style="width:600px;height:300px"></iframe>`,
        );
    response.writeHead(404).end();
  });
  const origin = await listenOwnedServer(t, server);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-oopif-'));
  let browser, detach;
  const owner = ownedFixture(t);
  for (const close of [() => detach?.(), () => browser?.close()]) owner.add(close);
  owner.remove(() => fx.cleanup());
  owner.remove(() => fs.rmSync(work, { recursive: true, force: true }));
  // Local changes: Lense serves them in place of the portal's.
  fx.write(HEADER, '<h1 id="title">Local title</h1>\n');
  fx.write(APP, 'window.webFile = "local-v1";\n');
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', ...args],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  // The cross-site frame is another site's page; it holds a page of the portal in a frame of its own.
  await context.route(
    (url) => url.port === framePort && url.pathname === '/frame',
    (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>Foreign</title><p id="foreign">Foreign page</p><iframe id="nested" src="${origin}/" style="width:500px;height:200px"></iframe>`,
      }),
  );
  const session = new OverlaySession({
    origin,
    siteName: 'OOPIF fixture',
    envName: 'loopback',
    site: structuredClone(SITE),
    sourceDir: fx.dir,
    stateDir: work,
    sourceMaps: false,
    browser: {},
  });
  const faults = [];
  session.on('fault', (error) => faults.push(error.message));
  const page = await context.newPage();
  detach = await attachSession(context, session);
  const nestedFrame = () => page.frames().find((frame) => frame.parentFrame()?.url() === crossSite);
  // The nested portal frame's next document, once it has loaded.
  const nextNested = async (action) => {
    const navigated = page.waitForEvent('framenavigated', (frame) => frame.parentFrame()?.url() === crossSite);
    await action();
    const frame = await navigated;
    await frame.waitForFunction(() => document.readyState === 'complete');
    return frame;
  };
  const served = async (frame) => {
    assert.equal(await frame.locator('#title').textContent(), 'Local title');
    assert.equal(await frame.evaluate(() => window.webFile), 'local-v1');
    assert.deepEqual(await instrumentation(frame), { registry: true, marks: 0 });
  };

  const first = await nextNested(() => page.goto(`${origin}/top/`, { waitUntil: 'load' }));
  assert.equal(first, nestedFrame());
  // Precondition of the forced process model: the nested portal frame has a target of its own only with isolation.
  let ownTarget = true;
  try {
    await (await context.newCDPSession(first)).detach();
  } catch {
    ownTarget = false;
  }
  assert.equal(ownTarget, outOfProcess);
  // Served by Lense on its first load: the local template and web file, a registry that read and removed its marks.
  await served(first);
  assert.equal(requests.includes('/scripts/app.js'), false, 'the local web file never reached the portal');
  // The cross-site frame is not the portal's: no registry, no marks.
  const cross = page.frames().find((frame) => frame.url() === crossSite);
  assert.deepEqual(await instrumentation(cross), { registry: false, marks: 0 });

  // A reload of the nested frame, a reload of the cross-site frame (the nested frame is created again) and a new
  // nested frame: each document is served and instrumented again.
  const before = requests.filter((item) => item === '/').length;
  await served(await nextNested(() => first.evaluate(() => location.reload())));
  await served(await nextNested(() => cross.evaluate(() => location.reload())));
  await served(
    await nextNested(() =>
      page
        .frames()
        .find((frame) => frame.url() === crossSite)
        .evaluate(() => {
          const old = document.getElementById('nested');
          const replacement = old.cloneNode();
          old.remove();
          document.body.append(replacement);
        }),
    ),
  );
  // Each of those documents came through Lense, which asked the portal for it.
  assert.equal(requests.filter((item) => item === '/').length, before + 3);
  assert.deepEqual(faults, []);
}

test('real browser, site isolation forced: a portal page in an out-of-process frame is served and instrumented by Lense', (t) =>
  scenario(t, PROCESS_MODELS.isolated));

test('real browser, site isolation off: a portal page nested in a cross-site frame is served and instrumented by Lense', (t) =>
  scenario(t, PROCESS_MODELS.shared));
