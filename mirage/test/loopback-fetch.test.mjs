// loopbackFetch: loopback URLs only, and redirects are refused. Invented endpoints on 127.0.0.1 with port 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
  await assert.rejects(loopbackFetch(`http://127.0.0.1:${redirecting}/hook`, { method: 'POST', body: '{}' }));
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
