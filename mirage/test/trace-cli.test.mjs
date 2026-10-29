// paqvilo mirage trace (mirage/trace.mjs) and connectRuntime().trace against a loopback server built from the trace router
// (sim-trace-routes.mjs), a status route, a CSRF state route and a /_sim/events `trace` channel (createTraceChannel). The
// event stream produces its spans once the channel is attached, so no step waits on time; with `endStream` the server
// then drops the connection the way a stopping runtime does.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTraceStore } from '../lib/trace-store.mjs';
import { createTraceChannel, createTraceRoutes } from '../lib/sim-trace-routes.mjs';
import { connectRuntime } from '../testing/runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CSRF = 'invented-csrf';
const START = Date.parse('2026-02-01T10:00:00.000Z');

async function fixture(t, { endStream = false } = {}) {
  let time = START;
  const traces = createTraceStore({ settings: { level: 'full' }, now: () => time });
  const page = traces.start({ kind: 'http', name: 'GET /invented', module: 'portal', operation: 'get' });
  let child;
  traces.run(page, () => {
    child = traces.start({ kind: 'dataverse', name: 'Create x_item', entity: 'x_item', operation: 'create' });
    time += 3;
    child.end();
  });
  time += 1;
  page.end();
  const routes = createTraceRoutes({ traces, csrf: () => CSRF });
  const channel = createTraceChannel(traces);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (await routes(req, res, url)) return;
    if (url.pathname === '/_sim/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ sourceDir: null }));
    }
    if (url.pathname === '/_sim/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ csrf: CSRF }));
    }
    if (url.pathname === '/_sim/events' && url.searchParams.get('channels') === 'trace') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: ready\ndata: 1\n\n');
      channel(res);
      const watched = traces.start({ kind: 'http', name: 'GET /watched', module: 'portal' });
      traces.run(watched, () =>
        traces.start({ kind: 'dataverse', name: 'Update x_item', entity: 'x_item', operation: 'update' }).end(),
      );
      watched.end();
      traces.start({ kind: 'job', name: 'Invented job', module: 'jobs', async: true }).end();
      // Once the frames reach the socket, drop the connection the way a stopping runtime does.
      if (endStream) res.write(': closing\n\n', () => res.destroy());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { traces, page, child, origin: `http://127.0.0.1:${server.address().port}` };
}

const cli = (...args) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [path.join(root, 'bin/paqvilo.mjs'), 'mirage', 'trace', ...args],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 },
      (error, stdout, stderr) =>
        resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }),
    ),
  );
// The --json envelope of a successful action: { schemaVersion: 1, ok: true, command, result }.
const json = async (...args) => {
  const outcome = await cli(...args, '--json');
  assert.equal(outcome.status, 0, outcome.stderr || outcome.stdout);
  const value = JSON.parse(outcome.stdout);
  assert.deepEqual(Object.keys(value), ['schemaVersion', 'ok', 'command', 'result']);
  assert.deepEqual([value.schemaVersion, value.ok, value.command], [1, true, args[0]]);
  return value.result;
};
// The --json envelope of a failure: exit 1, { schemaVersion: 1, ok: false, command, error: { code, message } }.
const failure = async (...args) => {
  const outcome = await cli(...args, '--json');
  assert.equal(outcome.status, 1, args.join(' '));
  assert.equal(outcome.stderr, '', args.join(' '));
  const value = JSON.parse(outcome.stdout);
  assert.deepEqual(Object.keys(value), ['schemaVersion', 'ok', 'command', 'error']);
  assert.equal(value.ok, false);
  return value;
};

test('list, show, spans, stats and export read the runtime trace store in one envelope shape', async (t) => {
  const { origin, page } = await fixture(t);
  const list = await json('list', '--origin', origin);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].traceId, page.traceId);
  assert.equal((await json('list', '--sort', 'duration', '--order', 'asc', '--origin', origin)).total, 1);

  const human = await cli('list', '--origin', origin);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^STARTED\s+STATUS\s+DURATION/m);
  assert.match(human.stdout, new RegExp(`GET /invented\\s+${page.traceId}`));
  assert.match(human.stdout, /Page 1 of 1; 1 matching, 1 retained, 0 dropped\./);

  const show = await cli('show', page.traceId, '--origin', origin);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /^GET \/invented \[http\] ok 4 ms$/m);
  assert.match(show.stdout, /^ {2}Create x_item \[dataverse\] ok 3 ms x_item$/m);
  const tree = await json('show', page.traceId, '--origin', origin);
  assert.equal(tree.trace.traceId, page.traceId);
  assert.equal(tree.spans.length, 2);

  const spans = await json('spans', '--kind', 'dataverse', '--entity', 'x_item', '--origin', origin);
  assert.deepEqual(
    spans.items.map((span) => span.name),
    ['Create x_item'],
  );
  const stats = await json('stats', '--origin', origin);
  assert.equal(stats.count, 2);
  assert.equal(stats.byKind.dataverse.p50, 3);
  const statsText = (await cli('stats', '--origin', origin)).stdout;
  assert.match(statsText, /^dataverse\s+1\s+0\s+3 ms/m);
  assert.match(statsText, /^Overall: 2 spans, 0 errors, p50 3 ms, p95 4 ms, max 4 ms\.$/m);
  assert.match(statsText, /^Roots: 1 trace, 0 errors, p50 4 ms, p95 4 ms, max 4 ms\.$/m);
  const empty = (await cli('stats', '--kind', 'invented', '--origin', origin)).stdout;
  assert.match(empty, /^0 spans from — to —\.$/m);
  assert.match(empty, /^Overall: 0 spans, 0 errors, p50 —, p95 —, max —\.$/m);
  assert.doesNotMatch(empty, /running/);
});

test('export prints json, ndjson or otlp, bounded by --limit', async (t) => {
  const { origin, page } = await fixture(t);
  const exported = await cli('export', '--has-errors', 'false', '--origin', origin);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).traces[0].trace.traceId, page.traceId);
  const ndjson = await cli('export', '--format', 'ndjson', '--origin', origin);
  assert.equal(ndjson.status, 0, ndjson.stderr);
  const lines = ndjson.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['trace', 'spans']);
  const otlp = await json('export', '--format', 'otlp', '--origin', origin);
  assert.equal(otlp.resourceSpans[0].scopeSpans[0].spans[0].traceId, page.traceId.replaceAll('-', ''));
  assert.deepEqual(
    (await json('export', '--format', 'ndjson', '--limit', '1', '--origin', origin)).map((line) => line.trace.traceId),
    [page.traceId],
  );
  assert.equal((await json('export', '--origin', origin)).traces.length, 1);
  const refused = await failure('export', '--format', 'xml', '--origin', origin);
  assert.equal(refused.error.code, 'InvalidTraceFilter');
  const human = await cli('export', '--limit', '0', '--origin', origin);
  assert.equal(human.status, 1);
  assert.match(human.stderr, /\(400\): limit must be an integer from 1 to 2000\./);
});

test('every failure names its code', async (t) => {
  const { origin } = await fixture(t);
  const invalid = await failure('list', '--page-size', '0', '--origin', origin);
  assert.equal(invalid.command, 'list');
  assert.equal(invalid.error.code, 'InvalidTraceFilter');
  assert.match(invalid.error.message, /\(400\): pageSize /);
  const unknown = await failure('show', 'invented-unknown', '--origin', origin);
  assert.deepEqual(unknown.error, { code: 'TraceNotFound', message: 'No retained trace has the id invented-unknown.' });
  const human = await cli('show', 'invented-unknown', '--origin', origin);
  assert.equal(human.status, 1);
  assert.match(human.stderr, /No retained trace has the id invented-unknown/);
  assert.equal((await failure('settings', '--level', 'loud', '--origin', origin)).error.code, 'InvalidTraceSettings');
  const unreachable = await failure('list', '--origin', 'http://127.0.0.1:1');
  assert.equal(unreachable.error.code, 'RuntimeUnreachable');
  assert.equal(
    unreachable.error.message,
    'No Mirage runtime answers at http://127.0.0.1:1; start one or pass --origin.',
  );
  assert.equal((await failure('watch', '--origin', 'http://127.0.0.1:1')).error.code, 'RuntimeUnreachable');
  assert.equal((await failure('watch', '--has-errors', 'maybe', '--origin', origin)).error.code, 'InvalidTraceFilter');
});

test('settings change the level at run time and clear drops every trace', async (t) => {
  const { origin, traces } = await fixture(t);
  const read = await json('settings', '--origin', origin);
  assert.equal(read.settings.level, 'full');
  assert.equal(read.status.retained, 1);
  const changed = await json(
    'settings',
    '--level',
    'summary',
    '--persist',
    'false',
    '--traces',
    '20',
    '--origin',
    origin,
  );
  assert.equal(changed.settings.level, 'summary');
  assert.equal(changed.settings.traces, 20);
  assert.equal(traces.settings().level, 'summary');
  const refused = await cli('settings', '--level', 'loud', '--origin', origin);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /\(400\).*level/);
  assert.equal(traces.settings().level, 'summary');
  assert.match((await cli('settings', '--origin', origin)).stdout, /^level: summary$/m);
  const cleared = await json('clear', '--origin', origin);
  assert.equal(cleared.retained, 0);
  assert.equal(traces.status().retained, 0);
});

test('watch prints ended spans or traces that match its filters and stops after --count', async (t) => {
  const { origin } = await fixture(t);
  const first = await cli('watch', '--count', '1', '--origin', origin, '--json');
  assert.equal(first.status, 0, first.stderr);
  const lines = first.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0]);
  assert.deepEqual([envelope.schemaVersion, envelope.ok, envelope.command], [1, true, 'watch']);
  assert.equal(envelope.result.type, 'span-end');
  assert.equal(envelope.result.span.name, 'Update x_item');
  assert.equal(first.stderr, '');

  const job = await cli('watch', '--count', '1', '--kind', 'JOB', '--origin', origin);
  assert.match(job.stdout, /^\S+ {2}job {2}ok {2}0 ms {2}Invented job {2}trace \S+$/m);
  const module = await cli('watch', '--count', '1', '--module', 'portal', '--origin', origin, '--json');
  assert.equal(JSON.parse(module.stdout).result.span.name, 'GET /watched');

  const ended = await cli('watch', '--trace-end', '--count', '1', '--entity', 'x_item', '--origin', origin, '--json');
  assert.equal(ended.status, 0, ended.stderr);
  const frame = JSON.parse(ended.stdout).result;
  assert.equal(frame.type, 'trace-end');
  assert.equal(frame.trace.root.name, 'GET /watched');
  assert.equal(frame.trace.spanCount, 2);
  const human = await cli('watch', '--trace-end', '--count', '1', '--kind', 'job', '--origin', origin);
  assert.match(human.stdout, /^\S+ {2}ok {2}0 ms {2}1 span {2}0 errors {2}Invented job {2}trace \S+$/m);
});

test('watch ends cleanly with one stream ended line when the runtime stops', async (t) => {
  const { origin } = await fixture(t, { endStream: true });
  const watched = await cli('watch', '--status', 'ok', '--origin', origin);
  assert.equal(watched.status, 0, watched.stderr);
  assert.deepEqual(
    watched.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('  ')[4]),
    ['Update x_item (x_item)', 'GET /watched', 'Invented job'],
  );
  assert.equal(watched.stderr, 'stream ended\n');
  const counted = await cli('watch', '--count', '5', '--origin', origin, '--json');
  assert.equal(counted.status, 0, counted.stderr);
  assert.equal(counted.stdout.trim().split('\n').length, 3);
  assert.equal(counted.stderr, 'stream ended\n');
});

test('the command rejects unknown flags, actions and misplaced options before connecting', async () => {
  const bogus = await cli('--bogus');
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /--bogus/);
  assert.equal(bogus.stdout, '');
  for (const [args, message] of [
    [['--bogus'], /--bogus/],
    [[], /Usage: paqvilo mirage trace list\|show TRACE_ID/],
    [['inspect'], /Usage:/],
    [['show'], /exactly one TRACE_ID/],
    [['list', 'extra'], /Unexpected argument: extra/],
    [['clear', '--kind', 'http'], /--kind filters list, spans, stats, export and watch only/],
    [['watch', '--page', '2'], /--page applies to list, spans, stats and export, not watch/],
    [['list', '--level', 'off'], /Settings flags belong to trace settings/],
    [['watch', '--count', '0'], /--count must be a positive integer/],
    [['list', '--trace-end'], /--trace-end applies to trace watch only/],
    [['list', '--format', 'ndjson'], /--format applies to trace export only/],
    [['stats', '--limit', '5'], /--limit applies to trace export only/],
    [['list', '--origin', 'https://example.invalid'], /loopback origin/],
    [['list', '--origin', 'http://127.0.0.1:1', '--site', 'invented'], /--origin or --config\/--site/],
  ]) {
    const value = await failure(...args);
    assert.equal(value.error.code, 'InvalidArguments', args.join(' '));
    assert.match(value.error.message, message, args.join(' '));
  }
  const help = await cli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /paqvilo mirage trace .*--min-duration-ms N/);
  assert.match(help.stdout, /--sort start\|duration\|spans\|errors/);
  assert.match(help.stdout, /--format json\|ndjson\|otlp/);
});

test('connectRuntime().trace answers the store views and null for unknown ids', async (t) => {
  const { origin, page, child, traces } = await fixture(t);
  const client = await connectRuntime({ origin });
  assert.equal((await client.trace.query({ entity: 'x_item' })).total, 1);
  assert.equal((await client.trace.spans({ traceId: page.traceId })).total, 2);
  assert.equal((await client.trace.tree(page.traceId)).root.spanId, page.spanId);
  assert.equal((await client.trace.span(page.spanId)).name, 'GET /invented');
  assert.equal(await client.trace.tree('invented-unknown'), null);
  assert.equal(await client.trace.span('invented-unknown'), null);
  assert.deepEqual(
    (await client.trace.ancestry(child.spanId)).map((span) => span.spanId),
    [page.spanId, child.spanId],
  );
  assert.deepEqual(await client.trace.ancestry(child.spanId), traces.ancestry(child.spanId));
  assert.deepEqual(await client.trace.ancestry('invented-unknown'), []);
  assert.equal((await client.trace.stats({ kind: 'http' })).count, 1);
  // A Date keeps its milliseconds: one millisecond after the trace started leaves it out.
  assert.equal((await client.trace.query({ from: new Date(START) })).total, 1);
  assert.equal((await client.trace.query({ from: new Date(START + 1) })).total, 0);
  assert.equal((await client.trace.query({ from: undefined, to: null })).total, 1);
  assert.equal((await client.trace.export()).traces.length, 1);
  assert.equal((await client.trace.export({ format: 'ndjson' }))[0].trace.traceId, page.traceId);
  assert.equal((await client.trace.export({ format: 'otlp' })).resourceSpans.length, 1);
  await assert.rejects(client.trace.export({ format: 'xml' }), { status: 400, code: 'InvalidTraceFilter' });
  assert.deepEqual(await client.trace.settings(), traces.settings());
  assert.equal((await client.trace.status()).retained, 1);
  assert.equal((await client.trace.configure({ level: 'off' })).level, 'off');
  assert.equal(traces.enabled, false);
  await assert.rejects(client.trace.configure({ level: 'loud' }), { status: 400, code: 'InvalidTraceSettings' });
  await assert.rejects(client.trace.query({ order: 'sideways' }), { status: 400, code: 'InvalidTraceFilter' });
  assert.equal((await client.trace.clear()).retained, 0);
  await assert.rejects(connectRuntime({ origin: 'http://127.0.0.1:1' }), { code: 'RuntimeUnreachable' });
});

test('connectRuntime().trace.subscribe follows the trace channel until the signal aborts or the runtime stops', async (t) => {
  const { origin } = await fixture(t);
  const client = await connectRuntime({ origin });
  const controller = new AbortController();
  const events = [];
  const unsubscribe = client.trace.subscribe(
    (event) => {
      events.push(event);
      if (event.type === 'span-end' && event.span.name === 'Invented job') controller.abort();
    },
    { signal: controller.signal },
  );
  assert.equal(typeof unsubscribe, 'function');
  await unsubscribe.closed;
  assert.equal(events[0].type, 'connected');
  assert.deepEqual(
    events.filter((event) => event.type === 'span-end').map((event) => event.span.name),
    ['Update x_item', 'GET /watched', 'Invented job'],
  );
  assert.equal(
    events.filter((event) => event.type === 'trace-end').length,
    2,
    'the watched request and the job each end a trace',
  );
  const stopped = client.trace.subscribe(() => {});
  stopped();
  await stopped.closed;

  const ending = await fixture(t, { endStream: true });
  const types = [];
  const closed = (await connectRuntime({ origin: ending.origin })).trace.subscribe((event) => types.push(event.type));
  await closed.closed;
  assert.equal(types.at(-1), 'trace-end');
  const failing = client.trace.subscribe(() => {
    throw new Error('Invented listener failure.');
  });
  await assert.rejects(failing.closed, /Invented listener failure/);
  assert.throws(() => client.trace.subscribe(null), TypeError);
});
