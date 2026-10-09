// The overlay treats a .powerpages-site (short-key) export like any other: its per-folder web
// files and its content-pages/<language>/ page sources apply to the online page. Loopback only:
// the synthetic code site (fixtures/code-site, NOTICE.md) in a temporary git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { SITE } from '../test/fixture.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/code-site/.powerpages-site/', import.meta.url));
const PAGE_JS = 'web-pages/home/content-pages/en-US/Home.webpage.custom_javascript.js';

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd, env, stdio: 'ignore', windowsHide: true, timeout: 30_000 });
}

test('real browser: a code site\'s per-folder web file and language page script replace the online versions', { timeout: 120_000 }, async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-code-site-')));
  const site = path.join(work, 'site');
  fs.cpSync(FIXTURE, site, { recursive: true });
  git(site, 'init', '-q');
  git(site, 'add', '-A');
  git(site, '-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'baseline');
  // The online page carries the committed page script; the local copy is edited.
  const online = fs.readFileSync(path.join(site, PAGE_JS), 'utf8');
  fs.writeFileSync(path.join(site, PAGE_JS), 'window.syntheticHome = "local edit";\n');
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === '/app.js') response.writeHead(200, { 'content-type': 'application/javascript' }).end('window.syntheticApp = "online";');
    else if (url.pathname === '/') response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><title>Code site</title><script>${online}</script><script src="/app.js"></script></head><body><h1 id="welcome">Welcome</h1></body></html>`);
    else response.writeHead(404).end('loopback fixture: missing');
  });
  server.on('connect', (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context, detach;
  t.after(async () => {
    await detach?.();
    await context?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    serviceWorkers: 'block',
    proxy: { server: origin, bypass: '127.0.0.1,localhost' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-domain-reliability', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  context.setDefaultTimeout(15_000);
  const session = new OverlaySession({
    sourceDir: site, origin, site: structuredClone(SITE),
    siteName: 'code-site-test', envName: 'isolated', stateDir: path.join(work, 'state'), browser: { bypassCSP: false },
  });
  const faults = [];
  session.on('fault', (error) => faults.push(error.message));
  detach = await attachSession(context, session);
  const page = context.pages()[0];
  await page.goto(origin, { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.syntheticApp), 'from the web file');
  assert.equal(await page.evaluate(() => window.syntheticHome), 'local edit');
  assert.ok(!requests.includes('/app.js'), 'the local web file never reached the online server');
  assert.deepEqual(faults, []);
});
