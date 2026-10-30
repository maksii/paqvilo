// Tracing of Power Pages server logic (D-R3-9, DV-A-4, DV-A-15, DV-A-17): one `server-logic` span per run (never the classic
// `workflow` kind) with the call as input and the result as output at level full, each Logger line a `trace` event, and each
// HttpClient request an http-out span (tracedFetch) whose request carries the span's trace headers to the loopback receiver.
// Invented site and loopback receiver only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { emptyState } from '../lib/data.mjs';
import { runExportedServerLogic } from '../lib/exported-operations.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '77777777-7777-4777-8777-7777777777c1';
const CONTACT = '77777777-7777-4777-8777-7777777777c2';

async function logic(t, code) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-server-logic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'logic.js'), code);
  return { name: 'invented-logic', file: await fs.realpath(path.join(dir, 'logic.js')) };
}

async function receiver(t) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.writeHead(req.url.endsWith('/missing') ? 404 : 200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url.endsWith('/missing')
            ? { error: { code: 'InventedMissing', message: 'No such object.' } }
            : { ok: true },
        ),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { received, origin: `http://127.0.0.1:${server.address().port}/` };
}

test('a server logic run is a server-logic span with input, output, Logger lines as trace events and HttpClient as http-out spans', async (t) => {
  const target = await receiver(t);
  const traces = createTraceStore({ settings: { level: 'full' } });
  const store = { state: emptyState(), traces };
  const code =
    'async function post(){ Server.Logger.Log("invented start"); ' +
    "const a = JSON.parse(await Server.Connector.HttpClient.PostAsync('https://api.example.test/objects', JSON.stringify({ n: 1 }), {}, 'application/json')); " +
    "const b = JSON.parse(await Server.Connector.HttpClient.GetAsync('https://api.example.test/missing')); " +
    'Server.Logger.Error("invented end", 2); return { first: a.StatusCode, second: b.StatusCode }; }';
  const request = traces.start({ kind: 'http', name: 'POST /_api/serverlogics/invented-logic' });
  const raw = await traces.run(request, async () =>
    runExportedServerLogic({
      record: await logic(t, code),
      portal: { settings: {}, website: { id: SITE, name: 'Invented site' } },
      store,
      identity: { id: CONTACT, contactId: CONTACT },
      method: 'POST',
      operation: 'post',
      body: '{"order":"A-1"}',
      query: { mode: 'invented' },
      services: { httpRewrites: { 'https://api.example.test/': target.origin } },
    }),
  );
  request.end();
  assert.deepEqual(JSON.parse(raw), { first: 200, second: 404 });

  const { spans } = traces.tree(request.traceId);
  const [run] = spans.filter((span) => span.kind === 'server-logic');
  assert.ok(run, 'the run has a server-logic span');
  assert.equal(spans.filter((span) => span.kind === 'workflow').length, 0, 'never the classic workflow kind');
  assert.equal(run.parentSpanId, request.spanId);
  assert.equal(run.name, 'Server logic invented-logic');
  assert.equal(run.operation, 'post');
  assert.equal(run.status, 'ok');
  assert.deepEqual(run.input, {
    function: 'post',
    method: 'POST',
    body: { order: 'A-1' },
    input: null,
    query: { mode: 'invented' },
  });
  assert.deepEqual(run.output, { first: 200, second: 404 });
  assert.deepEqual(
    run.events.filter((event) => event.type === 'trace').map((event) => [event.attributes.level, event.message]),
    [
      ['Log', 'invented start'],
      ['Error', 'invented end 2'],
    ],
  );

  const outbound = spans.filter((span) => span.kind === 'http-out');
  assert.equal(outbound.length, 2);
  for (const span of outbound) assert.equal(span.parentSpanId, run.spanId);
  const [posted, missing] = outbound;
  assert.equal(posted.attributes.method, 'POST');
  assert.equal(posted.attributes.status, 200);
  assert.deepEqual(posted.input.body, { n: 1 });
  assert.deepEqual(posted.output.body, { ok: true });
  assert.equal(missing.status, 'error');
  assert.deepEqual([missing.error.code, missing.error.message], ['InventedMissing', 'No such object.']);
  assert.equal(target.received[0].headers['x-sim-parent-trace'], posted.spanId);
  assert.equal(target.received[0].headers['x-trace-id'], request.traceId);
});

test('a failed server logic run fails its span with the error', async (t) => {
  const traces = createTraceStore({ settings: { level: 'summary' } });
  await assert.rejects(
    runExportedServerLogic({
      record: await logic(t, 'function get(){ throw new Error("invented logic failure"); }'),
      portal: { settings: {}, website: { id: SITE, name: 'Invented site' } },
      store: { state: emptyState(), traces },
      identity: null,
      method: 'GET',
      operation: 'get',
    }),
  );
  const [run] = traces.spans({ kind: 'server-logic' }).items;
  assert.equal(run.status, 'error');
  assert.match(run.error.message, /invented logic failure/);
  assert.equal(run.input ?? null, null, 'summary: no payload');
});
