import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFlowDefinition, inspectFlowDefinition } from '../lib/flow-runtime.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { PACK_EXPORTS } from '../lib/pack-exports.mjs';

// Built-in data operations, Until and concurrent branches.
const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } };
const flow = (actions, last) => ({
  triggers: manual,
  actions: {
    ...actions,
    Reply: {
      type: 'Response',
      runAfter: { [last]: ['Succeeded', 'Failed', 'TimedOut'] },
      inputs: { statusCode: 200, body: { status: `@actions('${last}')['status']`, body: `@outputs('${last}')` } },
    },
  },
});
const run = (definition, extra = {}) => executeFlowDefinition({ definition, input: {}, ...extra });

test('ParseJson parses text, validates the schema and fails on a mismatch', async () => {
  const schema = { type: 'object', properties: { x_count: { type: 'integer' } }, required: ['x_count'] };
  const ok = await run(flow({ Parse: { type: 'ParseJson', inputs: { content: '{"x_count":2}', schema } } }, 'Parse'));
  assert.equal(ok.body.status, 'Succeeded');
  assert.equal(String(ok.body.body.body.x_count.value ?? ok.body.body.body.x_count), '2');
  const bad = await run(
    flow({ Parse: { type: 'ParseJson', inputs: { content: '{"x_count":"two"}', schema } } }, 'Parse'),
  );
  assert.equal(bad.body.status, 'Failed');
  assert.equal(bad.body.body.error.code, 'ValidationFailed');
  const invalid = await run(flow({ Parse: { type: 'ParseJson', inputs: { content: '{', schema: {} } } }, 'Parse'));
  assert.equal(invalid.body.body.error.code, 'InvalidJSON');
});

test('Select maps items with item(), Query filters with a boolean where and Join joins with a delimiter', async () => {
  const select = await run(
    flow(
      {
        Map: {
          type: 'Select',
          inputs: { from: ['a', 'b'], select: { x_name: '@item()', x_upper: '@toUpper(item())' } },
        },
      },
      'Map',
    ),
  );
  assert.deepEqual(select.body.body, {
    body: [
      { x_name: 'a', x_upper: 'A' },
      { x_name: 'b', x_upper: 'B' },
    ],
  });
  const query = await run(
    flow(
      { Keep: { type: 'Query', inputs: { from: ['a', 'bb', 'ccc'], where: '@greater(length(item()), 1)' } } },
      'Keep',
    ),
  );
  assert.deepEqual(query.body.body, { body: ['bb', 'ccc'] });
  const notBoolean = await run(flow({ Keep: { type: 'Query', inputs: { from: ['a'], where: '@item()' } } }, 'Keep'));
  assert.equal(notBoolean.body.status, 'Failed');
  const join = await run(
    flow({ Joined: { type: 'Join', inputs: { from: ['a', 'b', 'c'], joinWith: ';' } } }, 'Joined'),
  );
  assert.deepEqual(join.body.body, { body: 'a;b;c' });
});

test('Table renders CSV and HTML with automatic or explicit columns', async () => {
  const csv = await run(
    flow({ T: { type: 'Table', inputs: { from: [{ x_name: 'a,b', x_n: 1 }], format: 'CSV' } } }, 'T'),
  );
  assert.equal(csv.body.body.body, 'x_name,x_n\r\n"a,b",1');
  const html = await run(
    flow(
      {
        T: {
          type: 'Table',
          inputs: { from: ['<x>'], format: 'HTML', columns: [{ header: 'Value', value: '@item()' }] },
        },
      },
      'T',
    ),
  );
  assert.equal(
    html.body.body.body,
    '<table><thead><tr><th>Value</th></tr></thead><tbody><tr><td>&lt;x&gt;</td></tr></tbody></table>',
  );
});

test('Until stops on the expression, on limit.count and on the timeout (TimedOut)', async () => {
  const counter = {
    Init: { type: 'InitializeVariable', inputs: { variables: [{ name: 'n', type: 'integer', value: 0 }] } },
  };
  const until = (expression, limit) => ({
    ...counter,
    Loop: {
      type: 'Until',
      runAfter: { Init: ['Succeeded'] },
      expression,
      limit,
      actions: { Step: { type: 'IncrementVariable', inputs: { name: 'n', value: 1 } } },
    },
    Count: {
      type: 'Compose',
      runAfter: { Loop: ['Succeeded', 'TimedOut'] },
      inputs: { status: "@actions('Loop')['status']", n: "@variables('n')" },
    },
  });
  const met = await run(flow(until("@equals(variables('n'), 3)", { count: 10 }), 'Count'));
  assert.deepEqual([met.body.body.status, String(met.body.body.n.value ?? met.body.body.n)], ['Succeeded', '3']);
  const counted = await run(flow(until("@equals(variables('n'), 99)", { count: 4 }), 'Count'));
  assert.deepEqual(
    [counted.body.body.status, String(counted.body.body.n.value ?? counted.body.body.n)],
    ['Succeeded', '4'],
  );
  const timedOut = await run(flow(until("@equals(variables('n'), 99)", { count: 50, timeout: 'PT0S' }), 'Count'));
  assert.deepEqual(
    [timedOut.body.body.status, String(timedOut.body.body.n.value ?? timedOut.body.body.n)],
    ['TimedOut', '1'],
  );
  assert.match(inspectFlowDefinition(flow(until('@true', { count: 0 }), 'Count')).errors.join(' '), /Until limit/);
  // A count above the local iteration limit is refused instead of stopping early as Succeeded (native maximum 5000).
  await assert.rejects(async () => run(flow(until("@equals(variables('n'), -1)", { count: 200 }), 'Count')), {
    status: 501,
    code: 'LocalFlowUnsupported',
    message: /Until Loop limit\.count 200 exceeds the local iteration limit \(100\)/,
  });
  const raised = await run(flow(until("@equals(variables('n'), -1)", { count: 200 }), 'Count'), {
    limits: { maxIterations: 200 },
  });
  assert.equal(String(raised.body.body.n.value ?? raised.body.body.n), '200');
});

test('a branch reading a variable another concurrent branch writes requires a mock', () => {
  const definition = {
    triggers: manual,
    actions: {
      Init: { type: 'InitializeVariable', inputs: { variables: [{ name: 'a', type: 'string', value: '' }] } },
      Writer: { type: 'SetVariable', runAfter: { Init: ['Succeeded'] }, inputs: { name: 'a', value: 'x' } },
      Reader: { type: 'Compose', runAfter: { Init: ['Succeeded'] }, inputs: "@concat('seen:', variables('a'))" },
      Reply: {
        type: 'Response',
        runAfter: { Writer: ['Succeeded'], Reader: ['Succeeded'] },
        inputs: { statusCode: 200 },
      },
    },
  };
  assert.match(inspectFlowDefinition(definition).errors.join(' '), /write and read the variable a/);
  assert.deepEqual(inspectFlowDefinition(definition, { Reader: { mode: 'mock' } }).errors, []);
});

test('mutually exclusive success/failure siblings run without a mock and only the matching one executes', async () => {
  const definition = {
    triggers: manual,
    actions: {
      A: { type: 'Compose', inputs: 1 },
      OnSuccess: { type: 'Response', runAfter: { A: ['Succeeded'] }, inputs: { statusCode: 200, body: 'ok' } },
      OnFailure: {
        type: 'Response',
        runAfter: { A: ['Failed', 'TimedOut'] },
        inputs: { statusCode: 500, body: 'failed' },
      },
    },
  };
  assert.deepEqual(inspectFlowDefinition(definition).errors, []);
  assert.deepEqual(await run(definition), { status: 200, body: 'ok' });
});

test('independent branches run in definition order and the run status follows every branch', async () => {
  const notes = [];
  const definition = {
    triggers: manual,
    actions: {
      Init: { type: 'InitializeVariable', inputs: { variables: [{ name: 'log', type: 'array', value: [] }] } },
      Left: {
        type: 'AppendToArrayVariable',
        runAfter: { Init: ['Succeeded'] },
        inputs: { name: 'log', value: 'left' },
      },
      Right: { type: 'Compose', runAfter: { Init: ['Succeeded'] }, inputs: 'right' },
      Reply: {
        type: 'Response',
        runAfter: { Left: ['Succeeded'], Right: ['Succeeded'] },
        inputs: { statusCode: 200, body: { log: "@variables('log')", right: "@outputs('Right')" } },
      },
    },
  };
  assert.deepEqual(await run(definition, { diagnostic: (n) => notes.push(n) }), {
    status: 200,
    body: { log: ['left'], right: 'right' },
  });
  // Branches start together (synchronous ones in definition order).
  assert.equal(notes.filter((n) => n.code === 'FLOW_PARALLEL_SEQUENTIAL').length, 0);
  const order = notes.filter((n) => n.code === 'FLOW_ACTION').map((n) => n.action);
  assert.ok(order.indexOf('Left') < order.indexOf('Right'));
  // A failed branch fails the run even when the other branch succeeds.
  definition.actions.Right = {
    type: 'Terminate',
    runAfter: { Init: ['Succeeded'] },
    inputs: { runStatus: 'Failed', runError: { message: 'invented' } },
  };
  // A Terminate Failed ends the run with its runError message.
  await assert.rejects(async () => run(definition), { code: 'LocalFlowTerminated', message: 'invented' });
});

test('two concurrent branches writing the same variable still require a mock', () => {
  const definition = {
    triggers: manual,
    actions: {
      Init: { type: 'InitializeVariable', inputs: { variables: [{ name: 'v', type: 'string', value: '' }] } },
      Left: {
        type: 'Scope',
        runAfter: { Init: ['Succeeded'] },
        actions: { Set: { type: 'SetVariable', inputs: { name: 'v', value: 'left' } } },
      },
      Right: { type: 'SetVariable', runAfter: { Init: ['Succeeded'] }, inputs: { name: 'v', value: 'right' } },
      Reply: { type: 'Response', runAfter: { Left: ['Succeeded'], Right: ['Succeeded'] }, inputs: { statusCode: 200 } },
    },
  };
  assert.match(inspectFlowDefinition(definition).errors.join(' '), /write the variable v/);
  assert.deepEqual(inspectFlowDefinition(definition, { Right: { mode: 'mock' } }).errors, []);
});

test('a pack flowActions handler runs as a journalled provider-backed action at contract', async () => {
  assert.throws(() => PACK_EXPORTS.flowActions.check({ Compose: () => ({}) }, 'fx-pack'), /new action type/);
  const seen = [];
  const connectors = createConnectorRuntime({
    packs: [
      {
        id: 'fx-pack',
        flowActions: {
          x_Lookup: async (request) => {
            seen.push(request);
            return request.inputs.code === 'bad'
              ? { statusCode: 404, body: null }
              : { body: { found: request.inputs.code } };
          },
        },
      },
    ],
  });
  assert.ok(connectors.describe().some((r) => r.name === 'flow-actions:pack' && r.level === 'contract'));
  const definition = (code) => flow({ Look: { type: 'x_Lookup', inputs: { code } } }, 'Look');
  const journal = [];
  const ok = await executeFlowDefinition({
    definition: definition("@concat('a', 'b')"),
    input: {},
    connectors,
    journal: (path, entry) => journal.push([path, entry.status]),
  });
  assert.deepEqual(ok.body, { status: 'Succeeded', body: { body: { found: 'ab' } } });
  assert.deepEqual(seen[0], { type: 'x_Lookup', inputs: { code: 'ab' } });
  assert.deepEqual(journal, [['Look', 'Succeeded']]);
  assert.equal(
    (await executeFlowDefinition({ definition: definition('bad'), input: {}, connectors })).body.status,
    'Failed',
  );
  assert.match(inspectFlowDefinition(definition('x')).errors.join(' '), /Unsupported action Look \(x_Lookup\)/);
});
