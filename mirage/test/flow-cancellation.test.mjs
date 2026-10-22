// Tasks 63 and 67: a run cancelled while provider 1 is in flight never calls provider 2 and ends Cancelled; Terminate with
// runStatus Cancelled ends the run Cancelled. Invented pack connector and flow ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { executeFlowDefinition, runTrackedFlow } from '../lib/flow-runtime.mjs';

const FLOW = '77777777-7777-4777-8777-0000000000c1';
const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } };
const call = (operationId, runAfter = {}) => ({ type: 'OpenApiConnection', runAfter, inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/x_slow', operationId }, parameters: {} } });

async function unit(t, definition, operations) {
  const clock = fixedClock(), store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  const connectors = createConnectorRuntime({ store, scheduler, clock, packs: [{ id: 'x-pack', connectors: { x_slow: { operations } } }] });
  const runs = createHostFlowRuns({ store, clock, scheduler, flowOf: () => ({ definition, mode: 'exported', connectors }) });
  runs.attach({});
  t.after(() => { runs.close(); scheduler.close(); });
  return { runs, start: context => runTrackedFlow({ runs, processId: FLOW, trigger: 'Test', definition, input: {}, store, connectors, context }) };
}

test('a cancel during provider 1 means provider 2 never runs and the run ends Cancelled', async t => {
  let release, second = 0, signalled = null;
  const operations = { One: (request, context) => new Promise(resolve => { signalled = context.signal; release = () => resolve({ statusCode: 200, body: {} }); }),
    Two: () => { second++; return { statusCode: 200, body: {} }; } };
  const { runs, start } = await unit(t, { triggers: manual, actions: { one: call('One'), two: call('Two', { one: ['Succeeded'] }) } }, operations);
  const pending = start({ background: true });
  for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  const [run] = runs.list();
  assert.equal(run.status, 'Running');
  assert.equal(await runs.cancel(run.id), true);
  assert.equal(signalled.aborted, true, 'the provider call received the aborted signal');
  release();
  const answer = await pending;
  assert.equal(answer.status, 'Cancelled');
  assert.equal(second, 0, 'provider 2 never ran');
  assert.equal(runs.get(run.id).status, 'Cancelled');
});

test('a retry wait is cut short by the cancellation', async t => {
  let calls = 0;
  const definition = { triggers: manual, actions: { flaky: { ...call('Flaky'), inputs: { ...call('Flaky').inputs, retryPolicy: { type: 'fixed', count: 3, interval: 'PT1H' } } } } };
  const { runs, start } = await unit(t, definition, { Flaky: () => { calls++; return { statusCode: 503, body: {} }; } });
  const pending = start({ background: true });
  for (let i = 0; i < 20 && !calls; i++) await new Promise(resolve => setImmediate(resolve));
  await runs.cancel(runs.list()[0].id);
  const answer = await pending;
  assert.equal(answer.status, 'Cancelled');
  assert.equal(calls, 1, 'no retry after the cancellation');
  assert.equal(answer.actions.flaky.status, 'Cancelled');
});

test('Terminate with runStatus Cancelled ends the run Cancelled, distinct from Failed and Succeeded', async t => {
  const store = await new DataStore({ state: emptyState() }).init();
  const actions = status => ({ first: { type: 'Compose', inputs: 1 }, stop: { type: 'Terminate', runAfter: { first: ['Succeeded'] }, inputs: { runStatus: status, ...(status === 'Failed' ? { runError: { message: 'invented' } } : {}) } }, after: { type: 'Compose', runAfter: { stop: ['Succeeded'] }, inputs: 2 } });
  const cancelled = await executeFlowDefinition({ definition: { triggers: manual, actions: actions('Cancelled') }, input: {}, store, context: { background: true } });
  assert.deepEqual([cancelled.status, cancelled.actions.after], ['Cancelled', undefined]);
  assert.equal((await executeFlowDefinition({ definition: { triggers: manual, actions: actions('Succeeded') }, input: {}, store, context: { background: true } })).status, 'Succeeded');
  await assert.rejects(async () => executeFlowDefinition({ definition: { triggers: manual, actions: actions('Failed') }, input: {}, store, context: { background: true } }), { code: 'LocalFlowTerminated' });
  // A tracked run records Cancelled; a flow that must answer a Response refuses with FlowRunCancelled.
  const { runs, start } = await unit(t, { triggers: manual, actions: actions('Cancelled') }, {});
  await assert.rejects(start(), { code: 'FlowRunCancelled' });
  assert.equal(runs.list()[0].status, 'Cancelled');
});
