// @test-kind contract+security: Paqvilo's tracing and activity design (docs/design/tracing.md); redaction keeps secrets, tokens and keys out of traces
// tracedFetch (lib/trace-hosts.mjs, D-R3-5): the http-out span of an outbound request against a loopback server: name,
// attributes, forwarded trace headers, redacted payloads at full only, the provider's own error on 4xx/5xx, denied on
// 401/403, the network failure code, capture 'none' and a plain fetch at level off.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
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
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port, seen };
}

test('an outbound request is an http-out span under the current span that forwards the trace headers', async (t) => {
  const { origin, port, seen } = await receiver(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const parent = traces.start({ kind: 'plugin-step', name: 'Invented.Step' });
  // Taken before the request: the http-out span ends when its body has been read, and the parent ends after that.
  const ended = nextSpanEnd(traces);
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
  assert.deepEqual(await response.json(), { ok: true, token: 'abc.def' }, 'the caller still reads the body');
  const span = await ended;
  parent.end();
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
  // A refused connection in the shape fetch rejects with; a released port could be taken by another process.
  const refusedConnection = async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    throw new TypeError('fetch failed', { cause });
  };
  await assert.rejects(tracedFetch(traces, { url: 'http://127.0.0.1:9/closed', fetch: refusedConnection }), TypeError);
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
  const ended = nextSpanEnd(traces);
  assert.equal(await tracedFetch(traces, { url: 'http://127.0.0.1/x', fetch: async () => answer }), answer);
  assert.deepEqual(await answer.json(), { ok: true }, 'the body was read from a clone');
  assert.deepEqual((await ended).output.body, { ok: true });
});

function closeServerAfter(t, server) {
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
}

// @test-kind contract: at level full the response returns at its headers, while its body is still open (ADM-5)
test('at level full tracedFetch returns while the body is open, and the caller then reads the whole body', async (t) => {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first ');
    released.then(() => res.end('second'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => {
    release();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  // The gate: the body is held open until the test releases it, so an await that waits for the body never returns.
  const response = await tracedFetch(traces, { url: `http://127.0.0.1:${server.address().port}/stream` });
  assert.equal(response.status, 200);
  release();
  assert.equal(await response.text(), 'first second', 'the caller reads the whole body');
  const span = await ended;
  assert.equal(span.status, 'ok');
  assert.equal(span.output.body, 'first second');
});

// @test-kind contract: a caller that cancels an open body ends the span as cancelled and releases the connection (ADM-5)
test('a caller that cancels an open body ends its span as cancelled, and the connection closes', async (t) => {
  let connectionClosed;
  const closed = new Promise((resolve) => {
    connectionClosed = resolve;
  });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first ');
    res.on('close', () => connectionClosed());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closeServerAfter(t, server);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const response = await tracedFetch(traces, { url: `http://127.0.0.1:${server.address().port}/held` });
  // The body stays open: only the caller's cancel can end it.
  await response.body.cancel('the caller stopped reading');
  await closed;
  const span = await ended;
  assert.equal(span.status, 'cancelled');
  assert.equal(span.output.status, 200);
});

// @test-kind contract: an aborted request ends its span as cancelled (ADM-5)
test('an aborted request ends its span as cancelled', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first ');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closeServerAfter(t, server);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const controller = new AbortController();
  const response = await tracedFetch(traces, {
    url: `http://127.0.0.1:${server.address().port}/held`,
    init: { signal: controller.signal },
  });
  controller.abort();
  await assert.rejects(response.text());
  const span = await ended;
  assert.equal(span.status, 'cancelled');
});

// A loopback server that answers text/plain with its first chunk and holds the body open. `closed` settles when the
// server sees the connection close.
async function heldServer(t) {
  let connectionClosed;
  const closed = new Promise((resolve) => {
    connectionClosed = resolve;
  });
  const server = http.createServer((req, res) => {
    req.on('close', () => connectionClosed());
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first ');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closeServerAfter(t, server);
  return { url: `http://127.0.0.1:${server.address().port}/held`, closed };
}

// A loopback server that answers text/plain completely: 'first second' and the end.
async function completeServer(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first ');
    res.end('second');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/whole`;
}

function nextSpanEnd(traces) {
  return new Promise((resolve) => {
    const stop = traces.subscribe(
      ({ span }) => {
        stop();
        resolve(span);
      },
      { events: ['span-end'] },
    );
  });
}

// Unhandled rejections seen while the test runs: the listener is attached now and removed when the test ends. The
// returned function yields them after one event-loop turn, when a rejection would have been reported.
function collectUnhandled(t) {
  const reasons = [];
  const listener = (reason) => reasons.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  return async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return reasons;
  };
}

// @test-kind contract: breaking out of for await over the caller's body is a caller cancel (ADM-5 cancel paths)
test('breaking out of for await over the body ends the span as cancelled and closes the connection', async (t) => {
  const unhandled = collectUnhandled(t);
  const held = await heldServer(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const response = await tracedFetch(traces, { url: held.url });
  const chunks = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk).toString('utf8'));
    break;
  }
  assert.deepEqual(chunks, ['first ']);
  await held.closed;
  assert.equal((await ended).status, 'cancelled');
  assert.deepEqual(await unhandled(), []);
});

// @test-kind contract: a pipe whose destination errors cancels the caller's body (ADM-5 cancel paths)
test('a pipe whose destination errors on its first write ends the span as cancelled', async (t) => {
  const unhandled = collectUnhandled(t);
  const held = await heldServer(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const response = await tracedFetch(traces, { url: held.url });
  const refusing = new WritableStream({
    write() {
      throw new Error('The destination refused the chunk.');
    },
  });
  await assert.rejects(response.body.pipeTo(refusing), /refused the chunk/);
  await held.closed;
  assert.equal((await ended).status, 'cancelled');
  assert.deepEqual(await unhandled(), []);
});

// @test-kind contract: a pipe aborted by its signal cancels the caller's body (ADM-5 cancel paths)
test('a pipe aborted by its signal ends the span as cancelled', async (t) => {
  const unhandled = collectUnhandled(t);
  const held = await heldServer(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const response = await tracedFetch(traces, { url: held.url });
  const controller = new AbortController();
  const firstWrite = Promise.withResolvers();
  const sink = new WritableStream({
    write() {
      firstWrite.resolve();
    },
  });
  const piped = response.body.pipeTo(sink, { signal: controller.signal });
  await firstWrite.promise;
  controller.abort();
  await assert.rejects(piped, { name: 'AbortError' });
  await held.closed;
  assert.equal((await ended).status, 'cancelled');
  assert.deepEqual(await unhandled(), []);
});

// @test-kind contract: destroying a Node readable adapted from the caller's body cancels it (ADM-5 cancel paths)
test('destroying a Node readable made from the body ends the span as cancelled', async (t) => {
  const unhandled = collectUnhandled(t);
  const held = await heldServer(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const response = await tracedFetch(traces, { url: held.url });
  const readable = Readable.fromWeb(response.body);
  const firstData = Promise.withResolvers();
  readable.once('data', (chunk) => firstData.resolve(chunk));
  assert.equal(Buffer.from(await firstData.promise).toString('utf8'), 'first ');
  readable.destroy();
  await held.closed;
  assert.equal((await ended).status, 'cancelled');
  assert.deepEqual(await unhandled(), []);
});

// @test-kind contract: a caller that reads the whole body through text() gets the captured body on an ok span (ADM-5)
test('a caller that reads the whole body through text() ends the span ok with the captured body', async (t) => {
  const url = await completeServer(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const response = await tracedFetch(traces, { url });
  assert.equal(await response.text(), 'first second');
  assert.equal(response.bodyUsed, true);
  const span = await ended;
  assert.equal(span.status, 'ok');
  assert.equal(span.output.body, 'first second');
});

// @test-kind contract: a caller that reads the whole body through a reader or for await ends the span ok (ADM-5)
test('a caller that reads the whole body through a reader or for await ends the span ok', async (t) => {
  const url = await completeServer(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const response = await tracedFetch(traces, { url });
  const reader = response.body.getReader();
  const parts = [];
  let next = await reader.read();
  while (!next.done) {
    parts.push(Buffer.from(next.value).toString('utf8'));
    next = await reader.read();
  }
  assert.equal(parts.join(''), 'first second');
  assert.equal((await ended).status, 'ok');

  const again = createTraceStore({ settings: { level: 'full' } });
  const endedAgain = nextSpanEnd(again);
  const second = await tracedFetch(again, { url });
  let text = '';
  for await (const chunk of second.body) text += Buffer.from(chunk).toString('utf8');
  assert.equal(text, 'first second');
  const span = await endedAgain;
  assert.equal(span.status, 'ok');
  assert.equal(span.output.body, 'first second');
});

// @test-kind contract: a clone the caller takes does not break the capture, and both responses read the whole body (ADM-5)
test('a caller clone is read in full next to the original, and the span ends ok once', async (t) => {
  const url = await completeServer(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const response = await tracedFetch(traces, { url });
  const copy = response.clone();
  assert.equal(await copy.text(), 'first second');
  assert.equal(await response.text(), 'first second');
  const span = await ended;
  assert.equal(span.status, 'ok');
  assert.equal(span.output.body, 'first second');
  assert.equal(traces.spans({ kind: 'http-out' }).items.length, 1);
});

// A fake answer whose body is an open stream the caller does not read; its clone is the stream the capture reads.
function openBodyAnswer(clone) {
  return {
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/plain' }),
    body: new ReadableStream(),
    clone: () => ({ body: clone }),
  };
}

// @test-kind contract: closing the trace store cancels a capture whose body never ends, and its span ends cancelled (ADM-5)
test('closing the trace store cancels an open capture: its body is cancelled and its span ends cancelled', async () => {
  let readStarted;
  const started = new Promise((resolve) => {
    readStarted = resolve;
  });
  let cancelled = false;
  // highWaterMark 0: pull runs only when a reader asks, so `started` settles once the capture is reading the body.
  const clone = new ReadableStream(
    {
      pull() {
        readStarted();
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  await tracedFetch(traces, { url: 'http://127.0.0.1/never-ends', fetch: async () => openBodyAnswer(clone) });
  await started;
  await traces.close();
  assert.equal(cancelled, true, 'the store cancels the body its capture reads');
  const span = await ended;
  assert.equal(span.status, 'cancelled');
});

// A real answer whose own body is `text`; the capture reads `clone` in place of a copy of that body.
function answerWithCaptureStream(text, clone) {
  const answer = new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } });
  answer.clone = () => ({ body: clone });
  return answer;
}

// @test-kind contract: a capture whose body read fails records the failure as its body, and the caller still reads its own body (ADM-5)
test('a body read that fails without an abort is recorded as unreadable, and the caller reads its own body', async () => {
  let controller;
  const clone = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  const traces = createTraceStore({ settings: { level: 'full' } });
  const ended = nextSpanEnd(traces);
  const response = await tracedFetch(traces, {
    url: 'http://127.0.0.1/read-fails',
    fetch: async () => answerWithCaptureStream('the caller body', clone),
  });
  controller.error(new Error('the disk went away'));
  const span = await ended;
  assert.equal(span.status, 'ok');
  assert.equal(span.output.body, '[unreadable body: the disk went away]');
  assert.equal(await response.text(), 'the caller body', 'the caller reads its own body');
});

// @test-kind contract: a capture stops reading once the body passes the payload limit and records the first bytes as truncated (ADM-5)
test('a body larger than the payload limit stops the capture at the limit, and the caller reads the whole body', async () => {
  const limit = 256;
  let pulls = 0;
  let cancelled = false;
  // highWaterMark 0: each pull is one read of the capture. The second chunk is offered only if the capture reads again.
  const clone = new ReadableStream(
    {
      pull(c) {
        pulls++;
        if (pulls === 1) c.enqueue(new TextEncoder().encode('a'.repeat(limit) + 'past the limit'));
        else {
          c.enqueue(new TextEncoder().encode('second chunk'));
          c.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const traces = createTraceStore({ settings: { level: 'full', payloadBytes: limit } });
  const ended = nextSpanEnd(traces);
  const whole = 'b'.repeat(limit * 2);
  const response = await tracedFetch(traces, {
    url: 'http://127.0.0.1/large',
    fetch: async () => answerWithCaptureStream(whole, clone),
  });
  const span = await ended;
  assert.equal(span.status, 'ok');
  // The store bounds the whole recorded output by the same limit: it keeps that output as a preview with its size.
  const recorded = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'a'.repeat(limit), truncated: true };
  assert.equal(span.output.truncated, true);
  assert.equal(
    span.output.bytes,
    Buffer.byteLength(JSON.stringify(recorded)),
    'the first bytes up to the limit, truncated',
  );
  assert.equal(pulls, 1, 'the capture does not read past the chunk that passes the limit');
  assert.equal(cancelled, true, 'the capture releases its stream');
  assert.equal(await response.text(), whole, 'the caller reads its whole body');
});
