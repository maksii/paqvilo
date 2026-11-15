// @test-kind contract: Paqvilo's own flow runtime behaviour as documented in mirage/docs/operations.md (flow limits, expressions)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import {
  executeFlowDefinition,
  inspectFlowDefinition,
  inspectFlowTrigger,
  parseFlowExpression,
  resolveFlowValue,
} from '../lib/flow-runtime.mjs';
import { parseExactJson, exactNumeric } from '../lib/exact-numeric.mjs';
const definition = (actions) => ({ triggers: { request: { type: 'Request', kind: 'powerpages' } }, actions });
const profile = {
  userId: '10000000-0000-0000-0000-000000000001',
  evidence: 'Invented backend grants',
  grants: [{ entity: 'widget', operations: ['read', 'create', 'update', 'delete'] }],
};
const store = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
      tables: { widget: [] },
      plugins: [],
      permissions: [],
      settings: { permissionMode: 'enforce' },
    },
  });
test('Imported flow executes branches, ordered variables and foreach with typed expressions', () => {
  const answer = executeFlowDefinition({
    definition: definition({
      init: { type: 'InitializeVariable', inputs: { variables: [{ name: 'sum', type: 'integer', value: 0 }] } },
      loop: {
        type: 'Foreach',
        foreach: "@triggerBody()?['values']",
        runAfter: { init: ['Succeeded'] },
        actions: { add: { type: 'IncrementVariable', inputs: { name: 'sum', value: '@item()' } } },
      },
      condition: {
        type: 'If',
        expression: { greater: ["@variables('sum')", 4] },
        runAfter: { loop: ['Succeeded'] },
        actions: {
          reply: {
            type: 'Response',
            inputs: { body: { total: "@variables('sum')", text: "Total @{variables('sum')}" } },
          },
        },
        else: { actions: { low: { type: 'Response', inputs: { statusCode: 202, body: 'low' } } } },
      },
    }),
    input: { values: [2, 3] },
  });
  assert.deepEqual(answer, { status: 200, body: { total: 5, text: 'Total 5' } });
});
test('External action needs exact per-action mock or explicit disable and traces show the chosen mode', () => {
  const d = definition({
    external: { type: 'Http', inputs: { uri: 'https://invalid.example.test' } },
    reply: { type: 'Response', runAfter: { external: ['Succeeded'] }, inputs: { body: "@body('external')" } },
  });
  assert.equal(inspectFlowDefinition(d).supported, false);
  assert.throws(() => executeFlowDefinition({ definition: d, input: {} }), /explicit action mock/);
  const notes = [];
  assert.deepEqual(
    executeFlowDefinition({
      definition: d,
      input: {},
      steps: { external: { mode: 'mock', outputs: { body: { answer: 7 } } } },
      diagnostic: (n) => notes.push(n),
    }),
    { status: 200, body: { answer: 7 } },
  );
  assert.equal(notes[0].status, 'Succeeded');
  const skipped = structuredClone(d);
  skipped.actions.reply.runAfter.external = ['Skipped'];
  assert.deepEqual(
    executeFlowDefinition({ definition: skipped, input: {}, steps: { external: { mode: 'disabled' } } }),
    { status: 200, body: null },
  );
  assert.equal(inspectFlowDefinition(d, { typo: { mode: 'mock' } }).supported, false);
});
test('runAfter failure handling is explicit and no successful response is invented', () => {
  const d = definition({
    bad: { type: 'Compose', inputs: '@div(1,0)' },
    reply: {
      type: 'Response',
      runAfter: { bad: ['Failed'] },
      inputs: { statusCode: 422, body: "@outputs('bad')?['error']?['code']" },
    },
  });
  assert.deepEqual(executeFlowDefinition({ definition: d, input: {} }), { status: 422, body: 'LocalFlowExpression' });
  d.actions.reply.runAfter.bad = ['Succeeded'];
  assert.throws(() => executeFlowDefinition({ definition: d, input: {} }), /without a Response/);
});
// A Dataverse row write runs on the asynchronous drive (its synchronous service endpoint steps are awaited in process).
test('Dataverse connector actions use separate explicit backend grants and actual local CRUD', async () => {
  const data = store(),
    actions = {
      create: {
        type: 'OpenApiConnection',
        inputs: {
          host: {
            apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
            operationId: 'CreateRecord',
          },
          parameters: { entityName: 'widgets', 'item/title': "@triggerBody()?['title']" },
        },
      },
      reply: { type: 'Response', runAfter: { create: ['Succeeded'] }, inputs: { body: "@body('create')" } },
    };
  assert.throws(
    () => executeFlowDefinition({ definition: definition(actions), input: { title: 'Denied' }, store: data }),
    /without a Response/,
  );
  assert.equal(data.snapshot().tables.widget.length, 0);
  const answer = await executeFlowDefinition({
    definition: definition(actions),
    input: { title: 'Created' },
    store: data,
    serviceProfile: profile,
  });
  assert.equal(answer.body.title, 'Created');
  assert.equal(data.snapshot().tables.widget.length, 1);
  const denied = structuredClone(profile);
  denied.grants[0].operations = ['read'];
  await assert.rejects(
    async () =>
      executeFlowDefinition({
        definition: definition(actions),
        input: { title: 'Denied' },
        store: data,
        serviceProfile: denied,
      }),
    /without a Response/,
  );
  assert.equal(data.snapshot().tables.widget.length, 1);
});
test('Expressions cannot access ambient JavaScript or unsafe members and retain null semantics', () => {
  assert.throws(() => parseFlowExpression('process.exit(0)'), /bare|syntax/);
  const state = { input: { null: null }, variables: {}, parameters: {}, results: {}, items: [] };
  assert.equal(resolveFlowValue("@triggerBody()?['missing']", state), null);
  assert.throws(() => resolveFlowValue("@triggerBody()['missing']", state), /absent/);
  assert.throws(() => resolveFlowValue("@triggerBody()['constructor']", state), /Unsafe/);
  assert.equal(resolveFlowValue('@@literal', state), '@literal');
});
test('Bounded foreach and action budget reject runaway definitions', () => {
  const d = definition({
    loop: {
      type: 'Foreach',
      foreach: "@triggerBody()['values']",
      actions: { value: { type: 'Compose', inputs: '@item()' } },
    },
    reply: { type: 'Response', runAfter: { loop: ['Succeeded'] }, inputs: { body: {} } },
  });
  assert.throws(
    () => executeFlowDefinition({ definition: d, input: { values: Array(101).fill(1) } }),
    /without a Response/,
  );
  assert.throws(
    () => executeFlowDefinition({ definition: d, input: { values: [1, 2] }, limits: { maxActions: 2 } }),
    /limit/,
  );
});

test('WDL arithmetic retains literal numeric type, boolean equality and null string conversion', () => {
  const state = { input: {}, variables: {}, parameters: {}, results: {}, items: [] };
  const value = (s) => resolveFlowValue('@' + s, state);
  assert.equal(value('div(11,5)'), 2);
  assert.equal(value('div(11,5.0)'), 2.2);
  assert.equal(value('div(-11,5)'), -2);
  assert.equal(value('div(mul(3,4),5)'), 2);
  assert.equal(value('div(float(11),5)'), 2.2);
  assert.equal(value('equals(true,1)'), true);
  assert.equal(value('equals(false,0)'), true);
  assert.equal(value('equals(true,2)'), false);
  assert.equal(value('string(null)'), '');
  assert.equal(value(`equals(json('{"a":1,"b":2}'),json('{"b":2,"a":1}'))`), true);
});

// @test-kind compatibility: Microsoft Learn expression-functions-reference#div: "div(11,5)" returns the Integer 2, and the result is a Float only when either the dividend or the divisor is a Float
test('div uses the Integer type of evaluated action outputs and loop items and keeps Float operands', () => {
  const answer = executeFlowDefinition({
    definition: definition({
      Five: { type: 'Compose', inputs: 5 },
      parts: { type: 'InitializeVariable', inputs: { variables: [{ name: 'halves', type: 'array', value: [] }] } },
      loop: {
        type: 'Foreach',
        foreach: '@createArray(5,7)',
        runAfter: { parts: ['Succeeded'] },
        actions: { half: { type: 'AppendToArrayVariable', inputs: { name: 'halves', value: '@div(item(),2)' } } },
      },
      reply: {
        type: 'Response',
        runAfter: { loop: ['Succeeded'] },
        inputs: {
          body: {
            halves: "@variables('halves')",
            output: "@div(outputs('Five'),2)",
            float: '@div(float(5),2)',
          },
        },
      },
    }),
    input: {},
  });
  assert.deepEqual(answer, { status: 200, body: { halves: [2, 3], output: 2, float: 2.5 } });
});

// @test-kind compatibility: Microsoft Learn expression-functions-reference#comparison-functions: the comparison functions accept Integer, Float or String values, so two strings are compared as text
test('comparison functions order two strings and reject a string mixed with a number', () => {
  const state = { input: {}, variables: {}, parameters: {}, results: {}, items: [] };
  const value = (s) => resolveFlowValue('@' + s, state);
  assert.equal(value("greater('apple','banana')"), false);
  assert.equal(value("less('apple','banana')"), true);
  assert.equal(value("greaterOrEquals('b','b')"), true);
  assert.equal(value("lessOrEquals('b','a')"), false);
  // Strings compare by UTF-16 code unit (ordinal), so 'B' (0x42) sorts before 'a' (0x61).
  assert.equal(value("greater('B','a')"), false);
  assert.equal(value('greater(2,1.5)'), true);
  assert.throws(() => value("greater('a',1)"), /Numeric arguments required for greater/);
});

// @test-kind compatibility: Microsoft Learn expression-functions-reference#logical-comparison-functions: "If you use logical functions or conditions to compare values, null values are converted to empty string ("") values"
test('equals converts null to an empty string beside a string or null only', () => {
  const state = { input: {}, variables: {}, parameters: {}, results: {}, items: [] };
  const value = (s) => resolveFlowValue('@' + s, state);
  assert.equal(value("equals(null,'')"), true);
  assert.equal(value("equals(triggerBody()?['missing'],'')"), true);
  assert.equal(value("equals('',null)"), true);
  assert.equal(value("equals('a',null)"), false);
  assert.equal(value('equals(null,0)'), false);
  assert.equal(value('equals(null,false)'), false);
});

// @test-kind compatibility: Microsoft Learn expression-functions-reference#logical-comparison-functions: the null-to-empty-string conversion applies to equals, while a Switch on null does not match a case of ""
test('Switch on null does not match a case of an empty string', () => {
  const answer = executeFlowDefinition({
    definition: definition({
      pick: {
        type: 'Switch',
        expression: '@null',
        cases: {
          blank: { case: '', actions: { hit: { type: 'Response', inputs: { statusCode: 201, body: 'blank' } } } },
        },
        default: { actions: { miss: { type: 'Response', inputs: { statusCode: 202, body: 'default' } } } },
      },
    }),
    input: {},
  });
  assert.deepEqual(answer, { status: 202, body: 'default' });
});

test('a provider call receives the remaining run deadline as timeoutMs only when limits.timeoutMs is supplied', async () => {
  const contexts = [];
  const connectors = createConnectorRuntime({
    packs: [{ id: 'p', flowActions: { Probe: async (request, context) => (contexts.push(context), { body: 'ok' }) } }],
  });
  const d = {
    triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object', properties: {} } } } },
    actions: { Probe: { type: 'Probe', inputs: {}, runAfter: {} } },
  };
  await executeFlowDefinition({
    definition: d,
    input: {},
    connectors,
    limits: { timeoutMs: 5000 },
    context: { background: true },
  });
  await executeFlowDefinition({ definition: d, input: {}, connectors, context: { background: true } });
  assert.ok(contexts[0].timeoutMs > 0 && contexts[0].timeoutMs <= 5000, String(contexts[0].timeoutMs));
  assert.equal(Object.hasOwn(contexts[1], 'timeoutMs'), false);
});

test('Unchosen nested branches expose Skipped state and Response preserves safe headers', () => {
  const d = definition({
    choice: {
      type: 'If',
      expression: '@false',
      actions: { unused: { type: 'Compose', inputs: 1 } },
      else: { actions: { chosen: { type: 'Compose', inputs: 2 } } },
    },
    reply: {
      type: 'Response',
      runAfter: { choice: ['Succeeded'] },
      inputs: { headers: { 'x-invented': 'safe' }, body: "@actions('unused')['status']" },
    },
  });
  assert.deepEqual(executeFlowDefinition({ definition: d, input: {} }), {
    status: 200,
    headers: { 'x-invented': 'safe' },
    body: 'Skipped',
  });
  d.actions.reply.inputs.headers['x-invented'] = 'bad\r\ninjection';
  assert.throws(() => executeFlowDefinition({ definition: d, input: {} }), /without a Response/);
});

test('Valid unsupported execution settings and prohibited Response layouts fail before any write', () => {
  for (const settings of [
    { runtimeConfiguration: { concurrency: { repetitions: 3 } } },
    { staticResults: { name: 'static', staticResultOptions: 'Enabled' } },
    { inputs: { retryPolicy: { type: 'fixed' } } },
  ])
    assert.equal(
      inspectFlowDefinition(definition({ value: { type: 'Compose', inputs: 1, ...settings } })).supported,
      false,
    );
  const loop = definition({
    loop: { type: 'Foreach', foreach: [1], actions: { reply: { type: 'Response', inputs: { body: 1 } } } },
  });
  assert.match(inspectFlowDefinition(loop).errors.join(' '), /Response is not allowed/);
  const action = {
    type: 'OpenApiConnection',
    inputs: {
      host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'ListRecords' },
      parameters: { entityName: 'widgets', x_unknown: 'x' },
    },
  };
  assert.match(
    inspectFlowDefinition(definition({ query: action })).errors.join(' '),
    /Unsupported Dataverse parameter/,
  );
  assert.equal(
    inspectFlowDefinition(
      definition({
        value: { type: 'Compose', inputs: 1, runtimeConfiguration: { secureData: { properties: ['inputs'] } } },
      }),
      { value: { mode: 'mock', outputs: 2 } },
    ).supported,
    true,
  );
  // Independent branches run in definition order; only an interleaving-dependent pair needs a mock.
  assert.equal(
    inspectFlowDefinition(
      definition({
        left: { type: 'Compose', inputs: 1 },
        right: { type: 'Compose', inputs: 2 },
        reply: { type: 'Response', runAfter: { left: ['Succeeded'], right: ['Succeeded'] }, inputs: { body: 1 } },
      }),
    ).supported,
    true,
  );
  assert.match(
    inspectFlowDefinition(
      definition({ left: { type: 'Response', inputs: { body: 1 } }, right: { type: 'Response', inputs: { body: 2 } } }),
    ).errors.join(' '),
    /both answer a Response/,
  );
});

test('WDL escaped inline expressions remain literal alongside evaluated expressions', () => {
  const state = { input: {}, variables: {}, parameters: { age: 42 }, results: {}, items: [] };
  assert.equal(resolveFlowValue("My age is @@{parameters('age')}", state), "My age is @{parameters('age')}");
  assert.equal(
    resolveFlowValue("Literal @@{unsupported()} and age @{parameters('age')}", state),
    'Literal @{unsupported()} and age 42',
  );
  assert.equal(
    resolveFlowValue("Literal @@{concat('Inner @{unsupported()}', '}')} and age @{parameters('age')}", state),
    "Literal @{concat('Inner @{unsupported()}', '}')} and age 42",
  );
  assert.equal(resolveFlowValue('Literal @@{unterminated', state), 'Literal @{unterminated');
  assert.equal(resolveFlowValue("@@{parameters('age')}", state), "@{parameters('age')}");
});

test('WDL interpolation preserves exact numeric digits in scalar and collection results', () => {
  const input = parseExactJson('{"integer":9007199254740993,"decimal":99999999999.1234567891}');
  const answer = executeFlowDefinition({
    definition: definition({
      reply: {
        type: 'Response',
        inputs: {
          body: {
            integer: "Number @{triggerBody()['integer']}",
            decimal: "Number @{triggerBody()['decimal']}",
            converted: "Number @{int('9223372036854775807')}",
            object: 'Object @{triggerBody()}',
            array: "Array @{createArray(triggerBody()['integer'],triggerBody()['decimal'])}",
          },
        },
      },
    }),
    input,
  });
  assert.deepEqual(answer, {
    status: 200,
    body: {
      integer: 'Number 9007199254740993',
      decimal: 'Number 99999999999.1234567891',
      converted: 'Number 9223372036854775807',
      object: 'Object {"integer":9007199254740993,"decimal":99999999999.1234567891}',
      array: 'Array [9007199254740993,99999999999.1234567891]',
    },
  });
});

test('Nested variable declarations fail before connector writes unless explicitly mocked or disabled', () => {
  const initialize = {
    type: 'InitializeVariable',
    inputs: { variables: [{ name: 'count', type: 'integer', value: 0 }] },
  };
  for (const container of [
    { type: 'Scope', actions: { init: initialize } },
    { type: 'If', expression: '@true', actions: { init: initialize } },
    { type: 'If', expression: '@false', else: { actions: { init: initialize } } },
    { type: 'Foreach', foreach: [1], actions: { init: initialize } },
    { type: 'Switch', expression: 'A', cases: { A: { case: 'A', actions: { init: initialize } } } },
    { type: 'Switch', expression: 'B', default: { actions: { init: initialize } } },
  ])
    assert.match(inspectFlowDefinition(definition({ nested: container })).errors.join(' '), /workflow global level/);
  const data = store(),
    d = definition({
      created: {
        type: 'OpenApiConnection',
        inputs: {
          host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'CreateRecord' },
          parameters: { entityName: 'widgets', 'item/title': 'Must not be committed' },
        },
      },
      nested: { type: 'Scope', runAfter: { created: ['Succeeded'] }, actions: { init: initialize } },
      reply: { type: 'Response', runAfter: { nested: ['Succeeded'] }, inputs: { body: {} } },
    });
  assert.throws(
    () => executeFlowDefinition({ definition: d, input: {}, store: data, serviceProfile: profile }),
    /workflow global level/,
  );
  assert.equal(data.snapshot().tables.widget.length, 0);
  assert.equal(inspectFlowDefinition(d, { 'nested/init': { mode: 'disabled' } }).supported, true);
  assert.equal(inspectFlowDefinition(d, { nested: { mode: 'mock' } }).supported, true);
});

const rowDefinition = (actions) => ({
  triggers: {
    row: {
      type: 'OpenApiConnectionWebhook',
      inputs: {
        host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger' },
        parameters: {
          'subscriptionRequest/message': 1,
          'subscriptionRequest/entityname': 'widget',
          'subscriptionRequest/scope': 4,
        },
      },
    },
  },
  actions,
});
const createWidget = {
  type: 'OpenApiConnection',
  inputs: {
    host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'CreateRecord' },
    parameters: { entityName: 'widgets', 'item/title': 'Must not be committed' },
  },
};

test('Request trigger settings cannot silently execute an unconditional flow or commit data', () => {
  const settings = [
    { splitOn: "@triggerBody()['values']" },
    { runtimeConfiguration: { concurrency: { runs: 1 } } },
    { runTimeConfiguration: { concurrency: { runs: 1 } } },
    { recurrence: { frequency: 'Day', interval: 1 } },
    { operationOptions: 'SingleInstance' },
  ];
  for (const setting of settings) {
    const data = store(),
      d = definition({
        created: createWidget,
        reply: { type: 'Response', runAfter: { created: ['Succeeded'] }, inputs: { body: {} } },
      });
    Object.assign(d.triggers.request, setting);
    assert.equal(inspectFlowTrigger(d).supported, false);
    assert.throws(
      () => executeFlowDefinition({ definition: d, input: {}, store: data, serviceProfile: profile }),
      /Unsupported source trigger setting/,
    );
    assert.equal(data.snapshot().tables.widget.length, 0);
  }
  const d = definition({ reply: { type: 'Response', inputs: { body: {} } } });
  d.triggers.request.inputs = { method: 'GET' };
  assert.match(inspectFlowTrigger(d).errors.join(' '), /Unsupported Request trigger input: method/);
});

test('Successful failure handlers resolve branch completion while retaining actual failed action status', () => {
  const actions = {
    bad: { type: 'Compose', inputs: '@div(1,0)' },
    handled: { type: 'Compose', inputs: 'Recovered', runAfter: { bad: ['Failed'] } },
  };
  const answer = executeFlowDefinition({ definition: rowDefinition(actions), input: {} });
  assert.equal(answer.status, 'Succeeded');
  assert.equal(answer.actions.bad.status, 'Failed');
  assert.equal(answer.actions.handled.status, 'Succeeded');
  const scope = definition({
    scoped: { type: 'Scope', actions },
    reply: {
      type: 'Response',
      runAfter: { scoped: ['Succeeded'] },
      inputs: {
        body: {
          scope: "@actions('scoped')['status']",
          failed: "@actions('bad')['status']",
          handled: "@outputs('handled')",
        },
      },
    },
  });
  assert.deepEqual(executeFlowDefinition({ definition: scope, input: {} }), {
    status: 200,
    body: { scope: 'Succeeded', failed: 'Failed', handled: 'Recovered' },
  });
});

test('Skipped terminal actions inherit unresolved predecessor failure or success across dependency chains', () => {
  for (const bad of [true, false]) {
    const d = rowDefinition({
      first: { type: 'Compose', inputs: bad ? '@div(1,0)' : 'Fine' },
      second: { type: 'Compose', inputs: 'Not run', runAfter: { first: [bad ? 'Succeeded' : 'Failed'] } },
      third: { type: 'Compose', inputs: 'Not run', runAfter: { second: ['Succeeded'] } },
    });
    if (bad) assert.throws(() => executeFlowDefinition({ definition: d, input: {} }), /triggered flow actions failed/);
    else {
      const answer = executeFlowDefinition({ definition: d, input: {} });
      assert.equal(answer.status, 'Succeeded');
      assert.equal(answer.actions.second.status, 'Skipped');
      assert.equal(answer.actions.third.status, 'Skipped');
    }
  }
  const d = rowDefinition({
    timed: { type: 'Compose', inputs: 'mocked' },
    skipped: { type: 'Compose', inputs: 'Not run', runAfter: { timed: ['Succeeded'] } },
  });
  assert.throws(
    () => executeFlowDefinition({ definition: d, input: {}, steps: { timed: { mode: 'mock', status: 'TimedOut' } } }),
    /triggered flow actions failed/,
  );
});

test('GetItem selects columns without a pipeline and preserves attributes added by Retrieve plugins', () => {
  const data = store(),
    row = data.createRecord('widget', { title: 'Original', other: 'Unselected' }, { admin: true });
  const read = {
    type: 'OpenApiConnection',
    inputs: {
      host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'GetItem' },
      parameters: { entityName: 'widgets', recordId: row.widgetid, $select: 'title' },
    },
  };
  const d = definition({
    read,
    reply: { type: 'Response', runAfter: { read: ['Succeeded'] }, inputs: { body: "@body('read')" } },
  });
  assert.equal(inspectFlowDefinition(d).supported, true);
  assert.deepEqual(executeFlowDefinition({ definition: d, input: {}, store: data, serviceProfile: profile }), {
    status: 200,
    body: { title: 'Original', widgetid: row.widgetid },
  });
  assert.equal(data.get('widgets', row.widgetid, { admin: true }).other, 'Unselected');
  const columns = [];
  data.setPluginPipeline(
    ({ stage, columns: columnSet, holder }) => {
      columns.push(structuredClone(columnSet));
      if (stage === 40) {
        holder.entity.attributes.title = 'Plugin title';
        holder.entity.attributes.added = 'Plugin attribute';
      }
    },
    ({ operation }) => operation === 'retrieve',
  );
  assert.deepEqual(executeFlowDefinition({ definition: d, input: {}, store: data, serviceProfile: profile }), {
    status: 200,
    body: { title: 'Plugin title', added: 'Plugin attribute', widgetid: row.widgetid },
  });
  assert.deepEqual(columns, [
    { allColumns: false, columns: ['title'] },
    { allColumns: false, columns: ['title'] },
    { allColumns: false, columns: ['title'] },
  ]);
  const denied = structuredClone(profile);
  denied.grants[0].operations = ['create'];
  d.actions.reply.runAfter.read = ['Failed'];
  d.actions.reply.inputs.body = "@outputs('read')['error']['code']";
  assert.deepEqual(executeFlowDefinition({ definition: d, input: {}, store: data, serviceProfile: denied }), {
    status: 200,
    body: 'LocalBackendPermissionDenied',
  });
  read.inputs.parameters.$expand = 'parent';
  assert.match(inspectFlowDefinition(d).errors.join(' '), /Unsupported Dataverse parameter read\/\$expand/);
});

test('Response prohibits static redirect status before writes and rejects dynamic redirects when evaluated', () => {
  for (const status of [300, 302, 399]) {
    const data = store(),
      d = definition({
        created: createWidget,
        reply: { type: 'Response', runAfter: { created: ['Succeeded'] }, inputs: { statusCode: status, body: {} } },
      });
    assert.throws(
      () => executeFlowDefinition({ definition: d, input: {}, store: data, serviceProfile: profile }),
      /2xx, 4xx or 5xx/,
    );
    assert.equal(data.snapshot().tables.widget.length, 0);
  }
  const dynamic = definition({
    reply: { type: 'Response', inputs: { statusCode: "@triggerBody()['status']", body: {} } },
  });
  assert.throws(() => executeFlowDefinition({ definition: dynamic, input: { status: 302 } }), /without a Response/);
  for (const status of [200, 299, 400, 599])
    assert.equal(executeFlowDefinition({ definition: dynamic, input: { status } }).status, status);
});

test('Explicit SDK projection preserves selected nulls and typed numerics/lookups with or without a Retrieve pipeline', () => {
  const id = '10000000-0000-0000-0000-000000000007',
    parent = '10000000-0000-0000-0000-000000000008';
  const row = {
    widgetid: id,
    nullable: null,
    quantity: exactNumeric('9007199254740993', 'Int64'),
    measure: exactNumeric('99999999999.1234567891', 'Decimal'),
    cost: 1.25,
    parentid: { id: parent, logical_name: 'widget', name: null },
    other: 'Unselected',
  };
  const data = new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: {
          entitySet: 'widgets',
          idColumn: 'widgetid',
          columns: {
            nullable: { type: 'string' },
            quantity: { dataverseType: 'bigint' },
            measure: { dataverseType: 'decimal' },
            cost: { dataverseType: 'money' },
            parentid: { dataverseType: 'lookup' },
          },
        },
      },
      tables: { widget: [row] },
      plugins: [],
      permissions: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  const columnSet = { allColumns: false, columns: ['nullable', 'quantity', 'measure', 'cost', 'parentid', 'absent'] };
  const ordinary = data.get('widget', id, { admin: true });
  assert.deepEqual(ordinary, row);
  const projected = data.get('widget', id, { admin: true }, { sdkColumns: columnSet });
  assert.deepEqual(projected, {
    widgetid: id,
    nullable: null,
    quantity: row.quantity,
    measure: row.measure,
    cost: 1.25,
    parentid: { id: parent, logical_name: 'widget' },
  });
  assert.equal(Object.hasOwn(projected, 'absent'), false);
  data.setPluginPipeline(
    () => {},
    ({ operation }) => operation === 'retrieve',
  );
  assert.deepEqual(data.get('widget', id, { admin: true }, { sdkColumns: columnSet }), projected);
});

// A pack action that waits on a gate the test releases, after the mocked clock has moved past two seconds.
const gatedRun = (t, limits) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const connectors = createConnectorRuntime({ packs: [{ id: 'gate-pack', flowActions: { x_Gate: () => gate } }] });
  const d = definition({
    Gate: { type: 'x_Gate', inputs: {} },
    Stamp: { type: 'Compose', runAfter: { Gate: ['Succeeded'] }, inputs: 'done' },
  });
  const pending = executeFlowDefinition({
    definition: d,
    input: {},
    connectors,
    limits,
    context: { background: true },
  });
  t.mock.timers.tick(3000);
  release({ body: { ok: true } });
  return pending;
};

test('a run has no wall-clock deadline unless limits.timeoutMs is supplied', async (t) => {
  const answer = await gatedRun(t);
  assert.equal(answer.status, 'Succeeded');
  assert.equal(answer.actions.Stamp.status, 'Succeeded');
});

test('limits.timeoutMs bounds the run on its clock and fails the next action with LocalFlowTimeout', async (t) => {
  await assert.rejects(gatedRun(t, { timeoutMs: 1000 }), { code: 'LocalFlowTimeout', status: 504 });
});

test('replace() substitutes its text literally, and an empty search text needs native evidence', () => {
  const state = { input: {}, variables: {}, parameters: {}, results: {}, items: [] };
  const value = (s) => resolveFlowValue('@' + s, state);
  assert.equal(value("replace('a-b','-','$&$&')"), 'a$&$&b');
  assert.equal(value("replace('a-b','-','$$')"), 'a$$b');
  assert.throws(() => value("replace('a-b','','x')"), { status: 501, code: 'LocalFlowUnsupported' });
});
