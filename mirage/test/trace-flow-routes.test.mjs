// An on-demand flow run started through /_sim/api/flow-runs (sim-flow-routes.mjs) opens a flow-run span named after the
// flow's display name, and the run view at /_sim/api/flow-runs/<id> names its trace (docs/design/tracing.md).
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

const BUTTON = '77777777-7777-4777-8777-0000000000b1';
const DEFINITION = {
  triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } },
  actions: { Note: { type: 'Compose', runAfter: {}, inputs: 'pressed' } },
};

test('an on-demand run is a flow-run span with the flow display name; its run view names the trace', async (t) => {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  store.traces = createTraceStore();
  const scheduler = createScheduler({ clock, manual: true });
  storeScheduler(store, scheduler);
  ownedFixture(t).add(() => scheduler.close());
  const connectors = createConnectorRuntime({ store, scheduler, clock });
  const flowOf = (id) =>
    id === BUTTON ? { name: 'Invented button flow', definition: DEFINITION, mode: 'exported', connectors } : null;
  const runs = createHostFlowRuns({ store, clock, scheduler, approvals: connectors.approvals, flowOf });
  const api = { store };
  runs.attach(api);
  ownedFixture(t).add(() => runs.close());
  const routes = createFlowRoutes({ api: { ...api, flowRuns: runs }, csrf: () => 'invented-csrf' });
  const server = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://127.0.0.1')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': 'invented-csrf' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };

  const started = await call('POST', '/_sim/api/flow-runs', { processId: BUTTON });
  assert.deepEqual([started.status, started.body.status], [201, 'Succeeded']);
  const [run] = store.traces.spans({ kind: 'flow-run' }).items;
  assert.deepEqual(
    [run.name, run.actor.name, run.attributes.trigger, run.status],
    ['Invented button flow', 'Invented button flow', 'Manual', 'ok'],
  );
  const view = await call('GET', `/_sim/api/flow-runs/${started.body.id}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.traceId, run.traceId);
});
