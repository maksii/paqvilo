// The trace store (lib/trace-store.mjs): span nesting, request-context fallback, explicit async parenting, levels,
// redaction, caps, queries, statistics, events, export and persistence. Time comes from an injected clock, so every
// duration below is exact; no assertion depends on how fast the host runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SPAN_KINDS,
  SPAN_STATUSES,
  checkTraceFilters,
  createTraceStore,
  recordHttpError,
  redactPayload,
  statusFromHttp,
} from '../lib/trace-store.mjs';
import { createRequestContext, runWithRequest } from '../lib/request-context.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const START = Date.parse('2026-02-01T10:00:00.000Z');
function clock() {
  let time = START;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
    set: (ms) => {
      time = ms;
    },
  };
}
const store = (settings = {}, options = {}) => {
  const time = clock();
  return { time, traces: createTraceStore({ settings, now: time.now, ...options }) };
};
const invalidFilter = (fn, key) =>
  assert.throws(fn, (error) => {
    assert.ok(error instanceof RangeError, key);
    assert.equal(error.status, 400, key);
    assert.equal(error.code, 'InvalidTraceFilter', key);
    assert.match(error.message, new RegExp(`^${key} `));
    assert.equal(error.parameter, key, key);
    return true;
  });

test('spans nest through run and wrap, and tree and ancestry follow the parents', async () => {
  const { time, traces } = store();
  assert.equal(traces.enabled, true);
  assert.equal(traces.current(), null);
  const root = traces.start({ kind: 'http', name: 'POST /_api/x_items', module: 'portal', operation: 'POST' });
  let inner, leaf;
  await traces.run(root, async () => {
    assert.equal(traces.current(), root);
    inner = traces.start({
      kind: 'dataverse',
      name: 'Create x_item',
      module: 'dataverse',
      operation: 'create',
      entity: 'x_item',
    });
    await traces.run(inner, async () => {
      await traces.wrap({ kind: 'plugin-step', name: 'Invented.PreCreate', module: 'plugins' }, async (span) => {
        leaf = span;
        assert.equal(traces.current(), span);
        time.advance(5);
      });
    });
    time.advance(3);
    inner.end({ attributes: { rowCount: 1 } });
  });
  assert.equal(traces.current(), null, 'run restores the previous current span');
  time.advance(2);
  root.end({ attributes: { statusCode: 204 } });

  assert.equal(inner.parentSpanId, root.spanId);
  assert.equal(leaf.parentSpanId, inner.spanId);
  assert.equal(new Set([root.traceId, inner.traceId, leaf.traceId]).size, 1);
  const tree = traces.tree(root.traceId);
  assert.equal(tree.root.spanId, root.spanId);
  assert.deepEqual(
    tree.spans.map((span) => [span.kind, span.depth, span.sequence, span.durationMs, span.status]),
    [
      ['http', 0, 1, 10, 'ok'],
      ['dataverse', 1, 2, 8, 'ok'],
      ['plugin-step', 2, 3, 5, 'ok'],
    ],
  );
  assert.equal(tree.spans[0].operation, 'post', 'operations are lowercase');
  assert.equal(tree.spans[0].startedAt, '2026-02-01T10:00:00.000Z');
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].children[0].children[0].spanId, leaf.spanId);
  assert.equal(tree.trace.spanCount, 3);
  assert.equal(tree.trace.pluginCount, 1);
  assert.equal(tree.trace.dataverseCount, 1);
  assert.equal(tree.trace.totalDurationMs, 10);
  assert.equal(tree.trace.ended, true);
  assert.deepEqual(tree.trace.entities, ['x_item']);
  assert.deepEqual(tree.trace.kinds, { http: 1, dataverse: 1, 'plugin-step': 1 });
  assert.deepEqual(
    traces.ancestry(leaf.spanId).map((span) => span.spanId),
    [root.spanId, inner.spanId, leaf.spanId],
  );
  assert.deepEqual(traces.ancestry('unknown'), []);
  assert.equal(traces.tree('unknown'), null);
  assert.equal(traces.span(inner.spanId).attributes.rowCount, 1);
  assert.equal(traces.span('unknown'), null);
  // Copies never expose the live record.
  traces.span(root.spanId).attributes.statusCode = 500;
  assert.equal(traces.span(root.spanId).attributes.statusCode, 204);
});

test('without a current span the request context supplies the trace and the parent', () => {
  const { traces } = store();
  const root = traces.start({ kind: 'http', name: 'GET /', actor: { kind: 'contact', id: 'C1', name: 'Invented' } });
  const context = createRequestContext({
    traceId: root.traceId,
    spanId: root.spanId,
    initiator: { kind: 'contact', id: 'C1' },
  });
  assert.equal(context.child().spanId, root.spanId, 'child() keeps the span ids');
  assert.equal(context.with({ inBatch: true }).traceId, root.traceId, 'with() keeps the span ids');
  assert.ok(Object.isFrozen(context));
  assert.equal(createRequestContext().traceId, null);
  assert.equal(createRequestContext().spanId, null);
  runWithRequest(context, () => {
    assert.equal(traces.current(), root, 'current() resolves the request context span');
    const nested = traces.start({ kind: 'store', name: 'query x_item' });
    assert.equal(nested.parentSpanId, root.spanId);
    assert.equal(nested.traceId, root.traceId);
    const record = traces.span(nested.spanId);
    assert.equal(record.depth, 1);
    assert.deepEqual(record.actor, { kind: 'contact', id: 'C1', name: 'Invented' }, 'the actor is inherited');
    nested.end();
  });
  // A request context with a trace id but no span starts a parentless span in that trace.
  runWithRequest(createRequestContext({ traceId: 'invented-trace', initiator: { kind: 'app', id: 'A1' } }), () => {
    const span = traces.start({ kind: 'dataverse', name: 'Retrieve' });
    assert.equal(span.traceId, 'invented-trace');
    assert.equal(span.parentSpanId, null);
    assert.deepEqual(traces.span(span.spanId).actor, { kind: 'app', id: 'A1', name: null });
    span.end();
  });
  root.end();
});

test('an async job parents explicitly, ignores the ambient span and re-opens its trace', async () => {
  const { time, traces } = store();
  const ends = [];
  traces.subscribe((event) => event.type === 'trace-end' && ends.push(event.trace));
  const root = traces.start({ kind: 'http', name: 'POST /_api/x_items' });
  const staging = traces.run(root, () => traces.start({ kind: 'dataverse', name: 'Create x_item' }));
  staging.event('job-staged', { attributes: { kind: 'plugin' } });
  staging.end();
  root.end();
  assert.equal(ends.length, 1);
  assert.equal(ends[0].ended, true);

  const unrelated = traces.start({ kind: 'http', name: 'GET /other' });
  time.advance(100);
  const job = await traces.run(unrelated, async () =>
    traces.start({
      kind: 'job',
      name: 'Invented async step',
      traceId: root.traceId,
      parentSpanId: staging.spanId,
      async: true,
    }),
  );
  assert.equal(job.traceId, root.traceId);
  assert.equal(job.parentSpanId, staging.spanId, 'the explicit parent wins over the current span');
  assert.equal(traces.query({ traceId: root.traceId }).items[0].status, 'running', 'the trace re-opened');
  const step = traces.run(job, () => traces.start({ kind: 'plugin-step', name: 'Invented.PostCreate' }));
  step.end();
  time.advance(4);
  job.end();
  assert.equal(ends.length, 2, 'the trace ends again after its async segment');
  const tree = traces.tree(root.traceId);
  const jobRecord = tree.spans.find((span) => span.kind === 'job');
  assert.equal(jobRecord.async, true);
  assert.equal(jobRecord.depth, 2);
  assert.equal(tree.spans.find((span) => span.kind === 'plugin-step').async, false);
  assert.equal(tree.trace.totalDurationMs, 104);
  assert.equal(tree.trace.root.spanId, root.spanId);
  // An unknown parent in an unknown trace gives a root of the named trace that links the parent id.
  const orphan = traces.start({ kind: 'job', parentSpanId: 'gone-span', traceId: 'gone-trace', async: true });
  const orphanRecord = traces.span(orphan.spanId);
  assert.deepEqual(
    [orphan.traceId, orphanRecord.parentSpanId, orphanRecord.depth, orphanRecord.links],
    ['gone-trace', null, 0, [{ traceId: 'gone-trace', spanId: 'gone-span', relation: 'parent-request' }]],
  );
  orphan.end();
  unrelated.end();
});

test('level off hands out one frozen no-op span and retains nothing', async () => {
  const { traces } = store({ level: 'off' });
  assert.equal(traces.enabled, false);
  let called = false;
  const span = traces.start({ kind: 'http', name: 'GET /', input: () => (called = true) });
  assert.equal(span, traces.start({ kind: 'store' }), 'one shared span');
  assert.ok(Object.isFrozen(span));
  assert.equal(span.enabled, false);
  assert.equal(span.spanId, null);
  assert.equal(
    span
      .event('x')
      .set({ a: 1 })
      .output(() => 1)
      .setName('n')
      .setActor({ kind: 'contact', id: 'c1' })
      .setEntity('x_item', 'r1')
      .setInput(() => (called = true))
      .end()
      .fail(new Error('x')),
    span,
  );
  assert.deepEqual(
    [span.kind, span.name, span.module, span.operation, span.entity, span.recordId, span.depth, span.async],
    [null, null, null, null, null, null, 0, false],
  );
  assert.equal(called, false, 'payload thunks never run');
  assert.equal(
    traces.run(span, () => 7),
    7,
  );
  assert.equal(await traces.wrap({ kind: 'job' }, async () => 8), 8);
  assert.deepEqual(traces.headers(span), {});
  assert.equal(traces.query().total, 0);
  assert.equal(traces.status().spans, 0);
});

test('summary skips payloads; full stores redacted, size-capped payloads; configure switches without a restart', () => {
  const { traces } = store({ payloadBytes: 1024 });
  let calls = 0;
  const payload = () => {
    calls++;
    return {
      x_name: 'Invented row',
      password: 'p4ss',
      nested: { authorization: 'Bearer abc.def', note: 'sent Bearer abc.def as header' },
      api_key: 'k',
      fetch: '<condition attribute="x_secret" operator="eq" value="s3cr3t"/>',
      pairs: [{ key: 'ClientSecret', value: 'v' }],
      when: new Date('2026-02-01T00:00:00Z'),
      bytes: Buffer.from('abc'),
      skip: undefined,
      query: new URLSearchParams('a=1&access_token=t'),
    };
  };
  const quiet = traces.start({ kind: 'webapi', name: 'POST', input: payload });
  quiet.output(payload).end();
  assert.equal(calls, 0, 'summary never calls a payload thunk');
  assert.equal('input' in traces.span(quiet.spanId), false);
  assert.equal('output' in traces.span(quiet.spanId), false);

  assert.deepEqual(traces.configure({ level: 'full' }).level, 'full');
  assert.equal(traces.settings().level, 'full');
  const loud = traces.start({ kind: 'webapi', name: 'POST', input: payload });
  loud.output(() => 'x'.repeat(2000)).end();
  assert.equal(calls, 1);
  const record = traces.span(loud.spanId);
  assert.deepEqual(record.input, {
    x_name: 'Invented row',
    password: '[redacted]',
    nested: { authorization: '[redacted]', note: 'sent Bearer [redacted] as header' },
    api_key: '[redacted]',
    fetch: '<condition attribute="x_secret" operator="eq" value="[redacted]"/>',
    pairs: [{ key: 'ClientSecret', value: '[redacted]' }],
    when: '2026-02-01T00:00:00.000Z',
    bytes: '[binary 3 bytes]',
    query: { a: '1', access_token: '[redacted]' },
  });
  assert.equal(record.output.truncated, true);
  assert.ok(record.output.bytes > 1024);
  assert.ok(Buffer.byteLength(record.output.preview) <= 1024);
  assert.doesNotMatch(JSON.stringify(record), /p4ss|abc\.def|s3cr3t/);
  // A thunk that throws records the failure instead of breaking the request.
  const failing = traces.start({
    kind: 'webapi',
    input: () => {
      throw new Error('cannot read');
    },
  });
  assert.deepEqual(traces.span(failing.spanId).input, { captureError: 'cannot read' });
  failing.end();

  traces.configure({ level: 'off' });
  assert.equal(traces.enabled, false);
  assert.equal(traces.start({ kind: 'http' }).enabled, false);
  traces.configure({ level: 'summary' });
  assert.equal(traces.start({ kind: 'http' }).enabled, true);
  assert.throws(() => traces.configure({ level: 'loud' }), /level must be off, summary or full/);
  assert.equal(traces.settings().level, 'summary', 'a refused change keeps the settings');
});

test('redactPayload handles cycles, depth and errors and stays JSON-safe', () => {
  const cyclic = { name: 'a' };
  cyclic.self = cyclic;
  const shared = { v: 1 };
  assert.deepEqual(redactPayload({ cyclic, left: shared, right: shared, fn: () => 1, n: Number.NaN, big: 2n }).value, {
    cyclic: { name: 'a', self: '[circular]' },
    left: { v: 1 },
    right: { v: 1 },
    n: 'NaN',
    big: '2',
  });
  let deep = 'bottom';
  for (let index = 0; index < 20; index++) deep = { deep };
  assert.match(JSON.stringify(redactPayload(deep).value), /\[depth limit\]/);
  const error = Object.assign(new Error('failed with Bearer xyz'), { code: 'X1' });
  assert.deepEqual(redactPayload(error).value, { name: 'Error', code: 'X1', message: 'failed with Bearer [redacted]' });
  assert.deepEqual(redactPayload(new Map([['token', 's']])).value, { token: '[redacted]' });
  assert.deepEqual(redactPayload(undefined).value, null);
});

test('events and attributes are redacted, end is idempotent and fail classifies denials', async () => {
  const { time, traces } = store();
  const span = traces.start({ kind: 'plugin-step', attributes: { stage: 20, cookie: 'c', label: 'Bearer zzz' } });
  time.advance(1.234);
  span.event('trace', { message: 'calling with Bearer abc' });
  span.event('permission', { attributes: { table: 'x_item', result: 'deny', secretValue: 'v' } });
  span.set({ mode: 'clr', roles: ['Invented'] });
  span.end({ status: 'ok' });
  time.advance(10);
  span.end({ status: 'error' });
  const record = traces.span(span.spanId);
  assert.equal(record.status, 'ok', 'a second end is ignored');
  assert.equal(record.durationMs, 1.23);
  assert.deepEqual(record.attributes, {
    stage: 20,
    cookie: '[redacted]',
    label: 'Bearer [redacted]',
    mode: 'clr',
    roles: ['Invented'],
  });
  assert.deepEqual(record.events, [
    { offsetMs: 1.23, type: 'trace', message: 'calling with Bearer [redacted]' },
    { offsetMs: 1.23, type: 'permission', attributes: { table: 'x_item', result: 'deny', secretValue: '[redacted]' } },
  ]);

  const denied = traces.start({ kind: 'permission' });
  denied.fail(Object.assign(new Error('Table permission denied'), { status: 403, code: 'PermissionDenied' }));
  assert.equal(traces.span(denied.spanId).status, 'denied');
  assert.deepEqual(traces.span(denied.spanId).error, {
    code: 'PermissionDenied',
    message: 'Table permission denied',
    status: 403,
  });
  await assert.rejects(
    traces.wrap({ kind: 'connector', name: 'Invented connector' }, async () => {
      throw Object.assign(new Error('upstream failed'), { code: 'ConnectorFailed' });
    }),
    /upstream failed/,
  );
  assert.throws(() =>
    traces.wrap({ kind: 'secret' }, () => {
      throw new Error('sync failure');
    }),
  );
  const failed = traces.spans({ status: 'error', order: 'asc' }).items;
  assert.deepEqual(
    failed.map((item) => [item.kind, item.error.code]),
    [
      ['connector', 'ConnectorFailed'],
      ['secret', 'Error'],
    ],
  );
  const explicit = traces.start({ kind: 'webapi' });
  explicit.end({ status: 'denied', error: 'refused' });
  assert.deepEqual(traces.span(explicit.spanId).error, { code: 'Error', message: 'refused' });
  assert.equal(traces.span(explicit.spanId).status, 'denied');
});

test('the per-trace span cap and the trace LRU count what they drop', () => {
  const { traces } = store({ spansPerTrace: 50, traces: 10 });
  const root = traces.start({ kind: 'http' });
  traces.run(root, () => {
    for (let index = 0; index < 60; index++) traces.start({ kind: 'store' }).end();
  });
  root.end();
  const summary = traces.query({ traceId: root.traceId }).items[0];
  assert.equal(summary.spanCount, 50);
  assert.equal(summary.droppedSpans, 11);
  assert.equal(traces.status().droppedSpans, 11);

  const first = traces.start({ kind: 'http', name: 'first' });
  first.end();
  for (let index = 0; index < 9; index++) traces.start({ kind: 'http', name: `t${index}` }).end();
  assert.equal(traces.status().retained, 10);
  assert.equal(traces.status().dropped, 1, 'the capped trace was the least recently touched');
  assert.equal(traces.tree(root.traceId), null);
  // Adding a span touches a trace, so the next eviction takes another one.
  traces.start({ kind: 'job', traceId: first.traceId, parentSpanId: first.spanId }).end();
  traces.start({ kind: 'http', name: 'newest' }).end();
  assert.ok(traces.tree(first.traceId));
  assert.equal(traces.query({ search: 't0' }).total, 0);
  assert.equal(traces.status().dropped, 2);
  assert.equal(traces.query().retained, 10);
  assert.equal(traces.query().dropped, 2);
  // Lowering the limit evicts at once.
  traces.configure({ traces: 10, spansPerTrace: 50 });
  assert.equal(traces.status().retained, 10);
  const status = traces.clear();
  assert.equal(status.retained, 0);
  assert.equal(status.dropped, 0);
  assert.equal(status.spans, 0);
  assert.ok(status.latestSequence > 0, 'the sequence keeps counting after clear');
});

function dataset() {
  const { time, traces } = store();
  const ids = {};
  const add = (name, args, steps) => {
    const root = traces.start({ kind: 'http', name, module: 'portal', ...args });
    ids[name] = root;
    traces.run(root, () => {
      for (const [kind, extra, duration, status] of steps) {
        const span = traces.start({ kind, name: `${name} ${kind}`, ...extra });
        time.advance(duration);
        span.end({ status });
      }
    });
    time.advance(1);
    root.end();
    time.advance(1000);
  };
  add(
    'portal create',
    {
      actor: { kind: 'contact', id: '{AAAA-1}' },
      session: { visitorId: 'v1', sessionKey: 'v1:c1' },
      origin: { host: 'power-pages', portal: 'invented-portal' },
      operation: 'post',
    },
    [
      ['dataverse', { module: 'dataverse', operation: 'create', entity: 'x_item' }, 10],
      ['plugin-step', { module: 'plugins', entity: 'x_item', attributes: { stage: 20 } }, 20, 'error'],
    ],
  );
  add('api read', { actor: { kind: 'app', id: 'app-1' }, origin: { host: 'dataverse-api' }, operation: 'get' }, [
    ['dataverse', { module: 'dataverse', operation: 'retrieve', entity: 'x_other' }, 30],
  ]);
  add('anonymous page', { actor: { kind: 'anonymous' }, origin: { host: 'standalone' }, operation: 'get' }, [
    ['render', { module: 'liquid', operation: 'render' }, 40],
    ['permission', { module: 'security', entity: 'x_item' }, 0, 'denied'],
  ]);
  return { time, traces, ids };
}

test('query filters traces by every documented filter and pages the summaries', () => {
  const { traces, ids } = dataset();
  const names = (filters) => traces.query(filters).items.map((item) => item.root.name);
  assert.deepEqual(names(), ['anonymous page', 'api read', 'portal create'], 'newest first');
  assert.deepEqual(names({ order: 'asc' }), ['portal create', 'api read', 'anonymous page']);
  assert.deepEqual(names({ from: '2026-02-01T10:00:01.000Z' }), ['anonymous page', 'api read']);
  assert.deepEqual(names({ to: String(START + 500) }), ['portal create'], 'epoch milliseconds');
  assert.deepEqual(names({ kind: 'plugin-step' }), ['portal create']);
  assert.deepEqual(names({ module: 'liquid' }), ['anonymous page']);
  assert.deepEqual(names({ operation: 'RETRIEVE' }), ['api read']);
  assert.deepEqual(names({ entity: 'x_item' }), ['anonymous page', 'portal create']);
  assert.deepEqual(names({ status: 'denied' }), ['anonymous page']);
  assert.deepEqual(names({ host: 'dataverse-api' }), ['api read']);
  assert.deepEqual(names({ actorKind: 'contact' }), ['portal create']);
  assert.deepEqual(names({ actorId: 'aaaa-1' }), ['portal create'], 'actor ids compare without braces or case');
  assert.deepEqual(names({ sessionKey: 'v1:c1' }), ['portal create']);
  assert.deepEqual(names({ visitorId: 'v1' }), ['portal create']);
  assert.deepEqual(names({ portal: 'invented-portal' }), ['portal create']);
  assert.deepEqual(names({ traceId: ids['api read'].traceId }), ['api read']);
  assert.deepEqual(names({ search: 'STAGE' }), ['portal create'], 'search covers attributes');
  assert.deepEqual(names({ minDurationMs: 35 }), ['anonymous page']);
  assert.deepEqual(names({ hasErrors: 'true' }), ['portal create']);
  assert.deepEqual(names({ hasErrors: false }), ['anonymous page', 'api read']);
  assert.deepEqual(names(new URLSearchParams('kind=dataverse&entity=x_item')), ['portal create']);
  assert.deepEqual(names({ kind: 'dataverse', entity: 'x_other', host: 'power-pages' }), [], 'one span meets all');
  const page = traces.query({ pageSize: 2, page: 2 });
  assert.deepEqual(
    { total: page.total, page: page.page, pageSize: page.pageSize, pageCount: page.pageCount, retained: page.retained },
    { total: 3, page: 2, pageSize: 2, pageCount: 2, retained: 3 },
  );
  assert.equal(page.items[0].root.name, 'portal create');
  assert.equal(page.dropped, 0);
  assert.equal(page.latestSequence, 8);
  assert.equal(traces.query({ pageSize: 2, page: 9 }).page, 2, 'a page beyond the end shows the last page');
  const summary = traces.query({ traceId: ids['portal create'].traceId }).items[0];
  assert.deepEqual(
    [summary.spanCount, summary.errorCount, summary.deniedCount, summary.durationMs, summary.status],
    [3, 1, 0, 31, 'ok'],
  );
  assert.deepEqual(summary.modules, ['portal', 'dataverse', 'plugins']);
});

test('spans filters flat spans, including parentSpanId and depth', () => {
  const { traces, ids } = dataset();
  const root = ids['portal create'];
  assert.deepEqual(
    traces.spans({ parentSpanId: root.spanId, order: 'asc' }).items.map((span) => span.kind),
    ['dataverse', 'plugin-step'],
  );
  assert.equal(traces.spans({ depth: 0 }).total, 3);
  assert.equal(traces.spans({ depth: 1 }).total, 5);
  assert.deepEqual(
    traces.spans({ minDurationMs: 30, depth: 1 }).items.map((span) => span.kind),
    ['render', 'dataverse'],
  );
  assert.deepEqual(
    traces.spans({ hasErrors: true }).items.map((span) => span.name),
    ['portal create plugin-step'],
  );
  assert.equal(traces.spans({ traceId: root.traceId }).total, 3);
  assert.equal(traces.spans({ from: '2026-02-01T10:00:02Z' }).total, 3);
  assert.equal(traces.spans({ actorKind: 'anonymous' }).total, 3, 'children inherit the root actor');
  assert.equal(traces.spans({ pageSize: 1 }).items[0].name, 'anonymous page permission', 'newest first');
});

test('invalid filters are 400 RangeErrors', () => {
  const { traces } = dataset();
  invalidFilter(() => traces.query({ from: 'not a date' }), 'from');
  invalidFilter(() => traces.query({ to: 'soon' }), 'to');
  invalidFilter(() => traces.query({ pageSize: 201 }), 'pageSize');
  invalidFilter(() => traces.query({ pageSize: 0 }), 'pageSize');
  invalidFilter(() => traces.query(new URLSearchParams('page=0')), 'page');
  invalidFilter(() => traces.query({ page: '1.5' }), 'page');
  invalidFilter(() => traces.query({ minDurationMs: -1 }), 'minDurationMs');
  invalidFilter(() => traces.query({ hasErrors: 'maybe' }), 'hasErrors');
  invalidFilter(() => traces.query({ order: 'sideways' }), 'order');
  invalidFilter(() => traces.spans({ depth: 'deep' }), 'depth');
  invalidFilter(() => traces.stats({ bucketMs: 0 }), 'bucketMs');
  invalidFilter(() => traces.stats({ bucketMs: 1 }), 'bucketMs');
  invalidFilter(() => traces.export({ from: 'x' }), 'from');
});

test('stats computes percentiles, groups, a bounded timeline and the slowest and failed spans', () => {
  const { time, traces } = store();
  const root = traces.start({ kind: 'http', name: 'POST /_api/x_items', actor: { kind: 'contact', id: 'c1' } });
  traces.run(root, () => {
    for (const [duration, status] of [
      [10, 'ok'],
      [20, 'ok'],
      [30, 'error'],
      [40, 'ok'],
    ]) {
      const span = traces.start({ kind: 'plugin-step', module: 'plugins', entity: 'x_item', operation: 'create' });
      time.advance(duration);
      span.end({ status });
    }
  });
  root.end();
  const running = traces.start({ kind: 'job', module: 'jobs' });
  const stats = traces.stats();
  assert.equal(stats.count, 6);
  assert.deepEqual(stats.byKind['plugin-step'], { count: 4, errors: 1, p50: 20, p95: 40, max: 40 });
  assert.deepEqual(stats.byKind.http, { count: 1, errors: 0, p50: 100, p95: 100, max: 100 });
  assert.deepEqual(stats.byKind.job, { count: 1, errors: 0, p50: null, p95: null, max: null }, 'running spans count');
  assert.deepEqual(Object.keys(stats.byModule).sort(), ['jobs', 'plugins']);
  assert.equal(stats.byEntity.x_item.count, 4);
  assert.equal(stats.byOperation.create.count, 4);
  assert.equal(stats.byActor['contact:c1'].count, 5);
  assert.equal(stats.byActor.system.count, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(stats.byStatus).map(([key, value]) => [key, value.count])), {
    ok: 4,
    error: 1,
    running: 1,
  });
  assert.deepEqual(
    stats.slowest.map((span) => span.durationMs),
    [100, 40, 30, 20, 10],
  );
  assert.deepEqual(
    stats.errors.map((span) => [span.durationMs, span.error]),
    [[30, undefined]],
  );
  assert.equal(stats.from, '2026-02-01T10:00:00.000Z');
  assert.equal(stats.to, '2026-02-01T10:00:00.100Z');
  assert.ok(stats.timeline.length <= 60);
  assert.equal(
    stats.timeline.reduce((sum, bucket) => sum + bucket.count, 0),
    6,
  );
  const coarse = traces.stats({ bucketMs: 50 });
  assert.deepEqual(
    coarse.timeline.map((bucket) => [bucket.bucketStart, bucket.count, bucket.errors, bucket.p95]),
    [
      ['2026-02-01T10:00:00.000Z', 4, 1, 100],
      ['2026-02-01T10:00:00.050Z', 1, 0, 40],
      ['2026-02-01T10:00:00.100Z', 1, 0, null],
    ],
  );
  assert.equal(traces.stats({ kind: 'plugin-step', status: 'error' }).count, 1);
  // A long range picks a bucket that keeps at most 60 buckets.
  time.advance(6 * 3_600_000);
  traces.start({ kind: 'http' }).end();
  const wide = traces.stats();
  assert.ok(wide.timeline.length <= 60);
  assert.equal(wide.bucketMs, 600_000, 'ten-minute buckets for six hours');
  assert.equal(wide.timeline.length, 37);
  const empty = traces.stats({ kind: 'canvas' });
  assert.deepEqual([empty.count, empty.timeline, empty.from, empty.bucketMs], [0, [], null, null]);
  running.end();
});

test('subscribe delivers frozen copies of span-start, span-end and trace-end events', () => {
  const { traces } = store();
  const events = [];
  const stop = traces.subscribe((event) => events.push(event));
  traces.subscribe(() => {
    throw new Error('a broken observer');
  });
  const root = traces.start({ kind: 'http', name: 'GET /' });
  traces.run(root, () => traces.start({ kind: 'render', name: 'Home' }).end());
  root.end();
  assert.deepEqual(
    events.map((event) => [event.type, event.span.kind, event.span.status]),
    [
      ['span-start', 'http', 'running'],
      ['span-start', 'render', 'running'],
      ['span-end', 'render', 'ok'],
      ['span-end', 'http', 'ok'],
      ['trace-end', 'http', 'ok'],
    ],
  );
  assert.ok(Object.isFrozen(events[0]) && Object.isFrozen(events[0].span));
  assert.equal(events.at(-1).trace.spanCount, 2);
  assert.equal(traces.status().listeners, 2);
  stop();
  traces.start({ kind: 'http' }).end();
  assert.equal(events.length, 5);
  assert.throws(() => traces.subscribe('nope'), TypeError);
});

test('headers and fromHeaders carry a trace across loopback HTTP', () => {
  const { traces } = store();
  const sender = traces.start({ kind: 'http-out', name: 'Invented webhook' });
  const headers = traces.run(sender, () => traces.headers());
  assert.deepEqual(headers, {
    'x-sim-parent-trace': sender.spanId,
    'x-sim-span-id': sender.spanId,
    'x-trace-id': sender.traceId,
  });
  assert.deepEqual(traces.headers(), {}, 'no current span, no headers');
  // Only x-trace-id names a trace; x-sim-trace-id is an audit id (D-M-4) and an unknown one is ignored.
  const A = '0a0a0a0a-0000-4000-8000-00000000000a',
    B = '0b0b0b0b-0000-4000-8000-00000000000b';
  assert.deepEqual(traces.fromHeaders(new Headers({ 'X-Trace-Id': A, 'X-Sim-Trace-Id': B })), {
    traceId: A,
    parentSpanId: null,
  });
  assert.equal(traces.fromHeaders({ 'x-trace-id': A }).traceId, A);
  assert.deepEqual(traces.fromHeaders({ 'x-sim-trace-id': B }), { traceId: null, parentSpanId: null });
  assert.equal(traces.fromHeaders({ 'x-trace-id': 'bad value', 'x-sim-trace-id': B }).traceId, null);
  assert.equal(traces.fromHeaders({ 'x-trace-id': A.toUpperCase() }).traceId, A, 'ids are lowercased');
  const inbound = traces.start({ kind: 'http', name: 'POST /hook', ...traces.fromHeaders(headers) });
  assert.equal(inbound.parentSpanId, sender.spanId);
  assert.equal(inbound.traceId, sender.traceId);
  // A parent header alone resolves the trace from the retained parent.
  const parentOnly = traces.fromHeaders(new Headers({ 'X-Sim-Parent-Trace': sender.spanId }));
  assert.deepEqual(parentOnly, { traceId: null, parentSpanId: sender.spanId });
  assert.equal(traces.start({ kind: 'http', ...parentOnly }).traceId, sender.traceId);
  // Malformed or absent headers start a root, even inside another span.
  const roots = traces.run(sender, () => [
    traces.start({ kind: 'http', ...traces.fromHeaders({ 'x-sim-parent-trace': 'bad value\r\n' }) }),
    traces.start({ kind: 'http', ...traces.fromHeaders({ 'x-sim-trace-id': [A, B] }) }),
  ]);
  assert.equal(roots[0].parentSpanId, null);
  assert.notEqual(roots[0].traceId, sender.traceId);
  assert.ok(![A, B, sender.traceId].includes(roots[1].traceId), 'an unknown audit id never names the trace');
});

test('x-sim-trace-id resolves as an audit id: the span naming it is the parent; summaries and filters expose auditId', () => {
  const { traces } = store();
  const AUDIT = '0c0c0c0c-0000-4000-8000-00000000000c',
    READ_AUDIT = '0d0d0d0d-0000-4000-8000-00000000000d',
    OTHER = '0e0e0e0e-0000-4000-8000-00000000000e';
  const root = traces.start({ kind: 'http', name: 'GET /' });
  root.set({ auditId: AUDIT });
  const read = traces.run(root, () =>
    traces.start({ kind: 'read', name: 'read', attributes: { auditId: READ_AUDIT } }),
  );
  read.end();
  root.end();
  assert.deepEqual(traces.fromHeaders({ 'x-sim-trace-id': AUDIT }), {
    traceId: root.traceId,
    parentSpanId: root.spanId,
  });
  assert.deepEqual(traces.fromHeaders(new Headers({ 'X-Sim-Trace-Id': READ_AUDIT.toUpperCase() })), {
    traceId: root.traceId,
    parentSpanId: read.spanId,
  });
  // X-Trace-Id still names the trace; a parent header wins over the audit id.
  assert.deepEqual(traces.fromHeaders({ 'x-sim-trace-id': AUDIT, 'x-trace-id': OTHER }), {
    traceId: OTHER,
    parentSpanId: root.spanId,
  });
  assert.deepEqual(traces.fromHeaders({ 'x-sim-trace-id': AUDIT, 'x-sim-parent-trace': read.spanId }), {
    traceId: null,
    parentSpanId: read.spanId,
  });
  const [summary] = traces.query({ auditId: AUDIT }).items;
  assert.equal(summary.traceId, root.traceId);
  assert.equal(summary.auditId, AUDIT);
  assert.deepEqual(
    traces.query({ auditId: READ_AUDIT }).items.map((item) => item.traceId),
    [root.traceId],
  );
  assert.deepEqual(
    traces.spans({ auditId: READ_AUDIT }).items.map((span) => span.spanId),
    [read.spanId],
  );
  assert.equal(traces.query({ auditId: OTHER }).total, 0);
  assert.equal(traces.start({ kind: 'http' }).end() && traces.query({ pageSize: 1 }).items[0].auditId, null);
  // An evicted or cleared trace no longer resolves its audit ids.
  traces.clear();
  assert.deepEqual(traces.fromHeaders({ 'x-sim-trace-id': AUDIT }), { traceId: null, parentSpanId: null });
});

test('headers send x-sim-trace-id only as the audit id of the nearest audited span, never the trace id', () => {
  const { traces } = store();
  const AUDIT = '0f0f0f0f-0000-4000-8000-00000000000f',
    NESTED = '0f0f0f0f-0000-4000-8000-0000000000f0';
  const root = traces.start({ kind: 'http', name: 'GET /' });
  assert.equal('x-sim-trace-id' in traces.headers(root), false, 'an unaudited root sends no x-sim-trace-id');
  root.set({ auditId: AUDIT });
  const child = traces.run(root, () => traces.start({ kind: 'dataverse', name: 'Create' }));
  assert.deepEqual(traces.headers(child), {
    'x-sim-parent-trace': child.spanId,
    'x-sim-span-id': child.spanId,
    'x-trace-id': root.traceId,
    'x-sim-trace-id': AUDIT,
  });
  // A nested audited request (a Web API call under the page) names its own entry.
  const api = traces.run(child, () =>
    traces.start({ kind: 'http', name: 'POST /_api', attributes: { auditId: NESTED } }),
  );
  const write = traces.run(api, () => traces.start({ kind: 'dataverse' }));
  assert.equal(traces.headers(write)['x-sim-trace-id'], NESTED);
  // The receiver resolves it back to that span (a parent header still wins).
  const { 'x-sim-parent-trace': _parent, ...withoutParent } = traces.headers(write);
  assert.deepEqual(traces.fromHeaders(withoutParent), { traceId: root.traceId, parentSpanId: api.spanId });
  for (const span of [write, api, child, root]) span.end();
});

test('result filters traces by their summary status, a comma list counted in the totals; status keeps matching any span', () => {
  const { traces } = store();
  const ok = traces.start({ kind: 'http', name: 'ok' });
  traces.run(ok, () => traces.start({ kind: 'internal', name: 'failed child' }).fail(new Error('inner')));
  ok.end({ status: 'ok' });
  traces.start({ kind: 'http', name: 'error' }).fail(new Error('outer'));
  traces.start({ kind: 'http', name: 'denied' }).end({ status: 'denied' });
  const running = traces.start({ kind: 'http', name: 'running' });
  const names = (filters) => traces.query({ ...filters, order: 'asc' }).items.map((item) => item.root.name);
  assert.deepEqual(names({ result: 'error,denied' }), ['error', 'denied'], 'the root result, not a failed child');
  assert.deepEqual(names({ result: 'OK' }), ['ok']);
  assert.deepEqual(names({ result: 'running' }), ['running']);
  assert.equal(traces.query({ result: 'error, denied', pageSize: 1 }).total, 2, 'the total counts every match');
  assert.deepEqual(names({ status: 'error' }), ['ok', 'error'], 'status still matches any span');
  assert.equal(traces.stats({ result: 'denied' }).roots.count, 1);
  assert.equal(traces.export({ result: 'ok' }).traces.length, 1);
  assert.throws(
    () => traces.query({ result: 'error,failed' }),
    (error) => error.code === 'InvalidTraceFilter' && error.parameter === 'result' && error.status === 400,
  );
  running.end();
});

test('id filters take an 8+ hex prefix (an ambiguous one matches every candidate); table names resolve both ways', () => {
  const traces = createTraceStore({
    settings: { level: 'summary' },
    // The organization host resolves through the store mappings; this one knows x_item / x_items.
    entityNames: (name) => (['x_item', 'x_items'].includes(name) ? ['x_item', 'x_items'] : [name]),
  });
  const VISITOR_A = 'ad87d220-0000-4000-8000-00000000000a',
    VISITOR_B = 'ad87d220-0000-4000-8000-00000000000b',
    RECORD = 'bead0000-1111-4111-8111-000000000001';
  for (const [name, visitorId] of [
    ['a', VISITOR_A],
    ['b', VISITOR_B],
  ])
    traces
      .start({
        kind: 'http',
        name,
        entity: 'x_item',
        recordId: RECORD,
        actor: { kind: 'contact', id: `${visitorId.slice(0, 8)}-cccc-4000-8000-0000000000${name}0` },
        session: { visitorId, sessionKey: `visitor:${visitorId}` },
      })
      .end();
  const names = (filters) =>
    traces
      .query({ ...filters, order: 'asc' })
      .items.map((item) => item.root.name)
      .join(',');
  assert.equal(names({ sessionKey: 'visitor:ad87d220' }), 'a,b', 'an ambiguous prefix matches all candidates');
  assert.equal(names({ sessionKey: `visitor:${VISITOR_B}` }), 'b', 'a whole key still matches exactly');
  assert.equal(names({ visitorId: 'ad87d220-0000-4000-8000-00000000000a' }), 'a');
  assert.equal(names({ visitorId: 'ad87d22' }), '', 'fewer than 8 hex characters match exactly only');
  assert.equal(names({ actorId: '{AD87D220}' }), 'a,b', 'braces and case are ignored as for whole ids');
  assert.equal(names({ recordId: 'BEAD0000' }), 'a,b');
  assert.equal(names({ recordId: 'bead000' }), '');
  assert.equal(names({ sessionKey: 'visitor:' }), '', 'a bare kind is no prefix');
  assert.equal(names({ entity: 'X_ITEMS' }), 'a,b', 'the entity set name finds the logical name');
  assert.equal(names({ table: 'x_items' }), 'a,b', 'table is the D-M-2 name of entity');
  assert.equal(names({ entity: 'x_other' }), '');
  assert.deepEqual(
    [...new Set(traces.spans({ entity: 'x_items' }).items.map((span) => span.entity))],
    ['x_item'],
    'spans keep their logical name',
  );
});

test('subscribe events: a listener receives only the frame types it names', () => {
  const { traces } = store();
  const ends = [],
    all = [];
  const stopEnds = traces.subscribe((event) => ends.push(event.type), { events: ['trace-end'] });
  const stopAll = traces.subscribe((event) => all.push(event.type));
  const root = traces.start({ kind: 'http' });
  traces.run(root, () => traces.start({ kind: 'internal' }).end());
  root.end();
  assert.deepEqual(ends, ['trace-end']);
  assert.deepEqual(all, ['span-start', 'span-start', 'span-end', 'span-end', 'trace-end']);
  stopEnds();
  stopAll();
  for (const events of [['span-done'], 'span-done', [], [1]])
    assert.throws(() => traces.subscribe(() => {}, { events }), TypeError, JSON.stringify(events));
  assert.throws(() => traces.subscribe(() => {}, { traceId: 7 }), TypeError);
  // One type as a string, and traceId: only that trace's frames (the in-process simulator.trace.subscribe takes both).
  const mine = [];
  const watched = traces.start({ kind: 'http', name: 'watched' });
  const stopMine = traces.subscribe((event) => mine.push([event.type, event.span.name]), {
    events: 'span-end',
    traceId: watched.traceId,
  });
  traces.start({ kind: 'http', name: 'other' }).end();
  watched.end();
  stopMine();
  assert.deepEqual(mine, [['span-end', 'watched']]);
});

test('fromHeaders ignores reserved and non-UUID ids, so a client can never name a route', () => {
  const { traces } = store();
  for (const value of ['stats', 'spans', 'export', 'settings', 'clear', 'span', '.', '..', 'wide-trace', 't-1'])
    assert.deepEqual(
      traces.fromHeaders({ 'x-trace-id': value, 'x-sim-trace-id': value, 'x-sim-parent-trace': value }),
      { traceId: null, parentSpanId: null },
      value,
    );
  const root = traces.start({ kind: 'http', ...traces.fromHeaders({ 'x-trace-id': 'stats' }) });
  assert.notEqual(root.traceId, 'stats', 'the request starts a fresh trace');
  assert.equal(traces.tree('stats'), null);
  root.end();
});

test('a retained parent decides the trace; an unknown parent goes under the named trace root', () => {
  const { traces } = store();
  const a = traces.start({ kind: 'http', name: 'A' });
  const b = traces.start({ kind: 'http', name: 'B' });
  // A header trace id that conflicts with the parent's own trace loses.
  const cross = traces.start({ kind: 'http', traceId: a.traceId, parentSpanId: b.spanId });
  assert.deepEqual([cross.traceId, cross.parentSpanId, cross.depth], [b.traceId, b.spanId, 1]);
  assert.deepEqual(
    traces.tree(b.traceId).children[0].children.map((node) => node.spanId),
    [cross.spanId],
  );
  assert.deepEqual(
    traces.ancestry(cross.spanId).map((record) => record.traceId),
    [b.traceId, b.traceId],
  );
  // An unknown parent id (an evicted audit id) with a retained trace: depth 1 under that trace's root, linked.
  const gone = '0c0c0c0c-0000-4000-8000-00000000000c';
  const late = traces.start({ kind: 'http', traceId: a.traceId, parentSpanId: gone });
  assert.deepEqual([late.traceId, late.parentSpanId, late.depth], [a.traceId, a.spanId, 1]);
  assert.deepEqual(traces.span(late.spanId).links, [{ traceId: a.traceId, spanId: gone, relation: 'parent-request' }]);
  // Unknown parent and unknown trace: a new root.
  const fresh = traces.start({ kind: 'http', parentSpanId: gone });
  assert.deepEqual([fresh.parentSpanId, fresh.depth], [null, 0]);
  assert.notEqual(fresh.traceId, a.traceId);
  for (const span of [cross, late, fresh, a, b]) span.end();
});

test('export returns trees with the settings in force', () => {
  const { traces, ids } = dataset();
  const exported = traces.export({ kind: 'render' });
  assert.match(exported.exportedAt, /^2026-02-01T/);
  assert.deepEqual(exported.settings, traces.settings());
  assert.equal(exported.traces.length, 1);
  const [tree] = exported.traces;
  assert.deepEqual(Object.keys(tree), ['trace', 'root', 'spans', 'children']);
  assert.equal(tree.root.spanId, ids['anonymous page'].spanId);
  assert.equal(tree.children[0].children.length, 2);
  assert.equal(traces.export().traces.length, 3, 'export ignores paging');
});

test('persist appends each ended trace as one NDJSON line under the lazily resolved state folder', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-store-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  let resolved = 0;
  const { traces } = store(
    { persist: true, level: 'full' },
    {
      stateDirectory: () => {
        resolved++;
        return directory;
      },
    },
  );
  const root = traces.start({ kind: 'http', name: 'POST /', input: () => ({ token: 't', x_name: 'n' }) });
  traces.run(root, () => traces.start({ kind: 'dataverse' }).end());
  assert.equal(resolved, 0, 'the folder is resolved only when a trace ends');
  root.end();
  await traces.flush();
  const file = path.join(directory, 'traces', '2026-02-01.ndjson');
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].trace.traceId, root.traceId);
  assert.equal(lines[0].spans.length, 2);
  assert.deepEqual(lines[0].spans[0].input, { token: '[redacted]', x_name: 'n' });
  const status = traces.status();
  assert.equal(status.persist.written, 1);
  assert.equal(status.persist.directory, path.join(directory, 'traces'));

  // A failing write is counted and never thrown into the request.
  const blocked = path.join(directory, 'file-not-folder');
  await fs.writeFile(blocked, 'x');
  const failing = createTraceStore({ settings: { persist: true }, stateDirectory: blocked });
  failing.start({ kind: 'http' }).end();
  await failing.flush();
  assert.equal(failing.status().persist.failures, 1);
  assert.ok(failing.status().persist.lastError);

  // persist false writes nothing.
  const off = createTraceStore({ stateDirectory: path.join(directory, 'unused') });
  off.start({ kind: 'http' }).end();
  await off.flush();
  await assert.rejects(fs.stat(path.join(directory, 'unused')), { code: 'ENOENT' });
});

test('status reports counts, a memory estimate and the level', () => {
  const { traces } = store({ level: 'full' });
  const open = traces.start({ kind: 'http', input: () => ({ x: 'y' }) });
  open.event('trace', { message: 'one' });
  const status = traces.status();
  assert.deepEqual(
    [status.level, status.enabled, status.retained, status.spans, status.running, status.listeners],
    ['full', true, 1, 1, 1, 0],
  );
  assert.ok(status.memoryBytes > 512);
  assert.deepEqual(status.persist, { enabled: false, directory: null, written: 0, failures: 0, lastError: null });
  open.end();
  assert.equal(traces.status().running, 0);
});

test('span getters read the live record and the set* members change it only while it runs', () => {
  const { traces } = store({ level: 'full' });
  const root = traces.start({ kind: 'dataverse', name: 'Request', module: 'dataverse', operation: 'POST' });
  assert.deepEqual(
    [root.kind, root.name, root.module, root.operation, root.entity, root.recordId, root.depth, root.async],
    ['dataverse', 'Request', 'dataverse', 'post', null, null, 0, false],
  );
  assert.equal(
    root
      .setName('Create x_item')
      .setEntity('x_item', 'r1')
      .setActor({ kind: 'staff', id: '{U1}', name: 'Invented' })
      .setInput(() => ({ x_name: 'n', password: 'p' })),
    root,
    'setters chain',
  );
  assert.deepEqual([root.name, root.entity, root.recordId], ['Create x_item', 'x_item', 'r1']);
  root.setActor('not an actor');
  const child = traces.run(root, () => traces.start({ kind: 'plugin-step', async: true }));
  assert.deepEqual([child.depth, child.async], [1, true]);
  assert.deepEqual(
    traces.span(child.spanId).actor,
    { kind: 'staff', id: '{U1}', name: 'Invented' },
    'children inherit',
  );
  assert.equal(traces.spans({ actorKind: 'staff', actorId: 'u1' }).total, 2, 'actor filters match the set actor');
  root.setEntity('x_other');
  assert.deepEqual([root.entity, root.recordId], ['x_other', null], 'setEntity sets both members');
  child.end();
  root.end();
  root
    .setName('late')
    .setEntity('late', 'late')
    .setActor({ kind: 'app' })
    .setInput(() => 'late');
  const record = traces.span(root.spanId);
  assert.deepEqual(
    [record.name, record.entity, record.recordId, record.actor.kind, record.input],
    ['Create x_item', 'x_other', null, 'staff', { x_name: 'n', password: '[redacted]' }],
    'set* after end is ignored',
  );
  // At summary no input thunk runs.
  const summary = store().traces;
  let called = false;
  const span = summary.start({ kind: 'webapi' }).setInput(() => (called = true));
  span.end();
  assert.equal(called, false);
  assert.equal('input' in summary.span(span.spanId), false);
});

test('a full trace hands out its overflow handle, and the refused chain stays in that trace', async () => {
  const { traces } = store({ spansPerTrace: 50 });
  const root = traces.start({ kind: 'http' });
  let refused;
  traces.run(root, () => {
    for (let index = 1; index < 50; index++) traces.start({ kind: 'store' }).end();
    refused = traces.start({ kind: 'store' });
  });
  assert.deepEqual(
    [refused.enabled, refused.traceId, refused.spanId, refused.parentSpanId],
    [false, root.traceId, null, null],
  );
  assert.ok(Object.isFrozen(refused));
  assert.equal(refused.event('x').set({ a: 1 }).end(), refused, 'every method is inert');
  // run makes the handle current; ambient children get the same handle and never start a new trace.
  traces.run(refused, () => {
    assert.equal(traces.current(), refused);
    assert.equal(traces.start({ kind: 'render' }), refused);
  });
  assert.deepEqual(traces.headers(refused), { 'x-trace-id': root.traceId });
  // A request root parented explicitly into the full trace (a page's follow-up call) and its whole chain.
  const followUp = traces.start({ kind: 'http', traceId: root.traceId, parentSpanId: root.spanId });
  assert.equal(followUp, refused);
  await traces.run(followUp, () =>
    traces.wrap({ kind: 'webapi' }, async () => {
      traces.wrap({ kind: 'dataverse' }, () => assert.equal(traces.current(), refused));
    }),
  );
  // A request context naming the full trace without a span (built from the overflow handle).
  runWithRequest(createRequestContext({ traceId: refused.traceId, spanId: refused.spanId }), () => {
    assert.equal(traces.current(), refused);
    assert.equal(traces.start({ kind: 'read' }), refused);
  });
  traces.remember('job:overflow', refused);
  assert.deepEqual(traces.recall('job:overflow'), { traceId: root.traceId, spanId: null });
  root.end();
  assert.equal(traces.status().retained, 1, 'no fragment trace was started');
  assert.equal(traces.tree(root.traceId).trace.droppedSpans, 6);
  assert.equal(traces.status().droppedSpans, 6);
  assert.equal(store({ level: 'off' }).traces.start({ kind: 'http' }).traceId, null, 'level off keeps the no-op');
});

test('remember and recall keep a bounded least-recently-used registry that clear empties', () => {
  const { traces } = store();
  const span = traces.start({ kind: 'dataverse' });
  assert.equal(traces.recall('job:missing'), null);
  traces.remember('job:1', span);
  const recalled = traces.recall('job:1');
  assert.deepEqual(recalled, { traceId: span.traceId, spanId: span.spanId });
  recalled.spanId = 'changed';
  assert.equal(traces.recall('job:1').spanId, span.spanId, 'recall returns copies');
  traces.remember('job:none', { traceId: null, spanId: null });
  traces.remember(42, span);
  assert.equal(traces.recall('job:none'), null, 'nothing without a trace id is remembered');
  for (let index = 0; index < 10_000; index++) {
    traces.remember(`flow-run:${index}`, { traceId: `t${index}`, spanId: `s${index}` });
    if (index === 5000) traces.recall('job:1'); // a recall makes the key the most recently used
  }
  assert.ok(traces.recall('job:1'), 'recently used keys stay');
  assert.equal(traces.recall('flow-run:0'), null, 'the least recently used key went first');
  assert.deepEqual(traces.recall('flow-run:9999'), { traceId: 't9999', spanId: 's9999' });
  traces.clear();
  assert.equal(traces.recall('flow-run:9999'), null);
  span.end();
});

test('detached runs outside the current span, so scheduled work never inherits a request', async () => {
  const { traces } = store();
  const request = traces.start({ kind: 'http' });
  const job = await traces.run(request, () =>
    traces.detached(async () => {
      assert.equal(traces.current(), null);
      await null;
      return traces.start({ kind: 'job', async: true });
    }),
  );
  assert.notEqual(job.traceId, request.traceId);
  assert.equal(job.parentSpanId, null);
  assert.equal(
    traces.run(request, () => traces.detached(() => 5)),
    5,
  );
  job.end();
  request.end();
});

test('statusFromHttp maps 401 and 403 to denied and other failures to error', () => {
  assert.deepEqual([200, 204, 302, 399, 400, 401, 403, 404, 500, '403', undefined].map(statusFromHttp), [
    'ok',
    'ok',
    'ok',
    'ok',
    'error',
    'denied',
    'denied',
    'error',
    'error',
    'denied',
    'ok',
  ]);
});

test('stats reports overall figures over the matching spans and root figures over the matching traces', () => {
  const { time, traces } = store();
  const trace = (rootMs, childMs, entity, status = 'ok') => {
    const root = traces.start({ kind: 'http' });
    traces.run(root, () => {
      const child = traces.start({ kind: 'dataverse', entity });
      time.advance(childMs);
      child.end({ status });
    });
    time.advance(rootMs - childMs);
    root.end({ status });
  };
  trace(10, 4, 'x_item');
  trace(20, 6, 'x_item', 'error');
  trace(30, 8, 'x_other');
  const all = traces.stats();
  assert.deepEqual(all.overall, { count: 6, errors: 2, p50: 8, p95: 30, max: 30 });
  assert.deepEqual(all.roots, { count: 3, errors: 1, p50: 20, p95: 30, max: 30 });
  // A span filter narrows overall to the spans and roots to the roots of traces holding one.
  const items = traces.stats({ entity: 'x_item' });
  assert.deepEqual(items.overall, { count: 2, errors: 1, p50: 4, p95: 6, max: 6 });
  assert.deepEqual(items.roots, { count: 2, errors: 1, p50: 10, p95: 20, max: 20 });
  const roots = traces.stats({ depth: 0, entity: 'x_item' });
  assert.equal(roots.overall.count, 0, 'no root has the entity');
  assert.equal(roots.roots.count, 2, 'root figures ignore depth');
  const running = traces.start({ kind: 'http' });
  assert.deepEqual(traces.stats({ status: 'running' }).roots, {
    count: 1,
    errors: 0,
    p50: null,
    p95: null,
    max: null,
  });
  running.end();
  assert.deepEqual(traces.stats({ kind: 'canvas' }).overall, { count: 0, errors: 0, p50: null, p95: null, max: null });
});

test('the memory estimate counts event messages and attribute JSON, and events stop at 1000', () => {
  const { traces } = store();
  const span = traces.start({ kind: 'plugin-step' });
  const base = traces.status().memoryBytes;
  span.set({ note: 'x'.repeat(1000) });
  assert.ok(traces.status().memoryBytes >= base + 1000, 'attribute JSON counts');
  const withAttributes = traces.status().memoryBytes;
  span.event('trace', { message: 'y'.repeat(4000), attributes: { line: 'z'.repeat(500) } });
  assert.ok(traces.status().memoryBytes >= withAttributes + 96 + 4000 + 500, 'event message and attributes count');
  for (let index = 1; index < 1005; index++) span.event('trace', { message: 'l' });
  span.end();
  const record = traces.span(span.spanId);
  assert.equal(record.events.length, 1000);
  assert.equal(record.attributes.droppedEvents, 5);
});

test('redaction hides credential query parameters, authentication values and SAS and Basic credentials', () => {
  const { value } = redactPayload({
    uri: 'https://fn.example.test/api/x?code=KEY123&sig=SIG456&keep=1',
    authentication: { type: 'Raw', value: 'Basic dXNlcjpwYXNzd29yZA==' },
    headers: { 'x-note': 'Basic dXNlcjpwYXNzd29yZA==', 'x-sas': 'SharedAccessSignature sr=a&sig=SIG789&se=1' },
    sas: 'sv=2024&sig=SAS1',
    sig: 'SIG2',
    query: new URLSearchParams('code=KEY9&page=2'),
    signal: 'kept',
    statusCode: 200,
  });
  const json = JSON.stringify(value);
  for (const secret of ['KEY123', 'SIG456', 'dXNl', 'SIG789', 'SAS1', 'SIG2', 'KEY9'])
    assert.equal(json.includes(secret), false, secret);
  assert.equal(value.uri, 'https://fn.example.test/api/x?code=[redacted]&sig=[redacted]&keep=1');
  assert.equal(value.authentication, '[redacted]');
  assert.deepEqual(
    [value.sas, value.sig, value.query.page, value.signal, value.statusCode],
    ['[redacted]', '[redacted]', '2', 'kept', 200],
  );
});

test('persisted lines carry only the spans added since the previous line, built on a later turn', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-store-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const { traces } = store({ persist: true }, { stateDirectory: directory });
  const read = async () => {
    await traces.flush();
    const text = await fs.readFile(path.join(directory, 'traces', '2026-02-01.ndjson'), 'utf8');
    return text.trim().split('\n').map(JSON.parse);
  };
  const root = traces.start({ kind: 'http', name: 'GET /page' });
  traces.run(root, () => traces.start({ kind: 'render' }).end());
  root.end();
  await traces.flush();
  for (let index = 0; index < 5; index++) {
    const followUp = traces.start({ kind: 'http', traceId: root.traceId, parentSpanId: root.spanId });
    traces.run(followUp, () => traces.start({ kind: 'webapi' }).end());
    followUp.end();
    await traces.flush(); // each follow-up request ends on its own turn
  }
  const lines = await read();
  assert.equal(lines.length, 6);
  assert.equal(
    lines.reduce((sum, line) => sum + line.spans.length, 0),
    traces.tree(root.traceId).trace.spanCount,
    'every span is written once',
  );
  assert.deepEqual(Object.keys(lines[0]), ['persistedAt', 'traceId', 'trace', 'spans', 'complete']);
  assert.ok(lines.every((line) => line.traceId === root.traceId && line.complete === true));
  assert.equal(lines.at(-1).trace.spanCount, 12, 'the latest summary covers the whole trace');

  // The line is built after the end returns: a span re-opening the trace in the same turn joins the same line, and the
  // line written while it ran is completed by a later line.
  const page = traces.start({ kind: 'http', name: 'GET /other' });
  page.end();
  const late = traces.start({ kind: 'job', traceId: page.traceId, parentSpanId: page.spanId, async: true });
  const pending = await read();
  assert.deepEqual(
    pending.slice(6).map((line) => [line.spans.map((span) => span.status), line.complete]),
    [[['ok', 'running'], false]],
  );
  late.end();
  const done = await read();
  assert.deepEqual(
    done.slice(7).map((line) => [line.spans.map((span) => [span.spanId, span.status]), line.complete]),
    [[[[late.spanId, 'ok']], true]],
  );
});

test('a running trace evicted by the LRU ends for listeners and is persisted with and after its running spans', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-store-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const { traces } = store({ persist: true, traces: 10 }, { stateDirectory: directory });
  const ends = [];
  traces.subscribe((event) => event.type === 'trace-end' && ends.push(event.trace));
  const waiting = traces.start({ kind: 'http', name: 'POST /approve' });
  const step = traces.run(waiting, () => traces.start({ kind: 'flow-run' }));
  for (let index = 0; index < 10; index++) traces.start({ kind: 'http', name: `other ${index}` }).end();
  assert.equal(traces.tree(waiting.traceId), null, 'the waiting trace was evicted');
  const evicted = ends.find((summary) => summary.traceId === waiting.traceId);
  assert.deepEqual([evicted.evicted, evicted.status, evicted.spanCount], [true, 'running', 2]);
  assert.deepEqual(
    [traces.status().running, traces.status().retained, traces.status().dropped],
    [0, 10, 1],
    'the counters leave with the trace',
  );
  await traces.flush(); // the eviction line is written while the spans still run
  step.end();
  waiting.end();
  assert.equal(ends.filter((summary) => summary.traceId === waiting.traceId).length, 1, 'trace-end once');
  await traces.flush();
  const lines = (await fs.readFile(path.join(directory, 'traces', '2026-02-01.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((line) => line.traceId === waiting.traceId);
  assert.deepEqual(
    lines.map((line) => [line.complete, line.trace.evicted, line.spans.map((span) => span.status)]),
    [
      [false, true, ['running', 'running']],
      [true, true, ['ok', 'ok']],
    ],
  );
  assert.equal(traces.status().memoryBytes > 0, true);
  assert.equal(traces.clear().memoryBytes, 0);
});

test('persist without a state directory is accepted and reported as NoStateDirectory', async () => {
  const { traces } = store();
  assert.equal(traces.status().persist.lastError, null);
  traces.configure({ persist: true });
  assert.equal(traces.status().persist.lastError, 'NoStateDirectory');
  traces.start({ kind: 'http' }).end();
  await traces.flush();
  assert.deepEqual(
    [traces.status().persist.written, traces.status().persist.failures, traces.status().persist.directory],
    [0, 0, null],
  );
  traces.configure({ persist: false });
  assert.equal(traces.status().persist.lastError, 'NoStateDirectory', 'the last persist attempt stays reported');
});

test('query sorts by start, duration, span count or errors in either order', () => {
  const { traces } = dataset();
  const names = (filters) => traces.query(filters).items.map((item) => item.root.name);
  assert.deepEqual(names({ sort: 'start' }), names());
  assert.deepEqual(names({ sort: 'duration' }), ['anonymous page', 'api read', 'portal create']);
  assert.deepEqual(names({ sort: 'duration', order: 'asc' }), ['portal create', 'api read', 'anonymous page']);
  assert.deepEqual(names({ sort: 'spans' }), ['anonymous page', 'portal create', 'api read']);
  assert.deepEqual(names({ sort: 'errors' }), ['portal create', 'anonymous page', 'api read']);
  assert.deepEqual(names(new URLSearchParams('sort=errors&order=asc')), [
    'api read',
    'anonymous page',
    'portal create',
  ]);
  invalidFilter(() => traces.query({ sort: 'name' }), 'sort');
});

test('a trace matches from and to when any of its spans starts in the range, to the millisecond', () => {
  const { time, traces } = store();
  const page = traces.start({ kind: 'http', name: 'GET /page' });
  page.end();
  time.advance(5000);
  const followUp = traces.start({ kind: 'http', traceId: page.traceId, parentSpanId: page.spanId });
  followUp.end();
  const total = (from, to) => traces.query({ from, to }).total;
  assert.equal(total(new Date(START + 4999), new Date(START + 5001)), 1, 'only the follow-up is in the range');
  assert.equal(total(new Date(START + 5001), null), 0);
  assert.equal(total(new Date(START + 5000).toISOString(), new Date(START + 5000).toISOString()), 1);
  assert.equal(total(START + 1, START + 4999), 0, 'no span starts between the two');
  assert.equal(
    traces.stats({ from: START + 4999, to: START + 5001 }).count,
    traces.spans({ from: START + 4999 }).total,
  );
});

test('subscribe with payloads false receives copies without input and output', () => {
  const { traces } = store({ level: 'full' });
  const full = [],
    slim = [];
  traces.subscribe((event) => full.push(event));
  traces.subscribe((event) => slim.push(event), { payloads: false });
  const span = traces.start({ kind: 'http', input: () => ({ x_name: 'n' }) });
  span.output(() => ({ ok: true }));
  span.end();
  assert.deepEqual(
    slim.map((event) => event.type),
    ['span-start', 'span-end', 'trace-end'],
  );
  assert.deepEqual(full.at(-2).span.input, { x_name: 'n' });
  assert.deepEqual(full.at(-1).trace.root.output, { ok: true });
  for (const event of slim) {
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.span));
    assert.equal('input' in event.span || 'output' in event.span, false);
  }
  assert.equal('output' in slim.at(-1).trace.root, false);
  assert.equal(slim.at(-1).trace.spanCount, 1);
  assert.equal(traces.span(span.spanId).input.x_name, 'n', 'the record keeps its payloads');
});

test('unknown status, kind, sort and order values are refused with the parameter and the value', () => {
  const { traces } = store();
  for (const [key, value] of [
    ['status', 'bogus'],
    ['kind', 'invented-kind'],
    ['sort', 'sideways'],
    ['order', 'up'],
  ]) {
    invalidFilter(() => traces.query({ [key]: value }), key);
    invalidFilter(() => traces.spans({ [key]: value }), key);
    invalidFilter(() => traces.stats({ [key]: value }), key);
    invalidFilter(() => checkTraceFilters({ [key]: value }), key);
  }
  assert.throws(() => traces.query({ status: 'bogus' }), {
    message: 'status must be one of ok, error, denied, cancelled, running (got "bogus").',
  });
  assert.deepEqual(SPAN_STATUSES, ['ok', 'error', 'denied', 'cancelled', 'running']);
  for (const kind of SPAN_KINDS) assert.equal(traces.query({ kind }).total, 0, kind);
  for (const status of SPAN_STATUSES) assert.equal(traces.query({ status: status.toUpperCase() }).total, 0, status);
  assert.doesNotThrow(() => checkTraceFilters({ status: 'cancelled', kind: 'canvas', sort: 'errors', order: 'asc' }));
});

test('recordHttpError gives a handler-written answer its status and error; cancelled is a status of its own', () => {
  const { traces, time } = store();
  const failed = traces.start({ kind: 'http', name: 'POST /_api/x_items' });
  const details = { field: 'x' };
  assert.equal(recordHttpError(failed, 400, { code: '0x80040203', message: 'Invalid value.', details }), failed);
  assert.equal(traces.span(failed.spanId).status, 'running');
  assert.deepEqual(traces.span(failed.spanId).error, {
    code: '0x80040203',
    message: 'Invalid value.',
    status: 400,
    details: { field: 'x' },
  });
  failed.end();
  assert.equal(traces.span(failed.spanId).status, 'error');
  const denied = traces.start({ kind: 'http', name: 'GET /secure' });
  recordHttpError(denied, 401).end();
  assert.deepEqual(traces.span(denied.spanId).error, { code: 'Http401', message: 'HTTP 401', status: 401 });
  assert.equal(traces.span(denied.spanId).status, 'denied');
  const fine = traces.start({ kind: 'http', name: 'GET /fine' });
  recordHttpError(fine, 302, { code: 'Redirect' }).end();
  assert.deepEqual([traces.span(fine.spanId).status, traces.span(fine.spanId).error], ['ok', undefined]);
  // An explicit end status still wins; an ended span, the no-op span and no span ignore it.
  const explicit = traces.start({ kind: 'http' });
  recordHttpError(explicit, 500).end({ status: 'ok' });
  assert.equal(traces.span(explicit.spanId).status, 'ok');
  recordHttpError(explicit, 500);
  assert.equal(traces.span(explicit.spanId).status, 'ok');
  traces.configure({ level: 'off' });
  const noop = traces.start({ kind: 'http' });
  assert.equal(recordHttpError(noop, 500), noop);
  traces.configure({ level: 'summary' });
  assert.equal(recordHttpError(null, 500), null);

  const cancelled = traces.start({ kind: 'flow-action', name: 'Wait' });
  time.advance(2);
  cancelled.end({ status: 'cancelled' });
  const record = traces.span(cancelled.spanId);
  assert.deepEqual([record.status, record.durationMs], ['cancelled', 2]);
  assert.equal(traces.query({ status: 'cancelled' }).total, 1);
  const summary = traces.query({ traceId: cancelled.traceId }).items[0];
  assert.deepEqual([summary.errorCount, summary.deniedCount], [0, 0], 'cancelled is neither an error nor a denial');
  const pending = traces.start({ kind: 'job' }).setStatus('cancelled').setStatus('running');
  pending.end();
  assert.equal(traces.span(pending.spanId).status, 'cancelled');
});

test('errors keep their scalar facts, details and one level of cause', () => {
  const { traces } = store();
  const step = traces.start({ kind: 'plugin-step', name: 'Invented.Step' });
  step.fail(
    Object.assign(new Error('Invented rule refused the item.'), {
      type: 'InvalidPluginExecutionException',
      code: '0x80040265',
      status: 'Failed',
      pluginType: 'Invented.Plugin',
      step: 'Invented.Step',
      stage: 20,
      depth: 1,
      ignored: { deep: true },
      cause: Object.assign(new Error('inner'), { code: 'Inner', cause: new Error('too deep') }),
    }),
  );
  assert.deepEqual(traces.span(step.spanId).error, {
    code: '0x80040265',
    message: 'Invented rule refused the item.',
    status: 'Failed',
    type: 'InvalidPluginExecutionException',
    pluginType: 'Invented.Plugin',
    step: 'Invented.Step',
    stage: 20,
    depth: 1,
    cause: { code: 'Inner', message: 'inner' },
  });
  const run = traces.start({ kind: 'flow-run' });
  run.end({ error: { code: 'ActionFailed', message: 'Send failed.', action: 'Send_email', password: 'p4ss' } });
  assert.deepEqual(traces.span(run.spanId).error, {
    code: 'ActionFailed',
    message: 'Send failed.',
    action: 'Send_email',
  });
});

test('every span records the level it was captured at', () => {
  const { traces } = store({ level: 'summary' });
  const quiet = traces.start({ kind: 'http' });
  traces.configure({ level: 'full' });
  const loud = traces.start({ kind: 'http' });
  quiet.end();
  loud.end();
  assert.equal(traces.span(quiet.spanId).level, 'summary');
  assert.equal(traces.span(loud.spanId).level, 'full');
});

test('recordId filters spans and traces by the record identity, ignoring braces and case', () => {
  const { traces } = store();
  const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  const page = traces.start({ kind: 'http', name: 'POST /_api/x_items' });
  const create = traces.run(page, () => traces.start({ kind: 'dataverse', name: 'Create x_item', entity: 'x_item' }));
  create.setEntity('x_item', id).end();
  page.end();
  traces.start({ kind: 'http', attributes: { recordId: id } }).end();
  assert.deepEqual(
    traces.query({ recordId: `{${id.toUpperCase()}}` }).items.map((item) => item.traceId),
    [page.traceId],
  );
  assert.deepEqual(
    traces.spans({ recordId: id }).items.map((span) => span.spanId),
    [create.spanId],
  );
  assert.equal(traces.stats({ recordId: id }).count, 1);
  assert.equal(traces.export({ recordId: id }).traces.length, 1);
  assert.equal(traces.query({ recordId: 'invented-other' }).total, 0);
});

test('search matches names, attributes, event messages and, at full, payload text, and stays current after a late event', () => {
  const { traces } = store({ level: 'full' });
  const order = traces.start({
    kind: 'dataverse',
    name: 'Update x_order',
    attributes: { stage: 'PreValidation' },
    input: { x_name: 'Order SLOW' },
  });
  order.event('flow-skipped', {
    message: 'Skipped because the condition was false',
    attributes: { reason: 'NoMatch' },
  });
  order.output({ quote: 'QuoteBackendDown' }).end();
  for (const text of ['skipped because', 'prevalidation', 'nomatch', 'flow-skipped', 'order slow', 'quotebackenddown'])
    assert.equal(traces.query({ search: text }).total, 1, text);
  assert.equal(traces.spans({ search: 'ORDER slow' }).total, 1);
  const before = traces.status().memoryBytes;
  order.event('late', { message: 'Arrived after the end' });
  assert.equal(traces.query({ search: 'arrived after' }).total, 1, 'a late event invalidates the cached text');
  assert.ok(traces.status().memoryBytes > before, 'the cached search text counts in the memory estimate');
  order.set({ note: 'Late attribute' });
  assert.equal(traces.query({ search: 'late attribute' }).total, 1);
  const running = traces.start({ kind: 'http', name: 'GET /running' });
  running.event('progress', { message: 'Halfway there' });
  assert.equal(traces.query({ search: 'halfway' }).total, 1, 'a running span is searched as it is');
  running.end();

  const summary = store({ level: 'summary' }).traces;
  summary.start({ kind: 'dataverse', input: () => ({ word: 'Payload only' }) }).end();
  assert.equal(summary.query({ search: 'payload only' }).total, 0, 'summary captures no payload to search');
});

test('redactPayload summarises file and binary columns by size, type, name and hash', () => {
  const file = Buffer.from('%PDF-1.7 invented attachment bytes '.repeat(40));
  const base64 = file.toString('base64');
  const png = Buffer.from([137, 80, 78, 71]);
  const { value } = redactPayload({
    annotation: { subject: 'Invoice', filename: 'invoice.pdf', mimetype: 'application/pdf', documentbody: base64 },
    entityimage: new Uint8Array([1, 2, 3, 4]),
    entityimage_url: '/Image/download.aspx?Entity=contact',
    note: { body: 'Approved by the manager, see the attachment.' },
    raw: base64,
    picture: `data:image/png;base64,${png.toString('base64')}`,
    attributes: [{ key: 'documentbody', value: base64 }],
    long: 'x'.repeat(5000),
    hex: 'deadbeef'.repeat(200),
  });
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(value.annotation, {
    subject: 'Invoice',
    filename: 'invoice.pdf',
    mimetype: 'application/pdf',
    documentbody: { bytes: file.length, mimetype: 'application/pdf', filename: 'invoice.pdf', sha256: sha256(file) },
  });
  assert.deepEqual(value.entityimage, { bytes: 4, sha256: sha256(Buffer.from([1, 2, 3, 4])) });
  assert.equal(value.entityimage_url, '/Image/download.aspx?Entity=contact', 'a URL under an image key stays');
  assert.equal(value.note.body, 'Approved by the manager, see the attachment.', 'a text body stays');
  assert.deepEqual(value.raw, { bytes: file.length, sha256: sha256(file) }, 'base64 over 1 KB under any key');
  assert.deepEqual(value.picture, { bytes: 4, mimetype: 'image/png', sha256: sha256(png) });
  assert.deepEqual(value.attributes[0].value, { bytes: file.length, sha256: sha256(file) }, 'a { key, value } pair');
  assert.equal(value.long, 'x'.repeat(5000), 'a long repeated letter is not a file');
  assert.equal(value.hex.length, 1600, 'a hex string is not base64 of a file');
  assert.deepEqual(redactPayload(base64).value, { bytes: file.length, sha256: sha256(file) });
  assert.equal(JSON.stringify(value).includes(base64.slice(0, 40)), false);
});

test('an error carrying a traceError records that identity on every span it fails', () => {
  const { traces } = store();
  const root = traces.start({ kind: 'http', name: 'POST /_api/x_items' });
  const dispatch = traces.run(root, () => traces.start({ kind: 'dataverse', name: 'Create x_item' }));
  const fault = Object.assign(new Error('Invented rule refused the item.'), { code: 'PluginValidation', status: 400 });
  Object.defineProperty(fault, 'traceError', {
    enumerable: false,
    value: {
      type: 'InvalidPluginExecutionException',
      code: '0x80040265',
      status: 'Failed',
      message: 'Invented rule refused the item.',
      pluginType: 'Invented.Plugin',
      step: 'Invented.Step',
      stage: 20,
      depth: 1,
    },
  });
  dispatch.fail(fault);
  root.end({ status: 'error', error: fault });
  for (const span of [dispatch, root])
    assert.deepEqual(traces.span(span.spanId).error, {
      code: '0x80040265',
      message: 'Invented rule refused the item.',
      status: 'Failed',
      type: 'InvalidPluginExecutionException',
      pluginType: 'Invented.Plugin',
      step: 'Invented.Step',
      stage: 20,
      depth: 1,
    });
  const self = Object.assign(new Error('loop'), { code: 'Loop' });
  self.traceError = self;
  const looped = traces.start({ kind: 'http' });
  looped.fail(self);
  assert.equal(traces.span(looped.spanId).error.code, 'Loop', 'a self-referencing traceError is the error itself');
});

test('a trace summary names its first failed span', () => {
  const { traces } = store();
  const root = traces.start({ kind: 'http', name: 'POST /_api/x_items' });
  const step = traces.run(root, () => traces.start({ kind: 'plugin-step', name: 'Invented.Step' }));
  step.fail(Object.assign(new Error('Invented rule refused the item.'), { code: '0x80040265' }));
  recordHttpError(root, 400, { code: '0x80040265', message: 'Invented rule refused the item.' }).end();
  const [summary] = traces.query().items;
  assert.deepEqual(summary.firstError, {
    spanId: step.spanId,
    kind: 'plugin-step',
    name: 'Invented.Step',
    status: 'error',
    code: '0x80040265',
    message: 'Invented rule refused the item.',
  });
  assert.equal(summary.errorCount, 2);
  traces.start({ kind: 'http', name: 'GET /fine' }).end();
  assert.equal('firstError' in traces.query().items[0], false, 'a trace without a failure has none');
  const denied = traces.start({ kind: 'http', name: 'GET /secure' });
  recordHttpError(denied, 403).end();
  assert.equal(traces.query({ traceId: denied.traceId }).items[0].firstError.status, 'denied');
});

test('link adds a deduplicated link to a retained span, running or ended, and persists it again', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-store-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const { traces } = store({ persist: true }, { stateDirectory: directory });
  const staging = traces.start({ kind: 'dataverse', name: 'Update x_item' });
  staging.end();
  await traces.flush();
  const job = traces.start({
    kind: 'job',
    name: 'Invented process',
    traceId: staging.traceId,
    parentSpanId: staging.spanId,
  });
  const link = { traceId: job.traceId, spanId: job.spanId, relation: 'triggered' };
  assert.equal(traces.link(staging.spanId, link), true);
  assert.equal(traces.link(staging.spanId, link), false, 'an identical link is added once');
  assert.equal(traces.link('invented-unknown', link), false);
  assert.equal(traces.link(staging.spanId, {}), false, 'a link without ids is ignored');
  assert.deepEqual(traces.span(staging.spanId).links, [link]);
  job.end();
  assert.equal(traces.link(job.spanId, { spanId: staging.spanId, relation: 'staged-by' }), true, 'an ended span');
  await traces.flush();
  const folder = path.join(directory, 'traces');
  const [file] = await fs.readdir(folder);
  const lines = (await fs.readFile(path.join(folder, file), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const latest = new Map();
  for (const line of lines) for (const span of line.spans) latest.set(span.spanId, span);
  assert.deepEqual(latest.get(staging.spanId).links, [link], 'the staging span is written again with its link');
  assert.deepEqual(latest.get(job.spanId).links.at(-1), {
    traceId: null,
    spanId: staging.spanId,
    relation: 'staged-by',
  });
  traces.configure({ level: 'off' });
  assert.equal(traces.link(staging.spanId, { spanId: job.spanId, relation: 'other' }), false, 'level off');
});

test('the secretName attribute names a secret and stays readable; secret values stay hidden', () => {
  const { traces } = store();
  const span = traces.start({
    kind: 'secret',
    attributes: { vault: 'invented-vault', secretName: 'InventedKey', secret: 'v4lue', clientSecret: 'v4lue' },
  });
  span.end();
  assert.deepEqual(traces.span(span.spanId).attributes, {
    vault: 'invented-vault',
    secretName: 'InventedKey',
    secret: '[redacted]',
    clientSecret: '[redacted]',
  });
});
