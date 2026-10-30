// tracedFetch (lib/trace-hosts.mjs, D-R3-5): the http-out span of an outbound request against a loopback server: name,
// attributes, forwarded trace headers, redacted payloads at full only, the provider's own error on 4xx/5xx, denied on
// 401/403, the network failure code, capture 'none' and a plain fetch at level off.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTraceStore } from '../lib/trace-store.mjs';
import { tracedFetch } from '../lib/trace-hosts.mjs';

async function receiver(t) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/down') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'QuoteBackendDown', message: 'The quote backend is down.' } }));
    }
    if (path === '/forbidden') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('no');
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=s3cr3t' });
    res.end(JSON.stringify({ ok: true, token: 'abc.def' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port, seen };
}

test('an outbound request is an http-out span under the current span that forwards the trace headers', async (t) => {
  const { origin, port, seen } = await receiver(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const parent = traces.start({ kind: 'plugin-step', name: 'Invented.Step' });
  const response = await traces.run(parent, () =>
    tracedFetch(traces, {
      module: 'webhooks',
      url: `${origin}/hook?code=k3y&x=1`,
      init: {
        method: 'post',
        headers: { 'content-type': 'application/json', authorization: 'Bearer abc.def' },
        body: JSON.stringify({ name: 'Invented', password: 'p4ss' }),
      },
      attributes: { transport: 'http' },
    }),
  );
  parent.end();
  assert.deepEqual(await response.json(), { ok: true, token: 'abc.def' }, 'the caller still reads the body');
  const [span] = traces.spans({ kind: 'http-out' }).items;
  assert.equal(span.parentSpanId, parent.spanId);
  assert.equal(span.name, `POST 127.0.0.1:${port}/hook`);
  assert.deepEqual([span.module, span.operation, span.status], ['webhooks', 'post', 'ok']);
  assert.deepEqual(span.attributes, {
    transport: 'http',
    method: 'POST',
    url: `${origin}/hook?code=[redacted]&x=1`,
    status: 200,
  });
  assert.equal(seen[0].headers['x-sim-parent-trace'], span.spanId);
  assert.equal(seen[0].headers['x-trace-id'], span.traceId);
  assert.equal(seen[0].headers['x-sim-span-id'], span.spanId);
  assert.equal('x-sim-trace-id' in seen[0].headers, false, 'no audited span: no audit id, and never the trace id');
  assert.equal(seen[0].headers.authorization, 'Bearer abc.def', 'the request itself is unchanged');
  assert.deepEqual(span.input.body, { name: 'Invented', password: '[redacted]' });
  assert.equal(span.input.headers.authorization, '[redacted]');
  assert.deepEqual(span.output.body, { ok: true, token: '[redacted]' });
  assert.equal(span.output.status, 200);
  assert.equal(span.output.headers['set-cookie'], '[redacted]');
  assert.doesNotMatch(JSON.stringify(span), /p4ss|abc\.def|s3cr3t|k3y/);
});

test('4xx and 5xx answers keep the provider error; 403 is denied; a network failure names its code', async (t) => {
  const { origin } = await receiver(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const down = await tracedFetch(traces, { module: 'connectors', url: `${origin}/down` });
  assert.equal(down.status, 500);
  const forbidden = await tracedFetch(traces, { url: `${origin}/forbidden` });
  assert.equal(await forbidden.text(), 'no');
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(tracedFetch(traces, { url: `http://127.0.0.1:${closedPort}/closed` }), TypeError);
  const [failed, refused, downSpan] = traces.spans({ kind: 'http-out' }).items;
  assert.equal(downSpan.status, 'error');
  assert.deepEqual(downSpan.error, { code: 'QuoteBackendDown', message: 'The quote backend is down.', status: 500 });
  assert.equal(refused.status, 'denied');
  assert.deepEqual(refused.error, { code: 'Http403', message: '403 Forbidden', status: 403 });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.code, 'ECONNREFUSED');
  assert.equal(traces.query({ search: 'quotebackenddown' }).total, 1, 'the provider error is searchable');
});

test('summary reads no body and records the status; capture none skips bodies; off is a plain fetch', async (t) => {
  const { origin, seen } = await receiver(t);
  const traces = createTraceStore({ settings: { level: 'summary' } });
  await tracedFetch(traces, { url: `${origin}/down`, init: { method: 'POST', body: '{"a":1}' } });
  const [summary] = traces.spans({ kind: 'http-out' }).items;
  assert.equal('input' in summary || 'output' in summary, false);
  assert.deepEqual(summary.error, { code: 'Http500', message: '500 Internal Server Error', status: 500 });

  traces.configure({ level: 'full' });
  await tracedFetch(traces, { url: `${origin}/ok`, capture: 'none', forwardHeaders: false });
  const [quiet] = traces.spans({ kind: 'http-out' }).items;
  assert.equal('input' in quiet || 'output' in quiet, false);
  assert.equal(seen.at(-1).headers['x-trace-id'], undefined, 'forwardHeaders false sends no trace headers');

  traces.configure({ level: 'off' });
  const before = traces.status().spans;
  const plain = await tracedFetch(traces, { url: `${origin}/ok` });
  assert.equal(plain.status, 200);
  assert.equal(traces.status().spans, before);
  assert.equal(seen.at(-1).headers['x-trace-id'], undefined);
  assert.equal((await tracedFetch(null, { url: `${origin}/ok` })).status, 200, 'no store: a plain fetch');
});

test('a fetch implementation that throws synchronously fails the span and rethrows the same error', async () => {
  const traces = createTraceStore({ settings: { level: 'full' } });
  const refusal = Object.assign(new Error('Only loopback hosts are allowed.'), { code: 'NonLoopbackHost' });
  const seen = [];
  const guarded = (url, init) => {
    seen.push(init.headers.get('x-trace-id'));
    throw refusal;
  };
  await assert.rejects(
    tracedFetch(traces, { module: 'webhooks', url: 'https://example.invalid/hook', fetch: guarded }),
    (error) => error === refusal,
  );
  const [span] = traces.spans({ kind: 'http-out' }).items;
  assert.equal(seen[0], span.traceId, 'the implementation received the forwarded headers');
  assert.equal(span.status, 'error');
  assert.deepEqual(span.error, { code: 'NonLoopbackHost', message: 'Only loopback hosts are allowed.' });
  // The implementation's answer is what the caller gets.
  const answer = new Response('{"ok":true}', { status: 202, headers: { 'content-type': 'application/json' } });
  assert.equal(await tracedFetch(traces, { url: 'http://127.0.0.1/x', fetch: async () => answer }), answer);
  assert.deepEqual(await answer.json(), { ok: true }, 'the body was read from a clone');
  assert.deepEqual(traces.spans({ kind: 'http-out' }).items[0].output.body, { ok: true });
});
