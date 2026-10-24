// The Response answers the caller, the run's outcome is its own. A Response 200 followed by a connector 500 leaves the
// caller with 200 and the run Failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { runTrackedFlow } from '../lib/flow-runtime.mjs';

const FLOW = '77777777-7777-4777-8777-0000000000d4';
const http = { request: { type: 'Request', kind: 'Http' } };

async function unit(t, definition) {
  const clock = fixedClock(), store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  const connectors = createConnectorRuntime({ store, scheduler, clock, packs: [{ id: 'x-pack', connectors: { x_api: { operations: { Fail: () => ({ statusCode: 500, body: { reason: 'invented' } }), Ok: () => ({ statusCode: 200, body: {} }) } } } }] });
  const runs = createHostFlowRuns({ store, clock, scheduler, flowOf: () => ({ definition, mode: 'exported', connectors }) });
  runs.attach({});
  t.after(() => { runs.close(); scheduler.close(); });
  return { runs, start: () => runTrackedFlow({ runs, processId: FLOW, trigger: 'Http', definition, input: {}, store, connectors }) };
}
const definition = operation => ({ triggers: http, actions: {
  reply: { type: 'Response', inputs: { statusCode: 200, body: 'accepted' } },
  after: { type: 'OpenApiConnection', runAfter: { reply: ['Succeeded'] }, inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/x_api', operationId: operation }, parameters: {} } },
} });

for (const [operation, connector, outcome] of [['Fail', 'a connector 500', 'Failed'], ['Ok', 'a succeeding connector', 'Succeeded']]) {
  test(`a Response 200 then ${connector}: the caller got 200 and the run is ${outcome}`, async t => {
    const { runs, start } = await unit(t, definition(operation));
    assert.deepEqual(await start(), { status: 200, body: 'accepted' });
    assert.deepEqual(runs.list().map(run => run.status), [outcome]);
  });
}
