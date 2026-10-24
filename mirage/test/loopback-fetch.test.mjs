// loopbackFetch: loopback URLs only, and redirects are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { DataError } from '../lib/data-error.mjs';
import { loopbackFetch } from '../lib/dataverse-webhooks.mjs';

function listen(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((done) => server.close(done)));
    resolve(server.address().port);
  }));
}

test('a loopback endpoint that answers 307 is not followed to another host', async t => {
  let received = 0;
  const target = await listen(t, (request, response) => {
    received += 1;
    response.end('received');
  });
  const redirecting = await listen(t, (request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${target}/hook` });
    response.end();
  });
  await assert.rejects(loopbackFetch(`http://127.0.0.1:${redirecting}/hook`, { method: 'POST', body: '{}' }), /fetch failed/);
  assert.equal(received, 0);
});

test('a loopback endpoint that answers 200 resolves normally', async t => {
  const port = await listen(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  const response = await loopbackFetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
});

test('a non-loopback URL throws Endpoint unavailable without any network call', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('');
  });
  assert.throws(() => loopbackFetch('https://example.test/hook', { method: 'POST' }), error => {
    assert.ok(error instanceof DataError);
    assert.equal(error.message, 'Endpoint unavailable');
    assert.equal(error.status, 400);
    assert.equal(error.details?.innerCode, '0x80040265');
    return true;
  });
  assert.equal(calls, 0);
});

test('a DNS-checked localhost name connects only to the checked address and preserves its Host and request body', async t => {
  let received;
  const port = await listen(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { host: request.headers.host, body: Buffer.concat(chunks).toString(), method: request.method };
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    response.end(gzipSync(JSON.stringify({ ok: true })));
  });
  let lookups = 0;
  const lookup = async () => {
    lookups++;
    return [{ address: lookups === 1 ? '127.0.0.1' : '203.0.113.1', family: 4 }];
  };
  const url = `http://dns-rebinding-fixture.localhost:${port}/hook`;
  const response = await loopbackFetch(url, { method: 'POST', body: 'fixture-body', lookup });
  assert.equal(response.url, url);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(received, { host: `dns-rebinding-fixture.localhost:${port}`, method: 'POST', body: 'fixture-body' });
  assert.equal(lookups, 1, 'the connection reuses the checked address without a second DNS resolution');
});

test('a pinned hostname response still refuses redirects and propagates cancellation', async t => {
  let reached = 0;
  const port = await listen(t, (request, response) => {
    reached++;
    if (request.url === '/redirect') response.writeHead(307, { location: '/unexpected' }).end();
    else response.end('ok');
  });
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const url = `http://dns-rebinding-fixture.localhost:${port}`;
  await assert.rejects(loopbackFetch(url + '/redirect', { lookup }), /fetch failed/);
  assert.equal(reached, 1);
  const abort = new AbortController();
  abort.abort(new Error('fixture cancelled'));
  await assert.rejects(loopbackFetch(url + '/cancelled', { lookup, signal: abort.signal }), /fixture cancelled/);
  assert.equal(reached, 1);
});

test('pinned hostname responses retain empty HEAD/204 bodies and abort an active response stream', async t => {
  const port = await listen(t, (request, response) => {
    if (request.url === '/stream') {
      response.writeHead(200);
      response.write('partial');
    } else {
      response.writeHead(request.method === 'HEAD' ? 200 : 204, { 'content-encoding': 'gzip' });
      response.end();
    }
  });
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const url = `http://dns-rebinding-fixture.localhost:${port}`;
  for (const method of ['HEAD', 'POST']) {
    const response = await loopbackFetch(url + '/empty', { method, lookup });
    assert.equal(response.body, null);
    assert.equal(await response.text(), '');
  }
  const abort = new AbortController();
  const response = await loopbackFetch(url + '/stream', { lookup, signal: abort.signal });
  const text = response.text();
  abort.abort();
  await assert.rejects(text, /aborted/);
});
