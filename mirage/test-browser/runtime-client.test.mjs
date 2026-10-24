import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { connectRuntime } from '../testing.mjs';
import { captureShell } from '../capture-shell.mjs';

test('running-runtime client signs a Playwright context in and out with the configured persona', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-runtime-client-'));
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

test('shell capture owns an anonymous temporary CDP browser and closes it after local capture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-owned-capture-'));
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
      assert.deepEqual(await this.context.cookies(), []);
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
    await assert.rejects(fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) }), /fetch failed/);
  } finally {
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
