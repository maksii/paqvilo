// @test-kind compatibility: Firefox StreamFilter applies a Lense rewrite while preserving native upload bytes and cookies.
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HtmlRewriter } from '../../lense/html-rewriter.mjs';
import { makeTemporaryDirectory, ownedFixture, removeFixtureDirectory } from '../../mirage/testing/owned-fixture.mjs';
import { startFirefox } from '../bidi/native-browser.mjs';
import { listenOwnedServer } from '../helpers/owned-server.mjs';

const ORIGINAL = 'Original portal response';
const REWRITE = 'Response rewritten before rendering';
const REMOTE_SCRIPT = `window.formResult = ${JSON.stringify(ORIGINAL)};`;
const LOCAL_SCRIPT = `window.formResult = ${JSON.stringify(REWRITE)};`;
const LIMIT = 1024;
const UPLOAD = [0, 255, 65, 10];
const FIXTURE_COOKIES = ['visible_fixture=one; Path=/', 'http_only_fixture=two; Path=/; HttpOnly'];

// Serialized into a temporary extension installed only in the probe's Firefox profile.
function filterFixture({ origin, bridge, limit }) {
  const request = globalThis.browser.webRequest;
  request.onBeforeRequest.addListener(
    ({ url, method, requestId, tabId }) => {
      const target = new URL(url);
      const formPost = target.pathname === '/submit' && method === 'POST';
      const receipt = target.pathname === '/receipt' && method === 'GET';
      if (target.origin !== origin || tabId < 0 || !(formPost || receipt)) return;
      const filter = request.filterResponseData(requestId);
      const chunks = [];
      let size = 0;
      let deadline;

      const passThrough = (current) => {
        clearTimeout(deadline);
        for (const chunk of chunks) filter.write(chunk);
        chunks.length = 0;
        if (current) filter.write(current);
        if (filter.status === 'finishedtransferringdata') filter.close();
        else filter.disconnect();
      };
      filter.onstart = () => {
        deadline = setTimeout(passThrough, 2000);
      };
      filter.ondata = ({ data }) => {
        size += data.byteLength;
        if (size > limit) passThrough(data);
        else chunks.push(data);
      };
      filter.onstop = async () => {
        clearTimeout(deadline);
        let output;
        try {
          const endpoint = target.search === '?bridge-failure' ? '/transform?bridge-failure' : '/transform';
          const response = await fetch(bridge + endpoint, {
            method: 'POST',
            body: new Blob(chunks, { type: 'application/octet-stream' }),
            credentials: 'omit',
            redirect: 'error',
            signal: AbortSignal.timeout(2000),
          });
          const length = Number(response.headers.get('content-length'));
          if (
            !response.ok ||
            response.headers.has('content-encoding') ||
            !Number.isSafeInteger(length) ||
            length < 1 ||
            length > limit
          )
            throw new Error('The probe bridge did not return a bounded response.');
          output = await response.arrayBuffer();
          if (output.byteLength !== length) throw new Error('Unexpected probe bridge response length.');
        } catch {
          passThrough();
          return;
        }
        filter.write(output);
        filter.close();
      };
      filter.onerror = () => clearTimeout(deadline);
    },
    { urls: ['http://127.0.0.1/*'], types: ['main_frame'] },
    ['blocking'],
  );
  void fetch(`${bridge}/filter-ready`, { credentials: 'omit' });
}

function fixtureResponse(extra = '') {
  return `<!doctype html><meta charset="utf-8"><p id="original">${extra}</p>
    <script>${REMOTE_SCRIPT}</script><script>window.firstRead = window.formResult;</script>`;
}

function formFixture(t) {
  const uploads = [];
  const receipts = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/receipt') {
      receipts.push({ method: request.method, cookies: (request.headers.cookie ?? '').split('; ').sort() });
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' });
      response.end(fixtureResponse());
      return;
    }
    if (request.method === 'GET' && request.url === '/cookies') {
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end(request.headers.cookie ?? '');
      return;
    }
    if (
      request.method === 'POST' &&
      ['/submit', '/submit?large', '/submit?bridge-failure', '/submit?redirect'].includes(request.url)
    ) {
      const body = [];
      request.on('data', (chunk) => body.push(chunk));
      request.on('end', () => {
        uploads.push({ contentType: request.headers['content-type'], bytes: Buffer.concat(body) });
        if (request.url.endsWith('?redirect')) {
          response.writeHead(303, {
            location: '/receipt',
            'cache-control': 'no-store',
            'set-cookie': FIXTURE_COOKIES,
          });
          response.end();
          return;
        }
        const extra = request.url.endsWith('?large') ? 'x'.repeat(LIMIT) : '';
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': FIXTURE_COOKIES,
        });
        response.write(fixtureResponse(extra));
        response.end();
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/form') {
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><meta charset="utf-8">
        <form action="/submit" enctype="multipart/form-data" method="post">
          <input name="description" value="form value">
          <input name="attachment" type="file">
        </form>`);
      return;
    }
    response.writeHead(404).end();
  });
  return { uploads, receipts, origin: listenOwnedServer(t, server) };
}

async function bridgeFixture(t, pageUrl = '/submit') {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-firefox-source-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(directory));
  const file = path.join(directory, 'page.js');
  await writeFile(file, LOCAL_SCRIPT);
  const rewriter = new HtmlRewriter({
    model: {
      sourceDir: directory,
      inlineSources: [{ rel: 'page.js', file, kind: 'page-js', mode: 'block', tag: 'script', pageUrl }],
    },
    site: { inline: { kinds: ['page-js'] } },
    baseline: { changedFiles: () => new Set([file]), show: () => REMOTE_SCRIPT },
  });
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/filter-ready') {
      server.emit('filter-ready');
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'POST' || !['/transform', '/transform?bridge-failure'].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > LIMIT) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const original = Buffer.concat(chunks);
      requests.push({ original, credentials: Boolean(request.headers.cookie || request.headers.authorization) });
      if (request.url.endsWith('?bridge-failure')) {
        response.writeHead(503).end();
        return;
      }
      const html = new TextDecoder('utf-8', { fatal: true }).decode(original);
      const body = Buffer.from(rewriter.rewrite(html, pageUrl, { isDocument: true }).html);
      if (body.length > LIMIT) {
        response.writeHead(413).end();
        return;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/octet-stream',
        'content-length': body.length,
      });
      response.end(body);
    } catch {
      response.writeHead(500).end();
    }
  });
  return { server, requests, origin: await listenOwnedServer(t, server) };
}

async function installFilter(t, bidi, origin, bridge) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-firefox-filter-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(directory));
  const manifest = {
    manifest_version: 3,
    name: 'Paqvilo Firefox transport probe',
    version: '1.0.0',
    browser_specific_settings: { gecko: { id: 'firefox-filter-probe@paqvilo.example' } },
    background: { scripts: ['filter.js'] },
    host_permissions: ['http://127.0.0.1/*'],
    permissions: ['webRequest', 'webRequestBlocking', 'webRequestFilterResponse'],
  };
  const source = `(${filterFixture})(${JSON.stringify({ origin, bridge: bridge.origin, limit: LIMIT })});`;
  await Promise.all([
    writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(path.join(directory, 'filter.js'), source),
  ]);
  await Promise.all([
    once(bridge.server, 'filter-ready', { signal: AbortSignal.timeout(10_000) }),
    bidi.send('webExtension.install', { extensionData: { type: 'path', path: directory } }),
  ]);
}

function desktopPage(bidi, context) {
  return {
    navigate: (url) => bidi.send('browsingContext.navigate', { context, url, wait: 'complete' }),
    async evaluate(expression) {
      const evaluation = await bidi.send('script.evaluate', { expression, target: { context }, awaitPromise: true });
      assert.equal(evaluation.type, 'success', evaluation.exceptionDetails?.text);
      return evaluation.result.value;
    },
    async submit(url, loadedUrl = url) {
      const events = new EventEmitter();
      const unsubscribe = bidi.on('browsingContext.load', (event) => {
        if (event.context === context && event.url === loadedUrl) events.emit('loaded');
      });
      try {
        await Promise.all([
          once(events, 'loaded', { signal: AbortSignal.timeout(10_000) }),
          this.evaluate(`(() => {
            const form = document.querySelector('form');
            form.action = ${JSON.stringify(url)};
            const transfer = new DataTransfer();
            transfer.items.add(new File([Uint8Array.from(${JSON.stringify(UPLOAD)})], 'probe.bin',
              { type: 'application/octet-stream' }));
            form.elements.attachment.files = transfer.files;
            setTimeout(() => form.requestSubmit(), 0);
          })()`),
        ]);
      } finally {
        unsubscribe();
      }
    },
  };
}

function assertUpload(upload) {
  const boundary = upload.contentType.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
  assert.ok(boundary, 'native multipart boundary');
  assert.ok(
    upload.bytes.includes(`--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nform value`),
  );
  assert.ok(
    upload.bytes.includes(
      Buffer.concat([
        Buffer.from('name="attachment"; filename="probe.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'),
        Buffer.from(UPLOAD),
        Buffer.from(`\r\n--${boundary}--`),
      ]),
    ),
    'native file bytes and closing boundary',
  );
}

async function startProbePage(t, origin, bridge) {
  const { bidi } = await startFirefox(t);
  await installFilter(t, bidi, origin, bridge);
  const { contexts } = await bidi.send('browsingContext.getTree');
  const { context } = contexts[0];
  await bidi.send('session.subscribe', { events: ['browsingContext.load'], contexts: [context] });
  return desktopPage(bidi, context);
}

test('Firefox transforms a single upstream multipart form response in place', async (t) => {
  const selected = formFixture(t);
  const unselected = formFixture(t);
  const [origin, otherOrigin, bridge] = await Promise.all([selected.origin, unselected.origin, bridgeFixture(t)]);
  const page = await startProbePage(t, origin, bridge);

  await page.navigate(`${origin}/form`);
  await page.submit(`${origin}/submit`);
  assert.equal(await page.evaluate('window.firstRead'), REWRITE);
  assert.equal(selected.uploads.length, 1, 'one upstream mutation');
  assertUpload(selected.uploads[0]);
  assert.deepEqual(bridge.requests, [{ original: Buffer.from(fixtureResponse()), credentials: false }]);
  assert.equal(await page.evaluate('document.cookie'), 'visible_fixture=one');
  const requestCookies = await page.evaluate('fetch("/cookies").then((response) => response.text())');
  assert.deepEqual(requestCookies.split('; ').sort(), ['http_only_fixture=two', 'visible_fixture=one']);

  await page.navigate(`${origin}/form`);
  await page.submit(`${origin}/submit?large`);
  assert.equal(await page.evaluate('window.firstRead'), ORIGINAL);
  assert.equal(await page.evaluate('document.querySelector("#original").textContent'), 'x'.repeat(LIMIT));
  assert.equal(selected.uploads.length, 2, 'oversized response passed through without another POST');

  await page.navigate(`${origin}/form`);
  await page.submit(`${origin}/submit?bridge-failure`);
  assert.equal(await page.evaluate('window.firstRead'), ORIGINAL);
  assert.equal(selected.uploads.length, 3, 'bridge failure passed through without another POST');

  await page.navigate(`${otherOrigin}/form`);
  await page.submit(`${otherOrigin}/submit`);
  assert.equal(await page.evaluate('window.firstRead'), ORIGINAL);
  assert.equal(unselected.uploads.length, 1, 'the same route on another port passed through');
  assert.deepEqual(bridge.requests, [
    { original: Buffer.from(fixtureResponse()), credentials: false },
    { original: Buffer.from(fixtureResponse()), credentials: false },
  ]);
});

test('Firefox follows a multipart POST 303 and rewrites the separate GET response', async (t) => {
  const selected = formFixture(t);
  const [origin, bridge] = await Promise.all([selected.origin, bridgeFixture(t, '/receipt')]);
  const page = await startProbePage(t, origin, bridge);

  await page.navigate(`${origin}/form`);
  await page.submit(`${origin}/submit?redirect`, `${origin}/receipt`);
  assert.equal(await page.evaluate('window.firstRead'), REWRITE);
  assert.equal(await page.evaluate('document.cookie'), 'visible_fixture=one');
  assert.equal(selected.uploads.length, 1, 'the browser sent the multipart POST once');
  assertUpload(selected.uploads[0]);
  assert.deepEqual(selected.receipts, [{ method: 'GET', cookies: ['http_only_fixture=two', 'visible_fixture=one'] }]);
  assert.deepEqual(bridge.requests, [{ original: Buffer.from(fixtureResponse()), credentials: false }]);
});
