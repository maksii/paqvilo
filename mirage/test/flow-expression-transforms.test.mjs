import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFlowDefinition, resolveFlowValue } from '../lib/flow-runtime.mjs';

const state = (input = {}) => ({ input, variables: {}, parameters: {}, results: {}, items: [] });
const value = (expression, input) => resolveFlowValue(expression, state(input));
const definition = (actions) => ({ triggers: { manual: { type: 'Request', kind: 'Button' } }, actions });
const invalid = (expression) =>
  assert.throws(
    () => value(expression),
    (error) => error.status === 400 && error.code === 'LocalFlowExpression',
    expression,
  );

test('split uses literal case-sensitive delimiters and preserves empty segments', () => {
  assert.deepEqual(value("@split('red::blue::::green::', '::')"), ['red', 'blue', '', 'green', '']);
  assert.deepEqual(value("@split('left.right', '.')"), ['left', 'right']);
  assert.deepEqual(value("@split('leftRIGHT', 'right')"), ['leftRIGHT']);
  assert.deepEqual(value("@split('', ',')"), ['']);
  assert.deepEqual(value("@split('plain', ',')"), ['plain']);
  invalid("@split(null, ',')");
  invalid("@split('plain', 1)");
  assert.throws(
    () => value("@split('plain', '')"),
    (error) => error.code === 'LocalFlowUnsupported' && /empty delimiter/.test(error.message),
  );
});

test('join shares string conversion with Join actions and preserves exact numeric digits', () => {
  assert.equal(value("@join(createArray('red', 'blue'), '::')"), 'red::blue');
  assert.equal(value("@join(createArray(), ',')"), '');
  assert.equal(value("@join(createArray('red'), ',')"), 'red');
  assert.equal(value("@join(createArray('red', 'blue'), '')"), 'redblue');
  assert.equal(
    value("@join(createArray(9007199254740993, true, null, json('[9007199254740993]')), '|')"),
    '9007199254740993|true||[9007199254740993]',
  );
  invalid("@join('red', ',')");
  invalid('@join(createArray(1), 2)');
});

test('join refuses an oversized result before allocating the combined string', () => {
  const input = { values: Array(1100).fill('x'), separator: 'x'.repeat(100000) };
  assert.throws(
    () => value("@join(triggerBody()?['values'], triggerBody()?['separator'])", input),
    /output exceeds 104857600 characters/,
  );
});

test('substring supports optional length and checks bounds instead of silently clamping', () => {
  assert.equal(value("@substring('local sample', 6)"), 'sample');
  assert.equal(value("@substring('local sample', 6, 3)"), 'sam');
  assert.equal(value("@substring('local sample', 0, 12)"), 'local sample');
  assert.equal(value("@substring('local sample', 12, 0)"), '');
  assert.equal(value("@substring('', 0)"), '');
  assert.equal(value("@substring('🙂x', 2, 1)"), 'x');
  for (const expression of [
    "@substring('abc', -1)",
    "@substring('abc', 4)",
    "@substring('abc', 1, 3)",
    "@substring('abc', 1, -1)",
    "@substring('abc', 0.5)",
    "@substring('abc', true)",
    "@substring('abc', '1')",
    "@substring('abc', 9007199254740993)",
    '@substring(null, 0)',
  ])
    invalid(expression);
});

test('first and last accept only strings or arrays and preserve valid endpoint values', async () => {
  for (const name of ['first', 'last']) {
    assert.equal(value(`@${name}(createArray(0))`), 0);
    assert.equal(value(`@${name}(createArray(false))`), false);
    assert.equal(value(`@${name}(createArray())`), null);
    assert.equal(value(`@${name}('')`), null);
    for (const literal of ['null', '1', 'true', 'json(\'{"0":"invented"}\')', '9007199254740993'])
      invalid(`@${name}(${literal})`);
  }
  assert.equal(value("@first('hello')"), 'h');
  assert.equal(value("@last('hello')"), 'o');
  assert.equal(value('@first(createArray(0, false))'), 0);
  assert.equal(value('@last(createArray(0, false))'), false);
  const answer = await executeFlowDefinition({
    definition: definition({
      Endpoint: { type: 'Compose', inputs: '@last(triggerBody())' },
      Failure: {
        type: 'Response',
        runAfter: { Endpoint: ['Failed'] },
        inputs: { statusCode: 422, body: "@outputs('Endpoint')?['error']?['code']" },
      },
    }),
    input: { 0: 'invented' },
  });
  assert.deepEqual(answer, { status: 422, body: 'LocalFlowExpression' });
});

test('skip and take preserve collection types, return new arrays and reject unsafe count coercions', () => {
  const input = { rows: [{ x_id: 1 }, { x_id: 2 }, { x_id: 3 }] },
    before = structuredClone(input);
  assert.deepEqual(value("@skip(triggerBody()?['rows'], 1)", input), input.rows.slice(1));
  assert.deepEqual(value("@take(triggerBody()?['rows'], 2)", input), input.rows.slice(0, 2));
  assert.notEqual(value("@take(triggerBody()?['rows'], 9)", input), input.rows);
  assert.deepEqual(value("@skip(triggerBody()?['rows'], 0)", input), input.rows);
  assert.deepEqual(value("@skip(triggerBody()?['rows'], 9)", input), []);
  assert.deepEqual(value("@take(triggerBody()?['rows'], 0)", input), []);
  assert.deepEqual(input, before);
  assert.equal(value("@take('sample', 3)"), 'sam');
  assert.equal(value("@take('sample', 9)"), 'sample');
  assert.equal(value("@take('sample', 0)"), '');
  for (const name of ['skip', 'take'])
    for (const count of ['-1', '0.5', 'true', "'1'", '9007199254740993']) invalid(`@${name}(createArray(1), ${count})`);
  invalid("@skip('sample', 1)");
  invalid('@take(null, 1)');
});

test('new transform functions reject missing and extra arguments', () => {
  for (const expression of [
    "@split('a')",
    "@split('a', 'b', 'c')",
    '@join(createArray(1))',
    "@join(createArray(1), ',', 'extra')",
    "@substring('a')",
    "@substring('a', 0, 1, 2)",
    '@skip(createArray(1))',
    '@skip(createArray(1), 1, 2)',
    '@take(createArray(1))',
    '@take(createArray(1), 1, 2)',
  ])
    assert.throws(() => value(expression), /Invalid argument count/);
});

test('imported Compose, Query and Select actions combine transforms without action mocks', async () => {
  const answer = await executeFlowDefinition({
    definition: definition({
      Tokens: { type: 'Compose', inputs: "@split(triggerBody()?['text'], '|')" },
      Window: { type: 'Compose', runAfter: { Tokens: ['Succeeded'] }, inputs: "@take(skip(outputs('Tokens'), 1), 2)" },
      Keep: {
        type: 'Query',
        runAfter: { Window: ['Succeeded'] },
        inputs: { from: "@outputs('Window')", where: "@startsWith(item(), 'keep:')" },
      },
      Names: {
        type: 'Select',
        runAfter: { Keep: ['Succeeded'] },
        inputs: { from: "@body('Keep')", select: '@substring(item(), 5)' },
      },
      Reply: { type: 'Response', runAfter: { Names: ['Succeeded'] }, inputs: { body: "@join(body('Names'), ',')" } },
    }),
    input: { text: 'ignore:first|keep:red|drop:blue|keep:green' },
  });
  assert.deepEqual(answer, { status: 200, body: 'red' });
});

test('substring bounds failure follows the imported flow failure branch', async () => {
  const answer = await executeFlowDefinition({
    definition: definition({
      Extract: { type: 'Compose', inputs: "@substring('short', 4, 2)" },
      Failed: {
        type: 'Response',
        runAfter: { Extract: ['Failed'] },
        inputs: { statusCode: 422, body: "@outputs('Extract')?['error']?['code']" },
      },
    }),
    input: {},
  });
  assert.deepEqual(answer, { status: 422, body: 'LocalFlowExpression' });
});
