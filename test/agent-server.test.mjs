import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startAgentServer, redactText, redactUrl } from '../lense/agent-server.mjs';

async function fixture(t, options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-agent-api-'));
  const origin = 'https://portal.example';
  let address = `${origin}/chapter/?token=secret#private`;
  let closed = false;
  let stops = 0;
  const calls = [];
  const frame = { url: () => address };
  const navigation = (method, url = address) => ({ isNavigationRequest: () => true, frame: () => frame, url: () => url, method: () => method, resourceType: () => 'document' });
  const page = Object.assign(new EventEmitter(), {
    url: () => address, isClosed: () => closed,
    mainFrame: () => frame,
    goto: async (url, settings) => { calls.push(['goto', url, settings]); page.emit('request', navigation('GET', url)); address = url; page.emit('framenavigated', frame); return { status: () => 200 }; },
    reload: async () => assert.fail('API must never invoke browser reload and risk repeating POST'),
    evaluate: async (_fn, args) => args.selector ? { url: address, title: 'Example', total: 1, truncated: false, elements: [{ text: 'password=private', attributes: { href: 'next?token=secret' }, style: {} }] } : { width: 600, height: 400 },
    screenshot: async () => Buffer.from('fake PNG'),
    setViewportSize: async (size) => { calls.push(['viewport', size]); },
  });
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  const session = Object.assign(new EventEmitter(), {
    cfg: { stateDir, origin, siteName: 'fixture', envName: 'local', sourceDir: stateDir, site: { scope: 'all' }, agent: { enabled: true } },
    baseline: { spec: 'HEAD', commit: 'abc', available: true }, model: { webFileByUrl: new Map(), warnings: [] }, rewriter: { activeBlocks: 0, patches: [], unsupported: [] },
    changedFiles: new Set(), rel: (file) => path.relative(stateDir, file), pageHits: new WeakMap(), bypass: false, liveReload: true,
  });
  const panel = { stateFor: () => ({ token: 'private-panel-token', items: [{ rel: 'web-files/app.js', url: '/app.js' }], problems: [{ text: 'Bearer secret', type: 'console' }], notes: [], needsDeploy: [] }) };
  const server = await startAgentServer({ context, session, panel: options.panel === false ? undefined : panel, stop: () => stops++, options, runtime: { watching: true, debugPort: null } });
  const discovery = JSON.parse(fs.readFileSync(server.discoveryFile, 'utf8'));
  t.after(async () => { await server.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const call = (url, body, headers = {}) => fetch(server.endpoint + url, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${discovery.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...server, discovery, call, context, session, page, calls, frame, navigation, stops: () => stops, setUrl: (url) => { address = url; }, closePage: () => { closed = true; page.emit('close'); } };
}

test('agent discovery is local and authenticated; browser origins and forged hosts are rejected', async (t) => {
  const fx = await fixture(t);
  assert.match(fx.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(fx.endpoint + '/v1/session')).status, 401);
  assert.equal((await fx.call('/v1/session', undefined, { origin: 'https://portal.example' })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(fx.endpoint + '/v1/session', { headers: { host: 'attacker.example', authorization: `Bearer ${fx.discovery.token}` } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await fx.call('/v1/session', undefined, { 'sec-fetch-site': 'same-origin' })).status, 403);
  const state = await (await fx.call('/v1/session')).json();
  assert.equal(state.id, fx.discovery.id);
  assert.equal(state.readiness.watcher, true);
  assert.equal(state.baseline.commit, 'abc');
  assert.equal(JSON.stringify(state).includes(fx.discovery.token), false);
  assert.equal(JSON.stringify(await (await fx.call('/v1/pages/1/state')).json()).includes('private-panel-token'), false);
  fx.session.disabled = new Set(Array.from({ length: 201 }, (_, index) => `paused-${index}.js`));
  const paused = await (await fx.call('/v1/session')).json();
  assert.equal(paused.overlay.disabledCount, 201); assert.equal(paused.overlay.disabledSources.length, 200); assert.equal(paused.truncated.disabledSources, true);
  assert.equal((await fx.call('/v1/evaluate', { expression: 'fetch("/write")' })).status, 404);
});

test('bounded event history redacts URL values and secrets and captures external assets only from portal tabs', async (t) => {
  const fx = await fixture(t, { maxEvents: 6, panel: false });
  const request = { url: () => 'https://cdn.example/app.js?key=private#fragment', method: () => 'GET', resourceType: () => 'script', timing: () => ({ responseStart: 15, responseEnd: 20, requestStart: 4 }) };
  fx.page.emit('request', request);
  fx.page.emit('response', { request: () => request, url: request.url, status: () => 404, headers: () => ({ 'content-length': '5', 'content-type': 'text/plain', 'set-cookie': 'private' }) });
  fx.page.emit('requestfinished', request);
  fx.page.emit('console', { type: () => 'error', text: () => 'token=private Bearer private', location: () => ({ url: 'https://cdn.example/app.js?key=private', lineNumber: 4, columnNumber: 2 }) });
  let history = await (await fx.call('/v1/events')).json();
  assert.equal(history.events.length, 4);
  assert.equal(history.events[1].advertisedBytes, 5);
  assert.equal(history.events[2].timing.responseEnd, 20);
  assert.equal(JSON.stringify(history).includes('private'), false);
  const state = await (await fx.call('/v1/pages/1/state')).json();
  assert.equal(state.runtime.panelDiagnosticsAvailable, false);
  assert.equal(state.runtime.events.length, 1);
  fx.setUrl('https://login.example/secret');
  fx.page.emit('request', request);
  fx.page.emit('console', { type: () => 'error', text: () => 'privateIdpValue' });
  assert.equal((await (await fx.call('/v1/events')).json()).events.length, 4);
  assert.equal((await (await fx.call('/v1/session')).json()).access.externalTabCount, 1);
  fx.setUrl('https://portal.example/');
  for (let index = 0; index < 10; index++) fx.page.emit('pageerror', new Error(`failure ${index}`));
  history = await (await fx.call('/v1/events?after=0&limit=2')).json();
  assert.equal(history.events.length, 2); assert.equal(history.dropped, 8); assert.equal(history.hasMore, true);
  assert.equal((await (await fx.call('/v1/pages/1/state')).json()).runtime.retention.dropped, 8);
  assert.equal((await fx.call('/v1/events?limit=501')).status, 400);
});

test('DOM inspection redacts content and resolves links against the document; page actions validate inputs', async (t) => {
  const fx = await fixture(t);
  const dom = await (await fx.call('/v1/pages/1/dom', { selector: 'table tr', limit: 10 })).json();
  assert.equal(dom.elements[0].text, 'password=[redacted]');
  assert.match(dom.elements[0].attributes.href, /^https:\/\/portal\.example\/chapter\/next\?token=/);
  assert.equal((await fx.call('/v1/pages/1/dom', { selector: 'body', limit: 201 })).status, 400);
  assert.equal((await fx.call('/v1/pages/1/dom', { script: 'danger()' })).status, 400);
  assert.equal((await fx.call('/v1/pages/1/screenshot', { fullPage: 'true' })).status, 400);
  assert.equal((await fx.call('/v1/pages/1/navigate', { url: 'https://other.example/' })).status, 403);
  assert.equal((await fx.call('/v1/pages/1/navigate', { url: '/next', waitUntil: 'commit' })).status, 200);
  assert.equal(fx.calls[0][1], 'https://portal.example/next');
  assert.equal((await fx.call('/v1/pages/1/reload', {})).status, 200);
  const image = await fx.call('/v1/pages/1/screenshot', {});
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(await image.text(), 'fake PNG');
  fx.page.evaluate = async () => ({ width: 10_000, height: 10_000 });
  assert.equal((await fx.call('/v1/pages/1/screenshot', { fullPage: true })).status, 413);
  assert.equal((await fx.call('/v1/pages/1/viewport', { width: 800, height: 600 })).status, 200);
  assert.equal((await fx.call('/v1/pages/1/viewport', { width: 0, height: 600 })).status, 400);
  assert.equal((await fx.call('/v1/pages/1/viewport', {})).status, 400);
});

test('oversized and malformed requests fail without retaining browser work; operations are serialized per page', async (t) => {
  const fx = await fixture(t);
  assert.equal((await fx.call('/v1/pages/1/dom', { selector: 'x'.repeat(33 * 1024) })).status, 413);
  const malformed = await fetch(fx.endpoint + '/v1/pages/1/dom', { method: 'POST', headers: { authorization: `Bearer ${fx.discovery.token}`, 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400);
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  fx.page.evaluate = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
  const pending = fx.call('/v1/pages/1/dom', {});
  await started;
  assert.equal((await fx.call('/v1/pages/1/reload', {})).status, 409);
  release({ url: 'https://portal.example/', title: '', total: 0, elements: [] });
  assert.equal((await pending).status, 200);
  fx.setUrl('https://login.example/');
  assert.equal((await fx.call('/v1/pages/1/state')).status, 404);
  assert.deepEqual((await (await fx.call('/v1/pages')).json()).pages, []);
});

test('stop and disposal remove only this discovery file and release every listener', async (t) => {
  const fx = await fixture(t);
  assert.equal((await fx.call('/v1/stop', {})).status, 200);
  await new Promise(setImmediate);
  assert.equal(fx.stops(), 1);
  assert.ok(fx.page.listenerCount('console'));
  fx.closePage();
  assert.equal(fx.page.listenerCount('console'), 0);
  await fx.close(); await fx.close();
  assert.equal(fs.existsSync(fx.discoveryFile), false);
  assert.equal(fx.context.listenerCount('page'), 0);
  assert.equal(fx.session.listenerCount('hit'), 0);
});

test('API reload rejects unknown, POST, pending and history-restored documents and uses GET after a known GET', async (t) => {
  const fx = await fixture(t);
  assert.equal((await fx.call('/v1/pages/1/reload', {})).status, 409);
  await fx.call('/v1/pages/1/navigate', { url: '/result' });
  assert.equal((await fx.call('/v1/pages/1/reload', {})).status, 200);
  const submission = fx.navigation('POST');
  fx.page.emit('request', submission);
  assert.equal((await fx.call('/v1/pages/1/reload', {})).status, 409, 'pending POST blocks reload before commit');
  fx.page.emit('framenavigated', fx.frame);
  assert.equal((await fx.call('/v1/pages/1/reload', {})).status, 409, 'committed POST blocks reload');
  await fx.call('/v1/pages/1/navigate', { url: '/result' });
  fx.page.emit('framenavigated', fx.frame);
  assert.equal((await fx.call('/v1/pages/1/reload', {})).status, 409, 'uncorrelated history navigation is unknown');
  await fx.call('/v1/pages/1/navigate', { url: '/result' });
  const failed = fx.navigation('GET');
  failed.failure = () => ({ errorText: 'aborted' });
  fx.page.emit('request', failed); fx.page.emit('requestfailed', failed);
  assert.equal((await fx.call('/v1/pages/1/reload', {})).status, 409, 'failed GET cannot relabel an existing document');
});

test('attached and explicitly disabled sessions never expose an agent server', async () => {
  assert.equal(await startAgentServer({ attached: true, session: {} }), null);
  assert.equal(await startAgentServer({ session: { cfg: { agent: { enabled: false } } } }), null);
});

test('redaction strips query values, fragments, credentials and common credential formats', () => {
  assert.equal(redactUrl('https://name:password@example.com/a?token=secret#private').includes('secret'), false);
  for (const value of ['password="two words"', 'Authorization: Bearer abc', 'access_token=abc', 'eyJheader.eyJbody.signature']) assert.equal(redactText(value).includes('abc'), false);
});

test('query-heavy URL redaction stays bounded and collapses duplicate keys without retaining values', () => {
  const address = 'https://name:private@portal.example/asset?' + Array.from({ length: 5000 }, (_, index) => `key${index}=private`).join('&') + '#private';
  const before = performance.now();
  const result = redactUrl(address);
  assert.ok(performance.now() - before < 1500, 'redaction must not repeatedly serialize thousands of query parameters');
  assert.ok(result.length <= 2000);
  assert.equal(result.includes('private'), false);
  assert.deepEqual([...new URL(redactUrl('https://portal.example/?x=a&x=b&y=c')).searchParams], [['x', '[redacted]'], ['y', '[redacted]']]);
});

test('current document state excludes late failures from prior documents while paginated history retains them', async (t) => {
  const fx = await fixture(t, { maxEvents: 8, panel: false });
  await fx.call('/v1/pages/1/navigate', { url: '/first' });
  const first = (await (await fx.call('/v1/pages')).json()).pages[0].documentId;
  const slowRequest = { url: () => 'https://portal.example/slow.js', method: () => 'GET', resourceType: () => 'script', failure: () => ({ errorText: 'old document failure' }) };
  fx.page.emit('request', slowRequest);
  fx.page.emit('pageerror', new Error('old document error'));
  await fx.call('/v1/pages/1/navigate', { url: '/second' });
  fx.page.emit('requestfailed', slowRequest);
  fx.page.emit('pageerror', new Error('current document error'));
  let state = await (await fx.call('/v1/pages/1/state')).json();
  assert.notEqual(state.page.documentId, first);
  assert.deepEqual(state.runtime.events.map((entry) => entry.text), ['current document error']);
  const second = state.page.documentId;
  fx.setUrl('https://portal.example/second#section'); fx.page.emit('framenavigated', fx.frame);
  state = await (await fx.call('/v1/pages/1/state')).json();
  assert.equal(state.page.documentId, second, 'fragment navigation retains current diagnostics');
  assert.equal(state.runtime.events.length, 1);
  let cursor = 0;
  const history = [];
  let missing = 0;
  for (;;) {
    const batch = await (await fx.call(`/v1/events?after=${cursor}&limit=2`)).json();
    missing += batch.dropped;
    assert.ok(batch.nextSequence >= cursor);
    history.push(...batch.events); cursor = batch.nextSequence;
    if (!batch.hasMore) break;
  }
  assert.equal(new Set(history.map((entry) => entry.sequence)).size, history.length);
  assert.equal(history.length, 8); assert.equal(missing, 1);
  assert.ok(history.some((entry) => entry.type === 'requestfailed' && entry.documentId === first));
  const empty = await (await fx.call(`/v1/events?after=${cursor}`)).json();
  assert.deepEqual(empty.events, []); assert.equal(empty.hasMore, false); assert.equal(empty.nextSequence, cursor); assert.equal(empty.dropped, 0);
  fx.closePage();
  assert.deepEqual((await (await fx.call('/v1/events?after=' + cursor)).json()).events.map((entry) => entry.type), ['page-closed']);
});
