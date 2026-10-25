import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { openBrowser } from '../lense/browser.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';

async function lateInspectionFixture(t, html, cleanup) {
  let browser;
  const server = http.createServer((_request, response) =>
    response.writeHead(200, { 'content-type': 'text/html' }).end(html),
  );
  t.after(async () => {
    await cleanup();
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  return { browser, origin };
}

test(
  'CDP debugger conflicts leave the intended browser untouched and disconnect preserves its pages',
  { timeout: 60_000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-cdp-ownership-'));
    const fixture = http.createServer((_request, response) =>
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>Owned fixture</title><p id="value">original</p>'),
    );
    fixture.on('connect', (_request, socket) => {
      socket.on('error', () => {});
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    let owner, attachment;
    t.after(async () => {
      await Promise.allSettled([attachment?.close(), owner?.close()]);
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const reservation = net.createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const debugPort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const launch = chromium.launchPersistentContext;
    t.mock.method(chromium, 'launchPersistentContext', function (profile, options) {
      return launch.call(this, profile, {
        ...options,
        proxy: { server: origin, bypass: '127.0.0.1,localhost' },
        args: [
          ...options.args,
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        ],
      });
    });
    owner = await openBrowser(
      {
        configDir: directory,
        siteName: 'fixture',
        envName: 'local',
        browser: {
          channel: process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium'),
          profileDir: 'profiles',
          headless: true,
        },
      },
      { debugPort },
    );
    const page = owner.context.pages()[0];
    await page.goto(origin);
    const cfg = { browser: { cdpUrl: `http://127.0.0.1:${debugPort}`, debugPort } };
    await assert.rejects(openBrowser(cfg), /browser.debugPort.*cannot be combined with browser.cdpUrl/);
    assert.equal(await page.textContent('#value'), 'original');
    attachment = await openBrowser(cfg, { debugPort: 0 });
    assert.equal(attachment.attached, true);
    const attachedPage = attachment.context.pages().find((candidate) => candidate.url() === page.url());
    assert.ok(attachedPage, 'the transport attaches to the intended browser');
    await attachedPage.evaluate(() => {
      document.querySelector('#value').textContent = 'attached';
    });
    await attachment.close();
    attachment = null;
    assert.equal(await page.textContent('#value'), 'attached', 'disconnect keeps the original page alive');
    await page.goto(origin);
    assert.equal(await page.textContent('#value'), 'original', 'the browser remains usable after detachment');
  },
);

test(
  'late inspection preserves an edited initial document and manual reload applies local sources',
  { timeout: 30000 },
  async (t) => {
    let detach, release;
    const { browser, origin } = await lateInspectionFixture(
      t,
      '<!doctype html><input id="draft"><div id="editor" contenteditable>default</div>',
      async () => {
        release?.();
        await detach?.();
      },
    );
    for (const kind of ['text', 'contenteditable', 'shadow', 'open-shadow']) {
      const editor = kind === 'contenteditable',
        shadow = kind === 'shadow' || kind === 'open-shadow';
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let entered, reported;
      const installing = new Promise((resolve) => {
        entered = resolve;
      });
      const warning = new Promise((resolve) => {
        reported = resolve;
      });
      let documents = 0;
      detach = await interceptOrigin(
        context,
        origin,
        (route) => {
          if (route.request().isNavigationRequest()) documents++;
          return route.fulfill({
            headers: { 'content-type': 'text/html' },
            body: '<!doctype html><input id="draft"><script>window.localPreview = true</script>',
          });
        },
        {
          async onAttach({ configure }) {
            entered();
            await gate;
            await configure('Page.enable');
            await configure('Page.addScriptToEvaluateOnNewDocument', { source: 'window.inspectionReady = true;' });
          },
          onError: reported,
        },
      );
      const page = await context.newPage();
      await installing;
      await page.goto(origin);
      if (shadow) {
        await page.evaluate(
          (mode) => {
            const host = document.createElement('div'),
              input = document.createElement('input');
            host.id = 'fixture-shadow';
            document.body.appendChild(host);
            host.attachShadow({ mode }).appendChild(input);
            window.fixtureShadowInput = input;
            input.focus();
          },
          kind === 'open-shadow' ? 'open' : 'closed',
        );
        if (kind === 'open-shadow') await page.locator('#fixture-shadow input').fill('keep my draft');
        else await page.keyboard.type('keep my draft');
      } else await page.locator(editor ? '#editor' : '#draft').fill('keep my draft');
      if (editor || shadow) await page.locator('#draft').focus();
      release();
      const diagnostic = await warning;
      assert.equal(diagnostic.code, 'reload_required');
      assert.doesNotMatch(diagnostic.message, /keep my draft|127\.0\.0\.1/);
      assert.equal(page.isClosed(), false);
      assert.equal(
        shadow
          ? await page.evaluate(() => window.fixtureShadowInput.value)
          : await page.locator(editor ? '#editor' : '#draft')[editor ? 'textContent' : 'inputValue'](),
        'keep my draft',
      );
      assert.equal(documents, 0, 'draft preservation does not start a corrective navigation');
      await page.goto(origin);
      assert.equal(documents, 1, 'manual reload restores the complete local overlay');
      assert.equal(await page.evaluate(() => window.inspectionReady && window.localPreview), true);
      await detach();
      detach = null;
      await context.close();
    }
  },
);

test('a same-address navigation supersedes a pending late-document repair', { timeout: 30000 }, async (t) => {
  let detach, release;
  const { browser, origin } = await lateInspectionFixture(t, '<!doctype html><input id="draft">', async () => {
    release?.();
    await detach?.();
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(origin);
  let entered;
  const pending = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const attach = context.newCDPSession.bind(context);
  t.mock.method(context, 'newCDPSession', async (...args) => {
    const cdp = await attach(...args),
      send = cdp.send.bind(cdp);
    cdp.send = async (method, params) => {
      if (
        method === 'Runtime.callFunctionOn' &&
        params.functionDeclaration?.startsWith('function repairLateDocument')
      ) {
        entered();
        await gate;
      }
      return send(method, params);
    };
    return cdp;
  });
  let documents = 0;
  const diagnostics = [];
  const attaching = interceptOrigin(
    context,
    origin,
    (route) => {
      if (route.request().isNavigationRequest()) documents++;
      return route.fulfill({ headers: { 'content-type': 'text/html' }, body: '<!doctype html><input id="draft">' });
    },
    { onError: (error) => diagnostics.push(error) },
  );
  await pending;
  await page.goto(origin);
  await page.locator('#draft').fill('new document draft');
  release();
  detach = await attaching;
  assert.equal(documents, 1, 'the obsolete repair cannot navigate the replacement document');
  assert.deepEqual(diagnostics, [], 'an intercepted replacement needs no manual reload warning');
  assert.equal(await page.locator('#draft').inputValue(), 'new document draft');
});

test('late repair distinguishes pristine native controls from edited form state', { timeout: 30000 }, async (t) => {
  let detach;
  const html =
    '<!doctype html><input id="text"><input id="check" type="checkbox"><input id="range" type="range"><input id="color" type="color"><input id="file" type="file"><div id="editor" contenteditable>default</div><textarea id="notes">default</textarea><select id="pick"><option>A</option><option>B</option></select><select size="2"><option>A</option><option>B</option></select>';
  const { browser, origin } = await lateInspectionFixture(t, html, () => detach?.());
  const edits = [
    ['pristine controls', null],
    [
      'customized control',
      (page) =>
        page.evaluate(() => {
          window.customConstructed = 0;
          customElements.define(
            'draft-input',
            class extends HTMLInputElement {
              constructor() {
                super();
                window.customConstructed++;
              }
            },
            { extends: 'input' },
          );
          document.body.appendChild(document.createElement('input', { is: 'draft-input' }));
        }),
    ],
    ['text', (page) => page.locator('#text').fill('synthetic draft')],
    ['checkbox', (page) => page.locator('#check').check()],
    ['range', (page) => page.locator('#range').fill('70')],
    ['color', (page) => page.locator('#color').fill('#123456')],
    ['textarea', (page) => page.locator('#notes').fill('synthetic draft')],
    ['contenteditable', (page) => page.locator('#editor').fill('synthetic draft')],
    ['select', (page) => page.locator('#pick').selectOption({ label: 'B' })],
    [
      'file',
      (page) =>
        page
          .locator('#file')
          .setInputFiles({ name: 'invented.txt', mimeType: 'text/plain', buffer: Buffer.from('invented fixture') }),
    ],
  ];
  for (const [label, edit] of edits) {
    const context = await browser.newContext({ serviceWorkers: 'block' }),
      page = await context.newPage();
    await page.goto(origin);
    await edit?.(page);
    let documents = 0;
    const diagnostics = [];
    detach = await interceptOrigin(
      context,
      origin,
      (route) => {
        if (route.request().isNavigationRequest()) documents++;
        return route.fulfill({
          headers: { 'content-type': 'text/html' },
          body: html + '<script>window.localPreview=true</script>',
        });
      },
      { onError: (error) => diagnostics.push(error) },
    );
    if (edit) {
      assert.equal(documents, 0, label + ' must not be discarded by corrective navigation');
      assert.equal(diagnostics.length, 1, label);
      assert.equal(diagnostics[0].code, 'reload_required', label);
    } else {
      await page.waitForFunction(() => window.localPreview === true);
      assert.equal(documents, 1, 'pristine native defaults retain automatic overlay application');
      assert.deepEqual(diagnostics, []);
    }
    if (label === 'customized control')
      assert.equal(
        await page.evaluate(() => window.customConstructed),
        1,
        'inspection never invokes an application constructor',
      );
    await detach();
    detach = null;
    await context.close();
  }
});
