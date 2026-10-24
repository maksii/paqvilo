import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { executeFlowDefinition, runTrackedFlow } from '../lib/flow-runtime.mjs';

// The branch scheduler. Terminate stops the run in any key order; a Wait holds only its own branch, so a concurrent
// Response answers before the run suspends, and the resume completes the waiting branch.
const FLOW = '77777777-7777-4777-8777-0000000000b1';
const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } };
const wait = runAfter => ({ type: 'Wait', runAfter, inputs: { interval: { count: 1, unit: 'Minute' } } });
const respond = runAfter => ({ type: 'Response', runAfter, inputs: { statusCode: 200, body: { answered: 'now' } } });

async function unit(t, definition) {
  const clock = fixedClock(), store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  t.after(() => scheduler.close());
  const connectors = createConnectorRuntime({ store, scheduler, clock });
  const runs = createHostFlowRuns({ store, clock, scheduler, approvals: connectors.approvals, flowOf: id => (id === FLOW ? { definition, mode: 'exported', connectors } : null) });
  runs.attach({});
  t.after(() => runs.close());
  return { runs, scheduler, start: () => runTrackedFlow({ runs, processId: FLOW, trigger: 'Test', definition, input: {}, store, connectors }) };
}

test('nothing runs after Terminate, in either key order', async () => {
  const store = await new DataStore({ state: emptyState() }).init();
  const actions = {
    a: { type: 'Compose', runAfter: {}, inputs: 'first' },
    stop: { type: 'Terminate', runAfter: { a: ['Succeeded'] }, inputs: { runStatus: 'Succeeded' } },
    after: { type: 'Compose', runAfter: { stop: ['Succeeded'] }, inputs: 'after terminate ran' } };
  const statuses = async order => {
    const answer = await executeFlowDefinition({ definition: { triggers: manual, actions: Object.fromEntries(order.map(k => [k, actions[k]])) }, input: {}, store, context: { background: true } });
    return Object.fromEntries(Object.entries(answer.actions).map(([k, v]) => [k, v.status]));
  };
  assert.deepEqual(await statuses(['a', 'stop', 'after']), { a: 'Succeeded', stop: 'Succeeded' });
  assert.deepEqual(await statuses(['after', 'stop', 'a']), { a: 'Succeeded', stop: 'Succeeded' });
});

for (const [label, keys] of [['wait first', ['a_wait', 'b_reply']], ['response first', ['b_reply', 'a_wait']]]) {
  test(`a Response concurrent with a Wait answers before the run suspends (${label}), and the resume completes the waiting branch`, async t => {
    const all = { a_wait: wait({}), b_reply: respond({}), after_wait: { type: 'Compose', runAfter: { a_wait: ['Succeeded'] }, inputs: 'waited' } };
    const definition = { triggers: manual, actions: Object.fromEntries([...keys, 'after_wait'].map(k => [k, all[k]])) };
    const { runs, scheduler, start } = await unit(t, definition);
    const answer = await start();
    assert.equal(answer.status, 'Waiting');
    assert.deepEqual(answer.response, { status: 200, body: { answered: 'now' } });
    assert.deepEqual([answer.suspended.actionPath, answer.actions.b_reply.status, answer.actions.after_wait], ['a_wait', 'Succeeded', undefined]);
    await scheduler.advance(60000);
    const run = runs.get(answer.runId);
    assert.equal(run.status, 'Succeeded');
    assert.deepEqual(run.journal.a_wait, { status: 'Succeeded', outputs: {} });
  });
}
