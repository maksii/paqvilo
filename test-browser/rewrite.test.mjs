// Browser semantics proof with fulfilled loopback requests and no catalogue/environment access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { withFileSourceMap } from '../lense/source-map.mjs';

test('real browser: HTML recovery, dynamic imports and existing source-map directives retain their semantics', { timeout: 45_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rewrite-browser-'));
  const file = path.join(dir, 'page.js');
  let browser;
  t.after(async () => {
    await browser?.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const origin = 'http://127.0.0.1:9';
  const seen = [];
  let html = '';
  let rewriter;
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    seen.push(url.pathname);
    if (url.pathname === '/chapter/') return route.fulfill({ contentType: 'text/html', body: rewriter ? rewriter.rewrite(html, '/chapter/').html : html });
    if (url.pathname === '/__paqvilo/inline/page.js') return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(file, 'utf8') });
    if (url.pathname === '/chapter/changed.js') return route.fulfill({ contentType: 'application/javascript', body: 'export default 42;' });
    return route.fulfill({ status: 404, body: 'unmapped fixture request' });
  });
  const configure = (before, after, sourceMaps = false) => {
    fs.writeFileSync(file, after);
    rewriter = new HtmlRewriter({
      model: { sourceDir: dir, inlineSources: [{ rel: 'page.js', file, kind: 'page-js', mode: 'block', tag: 'script', pageUrl: '/chapter/' }] },
      site: { inline: { kinds: ['page-js'] } },
      baseline: { changedFiles: () => new Set([file]), show: () => before }, sourceMaps,
    });
  };
  configure('window.probe = 1;', 'window.probe = 2;');
  for (const [prefix, attrs, closing] of [
    ['<!-->', '', '</script ignored>'], ['<!--->', '', '</script/>'],
    ['<!-- comment --!>', 'type="text&#x2f;javascript"', '</script>'],
    ['<?probe <script>window.probe = 1;</script>', 'type="application/x-javascript"', '</script>'],
    ['<script.foo>window.probe = 1;</script.foo>', 'type="text/javascript1.5"', '</script>'],
  ]) {
    html = `${prefix}<script ${attrs}>window.probe = 1;${closing}`;
    await page.goto(`${origin}/chapter/`);
    assert.equal(await page.evaluate(() => window.probe), 2);
  }
  const escaped = "const a = '<!--<script>';\nconst b = '</script>';\nwindow.probe = 1;";
  configure(escaped, escaped.replace('probe = 1', 'probe = 2'));
  html = `<script>${escaped}</script>`;
  await page.goto(`${origin}/chapter/`);
  assert.equal(await page.evaluate(() => window.probe), 2);

  configure('window.probe = 1;', 'window.probe = 4;', true);
  html = '<script integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" async defer>window.probe = 1;</script><script>window.afterProbe = window.probe;</script>';
  await page.goto(`${origin}/chapter/`);
  assert.equal(await page.evaluate(() => window.probe), 4);
  assert.equal(await page.evaluate(() => window.afterProbe), 4);

  configure('window.probe = 1;', 'const label = "</script>"; window.probe = 5;');
  html = '<script>window.probe = 1;</script><p id="after">After</p>';
  await page.goto(`${origin}/chapter/`);
  assert.equal(await page.evaluate(() => window.probe), 1);
  assert.equal(await page.locator('#after').textContent(), 'After');
  assert.match(rewriter.rewrite(html, '/chapter/').notes[0].reason, /HTML closing boundary/);

  configure('window.ready = import("./module.js");', 'window.ready = import("./changed.js");', true);
  html = '<script>window.ready = import("./module.js");</script>';
  await page.goto(`${origin}/chapter/`);
  assert.equal(await page.evaluate(async () => (await window.ready).default), 42);
  assert.ok(seen.includes('/chapter/changed.js'));
  assert.equal(seen.filter((url) => url.startsWith('/__paqvilo/inline/')).length, 1);

  const cdp = await context.newCDPSession(page);
  await cdp.send('Debugger.enable');
  const maps = [];
  cdp.on('Debugger.scriptParsed', (event) => { if (event.sourceMapURL) maps.push(event.sourceMapURL); });
  rewriter = null;
  const mapped = withFileSourceMap(Buffer.from('window.probe = 3; //# sourceMappingURL=original.map\n'), file);
  html = `<script>${mapped}</script>`;
  await page.goto(`${origin}/chapter/`);
  assert.ok(maps.includes('original.map'));
  assert.ok(!maps.some((map) => map.startsWith('data:')));
  await cdp.detach();
});
