// @test-kind contract: running-runtime session clients and owned shell-capture lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { connectRuntime } from '../testing.mjs';
import { captureShell } from '../capture-shell.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const HANG_GUARD_MS = 120_000; // hang guard only: Playwright's 30 s default fails a loaded machine

test('running-runtime client signs a Playwright context in and out with the configured persona', async () => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-runtime-client-'));
  let simulator, browser;
  try {
    await fs.writeFile(path.join(root, 'website.yml'), 'adx_name: Invented\nadx_websiteid: invented\n');
    simulator = await createSimulator({
      sourceDir: root,
      watch: false,
      initial: {
        mappings: { contact: { idColumn: 'contactid' } },
        tables: { contact: [{ contactid: 'synthetic', fullname: 'Synthetic' }] },
        simulator: { identity: { contactId: 'synthetic', roles: ['Tester'], roleSource: 'override' } },
      },
    });
    browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    const context = await browser.newContext();
    try {
      const client = await connectRuntime({ origin: simulator.url });
      await client.signIn(context, { configuredPersona: true });
      let session = await (await context.request.get(simulator.url + '/_sim/api/session')).json();
      assert.equal(session.contactId, 'synthetic');
      assert.deepEqual(session.roles, ['Tester']);
      await client.signOut(context);
      session = await (await context.request.get(simulator.url + '/_sim/api/session')).json();
      assert.equal(session.signedIn, false);
    } finally {
      await context.close();
    }
  } finally {
    try {
      await browser?.close();
      await simulator?.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

// @test-kind contract+security: the owned anonymous browser starts without cookies and its CDP listener closes after capture.
test('shell capture owns an anonymous temporary CDP browser and closes it after local capture', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-owned-capture-'));
  const echo = http.createServer((request, response) => {
    if (request.url === '/issue') response.setHeader('set-cookie', 'invented-session=owned; Path=/; HttpOnly');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ cookie: request.headers.cookie ?? null, authorization: request.headers.authorization ?? null }),
    );
  });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        echo.closeAllConnections();
        echo.close(resolve);
      }),
  );
  const echoUrl = `http://127.0.0.1:${echo.address().port}`;
  let attached, endpoint;
  const bridge = {
    origin: 'https://invented.example.test',
    context: null,
    configure(value) {
      this.origin = value.origin;
    },
    status() {
      return { connected: Boolean(this.context), origin: this.origin };
    },
    async connect(cdp) {
      endpoint = cdp;
      attached = await chromium.connectOverCDP(cdp);
      assert.equal(attached.contexts().length, 1);
      this.context = attached.contexts()[0];
      this.context.setDefaultTimeout(HANG_GUARD_MS);
      this.context.setDefaultNavigationTimeout(HANG_GUARD_MS);
      // Preserve the zero-cookie assertion without dumping credentials if Edge implicitly signs the profile in.
      assert.equal((await this.context.cookies()).length, 0, 'the owned capture browser must begin without cookies');
      assert.deepEqual(await (await this.context.request.get(echoUrl)).json(), { cookie: null, authorization: null });
      await this.context.request.get(echoUrl + '/issue');
      assert.deepEqual(await (await this.context.request.get(echoUrl)).json(), {
        cookie: 'invented-session=owned',
        authorization: null,
      });
      return this.status();
    },
    async close() {
      await attached?.close();
      attached = null;
      this.context = null;
    },
    async request(route) {
      return route === '/'
        ? {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: Buffer.from(
              '<html><head><link rel="stylesheet" href="/theme.css"><script src="/jquery.min.js"></script></head><body>Invented</body></html>',
            ),
          }
        : {
            status: 200,
            headers: { 'content-type': route.endsWith('.css') ? 'text/css' : 'text/javascript' },
            body: Buffer.from(route.endsWith('.css') ? 'body{color:blue}' : 'window.jQuery={};'),
          };
    },
  };
  try {
    await fs.mkdir(path.join(root, 'portal/web-pages'), { recursive: true });
    await fs.writeFile(path.join(root, 'portal/website.yml'), 'adx_name: Invented\nadx_websiteid: invented\n');
    await fs.writeFile(
      path.join(root, 'portal/web-pages/home.webpage.yml'),
      'adx_name: Home\nadx_webpageid: home\nadx_partialurl: /\n',
    );
    await fs.writeFile(
      path.join(root, 'paqvilo.config.yml'),
      'sourceRoot: .\nsites:\n  invented:\n    source: portal\n    environments: { dev: https://invented.example.test }\n    mirage: { port: 0 }\n',
    );
    const report = await captureShell({
      config: path.join(root, 'paqvilo.config.yml'),
      site: 'invented',
      createLocalSimulator: (options) => createSimulator({ ...options, liveBridge: bridge }),
    });
    assert.equal(report.complete, true);
    assert.equal(bridge.context, null);
    // The owned browser's CDP endpoint is gone: its port refuses connections.
    await assert.rejects(fetch(endpoint + '/json/version'), /fetch failed/);
  } finally {
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
