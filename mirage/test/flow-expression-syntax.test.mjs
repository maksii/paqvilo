import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFlowDefinition, parseFlowExpression, resolveFlowValue } from '../lib/flow-runtime.mjs';

const state = () => ({ input: {}, variables: {}, parameters: {}, results: {}, items: [] });

test('flow parser rejects trailing missing arguments regardless of intervening whitespace', () => {
  for (const expression of [
    "concat('left', 'right',)",
    "concat('left', 'right', )",
    "concat('left', 'right',\n\t)",
    "concat('left', toUpper('right',))",
    "concat('left', toUpper('right', ))",
  ]) {
    assert.throws(() => parseFlowExpression(expression), /argument is missing/);
    assert.throws(() => resolveFlowValue('@' + expression, state()), /argument is missing/);
    assert.throws(() => resolveFlowValue('value @{' + expression + '}', state()), /argument is missing/);
  }
});

test('valid zero-argument calls, empty strings and commas inside strings retain their meaning', () => {
  assert.deepEqual(resolveFlowValue('@triggerBody( )', state()), {});
  assert.equal(resolveFlowValue("@concat('left,', 'right')", state()), 'left,right');
  assert.equal(resolveFlowValue("@concat('', '')", state()), '');
  assert.equal(resolveFlowValue("@concat('left', toUpper( 'right' ))", state()), 'leftRIGHT');
});

test('a malformed Compose expression fails instead of returning a successful plausible value', async () => {
  const answer = await executeFlowDefinition({
    definition: {
      triggers: { manual: { type: 'Request', kind: 'Button' } },
      actions: {
        Compose: { type: 'Compose', inputs: "@concat('left','right',)" },
        Rejected: {
          type: 'Response',
          runAfter: { Compose: ['Failed'] },
          inputs: { statusCode: 422, body: "@outputs('Compose')?['error']?['message']" },
        },
      },
    },
    input: {},
  });
  assert.deepEqual(answer, { status: 422, body: 'Flow expression argument is missing.' });
});

test('property chains and mixed expressions respect actual AST depth before evaluation', async () => {
  const nested = { leaf: 'kept' };
  let input = nested;
  for (let i = 0; i < 10; i++) input = { x: input };
  assert.equal(resolveFlowValue('@triggerBody()' + "?['x']".repeat(10) + '.leaf', { ...state(), input }), 'kept');
  for (const chain of ["?['x']", '.x', '?.x']) {
    const source = 'triggerBody()' + chain.repeat(6000);
    for (const evaluate of [() => parseFlowExpression(source), () => resolveFlowValue('@' + source, state())])
      assert.throws(
        evaluate,
        (error) => error.code === 'LocalFlowUnsupported' && /nesting exceeds 64/.test(error.message),
      );
  }
  const source = 'toUpper(' + 'triggerBody()' + '.x'.repeat(63) + ')';
  assert.throws(() => parseFlowExpression(source), /nesting exceeds 64/);
  const answer = await executeFlowDefinition({
    definition: {
      triggers: { manual: { type: 'Request', kind: 'Button' } },
      actions: {
        Compose: { type: 'Compose', inputs: '@triggerBody()' + '.x'.repeat(6000) },
        Rejected: {
          type: 'Response',
          runAfter: { Compose: ['Failed'] },
          inputs: { statusCode: 422, body: "@outputs('Compose')?['error']?['code']" },
        },
      },
    },
    input: {},
  });
  assert.deepEqual(answer, { status: 422, body: 'LocalFlowUnsupported' });
});
