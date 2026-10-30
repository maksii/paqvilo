// SSE back-pressure (D-R3-18) and trace flush (D-R3-26): a burst of large frames to a client that reads normally loses
// nothing (the write that returns false waits for drain instead of counting towards a drop), the trace channel delivers
// every frame of a burst to connectRuntime().trace.subscribe, and traces.flush() settles only once the frames reached the
// socket. Every step waits on stream events or promises, never on time.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { createTraceStore } from '../lib/trace-store.mjs';
import { createTraceChannel, createTraceRoutes } from '../lib/sim-trace-routes.mjs';
import { sseClients } from '../lib/trace-hosts.mjs';
import { connectRuntime } from '../testing/runtime.mjs';

const CSRF = 'invented-csrf';

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// Counts `event: <name>` frames of an SSE body until it ends.
async function countFrames(body, name) {
  const decoder = new TextDecoder();
  let buffer = '',
    count = 0;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      if (buffer.slice(0, end).startsWith(`event: ${name}\n`)) count++;
      buffer = buffer.slice(end + 2);
    }
  }
  return count;
}

test('one burst of 100 large frames reaches a normally reading client whole', async (t) => {
  const clients = sseClients();
  const frame = `event: burst\ndata: ${'x'.repeat(64 * 1024)}\n\n`;
  let refused = 0;
  const origin = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    assert.equal(clients.add(res), true);
    const write = res.write.bind(res);
    res.write = (...args) => write(...args) || (refused++, false);
    // 6.4 MB in one synchronous burst: the socket refuses writes long before the burst ends.
    for (let index = 0; index < 100; index++) clients.send(frame);
    assert.equal(clients.size, 1, 'the client is still registered after the burst');
    clients.end();
  });
  const response = await fetch(origin);
  assert.equal(await countFrames(response.body, 'burst'), 100);
  assert.ok(refused >= 3, `the burst met back-pressure (${refused} refused writes)`);
});

test('a client is dropped when the first write after each of three drains is refused again', async () => {
  const clients = sseClients();
  // highWaterMark 1: every write is refused; the test completes the writes by hand, as a socket does once it flushed.
  const slow = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, done) {
      slow.pending = done;
    },
  });
  clients.add(slow);
  // Completes every buffered write and waits for the drain event that follows.
  const drain = async () => {
    const drained = once(slow, 'drain');
    while (slow.pending) {
      const done = slow.pending;
      slow.pending = null;
      done();
    }
    await drained;
  };
  clients.send('event: a\ndata: 1\n\n'); // refused: cycle 1
  clients.send('event: a\ndata: 2\n\n'); // still waiting for drain: not counted
  for (let cycle = 2; cycle <= 3; cycle++) {
    await drain();
    clients.send(`event: a\ndata: ${cycle}\n\n`); // refused right after a drain: cycle 2, 3
    assert.equal(slow.destroyed, false, `cycle ${cycle} keeps the client`);
  }
  await drain();
  clients.send('event: a\ndata: 4\n\n'); // refused after the third drain in a row
  assert.equal(slow.destroyed, true);
  assert.equal(clients.size, 0);
});

test('the trace channel delivers every frame of a burst to connectRuntime().trace.subscribe, and flush waits for them', async (t) => {
  const traces = createTraceStore({ settings: { level: 'summary' } });
  const channel = createTraceChannel(traces);
  const routes = createTraceRoutes({ traces, csrf: () => CSRF });
  const SPANS = 50;
  const wide = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`note${index}`, 'y'.repeat(2000)]));
  let flushed = null;
  const origin = await serve(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (await routes(req, res, url)) return;
    if (url.pathname === '/_sim/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ csrf: CSRF }));
    }
    if (url.pathname === '/_sim/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ sourceDir: null }));
    }
    if (url.pathname === '/_sim/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      channel(res);
      // About 3 MB of frames in one synchronous burst: a start, an end and a trace-end frame per span.
      for (let index = 0; index < SPANS; index++)
        traces.start({ kind: 'http', name: `GET /burst/${index}`, attributes: wide }).end();
      flushed = traces.flush().then(() => res.end());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const client = await connectRuntime({ origin });
  const ends = [];
  const unsubscribe = client.trace.subscribe((event) => {
    if (event.type === 'span-end') ends.push(event.span.name);
  });
  await unsubscribe.closed;
  await flushed;
  assert.equal(ends.length, SPANS, 'every span-end frame arrived');
  assert.deepEqual(
    ends,
    Array.from({ length: SPANS }, (_, index) => `GET /burst/${index}`),
  );
  assert.equal(traces.status().listeners, 0, 'the channel stops observing once its client left');
  // POST /trace/flush through the testing client answers the status after the store flushed.
  assert.deepEqual((await client.trace.flush()).retained, traces.status().retained);
});

test('traces.flush settles only after every subscriber flush and queued persisted line settled', async () => {
  const traces = createTraceStore({ settings: { level: 'summary' } });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  traces.subscribe(() => {}, { flush: () => gate });
  traces.subscribe(() => {}, { flush: () => Promise.reject(new Error('Invented flush failure.')) });
  traces.subscribe(() => {}); // no flush: not waited for
  let settled = false;
  const flushing = traces.flush().then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'flush waits for the pending subscriber');
  release();
  await flushing;
  assert.equal(settled, true, 'a rejecting subscriber flush never rejects flush');
  assert.throws(() => traces.subscribe(() => {}, { flush: 'soon' }), TypeError);
});

test('traces.flush waits for a persisted line queued while it waits', async (t) => {
  const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'paqvilo-trace-flush-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const traces = createTraceStore({ settings: { level: 'summary', persist: true }, stateDirectory: directory });
  traces.start({ kind: 'http', name: 'GET /first' }).end();
  const flushing = traces.flush();
  traces.start({ kind: 'http', name: 'GET /second' }).end();
  await flushing;
  const [file] = await readdir(path.join(directory, 'traces'));
  const lines = (await readFile(path.join(directory, 'traces', file), 'utf8')).trim().split('\n');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).trace.root.name),
    ['GET /first', 'GET /second'],
  );
  assert.equal(traces.status().persist.written, 2);
});
