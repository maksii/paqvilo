// @test-kind contract: Paqvilo's designed runtime behaviour: a resumed tracked run replays its replayed actions and draws its volatile values from the run's tape, on invented flows.
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

test('trigger conditions bind frozen parameters for a suspended run while new events use current values', async (t) => {
  const definition = definitionOf();
  definition.triggers.manual.conditions = [{ expression: "@equals(parameters('mode'),'a')" }];
  const { runs, calls, setMode, start } = await setup(t, { definition });
  const first = await start();
  assert.equal(first.status, 'Waiting');
  await setMode('b');
  assert.deepEqual(await start(), { status: 'Skipped', reason: 'TriggerConditionFalse' });
  assert.equal(runs.list().length, 1);
  assert.deepEqual(await runs.resumeRun(first.runId, { status: 'Succeeded', outputs: {} }), {
    status: 200,
    body: { mode: 'a' },
  });
  assert.equal(runs.get(first.runId).status, 'Succeeded');
  assert.deepEqual(calls, ['OpA']);
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

// @test-kind security: secret parameter values are never stored in the run state
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

// @test-kind security: a secret parameter value never appears in simulator state
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

const DRAW_FLOW = '77777777-7777-4777-8777-0000000000f2';
// A run whose Compose actions draw a guid and a timestamp before a wait; the connector call receives both values.
function drawDefinition() {
  return {
    triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } },
    actions: {
      Draw: { type: 'Compose', runAfter: {}, inputs: '@guid()' },
      Stamp: { type: 'Compose', runAfter: { Draw: ['Succeeded'] }, inputs: '@utcNow()' },
      Record: {
        type: 'OpenApiConnection',
        runAfter: { Stamp: ['Succeeded'] },
        inputs: {
          host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_fx-5fapi', operationId: 'Record' },
          parameters: { guid: "@outputs('Draw')", at: "@outputs('Stamp')" },
        },
      },
      Pause: { type: 'Wait', runAfter: { Record: ['Succeeded'] }, inputs: { interval: { count: 1, unit: 'Minute' } } },
      Read: {
        type: 'Compose',
        runAfter: { Pause: ['Succeeded'] },
        inputs: { draw: "@outputs('Draw')", stamp: "@outputs('Stamp')" },
      },
      Reply: {
        type: 'Response',
        runAfter: { Read: ['Succeeded'] },
        inputs: { statusCode: 200, body: "@outputs('Read')" },
      },
    },
  };
}

// Every call of the fixture's connector operations (Record, Log) records its parameters, in call order.
async function drawSetup(t, definition = drawDefinition()) {
  const clock = fixedClock(),
    received = [];
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  t.after(() => scheduler.close());
  const record = async (request) => {
    received.push(request.parameters);
    return { statusCode: 200, body: 'ok' };
  };
  const pack = {
    id: 'fx-pack',
    connectors: {
      'shared_fx-5fapi': {
        operations: { Record: record, Log: record },
      },
    },
  };
  const connectors = createConnectorRuntime({ store, scheduler, clock, packs: [pack] });
  const flow = { definition, mode: 'exported', connectors };
  const runs = createHostFlowRuns({
    store,
    clock,
    scheduler,
    approvals: connectors.approvals,
    flowOf: (id) => (id === DRAW_FLOW ? flow : null),
  });
  runs.attach({});
  t.after(() => runs.close());
  const start = () =>
    runTrackedFlow({ runs, processId: DRAW_FLOW, trigger: 'Test', definition, input: {}, store, connectors });
  return { store, runs, received, start };
}

test('a value composed before a wait keeps the draw of its first attempt, so a resume matches what the connector received', async (t) => {
  const { store, runs, received, start } = await drawSetup(t);
  const first = await start();
  assert.equal(first.status, 'Waiting');
  assert.equal(received.length, 1);
  const sent = received[0];
  assert.deepEqual(await runs.resumeRun(first.runId, { status: 'Succeeded', outputs: {} }), {
    status: 200,
    body: { draw: sent.guid, stamp: sent.at },
  });
  assert.equal(received.length, 1, 'the connector call is replayed from the journal');

  const second = await start();
  assert.equal(second.status, 'Waiting');
  assert.notEqual(received[1].guid, sent.guid, 'an independent run draws its own guid');

  // A run stored without a tape (an entry written before the tape existed) still resumes, drawing its values again.
  const older = await start();
  store.transact(() => {
    delete store.state.simulator.flowRuns[older.runId].volatile;
  });
  const resumed = await runs.resumeRun(older.runId, { status: 'Succeeded', outputs: {} });
  assert.equal(resumed.status, 200);
  assert.equal(received.length, 3, 'the older run replays its journalled call too');
});

const DATA_FLOW_CALL = { type: 'OpenApiConnection', runAfter: {} };
// A create whose input draws a guid and a timestamp, a wait, a data operation (Select) drawing a guid per element, a logged
// call of the Select's output, and a second wait before the answer.
function dataDefinition() {
  const host = (operationId) => ({ apiId: '/providers/Microsoft.PowerApps/apis/shared_fx-5fapi', operationId });
  const wait = (after) => ({
    type: 'Wait',
    runAfter: { [after]: ['Succeeded'] },
    inputs: { interval: { count: 1, unit: 'Minute' } },
  });
  return {
    triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } },
    actions: {
      Create: { ...DATA_FLOW_CALL, inputs: { host: host('Record'), parameters: { id: '@guid()', at: '@utcNow()' } } },
      Pause: wait('Create'),
      Pick: { type: 'Select', runAfter: { Pause: ['Succeeded'] }, inputs: { from: [1, 2], select: { id: '@guid()' } } },
      Log: {
        ...DATA_FLOW_CALL,
        runAfter: { Pick: ['Succeeded'] },
        inputs: { host: host('Log'), parameters: { ids: "@body('Pick')" } },
      },
      Pause2: wait('Log'),
      Reply: {
        type: 'Response',
        runAfter: { Pause2: ['Succeeded'] },
        inputs: { statusCode: 200, body: { ids: "@body('Pick')" } },
      },
    },
  };
}

test('a data operation after a wait draws its guid once per run, and a second resume answers the same values', async (t) => {
  const { runs, received, start } = await drawSetup(t, dataDefinition());
  const first = await start();
  assert.equal(first.status, 'Waiting');
  assert.equal(received.length, 1);
  const created = structuredClone(received[0]);

  const afterFirst = await runs.resumeRun(first.runId, { status: 'Succeeded', outputs: {} });
  assert.equal(afterFirst.status, 'Waiting', 'the run waits again before its answer');
  assert.deepEqual(received[0], created, 'the create is replayed from the journal, not evaluated or called again');
  assert.equal(received.length, 2, 'only the logged call is new');
  assert.equal(received[1].ids.length, 2);

  const answered = await runs.resumeRun(first.runId, { status: 'Succeeded', outputs: {} });
  assert.deepEqual(answered, { status: 200, body: { ids: received[1].ids } }, 'the data operation drew the same guids');
  assert.equal(received.length, 2, 'the logged call is replayed from the journal');
});
