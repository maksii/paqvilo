import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFlowDefinition, resolveFlowValue } from '../lib/flow-runtime.mjs';

const state = (input = {}) => ({ input, variables: {}, parameters: {}, results: {}, items: [] });
const value = (expression, input) => resolveFlowValue(expression, state(input));
const definition = (actions) => ({ triggers: { manual: { type: 'Request', kind: 'Button' } }, actions });

// WDL prefix/suffix comparisons are case-insensitive; contains() keeps its case-sensitive semantics.
test('startsWith and endsWith compare strings without case sensitivity', () => {
  for (const [name, text, match, miss] of [
    ['startsWith', 'Invented record', 'INVENTED', 'record'],
    ['endsWith', 'Invented record', 'RECORD', 'Invented'],
  ]) {
    assert.equal(value(`@${name}('${text}', '${match}')`), true);
    assert.equal(value(`@${name}('${text}', '${miss}')`), false);
    assert.equal(value(`@${name}('${text}', '${text}')`), true);
    assert.equal(value(`@${name}('${text}', '${text} extra')`), false);
    assert.equal(value(`@${name}('${text}', '')`), true);
    assert.equal(value(`@${name}('', '')`), true);
    assert.equal(value(`@${name}('', 'x')`), false);
  }
  assert.equal(value("@STARTSWITH('Mixed', 'MIX')"), true);
  assert.equal(value("@ENDSWITH('Mixed', 'XED')"), true);
  assert.equal(value("@startsWith('O''Brien', 'o''b')"), true);
  assert.equal(value("@endsWith('O''Brien', '''BRIEN')"), true);
  assert.equal(value("@contains('Invented record', 'INVENTED')"), false);
});

test('prefix and suffix predicates reject invalid argument counts and non-string operands', () => {
  for (const name of ['startsWith', 'endsWith']) {
    for (const args of ['', "'x'", "'x', 'y', 'z'"])
      assert.throws(() => value(`@${name}(${args})`), /Invalid argument count/);
    for (const args of ["null, 'x'", "'x', null", "1, 'x'", "'x', false", "createArray('x'), 'x'"])
      assert.throws(
        () => value(`@${name}(${args})`),
        (error) => error.status === 400 && error.code === 'LocalFlowExpression',
      );
  }
  assert.throws(() => value("@startsWith(triggerBody()?['missing'], 'x')"), /requires strings/);
  assert.equal(value("@startsWith(coalesce(triggerBody()?['missing'], ''), 'x')"), false);
});

test('Filter array evaluates nested null-safe prefix and suffix conditions against each item', async () => {
  const rows = [
    { x_name: '  DEMO first ', x_email: 'one@Example.TEST' },
    { x_name: null, x_email: 'two@example.test' },
    { x_name: 'demo other', x_email: 'three@example.invalid' },
    { x_name: 'demo blocked', x_email: 'four@example.test', x_blocked: true },
    { x_name: 'ordinary', x_email: 'five@example.test' },
  ];
  const answer = await executeFlowDefinition({
    definition: definition({
      Keep: {
        type: 'Query',
        inputs: {
          from: "@triggerBody()?['rows']",
          where:
            "@and(startsWith(trim(coalesce(item()?['x_name'], '')), 'demo'), or(endsWith(coalesce(item()?['x_email'], ''), '@example.test'), equals(item()?['x_email'], 'fallback')), not(equals(item()?['x_blocked'], true)))",
        },
      },
      Reply: { type: 'Response', runAfter: { Keep: ['Succeeded'] }, inputs: { body: "@body('Keep')" } },
    }),
    input: { rows },
  });
  assert.deepEqual(answer, { status: 200, body: [rows[0]] });
});

test('If condition objects use the same prefix/suffix evaluator as WDL strings', async () => {
  const flow = definition({
    Check: {
      type: 'If',
      expression: {
        and: [
          { startsWith: ["@triggerBody()?['x_code']", 'DEMO-'] },
          { endsWith: ["@triggerBody()?['x_code']", '-LOCAL'] },
        ],
      },
      actions: { Reply: { type: 'Response', inputs: { body: 'match' } } },
      else: { actions: { Other: { type: 'Response', inputs: { body: 'other' } } } },
    },
  });
  assert.deepEqual(await executeFlowDefinition({ definition: flow, input: { x_code: 'demo-item-local' } }), {
    status: 200,
    body: 'match',
  });
  assert.deepEqual(await executeFlowDefinition({ definition: flow, input: { x_code: 'demo-item-remote' } }), {
    status: 200,
    body: 'other',
  });
});

test('an invalid prefix predicate fails its action and exposes an expression error to runAfter handling', async () => {
  const answer = await executeFlowDefinition({
    definition: definition({
      Keep: { type: 'Query', inputs: { from: [null], where: "@startsWith(item(), 'demo')" } },
      Failed: {
        type: 'Response',
        runAfter: { Keep: ['Failed'] },
        inputs: { statusCode: 422, body: "@outputs('Keep')?['error']?['code']" },
      },
    }),
    input: {},
  });
  assert.deepEqual(answer, { status: 422, body: 'LocalFlowExpression' });
});
