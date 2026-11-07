// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// An on-demand flow run started through /_sim/api/flow-runs (sim-flow-routes.mjs) opens a flow-run span named after the
// flow's display name, and the run view at /_sim/api/flow-runs/<id> names its trace (docs/design/tracing.md). Every
// run-starting request (on-demand run, HTTP Request trigger route, signed callback URL) is an http root of module flows
// that joins the caller's trace, answers with trace headers, records its error answers and parents the flow-run (D-R3-28).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds, storeScheduler } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { createFlowRoutes } from '../lib/sim-flow-routes.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const BUTTON = '77777777-7777-4777-8777-0000000000b1',
  HTTP_FLOW = '77777777-7777-4777-8777-0000000000b2',
  BROKEN = '77777777-7777-4777-8777-0000000000b3';
const DEFINITION = {
  triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } },
  actions: { Note: { type: 'Compose', runAfter: {}, inputs: 'pressed' } },
};
const httpFlow = (statusCode, body) => ({
  triggers: { request: { type: 'Request', kind: 'Http', inputs: { method: 'POST', schema: { type: 'object' } } } },
  actions: { Reply: { type: 'Response', runAfter: {}, inputs: { statusCode, body } } },
});
const FLOWS = {
  [BUTTON]: { name: 'Invented button flow', definition: DEFINITION },
  [HTTP_FLOW]: { name: 'Invented intake flow', definition: httpFlow(200, { ok: true }) },
  [BROKEN]: {
    name: 'Invented broken flow',
    definition: httpFlow(500, { error: { code: 'InventedIntakeFailed', message: 'Invented intake failed' } }),
  },
};

async function setup(t, options = {}) {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  store.traces = createTraceStore();
  const scheduler = createScheduler({ clock, manual: true });
  storeScheduler(store, scheduler);
  ownedFixture(t).add(() => scheduler.close());
  const connectors = createConnectorRuntime({ store, scheduler, clock });
  const flowOf = (id) => (FLOWS[id] ? { ...FLOWS[id], mode: 'exported', connectors } : null);
  const runs = createHostFlowRuns({ store, clock, scheduler, approvals: connectors.approvals, flowOf });
  const api = { store };
  runs.attach(api);
  ownedFixture(t).add(() => runs.close());
  const routes = createFlowRoutes({ api: { ...api, flowRuns: runs }, csrf: () => 'invented-csrf', ...options });
  const server = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://' + req.headers.host)))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const traces = store.traces;
  // The root ends on its response's close: an answer's root, once its span-end event arrived (or it already ended).
  const rootOf = (answer) => {
    const spanId = answer.headers.get('x-sim-span-id');
    return new Promise((resolve) => {
      const stop = traces.subscribe((event) => {
        if (event.type === 'span-end' && event.span.spanId === spanId) {
          stop();
          resolve(traces.span(spanId));
        }
      });
      if (traces.span(spanId)?.status !== 'running') {
        stop();
        resolve(traces.span(spanId));
      }
    });
  };
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': 'invented-csrf', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return { store, traces, runs, call, rootOf };
}

test('an on-demand run is a flow-run span with the flow display name; its run view names the trace', async (t) => {
  const { traces, call } = await setup(t);
  const started = await call('POST', '/_sim/api/flow-runs', { processId: BUTTON });
  assert.deepEqual([started.status, started.body.status], [201, 'Succeeded']);
  const [run] = traces.spans({ kind: 'flow-run' }).items;
  assert.deepEqual(
    [run.name, run.actor.name, run.attributes.trigger, run.status],
    ['Invented button flow', 'Invented button flow', 'Manual', 'ok'],
  );
  const view = await call('GET', `/_sim/api/flow-runs/${started.body.id}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.traceId, run.traceId);
});

test('a run-starting request is an http root of module flows that joins its caller and names its trace', async (t) => {
  const { traces, call, rootOf } = await setup(t, { origin: { host: 'standalone', portal: null, preset: null } });
  const caller = traces.start({ kind: 'http', name: 'POST /invented/caller' });
  const started = await call('POST', '/_sim/api/flow-runs', { processId: BUTTON }, traces.headers(caller));
  const root = await rootOf(started);
  caller.end();
  assert.equal(started.headers.get('x-trace-id'), caller.traceId, 'the answer names the joined trace');
  assert.deepEqual(
    [root.kind, root.name, root.module, root.parentSpanId, root.origin.host, root.actor.kind, root.status],
    ['http', 'POST /_sim/api/flow-runs', 'flows', caller.spanId, 'standalone', 'system', 'ok'],
  );
  assert.deepEqual([root.attributes.route, root.attributes.statusCode], ['flow-run', 201]);
  const [run] = traces.spans({ kind: 'flow-run', traceId: caller.traceId }).items;
  assert.equal(run.parentSpanId, root.spanId, 'the flow-run is a child of the request root');

  // Without caller headers the public HTTP-trigger path is a new root.
  const posted = await call('POST', `/_sim/api/flow-triggers/${HTTP_FLOW}`, { x_name: 'posted' });
  assert.equal(posted.status, 200);
  const intake = await rootOf(posted);
  assert.deepEqual(
    [intake.parentSpanId, intake.attributes.route, intake.origin.host],
    [null, 'flow-trigger', 'standalone'],
  );
  assert.equal(traces.spans({ kind: 'flow-run', traceId: intake.traceId }).items[0].parentSpanId, intake.spanId);
});

test('the signed callback URL root is an anonymous caller; error answers record their code and message', async (t) => {
  const { traces, call, rootOf } = await setup(t);
  const issued = await call('POST', `/_sim/api/flow-triggers/${HTTP_FLOW}/callback-url`);
  assert.equal(traces.query().total, 0, 'issuing the callback URL is administration: no root');
  const invoked = await call('POST', issued.body.url, { x_name: 'signed' }, { 'x-sim-csrf': '' });
  assert.equal(invoked.status, 200);
  const signed = await rootOf(invoked);
  assert.deepEqual(
    [signed.module, signed.origin.host, signed.actor, signed.attributes.route, signed.attributes.signed],
    ['flows', 'sim', { kind: 'anonymous', id: null, name: 'caller' }, 'flow-callback', true],
  );
  assert.doesNotMatch(signed.name, /sig=/, 'the root name carries no signature');
  assert.equal(traces.spans({ kind: 'flow-run', traceId: signed.traceId }).items[0].parentSpanId, signed.spanId);

  // A wrong signature (401), a wrong CSRF token (403) and a flow Response of 500 reach the root as its error.
  const forged = new URL(issued.body.url);
  forged.searchParams.set('sig', 'invented-forgery');
  const refused = await call('POST', forged.href, { x_name: 'forged' });
  const denied = await call('POST', '/_sim/api/flow-runs', { processId: BUTTON }, { 'x-sim-csrf': 'wrong' });
  const broken = await call('POST', `/_sim/api/flow-triggers/${BROKEN}`, {});
  assert.deepEqual([refused.status, denied.status, broken.status], [401, 403, 500]);
  const roots = [];
  for (const answer of [refused, denied, broken]) roots.push(await rootOf(answer));
  assert.deepEqual(
    roots.map((root) => [root.status, root.error.code, root.error.status, root.attributes.statusCode]),
    [
      ['denied', 'DirectApiInvalidAuthorizationSignature', 401, 401],
      ['denied', 'Forbidden', 403, 403],
      ['error', 'InventedIntakeFailed', 500, 500],
    ],
  );
  assert.equal(roots[2].error.message, 'Invented intake failed');
});
