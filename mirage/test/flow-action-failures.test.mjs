import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition, runTrackedFlow } from '../lib/flow-runtime.mjs';
import { createFlowRunStore } from '../lib/flow-runs.mjs';
import { createFlowTriggerRunner } from '../lib/flow-triggers.mjs';
import { operationCatalogue } from '../lib/operation-catalogue.mjs';
import { whenScheduled } from './support/scheduler-gates.mjs';

// One failure rule for every provider-backed action (pack connector, Http, child flow): an answer of 400 or above
// fails the action (ActionFailed), keeps its outputs and runs the runAfter Failed branch.
const API = '/providers/Microsoft.PowerApps/apis/shared_fx-5fapi';
const pack = (operations) => ({ id: 'fx-pack', connectors: { 'shared_fx-5fapi': { operations } } });
const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } };
const call = (operationId, extra = {}) => ({
  type: 'OpenApiConnection',
  runAfter: {},
  inputs: { host: { apiId: API, operationId }, parameters: {}, ...extra },
});
const withHandlers = (action) => ({
  triggers: manual,
  actions: {
    Call: action,
    OnSuccess: { type: 'Response', runAfter: { Call: ['Succeeded'] }, inputs: { statusCode: 200, body: 'ok' } },
    OnFailure: {
      type: 'Response',
      runAfter: { Call: ['Failed'] },
      inputs: {
        statusCode: 502,
        body: {
          status: "@actions('Call')['status']",
          code: "@actions('Call')['error']['code']",
          upstream: "@outputs('Call')['statusCode']",
        },
      },
    },
  },
});

test('a pack connector answer of 4xx or 5xx fails its action and runs the failure branch', async () => {
  for (const statusCode of [404, 500]) {
    const connectors = createConnectorRuntime({
      packs: [pack({ Op: async () => ({ statusCode, body: { error: { message: 'invented failure' } } }) })],
    });
    const trace = [];
    const answer = await executeFlowDefinition({
      definition: withHandlers(call('Op')),
      input: {},
      connectors,
      diagnostic: (d) => d.code === 'FLOW_ACTION' && trace.push([d.action, d.status, d.error?.code]),
    });
    assert.deepEqual(answer, { status: 502, body: { status: 'Failed', code: 'ActionFailed', upstream: statusCode } });
    assert.deepEqual(
      trace.find((t) => t[0] === 'Call'),
      ['Call', 'Failed', 'ActionFailed'],
    );
    assert.deepEqual(
      trace.find((t) => t[0] === 'OnSuccess'),
      ['OnSuccess', 'Skipped', undefined],
    );
  }
  // A 2xx/3xx answer still succeeds.
  const ok = createConnectorRuntime({ packs: [pack({ Op: async () => ({ statusCode: 204, body: null }) })] });
  assert.deepEqual(await executeFlowDefinition({ definition: withHandlers(call('Op')), input: {}, connectors: ok }), {
    status: 200,
    body: 'ok',
  });
});

test('a provider that throws fails its action with the ActionFailed error member naming the cause', async () => {
  const connectors = createConnectorRuntime({
    packs: [
      pack({
        Op: async () => {
          throw Object.assign(new Error('invented outage'), { code: 'FxOutage' });
        },
      }),
    ],
  });
  const definition = withHandlers(call('Op'));
  definition.actions.OnFailure.inputs.body = { error: "@actions('Call')['error']", outputs: "@outputs('Call')" };
  const answer = await executeFlowDefinition({ definition, input: {}, connectors });
  assert.equal(answer.status, 502);
  // The connector runtime reports a thrown pack error as ProviderFailed (its message never reaches the run).
  assert.deepEqual(answer.body.error, {
    code: 'ActionFailed',
    message: 'The connector provider failed.',
    cause: { code: 'ProviderFailed' },
  });
  assert.equal(answer.body.outputs.error.code, 'ProviderFailed');
});

test('a retried 503 that never recovers fails the action with every attempt journalled', async (t) => {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  t.after(() => scheduler.close());
  const connectors = createConnectorRuntime({
    store,
    scheduler,
    clock,
    packs: [pack({ Busy: async () => ({ statusCode: 503, body: null }) })],
  });
  const runs = createFlowRunStore({ store, scheduler });
  const definition = withHandlers(call('Busy', { retryPolicy: { type: 'fixed', count: 2, interval: 'PT1S' } }));
  let retry = whenScheduled(scheduler, 'connector-retry');
  const pending = runTrackedFlow({
    runs,
    processId: '77777777-7777-4777-8777-777777777771',
    definition,
    input: {},
    store,
    connectors,
  });
  // Each of the two retries waits PT1S on the manual scheduler: advance once its pause is queued.
  for (let i = 0; i < 2; i++) {
    await retry;
    retry = whenScheduled(scheduler, 'connector-retry');
    await scheduler.advance(1000);
  }
  assert.deepEqual(await pending, { status: 502, body: { status: 'Failed', code: 'ActionFailed', upstream: 503 } });
  const [run] = runs.list();
  const entry = runs.get(run.id).journal.Call;
  assert.equal(entry.status, 'Failed');
  assert.deepEqual(
    entry.attempts.map((a) => a.statusCode),
    [503, 503, 503],
  );
});

test('a child flow Response of 500 fails the parent Workflow action', async () => {
  const definition = withHandlers({
    type: 'Workflow',
    runAfter: {},
    inputs: { host: { workflowReferenceName: '77777777-7777-4777-8777-777777777772' }, body: {} },
  });
  const answer = await executeFlowDefinition({
    definition,
    input: {},
    connectors: createConnectorRuntime(),
    context: {
      runId: 'invented-run',
      runChildFlow: async () => ({ statusCode: 500, headers: {}, body: { error: 'invented child failure' } }),
    },
  });
  assert.deepEqual(answer, { status: 502, body: { status: 'Failed', code: 'ActionFailed', upstream: 500 } });
});

test('a row-triggered run whose pack action answers 500 completes Failed', async (t) => {
  const id = '77777777-7777-4777-8777-777777777773';
  const store = new DataStore({
    state: {
      version: 1,
      mappings: {
        x_widget: { entitySet: 'x_widgets', idColumn: 'x_widgetid', fields: { x_name: { type: 'string' } } },
      },
      tables: { x_widget: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  const profile = {
    userId: '77777777-7777-4777-8777-777777777774',
    evidence: 'Invented flow owner',
    grants: [{ entity: 'x_widget', operations: ['read'] }],
  };
  const definition = {
    properties: {
      definition: {
        triggers: {
          row: {
            type: 'OpenApiConnectionWebhook',
            inputs: {
              host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger' },
              parameters: {
                'subscriptionRequest/message': 1,
                'subscriptionRequest/entityname': 'x_widget',
                'subscriptionRequest/scope': 4,
              },
            },
          },
        },
        actions: { Call: call('Fail') },
      },
    },
  };
  const workflows = new Map([[id, { file: '/invented/flow.json', active: true, definition }]]),
    identities = new Map([[id, profile]]),
    notes = [];
  const connectors = createConnectorRuntime({
    store,
    packs: [pack({ Fail: async () => ({ statusCode: 500, body: null }) })],
  });
  const runner = createFlowTriggerRunner({
    store,
    workflows: () => workflows,
    identities: () => identities,
    connectors,
    diagnostic: (n) => notes.push(n),
    items: () =>
      operationCatalogue({
        portal: {},
        workflows,
        handlers: { flowIdentities: identities },
        overrides: { ['cloud-flow:' + id]: { mode: 'exported' } },
        connectors,
      }),
  });
  t.after(() => runner.close());
  await store.create('x_widget', { x_name: 'Invented' }, { admin: true });
  await runner.drain();
  const failed = notes.find((n) => n.code === 'FLOW_TRIGGER_FAILED');
  assert.ok(failed, JSON.stringify(notes.map((n) => n.code)));
  assert.equal(failed.error.code, 'LocalFlowFailed');
  assert.ok(!notes.some((n) => n.code === 'FLOW_TRIGGER_COMPLETED'));
});
