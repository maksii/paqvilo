// Concurrent branches. Actions whose runAfter dependencies have settled start together, a join applies its runAfter
// status sets, the run status follows the final graph, and a Foreach honours concurrency.repetitions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition, inspectFlowDefinition } from '../lib/flow-runtime.mjs';

const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } };
const call = (operationId, runAfter = {}, parameters = {}) => ({ type: 'OpenApiConnection', runAfter, inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/x_slow', operationId }, parameters } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runtime(operations) {
  const store = await new DataStore({ state: emptyState() }).init();
  return { store, connectors: createConnectorRuntime({ store, packs: [{ id: 'x-pack', connectors: { x_slow: { operations } } }] }) };
}

test('two provider branches overlap in time', async () => {
  const log = [];
  const slow = name => async () => { log.push(name + ':start'); await sleep(25); log.push(name + ':end'); return { statusCode: 200, body: { name } }; };
  const { store, connectors } = await runtime({ A: slow('a'), B: slow('b') });
  const definition = { triggers: manual, actions: { a: call('A'), b: call('B'), join: { type: 'Response', runAfter: { a: ['Succeeded'], b: ['Succeeded'] }, inputs: { statusCode: 200, body: { a: "@body('a')?['name']", b: "@body('b')?['name']" } } } } };
  assert.deepEqual(await executeFlowDefinition({ definition, input: {}, store, connectors }), { status: 200, body: { a: 'a', b: 'b' } });
  assert.deepEqual(log, ['a:start', 'b:start', 'a:end', 'b:end'], 'b starts before a ends');
});

test('a join on Failed runs only when its dependency failed, and the run status follows the final graph', async () => {
  const { store, connectors } = await runtime({ Ok: async () => ({ statusCode: 200, body: {} }), Bad: async () => ({ statusCode: 500, body: {} }) });
  const definition = operation => ({ triggers: manual, actions: {
    work: call(operation), other: call('Ok'),
    handle: { type: 'Compose', runAfter: { work: ['Failed'], other: ['Succeeded'] }, inputs: 'handled' },
  } });
  const failed = await executeFlowDefinition({ definition: definition('Bad'), input: {}, store, connectors, context: { background: true } });
  assert.deepEqual([failed.status, failed.actions.work.status, failed.actions.handle.status], ['Succeeded', 'Failed', 'Succeeded']);
  const fine = await executeFlowDefinition({ definition: definition('Ok'), input: {}, store, connectors, context: { background: true } });
  assert.equal(fine.actions.handle.status, 'Skipped');
  // A failed branch that nothing handles fails the run, even when its sibling branch succeeds.
  const unhandled = { triggers: manual, actions: { work: call('Bad'), other: call('Ok'), after: { type: 'Compose', runAfter: { other: ['Succeeded'] }, inputs: 1 } } };
  await assert.rejects(async () => executeFlowDefinition({ definition: unhandled, input: {}, store, connectors, context: { background: true } }), { code: 'LocalFlowFailed' });
});

test('a Foreach honours concurrency.repetitions as its degree of parallelism', async () => {
  let inflight = 0, peak = 0;
  const { store, connectors } = await runtime({ Item: async request => { inflight++; peak = Math.max(peak, inflight); await sleep(15); inflight--; return { statusCode: 200, body: { n: request.parameters.n } }; } });
  const loop = repetitions => ({ triggers: manual, actions: { each: { type: 'Foreach', foreach: [1, 2, 3, 4, 5], ...(repetitions ? { runtimeConfiguration: { concurrency: { repetitions } } } : {}),
    actions: { item: call('Item', {}, { n: '@item()' }) } } } });
  for (const [repetitions, expected] of [[undefined, 1], [2, 2], [5, 5]]) {
    peak = 0;
    const answer = await executeFlowDefinition({ definition: loop(repetitions), input: {}, store, connectors, context: { background: true } });
    assert.equal(answer.status, 'Succeeded');
    assert.equal(peak, expected, `repetitions ${repetitions ?? 'default (sequential)'}`);
  }
  // Iterations that run concurrently and write a variable depend on the interleaving: refused.
  const writes = { triggers: manual, actions: { init: { type: 'InitializeVariable', inputs: { variables: [{ name: 'n', type: 'integer', value: 0 }] } },
    each: { type: 'Foreach', runAfter: { init: ['Succeeded'] }, foreach: [1, 2], runtimeConfiguration: { concurrency: { repetitions: 2 } }, actions: { add: { type: 'IncrementVariable', inputs: { name: 'n', value: 1 } } } } } };
  assert.match(inspectFlowDefinition(writes).errors.join(' '), /runs its iterations concurrently and writes the variable n/);
});

// The refusal is Mirage's determinism policy for every Foreach outside a loop (it runs its repetitions concurrently
// there), also one wrapped in a Scope or an If; a Foreach nested in a loop runs in sequence and is allowed.
test('a concurrent Foreach inside a Scope or an If that writes a variable is refused; one nested in a loop is allowed', () => {
  const init = { type: 'InitializeVariable', inputs: { variables: [{ name: 'n', type: 'array', value: [] }] } };
  const each = { type: 'Foreach', foreach: [1, 2], runtimeConfiguration: { concurrency: { repetitions: 2 } }, actions: { add: { type: 'AppendToArrayVariable', inputs: { name: 'n', value: "@items('each')" } } } };
  const wrapped = {
    Scope: { type: 'Scope', runAfter: { init: ['Succeeded'] }, actions: { each } },
    If: { type: 'If', runAfter: { init: ['Succeeded'] }, expression: { equals: [1, 1] }, actions: {}, else: { actions: { each } } },
  };
  for (const [kind, wrapper] of Object.entries(wrapped)) {
    const errors = inspectFlowDefinition({ triggers: manual, actions: { init, wrap: wrapper } }).errors.join(' ');
    assert.match(errors, /Foreach wrap\/(?:else\/)?each runs its iterations concurrently and writes the variable n; Mirage refuses concurrent variable writes/, kind);
  }
  const nested = { type: 'Foreach', runAfter: { init: ['Succeeded'] }, foreach: [1], actions: { each } };
  assert.doesNotMatch(inspectFlowDefinition({ triggers: manual, actions: { init, outer: nested } }).errors.join(' '), /concurrently/);
});
