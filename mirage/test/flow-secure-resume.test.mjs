// Secured outputs are sealed in the run journal (AES-256-GCM, key file under the state directory), so a run resumes
// after a host restart over the same state directory; a Wait inside a loop suspends with its iteration's journal key and
// resumes at that iteration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { runTrackedFlow } from '../lib/flow-runtime.mjs';
import { VAULT_KEY_FILE } from '../lib/flow-vault.mjs';

const FLOW = '77777777-7777-4777-8777-0000000000a5';
const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } };
const api = operationId => ({ host: { apiId: '/providers/Microsoft.PowerApps/apis/x_vault', operationId } });
const wait = { type: 'Wait', inputs: { interval: { count: 1, unit: 'Minute' } } };

// One host: a store over `state`, its scheduler, connector runtime and run store on `stateDirectory`.
async function host(t, { state, definition, operations, stateDirectory }) {
  const clock = fixedClock(), store = await new DataStore({ state, clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  const connectors = createConnectorRuntime({ store, scheduler, clock, packs: [{ id: 'x-pack', connectors: { x_vault: { operations } } }] });
  const runs = createHostFlowRuns({ store, clock, scheduler, stateDirectory, flowOf: () => ({ definition, mode: 'exported', connectors }) });
  runs.attach({});
  const close = () => { runs.close(); scheduler.close(); };
  t.after(close);
  return { store, scheduler, runs, close, start: () => runTrackedFlow({ runs, processId: FLOW, trigger: 'Test', definition, input: {}, store, connectors, context: { background: true } }) };
}

test('a run with secured outputs resumes after a restart over the same state directory', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-secure-resume-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const received = [];
  const operations = { Issue: () => ({ statusCode: 200, body: { token: 'invented-secret-token' } }), Use: request => { received.push(request.parameters.token); return { statusCode: 200, body: {} }; } };
  const definition = { triggers: manual, actions: {
    issue: { type: 'OpenApiConnection', runtimeConfiguration: { secureData: { properties: ['outputs'] } }, inputs: { ...api('Issue'), parameters: {} } },
    pause: { ...wait, runAfter: { issue: ['Succeeded'] } },
    use: { type: 'OpenApiConnection', runAfter: { pause: ['Succeeded'] }, inputs: { ...api('Use'), parameters: { token: "@body('issue')?['token']" } } } } };
  const first = await host(t, { state: emptyState(), definition, operations, stateDirectory });
  const answer = await first.start();
  assert.equal(answer.status, 'Waiting');
  assert.deepEqual(first.runs.get(answer.runId).journal.issue, { status: 'Succeeded', secure: true });
  const saved = JSON.stringify(first.store.state);
  assert.ok(!saved.includes('invented-secret-token'), 'the secure output is sealed in state');
  const key = await fs.readFile(path.join(stateDirectory, VAULT_KEY_FILE), 'utf8');
  assert.ok(!saved.includes(key.trim()), 'the key is never in state');
  first.close();

  // A new runtime over the same state and state directory resumes the run with the clear output.
  const second = await host(t, { state: JSON.parse(saved), definition, operations, stateDirectory });
  await second.scheduler.advance(60000);
  assert.equal(second.runs.get(answer.runId).status, 'Succeeded');
  assert.deepEqual(received, ['invented-secret-token']);
});

test('a Wait in iteration 3 suspends there and the resume continues at iteration 3', async t => {
  const recorded = [];
  const operations = { Record: request => { recorded.push(request.parameters.n); return { statusCode: 200, body: {} }; } };
  const definition = { triggers: manual, actions: { each: { type: 'Foreach', foreach: [1, 2, 3, 4], actions: {
    check: { type: 'If', expression: { equals: ['@item()', 3] }, actions: { pause: wait } },
    log: { type: 'OpenApiConnection', runAfter: { check: ['Succeeded'] }, inputs: { ...api('Record'), parameters: { n: '@item()' } } } } } } };
  const unit = await host(t, { state: emptyState(), definition, operations, stateDirectory: null });
  const answer = await unit.start();
  assert.equal(answer.status, 'Waiting');
  assert.equal(answer.suspended.actionPath, 'each/check/pause#3');
  assert.deepEqual(recorded, [1, 2]);
  await unit.scheduler.advance(60000);
  const run = unit.runs.get(answer.runId);
  assert.equal(run.status, 'Succeeded');
  assert.deepEqual(recorded, [1, 2, 3, 4], 'iterations 1 and 2 replay from the journal; 3 and 4 run once');
  assert.deepEqual(Object.keys(run.journal).sort(), ['each/check/pause#3', 'each/log', 'each/log#2', 'each/log#3', 'each/log#4']);
});
