// Flow tracing (docs/design/tracing.md): a row-triggered flow job is an async segment of the committing request's trace
// (job -> flow-run -> flow-action -> connector), a waiting run's resume opens a linked flow-run span, sealed runs and the
// summary level capture no payloads, and portal flows and server logic nest under the portal request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createFlowTriggerRunner } from '../lib/flow-triggers.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { runTrackedFlow } from '../lib/flow-runtime.mjs';
import { runExportedCloudFlow, runExportedServerLogic } from '../lib/exported-operations.mjs';
import { operationCatalogue } from '../lib/operation-catalogue.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const FLOW = '30000000-0000-4000-8000-0000000000f1';
const USER = '30000000-0000-4000-8000-0000000000a1';
const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } };
const dataverse = (operationId) => ({ apiId: '/apis/shared_commondataserviceforapps', operationId });
const pack = {
  id: 'invented-pack',
  connectors: {
    x_api: {
      operations: { Op: (request) => ({ statusCode: 200, body: { echo: request.parameters?.value ?? null } }) },
    },
  },
};
const op = (extra = {}) => ({
  type: 'OpenApiConnection',
  inputs: {
    host: { apiId: '/providers/Microsoft.PowerApps/apis/x_api', operationId: 'Op' },
    parameters: { value: "@triggerBody()?['value']" },
  },
  ...extra,
});
const traced = (store, level = 'full') => (store.traces = createTraceStore({ settings: { level } }));
const byKind = (spans, kind) => spans.filter((span) => span.kind === kind);
const parentOf = (spans, span) => spans.find((candidate) => candidate.spanId === span.parentSpanId);

function rowTriggerSetup(t, { ids, clock } = {}) {
  const store = new DataStore({
    ...(ids ? { ids } : {}),
    ...(clock ? { clock } : {}),
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid', fields: { title: { type: 'string' } } },
        audit: { entitySet: 'audits', idColumn: 'auditid' },
      },
      tables: { widget: [], audit: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  const definition = {
    properties: {
      definition: {
        triggers: {
          row: {
            type: 'OpenApiConnectionWebhook',
            inputs: {
              host: dataverse('SubscribeWebhookTrigger'),
              parameters: {
                'subscriptionRequest/message': 1,
                'subscriptionRequest/entityname': 'widget',
                'subscriptionRequest/scope': 4,
              },
            },
          },
        },
        actions: {
          note: { type: 'Compose', inputs: "@triggerOutputs()?['body/title']" },
          create: {
            type: 'OpenApiConnection',
            runAfter: { note: ['Succeeded'] },
            inputs: {
              host: dataverse('CreateRecord'),
              parameters: { entityName: 'audits', 'item/message': "@outputs('note')" },
            },
          },
        },
      },
    },
  };
  const workflows = new Map([[FLOW, { file: '/invented/flow.json', active: true, name: 'Invented flow', definition }]]);
  const identities = new Map([
    [
      FLOW,
      {
        userId: USER,
        evidence: 'Invented flow owner',
        grants: [
          { entity: 'widget', operations: ['read'] },
          { entity: 'audit', operations: ['read', 'create'] },
        ],
      },
    ],
  ]);
  const runs = createHostFlowRuns({ store });
  runs.attach({ store });
  const runner = createFlowTriggerRunner({
    store,
    workflows: () => workflows,
    identities: () => identities,
    items: () => operationCatalogue({ portal: {}, workflows, handlers: { flowIdentities: identities } }),
  });
  t.after(async () => {
    await runner.close();
    runs.close();
  });
  return { store, runs, runner, workflows };
}

test('a row-triggered flow job is an async segment of the staging trace: job, flow-run, flow-action, connector', async (t) => {
  const { store, runs, runner } = rowTriggerSetup(t);
  const traces = traced(store);
  const root = traces.start({ kind: 'http', name: 'POST /invented', module: 'portal', operation: 'post' });
  await traces.run(root, () => store.create('widget', { title: 'Traced' }, { admin: true }));
  root.end();
  await runner.drain();
  assert.equal(store.state.tables.audit.length, 1, 'the flow ran');

  const { spans } = traces.tree(root.traceId);
  const [job] = byKind(spans, 'job');
  assert.ok(job, 'the job span joins the staging trace');
  assert.equal(job.async, true);
  assert.equal(job.origin.host, 'job');
  assert.equal(job.attributes.kind, 'flow');
  assert.equal(job.attributes.processId, FLOW);
  assert.equal(job.attributes.attempt, 1);
  assert.equal(traces.ancestry(job.spanId)[0].spanId, root.spanId, 'the job descends from the request root');
  assert.deepEqual(
    job.links.map((link) => link.relation),
    ['staged-by'],
  );

  const [run] = byKind(spans, 'flow-run');
  assert.equal(run.parentSpanId, job.spanId);
  assert.equal(run.name, 'Invented flow');
  assert.deepEqual([run.module, run.operation, run.status], ['flows', 'run', 'ok']);
  assert.deepEqual(run.actor, { kind: 'flow', id: FLOW, name: 'Invented flow' });
  assert.equal(run.attributes.trigger, 'Automated');
  assert.equal(run.attributes.status, 'Succeeded');
  assert.equal(run.input.title, 'Traced', 'level full captures the trigger input');

  const actions = byKind(spans, 'flow-action');
  assert.deepEqual(
    actions.map((span) => span.name),
    ['note', 'create'],
    'actions in execution order',
  );
  for (const action of actions) {
    assert.equal(action.parentSpanId, run.spanId);
    assert.equal(action.status, 'ok');
    assert.equal(typeof action.durationMs, 'number');
    assert.ok(
      action.events.some(
        (event) =>
          event.type === 'trace' &&
          event.message === `${action.name} Succeeded` &&
          event.attributes.status === 'Succeeded',
      ),
      'flow trace lines are trace events',
    );
  }
  assert.equal(actions[0].output, 'Traced');
  assert.equal(actions[1].input.parameters['item/message'], 'Traced');

  const [connector] = byKind(spans, 'connector');
  assert.equal(connector.parentSpanId, actions[1].spanId, 'the provider call runs inside its action span');
  assert.equal(connector.attributes.operationId, 'CreateRecord');
  assert.equal(connector.attributes.runId, run.attributes.runId);
  assert.equal(connector.attributes.actionPath, 'create');
  // Dataverse spans opened by the record pipeline for the provider's write nest under the connector span.
  for (const write of spans.filter((span) => ['dataverse', 'store'].includes(span.kind) && span.depth > job.depth))
    assert.ok(
      traces.ancestry(write.spanId).some((span) => span.spanId === connector.spanId),
      'a flow write nests under its connector span',
    );

  const view = runs.list()[0];
  assert.equal(view.traceId, root.traceId, 'the run view deep-links to the trace');
  assert.equal(runs.get(view.id).traceId, root.traceId);
});

test('a flow job whose staging had no span still opens an async job span; a false trigger condition is an event', async (t) => {
  const { store, runner, workflows } = rowTriggerSetup(t);
  const traces = traced(store);
  await store.create('widget', { title: 'Untraced request' }, { admin: true });
  await runner.drain();
  const job = traces.spans({ kind: 'job' }).items[0];
  assert.ok(job);
  assert.equal(job.async, true);
  assert.equal(job.attributes.kind, 'flow');
  assert.equal(typeof job.attributes.correlationId, 'string');
  const runSpan = traces.spans({ kind: 'flow-run' }).items[0];
  assert.equal(runSpan.traceId, job.traceId);

  workflows.get(FLOW).definition.properties.definition.triggers.row.conditions = [
    { expression: "@equals(triggerBody()?['title'],'Allowed')" },
  ];
  await store.create('widget', { title: 'Filtered' }, { admin: true });
  await runner.drain();
  const skipped = traces.spans({ kind: 'job' }).items[0];
  assert.notEqual(skipped.spanId, job.spanId);
  assert.ok(
    skipped.events.some(
      (event) => event.type === 'flow-trigger-skipped' && event.attributes.reason === 'TriggerConditionFalse',
    ),
  );
  assert.equal(traces.spans({ kind: 'flow-run' }).total, 1, 'a skipped trigger opens no flow-run span');
});

test('a waiting run ends its span ok with a suspended event; its resume opens a linked async flow-run span', async (t) => {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const traces = traced(store);
  const scheduler = createScheduler({ clock, manual: true });
  ownedFixture(t).add(() => scheduler.close());
  const connectors = createConnectorRuntime({ store, scheduler, clock });
  const definition = {
    triggers: manual,
    actions: {
      pause: { type: 'Wait', inputs: { interval: { count: 5, unit: 'Minute' } } },
      done: { type: 'Response', runAfter: { pause: ['Succeeded'] }, inputs: { statusCode: 200, body: { ok: true } } },
    },
  };
  const runs = createHostFlowRuns({
    store,
    clock,
    scheduler,
    flowOf: (id) => (id === FLOW ? { definition, mode: 'exported', connectors } : null),
  });
  runs.attach({});
  ownedFixture(t).add(() => runs.close());
  const waiting = await runTrackedFlow({
    runs,
    processId: FLOW,
    name: 'Invented waiting flow',
    trigger: 'Test',
    definition,
    input: {},
    store,
    connectors,
  });
  assert.equal(waiting.status, 'Waiting');
  const first = traces.spans({ kind: 'flow-run' }).items[0];
  assert.equal(first.status, 'ok');
  assert.equal(first.attributes.waiting, true);
  assert.equal(first.attributes.runId, waiting.runId);
  assert.ok(first.events.some((event) => event.type === 'suspended' && event.attributes.wait === 'delay'));
  const pause = traces.spans({ kind: 'flow-action' }).items[0];
  assert.deepEqual([pause.name, pause.attributes.status, pause.attributes.waiting], ['pause', 'Waiting', true]);
  assert.equal(runs.get(waiting.runId).traceId, first.traceId);

  await scheduler.advance(300000);
  assert.equal(runs.get(waiting.runId).status, 'Succeeded');
  const { spans } = traces.tree(first.traceId);
  const resumed = byKind(spans, 'flow-run').find((span) => span.spanId !== first.spanId);
  assert.ok(resumed, 'the resume joins the run trace');
  assert.equal(resumed.parentSpanId, first.spanId);
  assert.equal(resumed.async, true);
  assert.equal(resumed.attributes.resume, true);
  assert.equal(resumed.name, 'Invented waiting flow', 'the run entry keeps the display name');
  assert.equal(resumed.attributes.status, 'Succeeded');
  const replayed = byKind(spans, 'flow-action').filter((span) => span.parentSpanId === resumed.spanId);
  assert.deepEqual(
    replayed.map((span) => [span.name, span.attributes.replayed ?? false]),
    [
      ['pause', true],
      ['done', false],
    ],
  );
});

test('a sealed run captures no action or connector payloads; nested actions parent to their enclosing action', async () => {
  const store = await new DataStore({ state: emptyState() }).init();
  const traces = traced(store);
  const connectors = createConnectorRuntime({ store, packs: [pack] });
  const flow = (actions) => ({
    triggers: manual,
    actions: {
      ...actions,
      reply: { type: 'Response', runAfter: { scope: ['Succeeded'] }, inputs: { statusCode: 200 } },
    },
  });
  const open = flow({ scope: { type: 'Scope', actions: { call: op() } } });
  const sealed = flow({
    scope: {
      type: 'Scope',
      actions: { call: op({ runtimeConfiguration: { secureData: { properties: ['inputs', 'outputs'] } } }) },
    },
  });
  for (const definition of [open, sealed])
    await runTrackedFlow({ processId: FLOW, definition, input: { value: 'Hidden' }, store, connectors });
  const [sealedTrace, openTrace] = traces.query().items.map((item) => traces.tree(item.traceId).spans);

  const scope = byKind(openTrace, 'flow-action').find((span) => span.name === 'scope');
  const call = byKind(openTrace, 'flow-action').find((span) => span.name === 'scope/call');
  assert.equal(call.parentSpanId, scope.spanId, 'a Scope member is a child of the Scope span');
  assert.equal(parentOf(openTrace, scope).kind, 'flow-run');
  assert.equal(call.input.parameters.value, 'Hidden');
  assert.equal(byKind(openTrace, 'connector')[0].output.body.echo, 'Hidden');

  for (const span of sealedTrace.filter((record) => ['flow-action', 'connector'].includes(record.kind))) {
    assert.equal(Object.hasOwn(span, 'input'), false, span.kind + ' ' + span.name + ' has no input');
    assert.equal(Object.hasOwn(span, 'output'), false, span.kind + ' ' + span.name + ' has no output');
  }
  assert.doesNotMatch(JSON.stringify(sealedTrace), /Hidden/, 'no sealed value in the trace, its run span included');
});

test('trace ids never enter state: two runs of the same fixture keep identical flow runs and job rows', async (t) => {
  const states = [];
  for (let run = 0; run < 2; run++) {
    const { store, runs, runner } = rowTriggerSetup(t, { ids: sequentialIds(), clock: fixedClock() });
    const traces = traced(store);
    const root = traces.start({ kind: 'http', name: 'POST /invented' });
    await traces.run(root, () => store.create('widget', { title: 'Deterministic' }, { admin: true }));
    root.end();
    await runner.drain();
    const [view] = runs.list();
    assert.equal(view.traceId, root.traceId, 'the run view reads its trace from the trace store');
    const saved = JSON.stringify({
      flowRuns: store.state.simulator.flowRuns,
      asyncoperation: store.state.tables.asyncoperation ?? [],
      flowrun: store.state.tables.flowrun,
    });
    assert.equal(saved.includes(root.traceId), false, 'no trace id in state');
    states.push(saved);
  }
  assert.equal(states[0], states[1]);
});

test('a sealed run seals its child flow and its resume, also when the level turns full mid-run', async (t) => {
  const CHILD = '30000000-0000-4000-8000-0000000000f2';
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const traces = traced(store, 'summary');
  const scheduler = createScheduler({ clock, manual: true });
  ownedFixture(t).add(() => scheduler.close());
  const connectors = createConnectorRuntime({ store, scheduler, clock, packs: [pack] });
  const call = (value, after) => ({
    ...op({ runAfter: { [after]: ['Succeeded'] } }),
    inputs: { host: op().inputs.host, parameters: { value } },
  });
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        hidden: op({ runtimeConfiguration: { secureData: { properties: ['outputs'] } } }),
        child: {
          type: 'Workflow',
          runAfter: { hidden: ['Succeeded'] },
          inputs: { host: { workflowReferenceName: CHILD }, body: { k: "@triggerBody()?['value']" } },
        },
        pause: { type: 'Wait', runAfter: { child: ['Succeeded'] }, inputs: { interval: { count: 1, unit: 'Minute' } } },
        later: call("@triggerBody()?['value']", 'pause'),
        done: { type: 'Response', runAfter: { later: ['Succeeded'] }, inputs: { statusCode: 200 } },
      },
    },
    [CHILD]: {
      triggers: manual,
      actions: {
        echo: { type: 'Compose', inputs: "@triggerBody()?['k']" },
        use: call("@outputs('echo')", 'echo'),
        done: { type: 'Response', runAfter: { use: ['Succeeded'] }, inputs: { statusCode: 200, body: {} } },
      },
    },
  };
  const runs = createHostFlowRuns({
    store,
    clock,
    scheduler,
    flowOf: (id) =>
      flows[id] ? { definition: flows[id], mode: 'exported', connectors, name: 'Invented ' + id } : null,
  });
  runs.attach({});
  ownedFixture(t).add(() => runs.close());
  const start = () =>
    runTrackedFlow({ runs, processId: FLOW, definition: flows[FLOW], input: { value: 'Hidden' }, store, connectors });

  // Started at summary, resumed at full: the seal kept in the run entry still holds for the resumed segment.
  const waiting = await start();
  assert.equal(waiting.status, 'Waiting');
  traces.configure({ level: 'full' });
  await scheduler.advance(60000);
  assert.equal(runs.get(waiting.runId).status, 'Succeeded');
  const resumed = traces
    .spans({ kind: 'flow-run', pageSize: 200 })
    .items.find((span) => span.attributes.resume && span.attributes.runId === waiting.runId);
  assert.ok(resumed, 'the resume has its span');
  assert.equal(resumed.name, 'Invented ' + FLOW);

  // Started at full: the parent, its child and every connector span capture nothing.
  const second = await start();
  await scheduler.advance(60000);
  assert.equal(runs.get(second.runId).status, 'Succeeded');
  const child = traces
    .spans({ kind: 'flow-run', pageSize: 200 })
    .items.find((span) => span.attributes.processId === CHILD && span.traceId === resumed.traceId);
  assert.ok(child, 'the child run has its span');
  for (const span of traces.spans({ pageSize: 200 }).items)
    assert.equal(Object.hasOwn(span, 'input') || Object.hasOwn(span, 'output'), false, span.kind + ' ' + span.name);
  assert.doesNotMatch(JSON.stringify(traces.export({})), /Hidden/, 'the sealed value is in no span');
  const entries = Object.values(store.state.simulator.flowRuns);
  assert.ok(entries.length >= 4, 'two parent and two child runs');
  assert.ok(
    entries.every((entry) => entry.traceSealed === true),
    'the seal is kept with every run entry',
  );
});

test('the summary level records the same spans without payloads', async () => {
  const store = await new DataStore({ state: emptyState() }).init();
  const traces = traced(store, 'summary');
  const connectors = createConnectorRuntime({ store, packs: [pack] });
  await runTrackedFlow({
    processId: FLOW,
    definition: {
      triggers: manual,
      actions: {
        call: op(),
        reply: { type: 'Response', runAfter: { call: ['Succeeded'] }, inputs: { statusCode: 200 } },
      },
    },
    input: { value: 'Visible only at full' },
    store,
    connectors,
  });
  const { items } = traces.spans({ pageSize: 200 });
  assert.deepEqual(items.map((span) => span.kind).sort(), ['connector', 'flow-action', 'flow-action', 'flow-run']);
  for (const span of items) assert.equal(Object.hasOwn(span, 'input') || Object.hasOwn(span, 'output'), false);

  store.traces.configure({ level: 'off' });
  await runTrackedFlow({
    processId: FLOW,
    definition: {
      triggers: manual,
      actions: {
        call: op(),
        reply: { type: 'Response', runAfter: { call: ['Succeeded'] }, inputs: { statusCode: 200 } },
      },
    },
    input: {},
    store,
    connectors,
  });
  assert.equal(traces.status().spans, 4, 'level off adds no span');
});

test('a portal cloud flow nests under the request span and server logic answers its worker inside its own span', async (t) => {
  const store = await new DataStore({ state: emptyState() }).init();
  const traces = traced(store);
  const definition = {
    triggers: manual,
    actions: { reply: { type: 'Response', inputs: { statusCode: 200, body: { ok: true } } } },
  };
  const workflows = new Map([[FLOW, { name: 'Invented portal flow', definition: { properties: { definition } } }]]);
  const root = traces.start({ kind: 'http', name: 'POST /_api/cloudflow', module: 'portal', operation: 'post' });
  const answer = traces.run(root, () =>
    runExportedCloudFlow({ record: { processId: FLOW, name: 'Invented portal flow' }, workflows, input: {}, store }),
  );
  root.end();
  assert.deepEqual(answer, { status: 200, body: { ok: true } }, 'an untracked portal flow stays synchronous');
  const [run] = byKind(traces.tree(root.traceId).spans, 'flow-run');
  assert.equal(run.parentSpanId, root.spanId);
  assert.equal(run.name, 'Invented portal flow');
  assert.equal(run.attributes.responseStatus, 200);

  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-trace-logic-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logic.js');
  await fs.writeFile(
    file,
    "function get(){return Server.Connector.Dataverse.InvokeCustomApi('post','InventedApi',null);}",
  );
  const real = await fs.realpath(file);
  let current = null;
  const request = traces.start({ kind: 'http', name: 'GET /_api/serverlogics/sample', module: 'portal' });
  await traces.run(request, () =>
    runExportedServerLogic({
      record: { name: 'sample', file: real },
      portal: {},
      store,
      services: {
        invokeCustomApi() {
          current = traces.current();
          return { status: 200, body: {} };
        },
      },
    }),
  );
  request.end();
  const [logic] = byKind(traces.tree(request.traceId).spans, 'workflow');
  assert.equal(logic.parentSpanId, request.spanId);
  assert.equal(logic.name, 'Server logic sample');
  assert.equal(logic.status, 'ok');
  assert.equal(typeof logic.durationMs, 'number');
  assert.equal(current?.spanId, logic.spanId, 'a worker bridge request is answered inside the server-logic span');
});
