import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDefinition, validateDefinition } from '../lib/connector-definition.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';

function document(schema) {
  return {
    swagger: '2.0',
    paths: {
      '/example': {
        post: { operationId: 'Example', parameters: [{ name: 'body', in: 'body', required: true, schema }] },
      },
    },
    definitions: {},
  };
}
const validate = (schema, body) =>
  validateDefinition(compileDefinition(document(schema)), { operationId: 'Example', parameters: { body } });
const unsupported = (e) => e.status === 501 && e.code === 'OperationUnsupported';

test('flattened parent and child paths fail before dispatch without mutating input', () => {
  let calls = 0;
  const runtime = createConnectorRuntime({
    packs: [
      {
        id: 'invented',
        connectorDefinitions: { shared_example: document({ type: 'object' }) },
        connectors: {
          shared_example: {
            operations: {
              Example: () => {
                calls++;
                return { statusCode: 200 };
              },
            },
          },
        },
      },
    ],
  });
  for (const parent of [{ a: 1 }, 1]) {
    for (const entries of [
      [
        ['body/root', parent],
        ['body/root/child', 2],
      ],
      [
        ['body/root/child', 2],
        ['body/root', parent],
      ],
    ]) {
      const parameters = Object.fromEntries(entries),
        before = structuredClone(parameters);
      assert.throws(
        () => runtime.invoke({ connectorId: 'shared_example', operationId: 'Example', parameters }),
        (e) => e.status === 400 && e.code === 'ConnectorParameterInvalid',
      );
      assert.deepEqual(parameters, before);
    }
  }
  assert.equal(calls, 0);
});

test('local schema references cannot traverse inherited members or empty references', () => {
  for (const $ref of ['#/definitions/__proto__', '#/definitions/constructor', '', false, 0, null])
    assert.throws(() => validate({ $ref }, 42), unsupported);
  const doc = document({ $ref: '#/definitions/a~1b~0c' });
  doc.definitions = JSON.parse('{"a/b~c":{"type":"integer"}}');
  assert.doesNotThrow(() =>
    validateDefinition(compileDefinition(doc), { operationId: 'Example', parameters: { body: 42 } }),
  );
  doc.paths['/example'].post.parameters[0].schema = { $ref: '#/definitions/__proto__' };
  doc.definitions = JSON.parse('{"__proto__":{"type":"integer"}}');
  assert.doesNotThrow(() =>
    validateDefinition(compileDefinition(doc), { operationId: 'Example', parameters: { body: 42 } }),
  );
  assert.throws(
    () => validateDefinition(compileDefinition(doc), { operationId: 'Example', parameters: { body: 'text' } }),
    (e) => e.status === 400,
  );
});

test('object enums compare JSON values independently of property order', () => {
  assert.doesNotThrow(() => validate({ enum: [{ value: 0 }] }, { value: -0 }));
  const schema = { enum: [{ a: 1, nested: { b: 2, c: [1, 2] } }] };
  assert.doesNotThrow(() => validate(schema, { nested: { c: [1, 2], b: 2 }, a: 1 }));
  assert.throws(
    () => validate(schema, { a: 1, nested: { b: 2, c: [2, 1] } }),
    (e) => e.status === 400,
  );
});

test('string length constraints count Unicode characters', () => {
  assert.doesNotThrow(() => validate({ type: 'string', maxLength: 1 }, '😀'));
  assert.throws(
    () => validate({ type: 'string', minLength: 2 }, '😀'),
    (e) => e.status === 400,
  );
  assert.doesNotThrow(() => validate({ type: 'string', minLength: 2, maxLength: 2 }, '😀a'));
});

test('malformed schema constraints fail explicitly instead of coercing values', () => {
  for (const schema of [
    { type: 'number', maximum: 'bad' },
    { type: 'number', minimum: Number.NaN },
    { type: 'string', minLength: -1 },
    { type: 'array', maxItems: 1.5 },
    { type: 'number', exclusiveMaximum: 'false' },
    { type: 'object', additionalProperties: null },
    { type: 'array', items: [] },
    { type: '' },
  ])
    assert.throws(() => validate(schema, 5), unsupported);
});

test('uniqueItems false does not reject an unconstrained array', () => {
  assert.doesNotThrow(() => validate({ type: 'array', uniqueItems: false }, [1, 1]));
  assert.throws(() => validate({ type: 'array', uniqueItems: true }, [1, 1]), unsupported);
});
