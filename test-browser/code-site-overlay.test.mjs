// @test-kind contract: the overlay applies a code site's per-folder web files and language page scripts to the online page, as for any other export.
// The overlay treats a .powerpages-site (short-key) export like any other: its per-folder web
// files and its content-pages/<language>/ page sources apply to the online page, using
// the synthetic code site (fixtures/code-site) in a temporary git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSimulator } from '../mirage/server.mjs';
import { proxiedOverlay } from './helpers/proxied-overlay.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner
const FIXTURE = fileURLToPath(new URL('./fixtures/code-site/.powerpages-site/', import.meta.url));
const PAGE_JS = 'web-pages/home/content-pages/en-US/Home.webpage.custom_javascript.js';

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env,
    stdio: 'ignore',
    windowsHide: true,
    timeout: CLI_HANG_GUARD_MS,
  });
}

test("real browser: a code site's per-folder web file and language page script replace the online versions", async (t) => {
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
    if (url.pathname === '/app.js')
      response.writeHead(200, { 'content-type': 'application/javascript' }).end('window.syntheticApp = "online";');
    else if (url.pathname === '/')
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><html><head><title>Code site</title><script>${online}</script><script src="/app.js"></script></head><body><h1 id="welcome">Welcome</h1></body></html>`,
        );
    else response.writeHead(404).end('loopback fixture: missing');
  });
  const { origin, page, faults } = await proxiedOverlay(t, server, {
    work,
    session: { sourceDir: site, siteName: 'code-site-test' },
  });
  await page.goto(origin, { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.syntheticApp), 'from the web file');
  assert.equal(await page.evaluate(() => window.syntheticHome), 'local edit');
  assert.ok(!requests.includes('/app.js'), 'the local web file never reached the online server');
  assert.deepEqual(faults, []);
});

test('a configured build runs on a client route; Lense answers the build file first and the other exported web files', async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-compiled-overlay-')));
  const site = path.join(work, '.powerpages-site');
  fs.cpSync(FIXTURE, site, { recursive: true });
  fs.mkdirSync(path.join(work, 'dist'));
  fs.writeFileSync(
    path.join(work, 'powerpages.config.json'),
    JSON.stringify({ siteName: 'Invented code site', compiledPath: 'dist', defaultLandingPage: 'index.html' }),
  );
  fs.writeFileSync(
    path.join(work, 'dist', 'index.html'),
    '<!doctype html><html><head><title>Compiled app</title><script src="./app.js"></script></head><body><main>Compiled app</main></body></html>',
  );
  fs.writeFileSync(path.join(work, 'dist', 'app.js'), 'window.syntheticApp = "from the build";');
  const app = await createSimulator({ sourceDir: work, watch: false, requirePortalSource: true });
  t.after(() => app.close());
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      requests.push(request.url);
      const upstream = await fetch(app.url + request.url, { redirect: 'manual' });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502).end('loopback build fixture failed');
    }
  });
  const { origin, page, faults } = await proxiedOverlay(t, server, {
    work,
    session: { sourceDir: site, siteName: 'code-site-test' },
  });
  await page.goto(app.url + '/reports/calendar/', { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.syntheticApp), 'from the build');
  assert.equal(await page.evaluate(() => window.Microsoft.Dynamic365.Portal.isSpaSite), 'True');
  const fallback = await page.goto(origin + '/reports/calendar/', { waitUntil: 'load' });
  assert.equal(fallback.status(), 200);
  // The build is what pac pages upload-code-site deploys: its app.js answers ahead of the exported web file of that
  // address (as in Mirage), and a web file the build does not hold is still answered from the export.
  assert.equal(await page.evaluate(() => window.syntheticApp), 'from the build');
  const theme = await page.evaluate(() => fetch('/theme.css').then((response) => response.text()));
  assert.equal(theme, 'body { margin: 0; }\n');
  assert.equal(await page.evaluate(() => window.Microsoft.Dynamic365.Portal.isSpaSite), 'True');
  assert.ok(!requests.includes('/app.js'), 'the local build file never reached the upstream build');
  assert.ok(!requests.includes('/theme.css'), 'the local web file never reached the upstream build');
  assert.deepEqual(faults, []);
});
