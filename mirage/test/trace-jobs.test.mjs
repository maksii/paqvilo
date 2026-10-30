// Tracing across async boundaries (docs/design/tracing.md): a committed job opens its job span under the staging span
// the trace store remembered for its id (never the context the scheduler inherited), staging is a job-staged event,
// retries are events, and web hook posts are http-out spans that forward the trace to the loopback receiver. Invented
// schemas only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { settleCommittedWork, traceJob } from '../lib/committed-work.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';

const HOOK_AUDIT = '0a0d1700-0000-4000-8000-0000000000a1';
import { webhookDelivery } from '../lib/dataverse-webhooks.mjs';
import { workflowExtension, workflowHandlers } from '../lib/dataverse-workflows.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { widgetApi, wireRegisteredSteps } from './support/service-endpoint-pipeline.mjs';

const STEP = '10000000-0000-4000-8000-0000000000b1';
const asyncStep = {
  id: STEP,
  name: 'Invented asynchronous step',
  entity: 'widget',
  message: 'Create',
  enabled: true,
  stage: 40,
  rank: 1,
  mode: 1,
  typeName: 'Invented.Async',
  assemblyId: 'invented',
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
};

test('an async plug-in job opens its job span under the staging span, whatever context runs the scheduler', async (t) => {
  const store = new DataStore({
    state: {
      version: 1,
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
      tables: { widget: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  store.scheduler = createScheduler({ manual: true });
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  const traces = store.traces;
  const handlers = new Map([[STEP, ({ trace }) => trace('Invented async line')]]);
  const items = () => pluginCatalogue({ plugins: { steps: [asyncStep] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items: items(), handlers }));
  const runner = createAsyncPluginRunner({ store, items, handlers, runtimes: new Map() });
  t.after(() => runner.close());

  const request = traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
  await traces.run(request, () => store.create('widget', { title: 'Staged' }, { admin: true }));
  request.end();
  // The tick runs while an unrelated span is current: the job must not take it as its parent.
  const unrelated = traces.start({ kind: 'http', name: 'GET /unrelated' });
  await traces.run(unrelated, () => store.scheduler.runDue());
  unrelated.end();
  await runner.drain();

  const { spans } = traces.tree(request.traceId);
  const staged = spans.find((span) => span.spanId === request.spanId).events.find((e) => e.type === 'job-staged');
  assert.equal(staged.attributes.kind, 'plugin');
  const job = spans.find((span) => span.kind === 'job');
  assert.ok(job, 'the job joined the staging trace');
  assert.equal(job.async, true);
  assert.equal(job.parentSpanId, request.spanId);
  assert.equal(job.module, 'jobs');
  // The job names the process it runs and the record of its triggering event (D-R3-24, D-R3-1).
  // The name is the process display name alone: the kind says it is a job (a tree line reads "job <process>").
  assert.equal(job.name, 'Invented asynchronous step');
  assert.equal(job.name, job.attributes.processName);
  assert.doesNotMatch(job.name, /^job /);
  assert.deepEqual(
    [job.attributes.processType, job.attributes.processId, job.attributes.processName],
    ['plugin', STEP, 'Invented asynchronous step'],
  );
  const widgetId = store.tableRows('widget')[0].widgetid;
  assert.deepEqual([job.entity, job.recordId], ['widget', widgetId]);
  assert.deepEqual(job.links, [{ traceId: request.traceId, spanId: request.spanId, relation: 'staged-by' }]);
  assert.deepEqual(
    spans.find((span) => span.spanId === request.spanId).links,
    [{ traceId: request.traceId, spanId: job.spanId, relation: 'triggered' }],
    'the staging span names the job it triggered',
  );
  assert.equal(job.attributes.kind, 'plugin');
  assert.equal(job.attributes.jobId, staged.attributes.asyncOperationId);
  assert.equal(job.attributes.attempt, 1);
  assert.equal(job.status, 'ok');
  const stage = spans.find((span) => span.kind === 'plugin-stage');
  assert.equal(stage.parentSpanId, job.spanId);
  assert.equal(stage.attributes.asyncExecution, true);
  const run = spans.find((span) => span.kind === 'plugin-step');
  assert.equal(run.parentSpanId, stage.spanId);
  assert.deepEqual([stage.recordId, run.recordId], [widgetId, widgetId], 'the stage and step name the job record');
  assert.deepEqual(
    run.events.filter((event) => event.type === 'trace').map((event) => event.message),
    ['Invented async line'],
  );
  assert.equal(traces.tree(unrelated.traceId).spans.length, 1, 'nothing ran under the unrelated span');
});

test('traceJob parents explicitly, records retries, fails on a rejection and runs plainly without a trace store', async () => {
  const store = { traces: createTraceStore({ settings: { level: 'summary' } }) };
  const traces = store.traces;
  const staging = traces.start({ kind: 'http', name: 'POST /staging' });
  staging.end();
  const job = { id: 'job-1', payload: { kind: 'webhook', attempts: 1, chain: { id: 'chain-1', depth: 0 } } };
  traces.remember('job:job-1', { traceId: staging.traceId, spanId: staging.spanId });
  const ambient = traces.start({ kind: 'http', name: 'ambient' });
  await assert.rejects(
    traces.run(ambient, () =>
      traceJob(store, { ...job, event: {} }, async (span) => {
        assert.equal(traces.current(), span, 'the work runs inside the job span');
        throw Object.assign(new Error('Invented delivery failure'), { code: 'InventedFailure' });
      }),
    ),
    /Invented delivery failure/,
  );
  ambient.end();
  const [failed] = traces.spans({ kind: 'job' }).items;
  assert.equal(failed.traceId, staging.traceId);
  assert.equal(failed.parentSpanId, staging.spanId);
  assert.equal(failed.operation, 'run', 'every job span uses operation run; the kind is an attribute');
  assert.equal(failed.attributes.kind, 'webhook');
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.code, 'InventedFailure');
  assert.equal(failed.attributes.attempt, 2);
  assert.deepEqual(
    failed.events.map((event) => [event.type, event.attributes?.attempt]),
    [['retry', 2]],
  );

  // A job the trace store does not remember (staged without a trace, or before a restart) starts its own trace,
  // with the job origin, even while another span is current.
  const other = traces.start({ kind: 'http', name: 'other' });
  await traces.run(other, () => traceJob(store, { ...job, id: 'job-2', event: { entity: 'widget' } }, () => 'done'));
  other.end();
  assert.equal(traces.tree(other.traceId).spans.length, 1, 'the job never joins the current span');
  const [root] = traces.query({ kind: 'job', host: 'job' }).items;
  assert.equal(root.root.parentSpanId, null);
  assert.equal(root.root.origin.host, 'job');
  assert.equal(root.root.entity, 'widget');

  assert.equal(await traceJob({}, job, (span) => span), null, 'no store, no span');
});

// A store with an async plug-in step on widget Create on a manual scheduler; options seed the trace store and the
// id and clock sources.
function asyncWorld(t, { trace = {}, ids, clock } = {}) {
  const store = new DataStore({
    state: {
      version: 1,
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
      tables: { widget: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
    ...(ids ? { ids } : {}),
    ...(clock ? { clock } : {}),
  });
  store.scheduler = createScheduler({ manual: true, ...(clock ? { clock } : {}) });
  store.traces = createTraceStore({ settings: { level: 'summary', ...trace } });
  const handlers = new Map([[STEP, ({ trace: line }) => line('Invented async line')]]);
  const items = () => pluginCatalogue({ plugins: { steps: [asyncStep] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items: items(), handlers }));
  const runner = createAsyncPluginRunner({ store, items, handlers, runtimes: new Map() });
  t.after(() => runner.close());
  return { store, runner, traces: store.traces };
}

test('trace ids never enter asyncoperation.data: two runs of the same fixture stage identical rows', async (t) => {
  const rows = [];
  for (let run = 0; run < 2; run++) {
    const { store, traces } = asyncWorld(t, { trace: { level: 'full' }, ids: sequentialIds(), clock: fixedClock() });
    const request = traces.start({ kind: 'http', name: 'POST /invented' });
    await traces.run(request, () => store.create('widget', { title: 'Deterministic' }, { admin: true }));
    request.end();
    const staged = JSON.stringify(store.state.tables.asyncoperation);
    assert.equal(store.state.tables.asyncoperation.length, 1);
    assert.equal(staged.includes(request.traceId) || staged.includes(request.spanId), false);
    assert.deepEqual(traces.recall('job:' + store.state.tables.asyncoperation[0].asyncoperationid), {
      traceId: request.traceId,
      spanId: request.spanId,
    });
    rows.push(staged);
  }
  assert.equal(rows[0], rows[1], 'the same actions give the same state bytes, whatever the trace ids');
});

test('job-staged lands on the span that recorded the committed event, after the commit saved; a rollback records none', async (t) => {
  const { store, runner, traces } = asyncWorld(t);
  const request = traces.start({ kind: 'http', name: 'POST /invented' });
  const operation = traces.start({ kind: 'dataverse', name: 'Create widget', parentSpanId: request.spanId });
  // The event is recorded inside the operation span; the commit (and its staging) runs in the request span, as a
  // Web API write records it in its dataverse span and commits in its webapi span.
  await traces.run(request, () =>
    store.transact(() => {
      const row = { widgetid: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Staged' };
      store.state.tables.widget.push(row);
      traces.run(operation, () => store.recordCommittedEvent('widget', 'create', row, ['title']));
    }),
  );
  operation.end();
  request.end();
  await store.scheduler.runDue();
  await runner.drain();
  const { spans } = traces.tree(request.traceId);
  const staged = (span) => traces.span(span.spanId).events.filter((event) => event.type === 'job-staged');
  assert.equal(staged(request).length, 0, 'not on the span current at commit');
  assert.equal(staged(operation).length, 1);
  const job = spans.find((span) => span.kind === 'job');
  assert.equal(job.parentSpanId, operation.spanId, 'the job and its stage event agree on the parent');
  assert.equal(job.attributes.jobId, staged(operation)[0].attributes.asyncOperationId);

  traces.clear();
  const unstage = store.addCommitStager(() => {
    throw Object.assign(new Error('Invented later stager failure'), { code: 'InventedStager' });
  });
  const failing = traces.start({ kind: 'http', name: 'POST /invented' });
  await assert.rejects(
    traces.run(failing, () => store.create('widget', { title: 'Rolled back' }, { admin: true })),
    /Invented later stager failure/,
  );
  failing.end();
  unstage();
  assert.equal(staged(failing).length, 0, 'a commit that rolled back stages nothing');
  assert.equal(store.state.tables.asyncoperation?.length ?? 0, 0);
});

test('a job of a capped staging trace never joins the trace of the context that ran the tick', async (t) => {
  const { store, runner, traces } = asyncWorld(t, { trace: { spansPerTrace: 50 } });
  const staging = traces.start({ kind: 'http', name: 'POST /full' });
  await traces.run(staging, async () => {
    await store.create('widget', { title: 'Capped' }, { admin: true });
    while (traces.tree(staging.traceId).spans.length < 50) traces.start({ kind: 'internal', name: 'filler' }).end();
  });
  staging.end();
  const before = traces.tree(staging.traceId).trace.droppedSpans;
  // The tick runs (and its bookkeeping commits) while a span of another trace is current.
  const unrelated = traces.start({ kind: 'http', name: 'GET /unrelated' });
  await traces.run(unrelated, () => store.scheduler.runDue());
  await traces.run(unrelated, () => runner.drain());
  unrelated.end();
  assert.equal(traces.tree(unrelated.traceId).spans.length, 1, 'nothing joined the unrelated trace');
  assert.deepEqual(traces.span(unrelated.spanId).events, [], 'no commit or job event on the unrelated span');
  assert.equal(traces.tree(staging.traceId).spans.length, 50);
  assert.ok(traces.tree(staging.traceId).trace.droppedSpans > before, 'the job and its children were refused there');
});

// A store with the Dataverse API and a web hook step on contoso_widget Create, wired as server.mjs wires it.
async function webhookWorld(t, { mode, url }) {
  const { store, api, messageId, filterId } = await widgetApi('contoso');
  const endpointId = 'cccccccc-0000-4000-8000-0000000000c1';
  await store.create(
    'serviceendpoint',
    { serviceendpointid: endpointId, name: 'Invented hook', url, authtype: 4, contract: 8, authvalue: 'invented-code' },
    { admin: true },
  );
  await store.create(
    'sdkmessageprocessingstep',
    {
      sdkmessageprocessingstepid: 'dddddddd-0000-4000-8000-0000000000d1',
      name: 'Invented webhook step',
      sdkmessageid: messageId,
      sdkmessagefilterid: filterId,
      eventhandler: { id: endpointId, logical_name: 'serviceendpoint' },
      stage: 40,
      mode,
      rank: 1,
      statecode: 0,
      supporteddeployment: 0,
    },
    { admin: true },
  );
  const webhooks = webhookDelivery(store);
  const runner = wireRegisteredSteps(store, webhooks);
  t.after(async () => {
    await runner.close();
    await api.close();
  });
  // Set after the API starts, so this trace store is the one every layer reads.
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  return { store, runner, traces: store.traces };
}

async function receiver(t, status = 200) {
  const received = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { received, origin: `http://127.0.0.1:${server.address().port}` };
}

test('a synchronous web hook step posts under an http-out span that names the path only and forwards the trace', async (t) => {
  const hook = await receiver(t);
  const { store, traces } = await webhookWorld(t, { mode: 0, url: `${hook.origin}/hooks/sync` });
  // An audited request root (the Power Pages host names its audit entry): the delivery forwards that audit id.
  const request = traces.start({ kind: 'http', name: 'POST /invented', attributes: { auditId: HOOK_AUDIT } });
  await traces.run(request, () => store.create('contoso_widget', { contoso_name: 'Hooked' }, { admin: true }));
  request.end();
  assert.equal(hook.received.length, 1);
  const { spans } = traces.tree(request.traceId);
  const post = spans.find((span) => span.kind === 'http-out');
  assert.equal(post.name, 'POST /hooks/sync');
  assert.equal(post.module, 'webhooks');
  assert.equal(post.attributes.path, '/hooks/sync');
  assert.equal(post.attributes.statusCode, 200);
  assert.equal(post.status, 'ok');
  assert.equal(spans.find((span) => span.spanId === post.parentSpanId).kind, 'plugin-step');
  assert.equal(hook.received[0].headers['x-sim-parent-trace'], post.spanId);
  assert.equal(hook.received[0].headers['x-trace-id'], request.traceId);
  assert.equal(hook.received[0].headers['x-sim-trace-id'], HOOK_AUDIT, 'X-Sim-Trace-Id is the audit id (D-M-4)');
  assert.match(hook.received[0].url, /code=invented-code/, 'the receiver gets the WebhookKey code');
  assert.equal(JSON.stringify(traces.export({})).includes('invented-code'), false, 'no span holds the code');
});

test('a web hook answer maps to the span status like every HTTP answer: 403 denied, 500 error', async (t) => {
  for (const [status, expected] of [
    [403, 'denied'],
    [500, 'error'],
  ]) {
    const hook = await receiver(t, status);
    const { store, traces } = await webhookWorld(t, { mode: 0, url: `${hook.origin}/hooks/${status}` });
    const request = traces.start({ kind: 'http', name: 'POST /invented' });
    await traces
      .run(request, () => store.create('contoso_widget', { contoso_name: 'Refused' }, { admin: true }))
      .catch(() => {});
    request.end();
    const [post] = traces.spans({ kind: 'http-out', traceId: request.traceId }).items;
    assert.deepEqual([post.attributes.statusCode, post.status], [status, expected]);
  }
});

test('an asynchronous web hook job delivers under its job span in the staging trace', async (t) => {
  const hook = await receiver(t);
  const { store, runner, traces } = await webhookWorld(t, { mode: 1, url: `${hook.origin}/hooks/async` });
  const request = traces.start({ kind: 'http', name: 'POST /invented', attributes: { auditId: HOOK_AUDIT } });
  await traces.run(request, () => store.create('contoso_widget', { contoso_name: 'Later' }, { admin: true }));
  request.end();
  await runner.drain();
  assert.equal(hook.received.length, 1);
  const { spans } = traces.tree(request.traceId);
  const job = spans.find((span) => span.kind === 'job');
  assert.equal(job.async, true);
  assert.equal(job.attributes.kind, 'webhook');
  const post = spans.find((span) => span.kind === 'http-out');
  assert.equal(post.parentSpanId, job.spanId);
  assert.equal(hook.received[0].headers['x-sim-parent-trace'], post.spanId);
  assert.equal(hook.received[0].headers['x-trace-id'], request.traceId);
  assert.equal(hook.received[0].headers['x-sim-trace-id'], HOOK_AUDIT, 'the async job forwards its staging audit id');
});

test('a background classic workflow runs as a job span with its workflow span in the staging trace', async (t) => {
  const workflowId = 'bbbbbbbb-0000-4000-8000-0000000000e1';
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'name',
    userConfigured: true,
    fields: { name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.contoso_widget = [];
  const store = await new DataStore({ state }).init();
  const api = await startDataverseApi({
    store,
    settings: dataverseSettings({ enabled: true }),
    log: () => {},
    extensions: [
      ...EXTENSIONS,
      workflowExtension({
        facts: [
          {
            id: workflowId,
            name: 'Invented background workflow',
            uniquename: null,
            category: 0,
            type: 1,
            mode: 0,
            scope: 4,
            ondemand: false,
            subprocess: false,
            triggeroncreate: true,
            triggerondelete: false,
            triggeronupdateattributelist: null,
            primaryentity: 'contoso_widget',
            state: 1,
            runas: 0,
            istransacted: true,
            asyncautodelete: false,
            syncworkflowlogonfailure: false,
            xaml: '<Activity />',
            clientdata: null,
          },
        ],
        handlers: workflowHandlers([
          { id: 'invented-workflows', workflows: { [workflowId]: async () => ({ message: 'Invented run' }) } },
        ]),
        diagnostic: () => {},
      }),
    ],
  });
  t.after(() => api.close());
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  const traces = store.traces;
  const request = traces.start({ kind: 'http', name: 'POST /invented' });
  await traces.run(request, () => store.create('contoso_widget', { name: 'Triggering' }, { admin: true }));
  request.end();
  await settleCommittedWork(store, []);
  const { spans } = traces.tree(request.traceId);
  const job = spans.find((span) => span.kind === 'job');
  assert.equal(job.parentSpanId, request.spanId);
  assert.equal(job.async, true);
  const workflow = spans.find((span) => span.kind === 'workflow');
  assert.equal(workflow.parentSpanId, job.spanId);
  assert.equal(workflow.name, 'Invented background workflow');
  assert.equal(workflow.entity, 'contoso_widget');
  assert.equal(workflow.attributes.realtime, false);
  assert.equal(workflow.status, 'ok');
});
