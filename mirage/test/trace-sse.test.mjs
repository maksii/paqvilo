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

test('a reader that meets back-pressure on every frame stays and receives every frame', async () => {
  const clients = sseClients();
  // highWaterMark 1 KB and frames of 20 KB: every write is refused, and the reader takes 512 bytes per turn, so each
  // frame is a drain cycle of its own (a small kernel socket buffer does the same to a healthy reader).
  const received = [];
  const reader = new Writable({
    highWaterMark: 1024,
    write(chunk, _encoding, done) {
      const take = (offset) => {
        if (offset >= chunk.length) {
          received.push(chunk.toString());
          return done();
        }
        setImmediate(() => take(offset + 512));
      };
      take(0);
    },
  });
  clients.add(reader);
  const frame = (index) => `event: burst\ndata: ${index} ${'z'.repeat(20 * 1024)}\n\n`;
  let refused = 0;
  const closed = once(reader, 'close'); // a dropped reader never drains: wait for whichever comes first
  for (let index = 0; index < 50; index++) {
    const drained = Promise.race([once(reader, 'drain'), closed]);
    const before = reader.writableNeedDrain;
    clients.send(frame(index));
    if (!before && reader.writableNeedDrain) refused++;
    await drained; // the next event arrives once the reader caught up: one drain cycle per frame
    assert.equal(reader.destroyed, false, `frame ${index} keeps the reader`);
  }
  assert.equal(refused, 50, 'every frame met back-pressure');
  // Ten more in one synchronous burst, without waiting: the refused writes are queued, never skipped, and flush
  // resolves only once the last of them reached the reader (after its last drain), not when the writes were issued.
  for (let index = 50; index < 60; index++) clients.send(frame(index));
  assert.ok(reader.writableLength > 0, 'frames are still queued when flush is called');
  await clients.flush();
  assert.equal(reader.writableLength, 0);
  assert.deepEqual(
    received.filter((chunk) => chunk.startsWith('event: burst')).map((chunk) => Number(chunk.split(' ')[2])),
    Array.from({ length: 60 }, (_, index) => index),
  );
  assert.equal(clients.size, 1);
  clients.end();
});

test('a blocked event loop never drops a reader that takes bytes once the loop is free', () => {
  let clock = 0;
  const checks = [];
  // The stall checks run when the test runs them, as the event loop would once it is free again.
  const clients = sseClients({ now: () => clock, stallMs: 5000, defer: (fn) => checks.push(fn) });
  const runChecks = () => checks.splice(0).forEach((fn) => fn());
  // highWaterMark 16: every frame is refused; the test completes the reader's writes by hand.
  const pending = [];
  const reader = new Writable({
    highWaterMark: 16,
    write(_chunk, _encoding, done) {
      pending.push(done);
    },
  });
  clients.add(reader);
  clients.send(`event: a\ndata: ${'x'.repeat(64)}\n\n`); // refused at 0 ms: the stall clock starts
  clock = 6000; // a synchronous burst held the loop for 6 s, so the reader could take nothing
  for (let index = 0; index < 20; index++) clients.send(`event: a\ndata: ${index}\n\n`);
  assert.equal(reader.destroyed, false, 'sending inside the blocked stretch drops nobody');
  pending.shift()(); // the loop is free: the reader takes the first frame
  runChecks();
  assert.equal(reader.destroyed, false, 'progress at the first check after the block keeps the reader');
  assert.equal(clients.size, 1);
  clock = 11_000; // 5 s with a free loop and nothing more taken: still within the limit
  runChecks();
  assert.equal(reader.destroyed, false);
  clock = 11_001;
  runChecks();
  assert.equal(reader.destroyed, true, 'a reader that took nothing past the limit while the loop was free is dropped');
  assert.equal(clients.size, 0);
  assert.equal(checks.length, 0, 'no check outlives the client');
});

test('a reader still taking a large write that has not completed is making progress', () => {
  let clock = 0;
  const checks = [];
  const drops = [];
  const clients = sseClients({
    now: () => clock,
    stallMs: 5000,
    defer: (fn) => checks.push(fn),
    onDrop: (_res, reason) => drops.push(reason),
  });
  const runChecks = (info) => checks.splice(0).forEach((fn) => fn(info));
  // A corked burst is one writev: writableLength stays put until the kernel took all of it, while the libuv write
  // queue of the socket falls as the peer reads.
  const handle = { writeQueueSize: 0 };
  const res = new Writable({ highWaterMark: 16, write() {} });
  res.socket = { _handle: handle };
  clients.add(res);
  clients.send(`event: a\ndata: ${'x'.repeat(4096)}\n\n`); // refused at 0 ms
  handle.writeQueueSize = 3_000_000; // the burst is dispatched once the loop is free
  for (const [at, queued] of [
    [1000, 3_000_000],
    [4000, 2_000_000],
    [8000, 600_000],
    [12_000, 100_000],
  ]) {
    clock = at;
    handle.writeQueueSize = queued;
    runChecks();
    assert.equal(res.destroyed, false, `the reader keeps reading at ${at} ms`);
  }
  assert.equal(res.writableLength > 0, true, 'nothing completed, yet the reader was never taken for stalled');
  clock = 17_001; // the queue stopped shrinking 5 s ago with a free loop
  runChecks();
  assert.equal(res.destroyed, true);
  assert.deepEqual(drops, ['stalled']);
});

test('a check that ran late because the loop was blocked never counts that stretch as a stall', () => {
  let clock = 0;
  const checks = [];
  const clients = sseClients({ now: () => clock, stallMs: 5000, defer: (fn) => checks.push(fn) });
  const runChecks = (info) => checks.splice(0).forEach((fn) => fn(info));
  const res = new Writable({ highWaterMark: 16, write() {} });
  clients.add(res);
  clients.send(`event: a\ndata: ${'x'.repeat(64)}\n\n`); // refused at 0 ms
  clock = 60_000; // the loop was blocked for a minute: the first check after it runs late and has seen no I/O yet
  runChecks({ late: true });
  assert.equal(res.destroyed, false, 'the blocked minute is not a stall');
  clock = 65_000;
  runChecks();
  assert.equal(res.destroyed, false, '5 s of a free loop is the limit, not past it');
  clock = 65_001;
  runChecks();
  assert.equal(res.destroyed, true, 'past it with nothing taken while the loop was free');
});

test('the trace channel delivers every frame of a burst to connectRuntime().trace.subscribe, and flush waits for them', async (t) => {
  const traces = createTraceStore({ settings: { level: 'summary' } });
  // Diagnostics for a failure on a hosted runner: every drop with its reason, the response at flush and at close.
  const diagnostics = { drops: [], atFlush: null, atClose: null, clientError: null };
  const facts = (res) => ({
    writableLength: res.writableLength,
    writableEnded: res.writableEnded,
    destroyed: res.destroyed,
  });
  const channel = createTraceChannel(traces, {
    onDrop: (res, reason) => diagnostics.drops.push({ reason, ...facts(res) }),
  });
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
      res.on('close', () => (diagnostics.atClose = facts(res)));
      channel(res);
      // About 3 MB of frames in one synchronous burst: a start, an end and a trace-end frame per span.
      for (let index = 0; index < SPANS; index++)
        traces.start({ kind: 'http', name: `GET /burst/${index}`, attributes: wide }).end();
      flushed = traces.flush().then(() => {
        diagnostics.atFlush = facts(res);
        res.end();
      });
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
  await unsubscribe.closed.catch((error) => (diagnostics.clientError = { code: error.code, message: error.message }));
  await flushed;
  const report = JSON.stringify({ received: ends.length, ...diagnostics });
  assert.equal(ends.length, SPANS, `every span-end frame arrived: ${report}`);
  assert.deepEqual(
    diagnostics.drops.filter((drop) => drop.reason !== 'closed'),
    [],
    `no client was dropped: ${report}`,
  );
  assert.equal(diagnostics.atFlush?.writableLength, 0, `flush resolved once every byte left: ${report}`);
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

test('connectRuntime names a connection the runtime dropped apart from a runtime that never answered', async (t) => {
  const origin = await serve(t, (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/_sim/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ sourceDir: null }));
    }
    if (url.pathname === '/_sim/api/trace') {
      // Headers and half a body, then the socket goes away.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      return res.write('{"items":[', () => res.socket.destroy());
    }
    // Accepted, then closed before any answer.
    req.socket.destroy();
  });
  const client = await connectRuntime({ origin });
  const message = `The Mirage runtime at ${origin} closed the connection before the response completed.`;
  await assert.rejects(client.trace.query(), (error) => {
    assert.deepEqual([error.code, error.message], ['RuntimeConnectionLost', message]);
    assert.ok(error.cause instanceof TypeError);
    return true;
  });
  await assert.rejects(client.trace.spans(), { code: 'RuntimeConnectionLost', message });
  await assert.rejects(client.trace.export(), { code: 'RuntimeConnectionLost', message });

  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(connectRuntime({ origin: `http://127.0.0.1:${port}` }), (error) => {
    assert.deepEqual(
      [error.code, error.message],
      ['RuntimeUnreachable', `No Mirage runtime answers at http://127.0.0.1:${port}; start one or pass --origin.`],
    );
    assert.ok(error.cause instanceof TypeError);
    return true;
  });
});
