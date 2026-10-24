import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { runTrackedFlow } from '../lib/flow-runtime.mjs';

// A resume replays the parameter values frozen at run start, and a replay that diverges from its journal fails
// NotResumable (ReplayDiverged) before any provider is called.
const FLOW = '77777777-7777-4777-8777-0000000000f1';
const MODE = '77777777-7777-4777-8777-0000000000e1',
  KEY = '77777777-7777-4777-8777-0000000000e3';
const op = (id) => ({
  type: 'OpenApiConnection',
  runAfter: {},
  inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_fx-5fapi', operationId: id }, parameters: {} },
});
const pause = { type: 'Wait', runAfter: { Pick: ['Succeeded'] }, inputs: { interval: { count: 1, unit: 'Minute' } } };
const definitionOf = (extra = {}) => ({
  parameters: { mode: { type: 'String', defaultValue: 'a', metadata: { schemaName: 'x_mode' } }, ...extra.parameters },
  triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } },
  actions: {
    Pick: {
      type: 'If',
      runAfter: {},
      expression: { equals: ["@parameters('mode')", 'a'] },
      actions: { CallA: op('OpA') },
      else: { actions: { CallB: op('OpB') } },
    },
    Pause: pause,
    Reply: {
      type: 'Response',
      runAfter: { Pause: ['Succeeded'] },
      inputs: { statusCode: 200, body: { mode: "@parameters('mode')", ...extra.body } },
    },
  },
});

async function setup(t, { definition = definitionOf(), secrets = null, rows = [] } = {}) {
  const clock = fixedClock(),
    state = emptyState(),
    calls = [];
  state.tables.environmentvariabledefinition = [
    { environmentvariabledefinitionid: MODE, schemaname: 'x_mode', type: 100000000, defaultvalue: 'a' },
    ...rows,
  ];
  state.tables.environmentvariablevalue = [];
  const store = await new DataStore({ state, clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  t.after(() => scheduler.close());
  const pack = {
    id: 'fx-pack',
    connectors: {
      'shared_fx-5fapi': {
        operations: {
          OpA: async () => {
            calls.push('OpA');
            return { statusCode: 200, body: 'A' };
          },
          OpB: async () => {
            calls.push('OpB');
            return { statusCode: 200, body: 'B' };
          },
        },
      },
    },
  };
  const connectors = createConnectorRuntime({ store, scheduler, clock, packs: [pack] });
  const flow = { definition, mode: 'exported', connectors, secrets };
  const runs = createHostFlowRuns({
    store,
    clock,
    scheduler,
    approvals: connectors.approvals,
    flowOf: (id) => (id === FLOW ? flow : null),
  });
  runs.attach({});
  t.after(() => runs.close());
  const setMode = (value) =>
    store.transact(() => {
      store.state.tables.environmentvariablevalue.push({
        environmentvariablevalueid: '77777777-7777-4777-8777-0000000000e2',
        environmentvariabledefinitionid: MODE,
        value,
      });
    });
  return {
    store,
    runs,
    calls,
    flow,
    connectors,
    setMode,
    start: () =>
      runTrackedFlow({
        runs,
        processId: FLOW,
        trigger: 'Test',
        definition: flow.definition,
        input: {},
        store,
        connectors,
        secrets,
      }),
  };
}

test('resume replays with the parameter values captured at run start', async (t) => {
  const { runs, calls, setMode, start } = await setup(t);
  const first = await start();
  assert.equal(first.status, 'Waiting');
  assert.deepEqual(calls, ['OpA']);
  await setMode('b');
  const resumed = await runs.resumeRun(first.runId, { status: 'Succeeded', outputs: {} });
  assert.deepEqual(resumed, { status: 200, body: { mode: 'a' } });
  assert.deepEqual(calls, ['OpA']);
  const run = runs.get(first.runId);
  assert.equal(run.status, 'Succeeded');
  assert.deepEqual(Object.keys(run.journal).sort(), ['Pause', 'Pick/CallA']);
});

test('a replay that reaches an unjournalled connector action before consuming its journal fails NotResumable/ReplayDiverged without invoking the provider', async (t) => {
  const { store, runs, calls, setMode, start } = await setup(t);
  const first = await start();
  // Simulate a run state from before parameters were frozen: the replay re-reads the changed environment variable.
  store.state.simulator.flowRuns[first.runId].parameters = null;
  await setMode('b');
  assert.equal(await runs.resumeRun(first.runId, { status: 'Succeeded', outputs: {} }), null);
  assert.deepEqual(calls, ['OpA'], 'OpB was never called');
  const run = runs.get(first.runId);
  assert.equal(run.status, 'Failed');
  const row = store.state.tables.flowrun.find((r) => r.flowrunid === first.runId);
  assert.equal(row.errorcode, 'NotResumable');
  assert.match(row.errormessage, /ReplayDiverged/);
});

test('secret parameters are not stored in the run state and are re-resolved on resume', async (t) => {
  const resolved = [];
  const secrets = {
    resolve: (reference, { purpose }) => {
      resolved.push(purpose);
      return { status: 'resolved', value: 'invented-secret-value' };
    },
  };
  const definition = definitionOf({
    parameters: { key: { type: 'SecureString', metadata: { schemaName: 'x_key' } } },
    body: { hasKey: "@not(equals(parameters('key'), null))" },
  });
  const rows = [
    { environmentvariabledefinitionid: KEY, schemaname: 'x_key', type: 100000005, defaultvalue: 'env:INVENTED_FX_KEY' },
  ];
  const { store, runs, start } = await setup(t, { definition, secrets, rows });
  const first = await start();
  const stored = store.state.simulator.flowRuns[first.runId];
  assert.deepEqual(Object.keys(stored.parameters), ['mode']);
  assert.ok(!JSON.stringify(store.state.simulator).includes('invented-secret-value'));
  const resumed = await runs.resumeRun(first.runId, { status: 'Succeeded', outputs: {} });
  assert.deepEqual(resumed, { status: 200, body: { mode: 'a', hasKey: true } });
  assert.deepEqual(resolved, ['flow-parameter:key', 'flow-parameter:key']);
  assert.equal(store.state.simulator.flowRuns[first.runId].parameters, null, 'dropped when the run ends');
});

test('an action that takes a Secret parameter as input journals its outputs and the run resumes from the journal', async (t) => {
  const secrets = { resolve: () => ({ status: 'resolved', value: 'invented-secret-value' }) };
  const definition = definitionOf({ parameters: { key: { type: 'SecureString', metadata: { schemaName: 'x_key' } } } });
  definition.actions.Pick.actions.CallA.inputs.parameters = { x_key: "@parameters('key')" };
  const rows = [
    { environmentvariabledefinitionid: KEY, schemaname: 'x_key', type: 100000005, defaultvalue: 'env:INVENTED_FX_KEY' },
  ];
  const { store, runs, calls, start } = await setup(t, { definition, secrets, rows });
  const first = await start();
  assert.deepEqual(runs.get(first.runId).journal['Pick/CallA'], {
    status: 'Succeeded',
    outputs: { statusCode: 200, body: 'A' },
  });
  assert.equal(runs.get(first.runId).notResumable, null);
  assert.ok(!JSON.stringify(store.state.simulator).includes('invented-secret-value'));
  assert.deepEqual(await runs.resumeRun(first.runId, { status: 'Succeeded', outputs: {} }), {
    status: 200,
    body: { mode: 'a' },
  });
  assert.deepEqual(calls, ['OpA'], 'replayed from the journal');
});

test('a connector action in a loop journals one entry per occurrence and the run resumes after the loop', async (t) => {
  const definition = definitionOf();
  definition.actions.Pick = { type: 'Foreach', runAfter: {}, foreach: [1, 2], actions: { CallA: op('OpA') } };
  definition.actions.Reply.inputs.body = { mode: "@parameters('mode')", last: "@body('CallA')" };
  const { runs, calls, start } = await setup(t, { definition });
  const first = await start();
  assert.deepEqual(Object.keys(runs.get(first.runId).journal).sort(), ['Pick/CallA', 'Pick/CallA#2']);
  assert.equal(runs.get(first.runId).notResumable, null);
  assert.deepEqual(await runs.resumeRun(first.runId, { status: 'Succeeded', outputs: {} }), {
    status: 200,
    body: { mode: 'a', last: 'A' },
  });
  assert.deepEqual(calls, ['OpA', 'OpA'], 'both iterations replayed from the journal');
  assert.equal(runs.get(first.runId).status, 'Succeeded');
});
