// Connector tracing (docs/design/tracing.md): one connector span per invoke with retry and page events, failures and
// denials as span statuses, payloads only at level full and never for a secure call, and loopback HTTP that carries the
// span's trace headers so the local service's root joins the trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition } from '../lib/flow-runtime.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';

const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } };
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function traced(level = 'full', packs = []) {
  const store = await new DataStore({ state: emptyState() }).init();
  store.traces = createTraceStore({ settings: { level } });
  const notes = [];
  const connectors = createConnectorRuntime({ store, packs, diagnostic: (note) => notes.push(note) });
  return { store, traces: store.traces, connectors, notes };
}
const invented = (operations) => ({ id: 'invented-pack', connectors: { x_api: { operations } } });
const call = (connectors, operationId, parameters = {}, context = {}) =>
  connectors.invoke({ connectorId: 'x_api', operationId, parameters, context });

test('a retried call is one connector span with retry events, its attempts and its payloads at level full', async () => {
  let calls = 0;
  const { traces, connectors, notes } = await traced('full', [
    invented({ Op: () => ({ statusCode: ++calls === 1 ? 408 : 200, body: { calls } }) }),
  ]);
  const root = traces.start({ kind: 'http', name: 'POST /invented' });
  const answer = await traces.run(root, () =>
    connectors.invoke({
      connectorId: 'x_api',
      operationId: 'Op',
      parameters: { value: 'Visible' },
      retry: { type: 'fixed', count: 2, intervalMs: 0 },
      context: { caller: 'invented', runId: 'run-1', actionPath: 'op' },
    }),
  );
  root.end();
  assert.equal(answer.statusCode, 200);
  const spans = traces.spans({ kind: 'connector' }).items;
  assert.equal(spans.length, 1, 'one span per call, never per attempt');
  const [span] = spans;
  assert.equal(span.parentSpanId, root.spanId);
  assert.deepEqual([span.name, span.module, span.operation, span.status], ['x_api/Op', 'connectors', 'invoke', 'ok']);
  assert.deepEqual(
    [span.attributes.caller, span.attributes.runId, span.attributes.actionPath, span.attributes.attempts],
    ['invented', 'run-1', 'op', 2],
  );
  assert.equal(span.attributes.provider, 'pack:invented-pack');
  assert.deepEqual(
    span.events.map((event) => [event.type, event.attributes.attempt, event.attributes.statusCode]),
    [['retry', 1, 408]],
  );
  assert.deepEqual(span.input, { value: 'Visible' });
  assert.deepEqual(span.output.body, { calls: 2 });
  assert.ok(
    notes.some((note) => note.code === 'CONNECTOR_INVOKE'),
    'the CONNECTOR_INVOKE diagnostic stays',
  );
});

test('a failed call fails its span; a secure call and the summary level capture no payloads', async () => {
  const { traces, connectors } = await traced('full', [
    invented({
      Boom: () => {
        throw new Error('Invented provider failure');
      },
      Echo: (request) => ({ statusCode: 200, body: request.parameters }),
    }),
  ]);
  await assert.rejects(async () => call(connectors, 'Boom'), { code: 'ProviderFailed' });
  const [failed] = traces.spans({ kind: 'connector' }).items;
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.code, 'ProviderFailed');

  await call(connectors, 'Echo', { value: 'Sealed' }, { secure: true });
  const [secure] = traces.spans({ kind: 'connector' }).items;
  assert.equal(secure.status, 'ok');
  assert.equal(Object.hasOwn(secure, 'input') || Object.hasOwn(secure, 'output'), false);
  assert.doesNotMatch(JSON.stringify(secure), /Sealed/);

  traces.configure({ level: 'summary' });
  await call(connectors, 'Echo', { value: 'Summary' });
  const [summary] = traces.spans({ kind: 'connector' }).items;
  assert.equal(Object.hasOwn(summary, 'input') || Object.hasOwn(summary, 'output'), false);
});

test('the http provider forwards the connector span to a loopback service; later pages are events', async (t) => {
  const seen = [];
  const origin = await listen(t, (req, res) => {
    seen.push({ url: req.url, parent: req.headers['x-sim-parent-trace'], trace: req.headers['x-sim-trace-id'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      req.url === '/items'
        ? JSON.stringify({ value: [1], '@odata.nextLink': origin + '/items?page=2' })
        : JSON.stringify({ value: [2] }),
    );
  });
  const { store, traces } = await traced('summary');
  const connectors = createConnectorRuntime({ store });
  const definition = {
    triggers: manual,
    actions: {
      list: {
        type: 'Http',
        inputs: { method: 'GET', uri: origin + '/items' },
        runtimeConfiguration: { paginationPolicy: { minimumItemCount: 2 } },
      },
      reply: {
        type: 'Response',
        runAfter: { list: ['Succeeded'] },
        inputs: { statusCode: 200, body: "@body('list')" },
      },
    },
  };
  const root = traces.start({ kind: 'http', name: 'POST /invented' });
  const answer = await traces.run(root, () => executeFlowDefinition({ definition, input: {}, store, connectors }));
  root.end();
  assert.deepEqual(answer.body.value, [1, 2]);
  const [span] = traces.spans({ kind: 'connector' }).items;
  assert.equal(span.traceId, root.traceId);
  assert.equal(traces.span(span.parentSpanId).kind, 'flow-action', 'the connector span is a child of its action');
  assert.equal(seen.length, 2);
  for (const request of seen) assert.deepEqual([request.parent, request.trace], [span.spanId, span.traceId]);
  assert.equal(span.attributes.pages, 2);
  assert.deepEqual(
    span.events.map((event) => event.type),
    ['page'],
  );
});

test('without a trace store or at level off a connector call records nothing and sends no trace headers', async (t) => {
  const seen = [];
  const origin = await listen(t, (req, res) => {
    seen.push(Object.keys(req.headers).filter((name) => name.startsWith('x-sim-')));
    res.end();
  });
  const { store, traces } = await traced('off');
  const connectors = createConnectorRuntime({ store });
  const http = (uri) =>
    connectors.invoke({ connectorId: 'http', operationId: 'Http', parameters: { method: 'GET', uri } });
  await http(origin + '/off');
  await createConnectorRuntime({}).invoke({
    connectorId: 'http',
    operationId: 'Http',
    parameters: { method: 'GET', uri: origin + '/bare' },
  });
  assert.deepEqual(seen, [[], []]);
  assert.equal(traces.status().spans, 0);
});

test('a provider answer maps to the span status like a thrown error: 401/403 denied, other 4xx/5xx error', async () => {
  const { traces, connectors } = await traced('summary', [
    invented({
      Forbidden: () => ({ statusCode: 403, body: {} }),
      Unauthorized: () => ({ statusCode: 401, body: {} }),
      Missing: () => ({ statusCode: 404, body: {} }),
      Broken: () => ({ statusCode: 500, body: {} }),
      Fine: () => ({ statusCode: 204 }),
    }),
  ]);
  for (const operationId of ['Forbidden', 'Unauthorized', 'Missing', 'Broken', 'Fine'])
    await call(connectors, operationId);
  assert.deepEqual(
    traces
      .spans({ kind: 'connector', order: 'asc' })
      .items.map((span) => [span.attributes.operationId, span.attributes.status, span.status]),
    [
      ['Forbidden', 403, 'denied'],
      ['Unauthorized', 401, 'denied'],
      ['Missing', 404, 'error'],
      ['Broken', 500, 'error'],
      ['Fine', 204, 'ok'],
    ],
  );
});

// D-R3-4 (DV-A-11, DV-B1-6, DV-C-1, DV-B2-13): the span error is the provider's own, whether it threw or answered.
test("a provider's own exception and error answer are the connector span's error, with the exception's cause", async () => {
  const { traces, connectors } = await traced('full', [
    invented({
      Explode: () => {
        throw Object.assign(new Error('Invented connector exploded', { cause: new Error('Invented socket reset') }), {
          code: 'InventedExplode',
        });
      },
      Plain: () => {
        throw new Error('Invented plain failure');
      },
      Down: () => ({
        statusCode: 502,
        body: { error: { code: 'InventedBackendDown', message: 'Invented backend unavailable' } },
      }),
      Flat: () => ({ statusCode: 409, body: { code: 'InventedConflict', message: 'Invented conflict' } }),
      Bare: () => ({ statusCode: 500, body: 'oops' }),
    }),
  ]);
  const thrown = await call(connectors, 'Explode').catch((error) => error);
  assert.deepEqual([thrown.code, thrown.status, thrown.cause.code], ['ProviderFailed', 502, 'InventedExplode']);
  await assert.rejects(async () => call(connectors, 'Plain'), { code: 'ProviderFailed' });
  for (const operationId of ['Down', 'Flat', 'Bare']) await call(connectors, operationId);
  const byOperation = Object.fromEntries(
    traces.spans({ kind: 'connector' }).items.map((span) => [span.attributes.operationId, span]),
  );
  const exploded = byOperation.Explode;
  assert.equal(exploded.status, 'error');
  assert.deepEqual(
    [exploded.error.code, exploded.error.message, exploded.error.status, exploded.attributes.mappedCode],
    ['InventedExplode', 'Invented connector exploded', 502, 'ProviderFailed'],
  );
  assert.deepEqual(exploded.error.cause, { code: 'Error', message: 'Invented socket reset' });
  assert.deepEqual(
    [byOperation.Plain.error.code, byOperation.Plain.error.message],
    ['ProviderFailed', 'Invented plain failure'],
  );
  assert.deepEqual(
    ['Down', 'Flat', 'Bare'].map((operationId) => {
      const { status, error } = byOperation[operationId];
      return [status, error.code, error.message, error.status];
    }),
    [
      ['error', 'InventedBackendDown', 'Invented backend unavailable', 502],
      ['error', 'InventedConflict', 'Invented conflict', 409],
      ['error', 'Http500', 'The connector answered status 500.', 500],
    ],
  );
  // The error object is no payload: the summary level keeps it too; a sealed call keeps only the codes and status.
  traces.clear();
  traces.configure({ level: 'summary' });
  await call(connectors, 'Down');
  await assert.rejects(async () => call(connectors, 'Explode', {}, { secure: true }), { code: 'ProviderFailed' });
  await call(connectors, 'Down', {}, { secure: true });
  const [sealedDown, sealedExplode, summaryDown] = traces.spans({ kind: 'connector' }).items;
  assert.deepEqual(
    [summaryDown.error.code, summaryDown.error.message],
    ['InventedBackendDown', 'Invented backend unavailable'],
  );
  assert.deepEqual(
    [sealedExplode.error.code, sealedExplode.error.message],
    ['InventedExplode', 'The connector provider failed.'],
  );
  assert.equal(sealedExplode.error.cause, undefined);
  assert.deepEqual([sealedDown.error.code, sealedDown.error.status], ['Http502', 502]);
  assert.doesNotMatch(JSON.stringify(sealedDown), /Invented backend/);
});
