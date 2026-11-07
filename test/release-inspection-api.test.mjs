import { makeTemporaryDirectorySync } from '../mirage/testing/owned-fixture.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OverlaySession } from '../lense/session.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { createFixture, SITE } from './fixture.mjs';
import { fakeBrowser } from './fake-browser.mjs';

const origin = 'https://portal.example.com';
// Every test reads the same export and keeps its own session state.
const fx = createFixture();
after(() => fx.cleanup());
/** Resolves with the first panel redraw of `page` whose state satisfies `ready`. */
const drawn = (page, ready) =>
  new Promise((resolve) => {
    const evaluate = page.evaluate;
    page.evaluate = async (fn, data) => {
      const result = await evaluate(fn, data);
      if (Array.isArray(data?.items) && ready(data)) {
        page.evaluate = evaluate;
        resolve(data);
      }
      return result;
    };
  });
const response = (body, status = 200) => ({ ok: () => status < 400, status: () => status, json: async () => body });
async function fixture(t, getReport) {
  const stateDir = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-inspection-api-'));
  const browser = fakeBrowser(),
    tab = browser.openTab(origin + '/scripts/');
  browser.context.request.get = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/status'))
      return response({
        site: 'Invented',
        sourceDir: fx.dir,
        format: 'standard',
        revision: 1,
        diagnostics: { total: 0 },
        csrf: 'invented-local-csrf',
      });
    if (parsed.pathname.endsWith('/page-resources')) return getReport(parsed);
    return response({}, 404);
  };
  const session = new OverlaySession({
    origin,
    sourceDir: fx.dir,
    site: structuredClone(SITE),
    sourceMaps: false,
    siteName: 'Invented',
    envName: 'loopback',
    stateDir,
    mirage: true,
  });
  const panel = enablePanel(browser.context, session, { open: async () => null });
  await interceptOrigin(browser.context, origin, session.route);
  t.after(async () => {
    await panel.dispose();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const { token } = panel.stateFor(tab.page);
  // An intercepted request is answered by a Fetch.* command carrying its request ID.
  const pending = new Map(),
    send = tab.cdp.send;
  tab.cdp.send = async (method, params) => {
    const result = await send(method, params);
    if (method.startsWith('Fetch.')) pending.get(params?.requestId)?.();
    return result;
  };
  let sequence = 0;
  const call = async (name, body = {}) => {
    const id = 'api' + ++sequence;
    const answered = Promise.withResolvers();
    const timer = setTimeout(
      () => answered.reject(new Error(`Intercepted request ${id} did not answer within the panel API deadline`)),
      60_000,
    );
    pending.set(id, answered.resolve);
    tab.pause(id, origin + '/__paqvilo/api/' + name, {
      type: 'Fetch',
      method: 'POST',
      headers: { 'x-paqvilo-token': token },
      postData: JSON.stringify(body),
    });
    try {
      await answered.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
    const answers = browser.answers(id);
    assert.equal(answers.length, 1, 'the intercepted API answers once');
    return JSON.parse(Buffer.from(answers[0].body, 'base64').toString());
  };
  return { tab, session, panel, call };
}
const summary = (pathname) => ({ path: pathname, view: 'summary', counts: {}, tables: [] });
const full = () => ({
  path: '/scripts',
  page: null,
  webTemplates: [],
  forms: [],
  tables: [],
  columns: [],
  views: [],
  components: [],
  unresolved: [],
});

test('inspection API preserves summary HTTP errors and rejects malformed full reports with recoverable errors', async (t) => {
  let mode = 'summary-error',
    malformed = null;
  const { tab, session, call } = await fixture(t, (parsed) => {
    if (mode === 'summary-error') return response({ error: 'temporarily unavailable' }, 503);
    if (parsed.searchParams.get('view') === 'summary') return response(summary('/scripts'));
    return response(mode === 'malformed-full' ? malformed : full());
  });
  session.emit('hit', { page: tab.page, navigation: true });
  // Inspect awaits the inspection this navigation started.
  let result = await call('inspect');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Page inspection returned HTTP 503.');
  mode = 'malformed-full';
  for (const value of [null, [], 'invalid', { ...full(), forms: {} }]) {
    malformed = value;
    result = await call('inspect', { refresh: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Page inspection returned an invalid full report.');
  }
  mode = 'healthy';
  result = await call('inspect');
  assert.equal(result.ok, true);
  assert.equal(result.report.path, '/scripts');
});

test('late inspection responses cannot replace the current navigation report or source-open index', async (t) => {
  let release, started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const { tab, session, panel, call } = await fixture(t, async (parsed) => {
    if (parsed.searchParams.get('view') === 'summary') return response(summary(parsed.searchParams.get('path')));
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    return response({
      ...full(),
      webTemplates: [{ name: 'Old page template', relativePath: 'web-templates/header/Header.webtemplate.yml' }],
    });
  });
  session.emit('hit', { page: tab.page, navigation: true });
  const inspecting = call('inspect');
  await pending;
  tab.page.url = () => origin + '/other/';
  const navigated = drawn(tab.page, (state) => state.inspection?.path === '/other/');
  session.emit('hit', { page: tab.page, navigation: true });
  await navigated;
  release();
  const result = await inspecting;
  assert.equal(result.ok, false);
  assert.match(result.error, /page changed during source inspection/i);
  assert.equal(panel.stateFor(tab.page).inspection.path, '/other/');
  assert.equal((await call('open', { rel: 'web-templates/header/Header.webtemplate.yml' })).ok, false);
});

test('runtime-reported roots cannot widen the source editor boundary when no launch roots were supplied', async (t) => {
  const outside = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-untrusted-report-')),
    file = path.join(outside, 'invented.txt');
  fs.writeFileSync(file, 'Invented private file');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const report = { ...full(), sourceRoots: [outside], webTemplates: [{ name: 'Untrusted source', sourceFile: file }] };
  const { tab, session, call } = await fixture(t, () => response(structuredClone(report)));
  session.emit('hit', { page: tab.page, navigation: true });
  const result = await call('inspect');
  assert.equal(result.ok, true);
  assert.equal(result.report.webTemplates[0].ref, undefined);
  assert.equal((await call('open', { rel: `@${path.basename(outside)}/invented.txt` })).ok, false);
});
