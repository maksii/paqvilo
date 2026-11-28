// @test-kind compatibility: browser parsing and source-map semantics for rewritten portal documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeTemporaryDirectorySync, ownedFixture, removeFixtureDirectory } from '../mirage/testing/owned-fixture.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { withFileSourceMap } from '../lense/source-map.mjs';
import { launchRenderingBrowser, renderingBrowserName } from './helpers/lense-rendering-browser.mjs';
import { listenOwnedServer } from './helpers/owned-server.mjs';

async function rewriteFixture(t) {
  const owner = ownedFixture(t);
  const dir = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'pp-rewrite-browser-'));
  const file = path.join(dir, 'page.js');
  let browser;
  owner.add(() => browser?.close());
  owner.remove(() => removeFixtureDirectory(dir));
  const origin = await listenOwnedServer(
    t,
    http.createServer((_, response) => response.writeHead(404).end()),
  );
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await launchRenderingBrowser({
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const seen = [];
  let html = '';
  let rewriter;
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    seen.push(url.pathname);
    if (url.pathname === '/chapter/')
      return route.fulfill({
        contentType: 'text/html',
        body: rewriter ? rewriter.rewrite(html, '/chapter/').html : html,
      });
    if (url.pathname === '/__paqvilo/inline/page.js')
      return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(file, 'utf8') });
    if (url.pathname === '/chapter/changed.js')
      return route.fulfill({ contentType: 'application/javascript', body: 'export default 42;' });
    return route.fulfill({ status: 404, body: 'unmapped fixture request' });
  });
  const configure = (before, after, sourceMaps = false) => {
    fs.writeFileSync(file, after);
    rewriter = new HtmlRewriter({
      model: {
        sourceDir: dir,
        inlineSources: [{ rel: 'page.js', file, kind: 'page-js', mode: 'block', tag: 'script', pageUrl: '/chapter/' }],
      },
      site: { inline: { kinds: ['page-js'] } },
      baseline: { changedFiles: () => new Set([file]), show: () => before },
      sourceMaps,
    });
  };
  return {
    page,
    context,
    file,
    seen,
    configure,
    rewrite: () => rewriter.rewrite(html, '/chapter/'),
    navigate: (document) => {
      html = document;
      return page.goto(`${origin}/chapter/`);
    },
  };
}

test('rewritten HTML recovery, source-map scripts and dynamic imports retain their browser semantics', async (t) => {
  const { page, seen, configure, rewrite, navigate } = await rewriteFixture(t);
  configure('window.probe = 1;', 'window.probe = 2;');
  for (const [prefix, attrs, closing] of [
    ['<!-->', '', '</script ignored>'],
    ['<!--->', '', '</script/>'],
    ['<!-- comment --!>', 'type="text&#x2f;javascript"', '</script>'],
    ['<?probe <script>window.probe = 1;</script>', 'type="application/x-javascript"', '</script>'],
    ['<script.foo>window.probe = 1;</script.foo>', 'type="text/javascript1.5"', '</script>'],
  ]) {
    await navigate(`${prefix}<script ${attrs}>window.probe = 1;${closing}`);
    assert.equal(await page.evaluate(() => window.probe), 2);
  }
  const escaped = "const a = '<!--<script>';\nconst b = '</script>';\nwindow.probe = 1;";
  configure(escaped, escaped.replace('probe = 1', 'probe = 2'));
  await navigate(`<script>${escaped}</script>`);
  assert.equal(await page.evaluate(() => window.probe), 2);

  configure('window.probe = 1;', 'window.probe = 4;', true);
  await navigate(
    '<script integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" async defer>window.probe = 1;</script><script>window.afterProbe = window.probe;</script>',
  );
  assert.equal(await page.evaluate(() => window.probe), 4);
  assert.equal(await page.evaluate(() => window.afterProbe), 4);

  configure('window.probe = 1;', 'const label = "</script>"; window.probe = 5;');
  await navigate('<script>window.probe = 1;</script><p id="after">After</p>');
  assert.equal(await page.evaluate(() => window.probe), 1);
  assert.equal(await page.locator('#after').textContent(), 'After');
  assert.match(rewrite().notes[0].reason, /HTML closing boundary/);

  configure('window.ready = import("./module.js");', 'window.ready = import("./changed.js");', true);
  await navigate('<script>window.ready = import("./module.js");</script>');
  assert.equal(await page.evaluate(async () => (await window.ready).default), 42);
  assert.ok(seen.includes('/chapter/changed.js'));
  assert.equal(seen.filter((url) => url.startsWith('/__paqvilo/inline/')).length, 1);
});

if (renderingBrowserName === 'chromium')
  test('Chromium debugger retains the existing source-map directive', async (t) => {
    const { page, context, file, navigate } = await rewriteFixture(t);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Debugger.enable');
    const maps = [];
    cdp.on('Debugger.scriptParsed', (event) => {
      if (event.sourceMapURL) maps.push(event.sourceMapURL);
    });
    const mapped = withFileSourceMap(Buffer.from('window.probe = 3; //# sourceMappingURL=original.map\n'), file);
    await navigate(`<script>${mapped}</script>`);
    assert.ok(maps.includes('original.map'));
    assert.ok(!maps.some((map) => map.startsWith('data:')));
    await cdp.detach();
  });
