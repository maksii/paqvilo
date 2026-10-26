import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeHttpErrors } from '../lense/http-errors.mjs';

test('HTTP capture sets protocol byte bounds and stops reading oversized chunked responses without cancelling them', async () => {
  const client = new EventEmitter(),
    calls = [],
    rows = [];
  client.send = async (method, args) => {
    calls.push({ method, args });
    if (method === 'Network.getResponseBody') return { body: JSON.stringify({ error: { message: 'small' } }) };
  };
  client.detach = async () => {};
  const capture = observeHttpErrors(
    { newCDPSession: async () => client },
    {},
    { origin: 'http://127.0.0.1:1234', response: (entry) => (body) => rows.push({ entry, body }) },
  );
  await capture.ready;
  assert.deepEqual(calls[0], {
    method: 'Network.enable',
    args: { maxTotalBufferSize: 131072, maxResourceBufferSize: 32768, maxPostDataSize: 0 },
  });
  const respond = (id, headers = {}) => {
    client.emit('Network.requestWillBeSent', { requestId: id, request: { method: 'POST' } });
    client.emit('Network.responseReceived', {
      requestId: id,
      response: {
        status: 400,
        url: 'http://127.0.0.1:1234/_api/items?private=excluded',
        mimeType: 'application/json',
        headers,
      },
    });
  };
  respond('large');
  client.emit('Network.dataReceived', { requestId: 'large', dataLength: 20000 });
  client.emit('Network.dataReceived', { requestId: 'large', dataLength: 20000 });
  client.emit('Network.loadingFinished', { requestId: 'large' });
  assert.equal(calls.filter((call) => call.method === 'Network.getResponseBody').length, 0);
  assert.equal(rows[0].body, null);
  assert.equal(rows[0].entry.path, '/_api/items');
  respond('small');
  client.emit('Network.loadingFinished', { requestId: 'small' });
  await new Promise((r) => setImmediate(r));
  assert.equal(rows[1].body.error.message, 'small');
  respond('sized', { 'Content-Length': '40000' });
  assert.equal(rows[2].body, null);
  respond('closed');
  await capture.close();
  client.emit('Network.loadingFinished', { requestId: 'closed' });
  assert.equal(rows.length, 3);
  assert.ok(
    calls.every((call) => ['Network.enable', 'Network.getResponseBody'].includes(call.method)),
    'observing must never abort, replay or change a request',
  );
});

test('stalled observer attach, enable and detach cannot hold startup or shutdown open', async () => {
  const never = () => new Promise(() => {}),
    client = new EventEmitter();
  client.send = never;
  client.detach = never;
  const enabled = observeHttpErrors(
    { newCDPSession: async () => client },
    {},
    { origin: 'http://127.0.0.1:1234', response: () => () => {}, timeoutMs: 25 },
  );
  await assert.rejects(enabled.ready, /timed out/);
  assert.equal(enabled.failed, true);
  await enabled.close();
  assert.equal(client.listenerCount('Network.responseReceived'), 0);
  let attach;
  const detached = [];
  const late = observeHttpErrors(
    {
      newCDPSession: () =>
        new Promise((resolve) => {
          attach = resolve;
        }),
    },
    {},
    { origin: 'http://127.0.0.1:1234', response: () => () => {}, timeoutMs: 25 },
  );
  await late.close();
  await assert.rejects(late.ready, /timed out/);
  attach({ detach: async () => detached.push(true) });
  await new Promise((r) => setImmediate(r));
  assert.equal(detached.length, 1, 'a late connection is still released');
});

test('unfinished small JSON errors still produce an HTTP row within the body deadline', async (t) => {
  const client = new EventEmitter(),
    rows = [],
    timeoutMs = 25;
  client.send = async () => ({});
  client.detach = async () => {};
  const capture = observeHttpErrors(
    { newCDPSession: async () => client },
    {},
    { origin: 'http://127.0.0.1:1234', response: (entry) => (body) => rows.push({ entry, body }), timeoutMs },
  );
  await capture.ready;
  // The body deadline is a timer: advance it instead of sleeping past it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  client.emit('Network.responseReceived', {
    requestId: 'unfinished',
    response: { status: 400, url: 'http://127.0.0.1:1234/_api/items', mimeType: 'application/json', headers: {} },
  });
  client.emit('Network.dataReceived', { requestId: 'unfinished', dataLength: 10 });
  t.mock.timers.tick(timeoutMs - 1);
  assert.equal(rows.length, 0, 'the row waits for the body until the deadline');
  t.mock.timers.tick(1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entry.status, 400);
  assert.equal(rows[0].body, null);
  client.emit('Network.loadingFinished', { requestId: 'unfinished' });
  await new Promise((r) => setImmediate(r));
  assert.equal(rows.length, 1, 'late completion must not duplicate an expired row');
  await capture.close();
});

test('only target-origin error responses are observed and pending bodies are bounded', async () => {
  const client = new EventEmitter(),
    rows = [];
  client.send = async () => ({});
  client.detach = async () => {};
  const capture = observeHttpErrors(
    { newCDPSession: async () => client },
    {},
    { origin: 'http://127.0.0.1:1234', response: (entry) => (body) => rows.push({ entry, body }) },
  );
  await capture.ready;
  const respond = (requestId, status, url) =>
    client.emit('Network.responseReceived', {
      requestId,
      response: { status, url, mimeType: 'application/json', headers: {} },
    });
  respond('other-origin', 500, 'http://127.0.0.1:4321/_api/items');
  respond('redirect', 302, 'http://127.0.0.1:1234/_api/items');
  respond('malformed', 500, 'not a URL');
  assert.deepEqual(rows, [], 'other origins, non-error statuses and unparsable URLs are ignored');
  // The 129th unfinished body is not buffered: its row is reported at once without a body.
  for (let index = 0; index < 129; index++) respond(`pending-${index}`, 400, 'http://127.0.0.1:1234/_api/items');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, null);
  await capture.close();
});
