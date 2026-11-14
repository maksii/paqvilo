import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition, inspectFlowDefinition } from '../lib/flow-runtime.mjs';

const flow = (value, name = 'sum') => ({
  triggers: { manual: { type: 'Request', kind: 'Button' } },
  actions: {
    Init: { type: 'InitializeVariable', inputs: { variables: [{ name, type: 'integer', value: 0 }] } },
    Writer: { type: 'SetVariable', runAfter: { Init: ['Succeeded'] }, inputs: { name, value: 1 } },
    Reader: { type: 'Compose', runAfter: { Init: ['Succeeded'] }, inputs: value },
  },
});
const conflict = (definition, steps = {}) =>
  inspectFlowDefinition(definition, steps).errors.some((error) => /write and read the variable/.test(error));

test('preflight derives concurrent variable reads from parsed expressions rather than spelling', () => {
  for (const expression of [
    "@variables( 'sum' )",
    "@VARIABLES('sum')",
    "@add(variables(\n'sum'\n), 1)",
    "value: @{variables( 'sum' )}",
    "@{concat('}', string(variables( 'sum' )))}",
  ])
    assert.equal(conflict(flow(expression)), true, expression);
  assert.equal(conflict(flow("@variables('o''clock')", "o'clock")), true);
  assert.equal(conflict(flow({ nested: ["@VARIABLES( 'sum' )"] })), true);
  assert.equal(conflict(flow("@variables('Sum')")), false, 'variable names retain case-sensitive identity');
});

test('quoted and escaped expression-looking literals do not create a variable read', () => {
  for (const literal of [
    "variables('sum')",
    "@@variables('sum')",
    "@@{variables('sum')}",
    "literal @@{variables('sum')} then @{string('safe')}",
    "@concat('variables(''sum'')', ' literal')",
  ])
    assert.equal(conflict(flow(literal)), false, literal);
});

test('dynamic names and malformed expressions cannot establish independence from a concurrent writer', () => {
  for (const expression of ["@variables(concat('s', 'um'))", "@variables('sum'", "value @{variables('sum')"]) {
    const errors = inspectFlowDefinition(flow(expression)).errors;
    assert.ok(
      errors.some((error) => /unknown variable read set/.test(error)),
      expression,
    );
  }
  const alone = flow("@variables('sum'");
  delete alone.actions.Writer;
  assert.equal(inspectFlowDefinition(alone).supported, true, 'ordinary action-level failure remains available');
});

test('ordered, exclusive and explicitly mocked readers retain their existing contracts', () => {
  const definition = flow("@VARIABLES( 'sum' )");
  assert.equal(conflict(definition, { Reader: { mode: 'mock' } }), false);
  assert.equal(conflict(definition, { Reader: { mode: 'disabled' } }), false);
  definition.actions.Reader.runAfter = { Writer: ['Succeeded'] };
  assert.equal(conflict(definition), false);
  definition.actions.Reader.runAfter = { Init: ['Failed'] };
  assert.equal(conflict(definition), false);
});

test('nested source actions contribute their parsed reads, while static schemas do not', () => {
  const nested = flow(null);
  nested.actions.Reader = {
    type: 'Scope',
    runAfter: { Init: ['Succeeded'] },
    actions: { Read: { type: 'Compose', inputs: "@VARIABLES( 'sum' )" } },
  };
  assert.equal(conflict(nested), true);
  assert.equal(conflict(nested, { 'Reader/Read': { mode: 'mock' } }), false);
  const staticSchema = flow(null);
  staticSchema.actions.Reader = {
    type: 'ParseJson',
    runAfter: { Init: ['Succeeded'] },
    inputs: { content: '{}', schema: { type: 'object', description: "@variables('sum')" } },
  };
  assert.equal(conflict(staticSchema), false);
});

test('a rejected parsed read/write conflict executes no provider side effects', async () => {
  let calls = 0;
  const connectors = createConnectorRuntime({
    packs: [
      {
        id: 'local-probe',
        connectors: {
          x_probe: {
            operations: {
              Touch: () => {
                calls++;
                return { statusCode: 200, body: {} };
              },
            },
          },
        },
      },
    ],
  });
  const definition = flow("@VARIABLES( 'sum' )");
  definition.actions.Before = {
    type: 'OpenApiConnection',
    inputs: { host: { apiId: '/apis/x_probe', operationId: 'Touch' }, parameters: {} },
  };
  definition.actions.Init.runAfter = { Before: ['Succeeded'] };
  assert.equal(inspectFlowDefinition(definition, {}, { connectors }).supported, false);
  await assert.rejects(
    async () => executeFlowDefinition({ definition, input: {}, connectors, context: { background: true } }),
    /write and read the variable sum/,
  );
  assert.equal(calls, 0);
});

test('Table literal headers do not read variables, while evaluated column values do', async () => {
  const header = "@VARIABLES( 'sum' )";
  const definition = flow(null);
  definition.actions.Reader = {
    type: 'Table',
    runAfter: { Init: ['Succeeded'] },
    inputs: { from: [{ x_label: 'row' }], format: 'CSV', columns: [{ header, value: "@item()?['x_label']" }] },
  };
  assert.equal(inspectFlowDefinition(definition).supported, true);
  const answer = await executeFlowDefinition({ definition, input: {}, context: { background: true } });
  assert.equal(answer.actions.Reader.outputs.body, header + '\r\nrow');
  definition.actions.Reader.inputs.columns[0].value = "@VARIABLES( 'sum' )";
  assert.equal(conflict(definition), true);
  definition.actions.Reader.inputs.columns[0].value = 'literal';
  definition.actions.Reader.inputs.from = "@variables( 'sum' )";
  assert.equal(conflict(definition), true);
  definition.actions.Reader.inputs.from = [];
  definition.actions.Reader.inputs.format = "@VARIABLES( 'sum' )";
  assert.equal(conflict(definition), false, 'format is static, even when its invalid value will fail at runtime');
});

test('structured data operations ignore unevaluated input metadata and preserve evaluated reads', () => {
  for (const [type, inputs, evaluated] of [
    ['Select', { from: [], select: { x_label: 'literal' } }, 'select'],
    ['Query', { from: [], where: true }, 'where'],
    ['Join', { from: [], joinWith: ',' }, 'joinWith'],
  ]) {
    const definition = flow(null);
    definition.actions.Reader = {
      type,
      runAfter: { Init: ['Succeeded'] },
      inputs: { ...inputs, description: "@VARIABLES( 'sum' )" },
    };
    assert.equal(conflict(definition), false, type + ' metadata is literal');
    definition.actions.Reader.inputs[evaluated] = "@VARIABLES( 'sum' )";
    assert.equal(conflict(definition), true, type + ' evaluated input reads the variable');
  }
});
