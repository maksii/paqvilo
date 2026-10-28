import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFlowDefinition, validateFlowInput } from '../lib/flow-runtime.mjs';
import { parseExactJson } from '../lib/exact-numeric.mjs';

const rejected = (value, schema) =>
  assert.throws(
    () => validateFlowInput(value, schema),
    (error) => error.code === 'InvalidRequest',
  );
const unsupported = (schema, value = null) =>
  assert.throws(
    () => validateFlowInput(value, schema),
    (error) => error.code === 'LocalFlowUnsupported',
  );
const parse = (content, schema) =>
  executeFlowDefinition({
    definition: {
      triggers: { manual: { type: 'Request', kind: 'Button' } },
      actions: {
        Parse: { type: 'ParseJson', inputs: { content, schema } },
        Reply: {
          type: 'Response',
          runAfter: { Parse: ['Succeeded', 'Failed'] },
          inputs: { body: { status: "@actions('Parse')['status']", outputs: "@outputs('Parse')" } },
        },
      },
    },
    input: {},
  });

test('allOf checks every schema independently together with sibling constraints', () => {
  const schema = { type: 'object', allOf: [{ required: ['x_name'] }, { properties: { x_name: { type: 'string' } } }] };
  validateFlowInput({ x_name: 'local' }, schema);
  rejected({}, schema);
  rejected({ x_name: 1 }, schema);
  rejected('local', schema);
  rejected(
    { x_name: 'local' },
    {
      allOf: [{ type: 'object', additionalProperties: false }, { properties: { x_name: { type: 'string' } } }],
    },
  );
});

test('anyOf accepts one or several matches while oneOf requires exactly one', () => {
  const branches = [{ type: 'integer' }, { type: 'number' }];
  validateFlowInput(2, { anyOf: branches });
  validateFlowInput(2.5, { oneOf: branches });
  rejected(2, { oneOf: branches });
  rejected('2', { anyOf: branches });
  rejected('2', { oneOf: branches });
  validateFlowInput(null, { oneOf: [{ type: 'null' }, { type: 'string' }] });
});

test('composition uses exact numeric values without converting integers to double or coercing enum types', () => {
  const exact = parseExactJson('9007199254740993');
  validateFlowInput(exact, { oneOf: [{ type: 'integer', enum: [exact] }, { type: 'string' }] });
  rejected(exact, { oneOf: [{ type: 'integer' }, { type: 'number' }] });
  rejected(exact, { enum: ['9007199254740993'] });
  rejected(true, { enum: [1] });
  validateFlowInput(parseExactJson('1.50'), { enum: [1.5] });
});

test('boolean nested schemas and schema-valued additional properties cannot silently pass rejected values', () => {
  validateFlowInput('anything', true);
  rejected('anything', false);
  validateFlowInput('local', { oneOf: [false, { type: 'string' }] });
  rejected({ x_hidden: 1 }, { properties: { x_hidden: false } });
  rejected([1], { items: false });
  validateFlowInput({}, { properties: { x_hidden: false }, items: false });
  validateFlowInput({ x_name: 'local' }, { additionalProperties: { type: 'string' } });
  rejected({ x_name: 1 }, { additionalProperties: { type: 'string' } });
});

test('closed objects retain the undeclared-property diagnostic independently of false schemas', () => {
  assert.throws(
    () => validateFlowInput({ x_extra: true }, { type: 'object', additionalProperties: false }),
    (error) =>
      error.code === 'InvalidRequest' &&
      error.message === 'Cloud-flow input body contains undeclared property x_extra.',
  );
  assert.throws(
    () => validateFlowInput(true, false),
    (error) =>
      error.code === 'InvalidRequest' && error.message === 'Cloud-flow input body is rejected by a false schema.',
  );
});

test('enum structural equality preserves member order independence and exact nested numeric semantics', () => {
  const expected = parseExactJson('{"x_rows":[9007199254740993,1.50],"x_flag":true}');
  validateFlowInput(parseExactJson('{"x_flag":true,"x_rows":[9007199254740993,1.5]}'), { enum: [expected] });
  rejected(parseExactJson('{"x_flag":1,"x_rows":[9007199254740993,1.5]}'), { enum: [expected] });
  rejected(parseExactJson('{"x_flag":true,"x_rows":["9007199254740993",1.5]}'), { enum: [expected] });
});

test('enum comparisons share depth and work limits rather than overflowing or bypassing alternatives', () => {
  let value = 0,
    expected = 0;
  for (let index = 0; index < 12000; index++) {
    value = { x_child: value };
    expected = { x_child: expected };
  }
  assert.throws(
    () => validateFlowInput(value, { anyOf: [true, { enum: [expected] }] }),
    (error) => error.code === 'LocalFlowUnsupported' && /nesting limit/.test(error.message),
  );
  const wide = Array(10010).fill(1);
  assert.throws(
    () => validateFlowInput([...wide], { enum: [wide] }),
    (error) => error.code === 'LocalFlowUnsupported' && /validation work limit/.test(error.message),
  );
});

test('malformed composition declarations are explicit capability errors', () => {
  for (const keyword of ['allOf', 'anyOf', 'oneOf'])
    for (const branches of [[], {}, null, [{ type: 'string' }, 7]]) unsupported({ [keyword]: branches });
  for (const schema of [
    { type: [] },
    { type: [['string']] },
    { type: 'unknown' },
    { enum: [] },
    { required: 'x_name' },
    { properties: [] },
    { items: [] },
  ])
    unsupported(schema);
});

test('unsupported assertions and references cannot be swallowed by a matching anyOf branch', () => {
  for (const branch of [
    { $ref: 'https://example.invalid/schema.json' },
    { $ref: '#/$defs/local' },
    { type: 'number', minimum: 0 },
    { type: 'string', pattern: '^x' },
    { not: { type: 'string' } },
  ])
    unsupported({ anyOf: [true, branch] }, 'local');
});

test('schema depth and evaluation work limits remain errors across alternatives', () => {
  let schema = { type: 'string' };
  for (let index = 0; index < 33; index++) schema = { anyOf: [schema] };
  unsupported(schema, 'local');
  assert.throws(
    () =>
      validateFlowInput(Array(3500).fill(1), {
        type: 'array',
        items: { anyOf: [{ type: 'integer' }, { type: 'number' }] },
      }),
    /validation work limit/,
  );
});

test('ParseJson composition failures use its actual failure branch and successful bodies remain typed', async () => {
  const schema = {
    type: 'object',
    properties: { x_code: { oneOf: [{ type: 'string' }, { type: 'boolean' }] } },
    required: ['x_code'],
  };
  const failed = await parse({ x_code: 5 }, schema);
  assert.equal(failed.body.status, 'Failed');
  assert.equal(failed.body.outputs.error.code, 'ValidationFailed');
  for (const content of [{ x_code: 'local' }, { x_code: false }]) {
    const answer = await parse(content, schema);
    assert.deepEqual(answer.body, { status: 'Succeeded', outputs: { body: content } });
  }
  const overlapping = await parse(2, { oneOf: [{ type: 'integer' }, { type: 'number' }] });
  assert.equal(overlapping.body.outputs.error.code, 'ValidationFailed');
  const matching = await parse('2', { anyOf: [{ type: 'integer' }, { type: 'number' }] });
  assert.equal(matching.body.status, 'Succeeded');
});

test('ParseJson preserves unsupported schema errors instead of claiming an ordinary validation mismatch', async () => {
  const answer = await parse({}, { anyOf: [true, { $ref: 'https://example.invalid/schema.json' }] });
  assert.equal(answer.body.status, 'Failed');
  assert.equal(answer.body.outputs.error.code, 'LocalFlowUnsupported');
});

test('a failing composed Request schema prevents every action from executing', () => {
  const definition = {
    triggers: {
      manual: {
        type: 'Request',
        kind: 'Button',
        inputs: { schema: { oneOf: [{ type: 'array' }, { type: 'string' }] } },
      },
    },
    actions: { Reply: { type: 'Response', inputs: { body: 'must not run' } } },
  };
  assert.throws(
    () => executeFlowDefinition({ definition, input: 1 }),
    (error) => error.code === 'InvalidRequest',
  );
});
