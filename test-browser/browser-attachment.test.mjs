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

test('CDP debugger conflicts leave the intended browser untouched and disconnect preserves its pages', { timeout: 60_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-cdp-ownership-'));
  const fixture = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Owned fixture</title><p id="value">original</p>'));
  fixture.on('connect', (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  let owner, attachment;
  t.after(async () => {
    await Promise.allSettled([attachment?.close(), owner?.close()]);
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const debugPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const launch = chromium.launchPersistentContext;
  t.mock.method(chromium, 'launchPersistentContext', function (profile, options) {
    return launch.call(this, profile, { ...options, proxy: { server: origin, bypass: '127.0.0.1,localhost' },
      args: [...options.args, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
  });
  owner = await openBrowser({ configDir: directory, siteName: 'fixture', envName: 'local', browser: {
    channel: process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium'),
    profileDir: 'profiles', headless: true,
  } }, { debugPort });
  const page = owner.context.pages()[0];
  await page.goto(origin);
  const cfg = { browser: { cdpUrl: `http://127.0.0.1:${debugPort}`, debugPort } };
  await assert.rejects(openBrowser(cfg), /browser.debugPort.*cannot be combined with browser.cdpUrl/);
  assert.equal(await page.textContent('#value'), 'original');
  attachment = await openBrowser(cfg, { debugPort: 0 });
  assert.equal(attachment.attached, true);
  const attachedPage = attachment.context.pages().find(candidate => candidate.url() === page.url());
  assert.ok(attachedPage, 'the transport attaches to the intended browser');
  await attachedPage.evaluate(() => { document.querySelector('#value').textContent = 'attached'; });
  await attachment.close();
  attachment = null;
  assert.equal(await page.textContent('#value'), 'attached', 'disconnect keeps the original page alive');
  await page.goto(origin);
  assert.equal(await page.textContent('#value'), 'original', 'the browser remains usable after detachment');
});
