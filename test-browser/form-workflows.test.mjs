// Synthetic form workflows run only against disposable local sources and a loopback server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { interceptOrigin } from '../lense/intercept.mjs';
import { attachSession } from '../lense/browser.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { watchSources } from '../lense/commands/dev.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { componentContent } from '../lense/portal-model.mjs';
import { createFixture, SITE } from '../test/fixture.mjs';

const evidenceDir = new URL('../.paqvilo/extended-round/', import.meta.url);
const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
const xmlEscape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const component = (id, type, content) => `<powerpagecomponent powerpagecomponentid="${id}"><content>${xmlEscape(JSON.stringify(content))}</content><name>Fixture ${id}</name><powerpagecomponenttype>${type}</powerpagecomponenttype></powerpagecomponent>`;

async function localBrowser(t, handler) {
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith('/')) return response.writeHead(403).end();
    Promise.resolve(handler(request, response)).catch((error) => response.writeHead(500).end(error.message));
  });
  server.on('connect', (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel, headless: true,
    proxy: { server: origin, bypass: '127.0.0.1,localhost' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  return { context, page, origin };
}

test('interception preserves multipart file uploads, empty files and Unicode form values exactly once', { timeout: 45_000 }, async (t) => {
  const received = [];
  const { context, page, origin } = await localBrowser(t, async (request, response) => {
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push({ headers: request.headers, bytes: Buffer.concat(chunks) });
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<form action="/upload" method="post" enctype="multipart/form-data"><input type="file" name="uploads" multiple><textarea name="notes"></textarea><button>Upload fixture</button></form>');
  });
  const detach = await interceptOrigin(context, origin, async (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ response: await route.fetch() });
    return route.fallback();
  });
  t.after(detach);
  await page.goto(origin, { waitUntil: 'load' });
  const binary = Buffer.from(Array.from({ length: 24_000 }, (_, index) => index % 256));
  await page.locator('input[type=file]').setInputFiles([
    { name: 'fixture.bin', mimeType: 'application/octet-stream', buffer: binary },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
  ]);
  const notes = 'Synthetic résumé: λ & + = 🌍';
  await page.locator('textarea').fill(notes);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.locator('button').click()]);
  assert.equal(received.length, 1, 'a file submission is never replayed');
  assert.match(received[0].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.ok(received[0].bytes.includes(binary), 'all file bytes, including NUL and non-UTF8 data, arrive intact');
  assert.ok(received[0].bytes.includes(Buffer.from('filename="empty.txt"')));
  assert.ok(received[0].bytes.includes(Buffer.from(notes)));
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(new URL('multipart.json', evidenceDir), JSON.stringify({ submissions: received.length, binaryBytes: binary.length, bodyBytes: received[0].bytes.length, emptyFile: true, unicodeText: true }, null, 2));
});

for (const layout of ['classic', 'enhanced']) test(`${layout} form sources edit and recover through the real watcher`, { timeout: 90_000 }, async (t) => {
  const fx = createFixture();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-form-workflows-'));
  const sourceDir = layout === 'enhanced' ? fx.file('enhanced-source') : fx.dir;
  let watcher;
  let detach;
  t.after(async () => { await watcher?.close(); await detach?.(); fx.cleanup(); fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }); });
  const source = (kind, id, rel) => ({ kind, id, rel, file: path.join(sourceDir, rel), code: `document.getElementById("${id}").textContent = "${id} baseline";\nwindow.fixtureExecutions = window.fixtureExecutions || {};\nwindow.fixtureExecutions["${id}"] = (window.fixtureExecutions["${id}"] || 0) + 1;\n` });
  let sources;
  if (layout === 'classic') {
    sources = [source('basic-form-js', 'basic', 'basic-forms/contact/Contact.basicform.custom_javascript.js'), source('advanced-form-step-js', 'advanced', 'advanced-forms/application/steps/details/Details.advancedformstep.custom_javascript.js'), source('list-js', 'list', 'lists/records/Records.list.custom_javascript.js')];
    for (const item of sources) fx.write(item.rel, item.code);
  } else {
    const form = source('basic-form-js', 'basic', 'powerpagecomponents/form/powerpagecomponent.xml');
    form.field = 'customjavascript';
    form.rel += '#customjavascript';
    fx.write('enhanced-source/powerpagecomponents/home/powerpagecomponent.xml', component('home', 2, { isroot: true, partialurl: '/', entityform: 'form', customjavascript: 'window.fixturePage = "baseline";', customcss: '#basic { color: rgb(10, 20, 30); }' }));
    fs.mkdirSync(path.dirname(form.file), { recursive: true });
    fs.writeFileSync(form.file, component('form', 15, { customjavascript: form.code, entityname: 'fixture_only', settings: { preserved: true } }));
    sources = [form];
  }
  fx.commit();
  const methods = [];
  const html = `<!doctype html><html><head><title>${layout} forms fixture</title><style>#basic { color: rgb(10, 20, 30); }</style></head><body><h1>Synthetic ${layout} workflow</h1>${sources.map((item) => `<p id="${item.id}"></p><script>${item.code}</script>`).join('')}<script>window.fixturePage = "baseline";</script></body></html>`;
  const { context, page, origin } = await localBrowser(t, (request, response) => { methods.push(request.method); response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html); });
  const session = await OverlaySession.create({ sourceDir, origin, site: { ...structuredClone(SITE), scope: 'changed' }, sourceMaps: true, siteName: layout, envName: 'loopback', stateDir: work, browser: {} });
  assert.equal(session.model.format, layout);
  const faults = [];
  const pageErrors = [];
  session.on('fault', (error) => faults.push(error.message));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  detach = await attachSession(context, session);
  await page.goto(origin, { waitUntil: 'load' });
  const watcherLogs = [];
  watcher = watchSources(session, context, { log: (line) => watcherLogs.push(line) });
  await once(watcher, 'ready');
  const observations = [];
  const save = async (file, change) => {
    const refreshed = once(session, 'refreshed', { signal: AbortSignal.timeout(25_000) });
    change();
    const [event] = await refreshed;
    assert.ok(event.files.includes(path.resolve(file)), 'the watcher observed the edited physical source');
    await page.waitForLoadState('load');
  };
  for (const item of sources) {
    await save(item.file, () => editSource(item, (text) => text.replace(`${item.id} baseline`, `${item.id} edited`)));
    await page.waitForFunction(({ id }) => document.getElementById(id).textContent === `${id} edited`, { id: item.id }).catch(async (error) => {
      t.diagnostic(JSON.stringify({ layout, faults, pageErrors, watcherLogs, changed: [...session.changedFiles], unsupported: session.rewriter.unsupported, hits: session.pageHits.get(page), html: await page.content(), source: fs.readFileSync(item.file, 'utf8') }));
      throw error;
    });
    const hit = session.pageHits.get(page)?.flatMap((entry) => entry.sources ?? []).find((entry) => entry.rel === item.rel);
    assert.equal(hit?.kind, item.kind);
    assert.equal(await page.evaluate((id) => window.fixtureExecutions[id], item.id), 1, 'custom script executes once in the refreshed document');
    observations.push({ kind: item.kind, rel: item.rel, executed: true });
  }
  if (layout === 'enhanced') {
    const pageFile = path.join(sourceDir, 'powerpagecomponents/home/powerpagecomponent.xml');
    await save(pageFile, () => editSource({ path: pageFile, field: 'customcss' }, () => '#basic { color: rgb(40, 50, 60); }'));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('basic')).color === 'rgb(40, 50, 60)');
    assert.equal(await page.evaluate(() => window.fixturePage), 'baseline', 'other source fields still execute');
    const form = sources[0];
    const valid = fs.readFileSync(form.file, 'utf8');
    assert.deepEqual(componentContent(valid).settings, { preserved: true });
    assert.equal(componentContent(valid).entityname, 'fixture_only');
    await save(form.file, () => fs.writeFileSync(form.file, valid.replace('customjavascript', 'customjavascript"')));
    await page.waitForFunction(() => document.getElementById('basic').textContent === 'basic baseline');
    assert.ok(session.rewriter.unsupported.some((entry) => entry.rel.startsWith('powerpagecomponents/form/') && /source field.*metadata/.test(entry.reason)), 'invalid mid-save XML is diagnosed');
    await save(form.file, () => fs.writeFileSync(form.file, valid));
    await page.waitForFunction(() => document.getElementById('basic').textContent === 'basic edited');
    assert.ok(!session.rewriter.unsupported.some((entry) => entry.rel.startsWith('powerpagecomponents/form/')), 'repair recovers without restarting dev');
    observations.push({ kind: 'page-css', executed: true, siblingFieldsPreserved: true, invalidSaveRecovered: true });
  }
  assert.deepEqual(faults, []);
  assert.deepEqual(pageErrors, []);
  assert.ok(methods.every((method) => method === 'GET'), 'watcher scenarios send only GET to the synthetic fixture');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(new URL(`${layout}-workflows.json`, evidenceDir), JSON.stringify({ layout, observations, faults, pageErrors, documentReads: methods.length }, null, 2));
  await page.screenshot({ path: fileURLToPath(new URL(`${layout}-workflows.png`, evidenceDir)) });
});
