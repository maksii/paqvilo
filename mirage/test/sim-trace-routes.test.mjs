// /_sim/api/trace (lib/sim-trace-routes.mjs): every read, settings and clear, CSRF on mutations, 400 on invalid filters and
// settings, 404 on unknown ids and 501 without a trace store, sort passthrough, the reserved-name tree route, the streamed
// json/ndjson/otlp export and the /_sim/events trace channel (cleanup, payload-free frames, slow clients). Time comes
// from an injected clock; channel tests wait on stream events, never on time.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { finished as finishedStream } from 'node:stream/promises';
import { createTraceStore } from '../lib/trace-store.mjs';
import { createTraceChannel, createTraceRoutes, routes as TRACE_ROUTES } from '../lib/sim-trace-routes.mjs';

const CSRF = 'invented-csrf';

function populate(traces, advance) {
  const root = traces.start({ kind: 'http', name: 'GET /invented', module: 'portal', operation: 'get' });
  traces.run(root, () => {
    const child = traces.start({ kind: 'dataverse', name: 'Create x_item', entity: 'x_item', operation: 'create' });
    advance(4);
    child.end();
  });
  advance(2);
  root.end({ attributes: { statusCode: 200 } });
  const failed = traces.start({ kind: 'http', name: 'POST /invented', module: 'portal', operation: 'post' });
  advance(1);
  failed.fail(Object.assign(new Error('Invented failure.'), { code: 'InventedError' }));
  return { root, failed };
}

async function fixture(t, { traces: given } = {}) {
  let time = Date.parse('2026-02-01T10:00:00.000Z');
  const traces = given === undefined ? createTraceStore({ settings: { level: 'full' }, now: () => time }) : given;
  const seeded = traces ? populate(traces, (ms) => (time += ms)) : null;
  const handler = createTraceRoutes({ traces, csrf: () => CSRF });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res, new URL(req.url, 'http://127.0.0.1')))) {
      res.writeHead(404);
      res.end('not mine');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      body: /^application\/json/.test(response.headers.get('content-type') ?? '') ? JSON.parse(text) : text,
    };
  };
  return { traces, call, ...seeded };
}

test('the router publishes its prefix and leaves other paths alone', async (t) => {
  assert.deepEqual(TRACE_ROUTES, ['/trace']);
  const { call } = await fixture(t);
  assert.equal((await call('GET', '/_sim/api/traces')).text, 'not mine');
  assert.equal((await call('GET', '/_sim/api/flow-runs')).text, 'not mine');
  assert.equal((await call('GET', '/trace')).text, 'not mine');
  assert.equal((await call('GET', '/__sim/api/trace')).status, 200);
});

test('list, spans, stats, tree, span and export answer the store views', async (t) => {
  const { call, root, failed } = await fixture(t);
  const list = await call('GET', '/_sim/api/trace');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal(list.body.total, 2);
  assert.deepEqual(
    list.body.items.map((item) => item.traceId),
    [failed.traceId, root.traceId],
  );
  const errors = await call('GET', '/_sim/api/trace?hasErrors=true');
  assert.deepEqual(
    errors.body.items.map((item) => item.traceId),
    [failed.traceId],
  );
  const entity = await call('GET', '/_sim/api/trace?entity=X_ITEM&pageSize=1');
  assert.equal(entity.body.total, 1);
  assert.equal(entity.body.items[0].root.spanId, root.spanId);

  const spans = await call('GET', `/_sim/api/trace/spans?traceId=${root.traceId}&order=asc`);
  assert.deepEqual(
    spans.body.items.map((span) => span.kind),
    ['http', 'dataverse'],
  );
  const stats = await call('GET', '/_sim/api/trace/stats?kind=http');
  assert.equal(stats.body.count, 2);
  assert.equal(stats.body.byStatus.error.count, 1);
  assert.equal(stats.body.errors[0].spanId, failed.spanId);

  const tree = await call('GET', `/_sim/api/trace/${encodeURIComponent(root.traceId)}`);
  assert.equal(tree.status, 200);
  assert.equal(tree.body.root.spanId, root.spanId);
  assert.equal(tree.body.children[0].children[0].kind, 'dataverse');
  const span = await call('GET', `/_sim/api/trace/span/${failed.spanId}`);
  assert.deepEqual(span.body.error, { code: 'InventedError', message: 'Invented failure.' });

  const exported = await call('GET', '/_sim/api/trace/export?status=error');
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="simulator-traces.json"');
  assert.deepEqual(
    exported.body.traces.map((trace) => trace.trace.traceId),
    [failed.traceId],
  );
  assert.equal(exported.body.settings.level, 'full');
});

test('unknown ids are 404 and invalid filters are 400 InvalidTraceFilter', async (t) => {
  const { call } = await fixture(t);
  const trace = await call('GET', '/_sim/api/trace/invented-unknown');
  assert.equal(trace.status, 404);
  assert.equal(trace.body.error.code, 'TraceNotFound');
  assert.equal((await call('GET', '/_sim/api/trace/span/invented-unknown')).body.error.code, 'SpanNotFound');
  for (const query of ['from=yesterday', 'pageSize=0', 'hasErrors=maybe', 'order=sideways', 'minDurationMs=-1']) {
    const answer = await call('GET', `/_sim/api/trace?${query}`);
    assert.equal(answer.status, 400, query);
    assert.equal(answer.body.error.code, 'InvalidTraceFilter', query);
    assert.match(answer.body.error.message, new RegExp(`^${query.split('=')[0]} `), query);
  }
  assert.equal((await call('GET', '/_sim/api/trace/stats?bucketMs=0')).status, 400);
  assert.equal((await call('GET', '/_sim/api/trace/span/%E0%A4%A')).body.error.code, 'InvalidRequest');
});

test('settings change at run time behind the CSRF token; invalid settings are 400 and keep the old value', async (t) => {
  const { call, traces } = await fixture(t);
  const read = await call('GET', '/_sim/api/trace/settings');
  assert.equal(read.body.settings.level, 'full');
  assert.equal(read.body.status.retained, 2);

  const forbidden = await call('PUT', '/_sim/api/trace/settings', { level: 'off' });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'Forbidden');
  assert.equal(traces.settings().level, 'full');

  const changed = await call(
    'PUT',
    '/_sim/api/trace/settings',
    { level: 'summary', traces: 10 },
    { 'x-sim-csrf': CSRF },
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.body.settings.level, 'summary');
  assert.equal(changed.body.settings.traces, 10);
  assert.equal(traces.settings().level, 'summary');

  for (const bad of [{ level: 'loud' }, { traces: 1 }, { invented: true }, []]) {
    const answer = await call('PUT', '/_sim/api/trace/settings', bad, { 'x-sim-csrf': CSRF });
    assert.equal(answer.status, 400, JSON.stringify(bad));
    assert.match(answer.body.error.code, /^Invalid(?:TraceSettings|Request)$/);
  }
  assert.equal((await call('PUT', '/_sim/api/trace/settings', '{', { 'x-sim-csrf': CSRF })).status, 400);
  assert.deepEqual(traces.settings(), { ...changed.body.settings });
  assert.equal((await call('POST', '/_sim/api/trace/settings', {}, { 'x-sim-csrf': CSRF })).status, 405);
});

test('clear needs POST and the CSRF token and drops every trace', async (t) => {
  const { call, traces } = await fixture(t);
  assert.equal((await call('POST', '/_sim/api/trace/clear')).status, 403);
  assert.equal((await call('GET', '/_sim/api/trace/clear')).status, 405);
  assert.equal(traces.status().retained, 2);
  const cleared = await call('POST', '/_sim/api/trace/clear', undefined, { 'x-sim-csrf': CSRF });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.retained, 0);
  assert.equal((await call('GET', '/_sim/api/trace')).body.total, 0);
  assert.equal((await call('DELETE', '/_sim/api/trace', undefined, { 'x-sim-csrf': CSRF })).status, 405);
});

test('a runtime without a trace store answers 501 TraceNotConfigured', async (t) => {
  const { call } = await fixture(t, { traces: null });
  const answer = await call('GET', '/_sim/api/trace');
  assert.equal(answer.status, 501);
  assert.equal(answer.body.error.code, 'TraceNotConfigured');
});

test('GET /trace passes sort and order to the store', async (t) => {
  const { call, root, failed } = await fixture(t);
  // root: 6 ms and 2 spans; failed: 1 ms, 1 span and an error.
  for (const [query, expected] of [
    ['sort=duration', [root, failed]],
    ['sort=duration&order=asc', [failed, root]],
    ['sort=spans', [root, failed]],
    ['sort=errors', [failed, root]],
    ['sort=start&order=asc', [root, failed]],
  ]) {
    const answer = await call('GET', `/_sim/api/trace?${query}`);
    assert.equal(answer.status, 200, query);
    assert.deepEqual(
      answer.body.items.map((item) => item.traceId),
      expected.map((span) => span.traceId),
      query,
    );
  }
  const refused = await call('GET', '/_sim/api/trace?sort=sideways');
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'InvalidTraceFilter');
});

test('a trace id that equals a route name is read at /trace/id/<traceId>; /trace/<id> answers UUIDs only', async (t) => {
  const { call, traces, root } = await fixture(t);
  traces.start({ kind: 'http', name: 'GET /reserved', traceId: 'stats' }).end();
  const stats = await call('GET', '/_sim/api/trace/stats');
  assert.equal(stats.status, 200);
  assert.equal(typeof stats.body.count, 'number');
  const tree = await call('GET', '/_sim/api/trace/id/stats');
  assert.equal(tree.status, 200);
  assert.equal(tree.body.trace.traceId, 'stats');
  assert.equal(tree.body.root.name, 'GET /reserved');
  const canonical = await call('GET', `/_sim/api/trace/id/${root.traceId}`);
  const short = await call('GET', `/_sim/api/trace/${root.traceId}`);
  assert.equal(canonical.status, 200);
  assert.deepEqual(short.body, canonical.body);
  traces.start({ kind: 'http', name: 'GET /named', traceId: 'invented-named' }).end();
  const named = await call('GET', '/_sim/api/trace/invented-named');
  assert.equal(named.status, 404);
  assert.equal(named.body.error.code, 'TraceNotFound');
  assert.match(named.body.error.message, /\/trace\/id\/<traceId>/);
  assert.equal((await call('GET', '/_sim/api/trace/id/invented-named')).status, 200);
  assert.equal((await call('GET', '/_sim/api/trace/id/invented-unknown')).body.error.code, 'TraceNotFound');
});

// A store with `count` ended single-span traces, one per 10 ms.
function many(count) {
  let time = Date.parse('2026-02-01T10:00:00.000Z');
  const traces = createTraceStore({ settings: { level: 'full', traces: count + 10 }, now: () => time });
  for (let index = 0; index < count; index++) {
    const span = traces.start({ kind: 'http', name: `GET /item/${index}`, module: 'portal', input: () => ({ index }) });
    span.event('page', { attributes: { index } });
    time += 10;
    span.end({ attributes: { statusCode: 200 } });
  }
  return traces;
}

test('export streams json, ndjson and otlp, bounded by limit (default 200, at most 2000)', async (t) => {
  const { call, root, failed } = await fixture(t);
  const json = await call('GET', '/_sim/api/trace/export?format=json&sort=duration');
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-type'), /^application\/json/);
  assert.equal(json.headers.get('x-trace-export-matched'), '2');
  assert.deepEqual(Object.keys(json.body), ['exportedAt', 'settings', 'traces']);
  assert.deepEqual(
    json.body.traces.map((tree) => tree.trace.traceId),
    [root.traceId, failed.traceId],
  );
  assert.equal(json.body.traces[0].children[0].children[0].kind, 'dataverse');

  const ndjson = await call('GET', '/_sim/api/trace/export?format=ndjson&order=asc');
  assert.match(ndjson.headers.get('content-type'), /^application\/x-ndjson/);
  assert.equal(ndjson.headers.get('content-disposition'), 'attachment; filename="simulator-traces.ndjson"');
  const lines = ndjson.text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => [Object.keys(line), line.trace.traceId, line.spans.length]),
    [
      [['trace', 'spans'], root.traceId, 2],
      [['trace', 'spans'], failed.traceId, 1],
    ],
  );

  const otlp = await call('GET', `/_sim/api/trace/export?format=otlp&traceId=${root.traceId}`);
  assert.equal(otlp.headers.get('content-disposition'), 'attachment; filename="simulator-traces.otlp.json"');
  const [resource] = otlp.body.resourceSpans;
  assert.deepEqual(resource.resource.attributes, [{ key: 'service.name', value: { stringValue: 'paqvilo-mirage' } }]);
  const [server, child] = resource.scopeSpans[0].spans;
  assert.equal(server.traceId, root.traceId.replaceAll('-', ''));
  assert.match(server.spanId, /^[0-9a-f]{16}$/);
  assert.equal(server.parentSpanId, undefined);
  assert.equal(child.parentSpanId, server.spanId);
  assert.equal(child.traceId, server.traceId);
  assert.deepEqual([server.kind, child.kind], [2, 1]);
  assert.deepEqual(server.status, { code: 1 });
  assert.equal(BigInt(server.endTimeUnixNano) - BigInt(server.startTimeUnixNano), 6_000_000n);
  assert.equal(server.startTimeUnixNano, String(BigInt(Date.parse('2026-02-01T10:00:00.000Z')) * 1_000_000n));
  const attribute = (span, key) => span.attributes.find((item) => item.key === key)?.value;
  assert.deepEqual(attribute(server, 'mirage.span_id'), { stringValue: root.spanId });
  assert.deepEqual(attribute(server, 'statusCode'), { intValue: '200' });
  assert.deepEqual(attribute(child, 'mirage.entity'), { stringValue: 'x_item' });
  // The same span maps to the same OTLP id on every export.
  const again = await call('GET', `/_sim/api/trace/export?format=otlp&traceId=${root.traceId}`);
  assert.equal(again.body.resourceSpans[0].scopeSpans[0].spans[0].spanId, server.spanId);
  const failedOtlp = await call('GET', `/_sim/api/trace/export?format=otlp&traceId=${failed.traceId}`);
  assert.deepEqual(failedOtlp.body.resourceSpans[0].scopeSpans[0].spans[0].status, {
    code: 2,
    message: 'Invented failure.',
  });

  for (const query of ['format=xml', 'limit=0', 'limit=2001', 'limit=ten', 'sort=sideways']) {
    const answer = await call('GET', `/_sim/api/trace/export?${query}`);
    assert.equal(answer.status, 400, query);
    assert.equal(answer.body.error.code, 'InvalidTraceFilter', query);
  }
});

test('export pages past 200 traces, stops at limit and carries events and inputs into otlp', async (t) => {
  // The fixture adds its two traces after the 230 of many().
  const { call } = await fixture(t, { traces: many(230) });
  const all = await call('GET', '/_sim/api/trace/export?format=ndjson&limit=2000');
  assert.equal(all.headers.get('x-trace-export-matched'), '232');
  assert.equal(all.text.trimEnd().split('\n').length, 232);
  const bounded = await call('GET', '/_sim/api/trace/export?format=json&order=asc');
  assert.equal(bounded.body.traces.length, 200);
  assert.equal(bounded.body.traces.at(-1).trace.root.name, 'GET /item/199');
  const five = await call('GET', '/_sim/api/trace/export?format=otlp&limit=5&order=asc');
  const spans = five.body.resourceSpans[0].scopeSpans[0].spans;
  assert.deepEqual(
    spans.map((span) => span.name),
    ['GET /item/0', 'GET /item/1', 'GET /item/2', 'GET /item/3', 'GET /item/4'],
  );
  assert.equal(spans[0].events[0].name, 'page');
  assert.deepEqual(spans[0].events[0].attributes, [{ key: 'index', value: { intValue: '0' } }]);
  assert.deepEqual(spans[0].attributes.find((item) => item.key === 'mirage.input').value, {
    stringValue: '{"index":0}',
  });
});

// A response stand-in for the router: a Writable that accepts one byte before reporting a full buffer.
function slowResponse(chunks) {
  const res = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      setImmediate(callback);
    },
  });
  res.writeHead = (status) => {
    res.statusCode = status;
    res.headersSent = true;
  };
  return res;
}
const exportUrl = new URL('http://127.0.0.1/_sim/api/trace/export?format=ndjson');

test('export writes with backpressure and stops reading traces when the client goes away', async () => {
  const traces = many(40);
  const chunks = [];
  const res = slowResponse(chunks);
  let drains = 0;
  res.on('drain', () => drains++);
  await createTraceRoutes({ traces, csrf: () => CSRF })({ method: 'GET', headers: {} }, res, exportUrl);
  await finishedStream(res);
  assert.equal(res.statusCode, 200);
  assert.equal(chunks.join('').trimEnd().split('\n').length, 40);
  assert.ok(drains >= 40, `waited for drain ${drains} times`);

  let trees = 0;
  const counting = { query: traces.query, settings: traces.settings, tree: (id) => (trees++, traces.tree(id)) };
  const gone = slowResponse([]);
  gone.once('drain', () => gone.destroy());
  await createTraceRoutes({ traces: counting, csrf: () => CSRF })({ method: 'GET', headers: {} }, gone, exportUrl);
  assert.ok(trees < 40, `read ${trees} trees after the client left`);
});

// The /_sim/events host side: an HTTP server that attaches the trace channel to each event stream, optionally after the
// gate resolves (the host awaiting its own setup).
async function channelServer(t, traces, { gate = null } = {}) {
  const attach = createTraceChannel(traces);
  const attached = [];
  const server = http.createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    if (gate) await gate(res);
    attach(res);
    attached.push(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/_sim/events?channels=trace`, attached };
}

test('the trace channel never subscribes for a client that left before the first frame', async (t) => {
  const traces = createTraceStore({ settings: { level: 'full' } });
  let attachedAfterClose;
  const done = new Promise((resolve) => (attachedAfterClose = resolve));
  // The host's await outlasts the client: the response has closed before attach runs.
  const { url, attached } = await channelServer(t, traces, {
    gate: async (res) => {
      if (!res.destroyed) await once(res, 'close');
      setImmediate(attachedAfterClose);
    },
  });
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  controller.abort();
  await done;
  assert.equal(attached.length, 1);
  assert.equal(attached[0].destroyed, true);
  assert.equal(traces.status().listeners, 0);
  traces.start({ kind: 'http', name: 'after' }).end();
  assert.equal(traces.status().listeners, 0);
});

test('the trace channel unsubscribes when its last client disconnects and sends payload-free frames', async (t) => {
  const traces = createTraceStore({ settings: { level: 'full' } });
  const { url, attached } = await channelServer(t, traces);
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (pattern) => {
    while (!pattern.test(text)) text += decoder.decode((await reader.read()).value, { stream: true });
  };
  await until(/"type":"connected"/);
  assert.equal(traces.status().listeners, 1);
  const span = traces.start({ kind: 'http', name: 'GET /payload', input: () => ({ invented: 'value' }) });
  span.output(() => ({ answer: 1 }));
  span.end();
  await until(/"type":"trace-end"[^\n]*\n\n/);
  const frames = text
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: trace'))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)));
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ['connected', 'span-start', 'span-end', 'trace-end'],
  );
  for (const frame of frames.slice(1)) {
    assert.equal('input' in frame.span, false, frame.type);
    assert.equal('output' in frame.span, false, frame.type);
  }
  assert.equal('input' in frames[3].trace.root, false);
  assert.deepEqual(traces.tree(span.traceId).root.input, { invented: 'value' }, 'the store keeps the payload');
  const ended = finishedStream(attached[0]).catch(() => {});
  controller.abort();
  await ended;
  assert.equal(traces.status().listeners, 0);
});

test('the trace channel drops a client whose writes report a full buffer three times in a row', async () => {
  const traces = createTraceStore({ settings: { level: 'summary' } });
  const attach = createTraceChannel(traces);
  // A client that never reads: the connected frame fills its buffer, and every later write reports it full.
  const stuck = new Writable({ highWaterMark: 1, write() {} });
  const healthy = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  attach(stuck);
  attach(healthy);
  assert.equal(traces.status().listeners, 1);
  traces.start({ kind: 'http', name: 'one' });
  traces.start({ kind: 'http', name: 'two' });
  assert.equal(stuck.destroyed, false);
  traces.start({ kind: 'http', name: 'three' });
  assert.equal(stuck.destroyed, true);
  assert.equal(healthy.destroyed, false);
  assert.equal(traces.status().listeners, 1, 'the healthy client keeps the subscription');
  healthy.destroy();
  await finishedStream(healthy).catch(() => {});
  assert.equal(traces.status().listeners, 0);

  const destroyed = new Writable({ write() {} });
  destroyed.destroy();
  attach(destroyed);
  assert.equal(traces.status().listeners, 0);
});
