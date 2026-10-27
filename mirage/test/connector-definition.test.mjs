import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCodeAppsHandler } from '../lib/code-apps-http.mjs';
import { createConnectorRuntime, CONNECTOR_PACK_EXPORTS } from '../lib/connector-runtime.mjs';
import { compileDefinition, validateDefinition } from '../lib/connector-definition.mjs';
import { codeAppConnectors } from '../lib/organization-host.mjs';
import { inspectFlowDefinition } from '../lib/flow-runtime.mjs';
import { validatePackExports } from '../lib/pack-exports.mjs';

const definition = {
  swagger: '2.0',
  paths: {
    '/widgets/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, type: 'integer' }],
      post: {
        operationId: 'UpdateWidget',
        parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Widget' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
  definitions: {
    Widget: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', minLength: 2 } },
      additionalProperties: false,
    },
  },
};
const pack = { id: 'invented', connectorDefinitions: { shared_invented: definition } };

test('captured definition resolves operations and validates without simulating behaviour', async () => {
  CONNECTOR_PACK_EXPORTS.connectorDefinitions.check(pack.connectorDefinitions, pack.id);
  const runtime = createConnectorRuntime({ packs: [pack] });
  const valid = { id: 1, body: { name: 'ok' } };
  assert.equal(
    runtime.validateOperation('shared_invented', { method: 'POST', path: '/widgets/{id}', parameters: valid })
      .operationId,
    'UpdateWidget',
  );
  assert.throws(
    () => runtime.validateOperation('shared_invented', { operationId: 'Missing' }),
    (e) => e.status === 501 && e.code === 'OperationUnsupported',
  );
  for (const parameters of [
    { body: { name: 'ok' } },
    { id: 'one', body: { name: 'ok' } },
    { id: 1, body: { name: 'x' } },
    { id: 1, body: { name: 'ok', extra: 1 } },
  ])
    assert.throws(
      () => runtime.validateOperation('shared_invented', { operationId: 'UpdateWidget', parameters }),
      (e) => e.status === 400 && e.code === 'ConnectorParameterInvalid',
    );
  assert.throws(
    () => runtime.invoke({ connectorId: 'shared_invented', operationId: 'UpdateWidget', parameters: valid }),
    (e) => e.status === 501 && e.code === 'ConnectorNotSimulated',
  );
  const call = codeAppConnectors(runtime);
  assert.equal(
    await call({ reference: { apiId: 'shared_invented' }, operationId: 'UpdateWidget', body: valid }),
    undefined,
  );
  await assert.rejects(
    call({ reference: { apiId: 'shared_invented' }, operationId: 'UpdateWidget', body: { id: 1 } }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    call({ reference: { apiId: 'shared_invented' }, operationId: 'Missing', body: {} }),
    (e) => e.code === 'OperationUnsupported',
  );
});

test('a pack handler runs only after registered definition validation', async () => {
  let calls = 0;
  const runtime = createConnectorRuntime({
    packs: [
      {
        ...pack,
        connectors: {
          shared_invented: {
            operations: {
              UpdateWidget: () => {
                calls++;
                return { statusCode: 200, body: {} };
              },
            },
          },
        },
      },
    ],
  });
  assert.throws(
    () => runtime.invoke({ connectorId: 'shared_invented', operationId: 'UpdateWidget', parameters: {} }),
    (e) => e.status === 400,
  );
  assert.equal(
    (
      await runtime.invoke({
        connectorId: 'shared_invented',
        operationId: 'UpdateWidget',
        parameters: { id: 1, body: { name: 'ok' } },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await runtime.invoke({
        connectorId: 'shared_invented',
        method: 'POST',
        path: '/widgets/{id}',
        parameters: { id: 1, body: { name: 'ok' } },
      })
    ).statusCode,
    200,
  );
  assert.equal(calls, 2);
  assert.throws(() => createConnectorRuntime({ packs: [pack, { ...pack, id: 'other' }] }), /more than one pack/);
});

test('registration and inspection reject ambiguous or unsupported metadata', () => {
  validatePackExports(pack, { strict: true });
  assert.throws(
    () => CONNECTOR_PACK_EXPORTS.connectorDefinitions.check({ x: { swagger: '3.0', paths: {} } }, 'x'),
    /Swagger 2.0/,
  );
  const defaults = structuredClone(definition);
  defaults.paths['/widgets/{id}'].parameters[0].default = 5;
  const withDefault = createConnectorRuntime({
    packs: [{ id: 'x', connectorDefinitions: { shared_invented: defaults } }],
  });
  assert.throws(
    () =>
      withDefault.validateOperation('shared_invented', {
        operationId: 'UpdateWidget',
        parameters: Object.assign(Object.create({ id: 1 }), { body: { name: 'ok' } }),
      }),
    (e) => e.status === 400,
  );
  const duplicate = structuredClone(definition);
  duplicate.paths['/other'] = { get: { operationId: 'UpdateWidget' } };
  assert.throws(
    () => CONNECTOR_PACK_EXPORTS.connectorDefinitions.check({ x: duplicate }, 'x'),
    /duplicate connector operationId/,
  );
  for (const schema of [
    { $ref: 'https://example.test/schema.json' },
    { $ref: '#/definitions/Missing' },
    { type: 'string', oneOf: [{ type: 'string' }] },
    { type: 'string', enum: 'invalid' },
    { type: 'string', pattern: '[' },
    { $ref: 3 },
  ]) {
    const doc = structuredClone(definition);
    doc.paths['/widgets/{id}'].post.parameters[0].schema = schema;
    const runtime = createConnectorRuntime({ packs: [{ id: 'x', connectorDefinitions: { shared_invented: doc } }] });
    assert.throws(
      () =>
        runtime.validateOperation('shared_invented', {
          operationId: 'UpdateWidget',
          parameters: { id: 1, body: 'text' },
        }),
      (e) => e.status === 501 && e.code === 'OperationUnsupported',
    );
  }
  const runtime = createConnectorRuntime({ packs: [pack] });
  const action = (operationId) => ({
    type: 'OpenApiConnection',
    inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_invented', operationId }, parameters: {} },
  });
  const flow = (operationId) => ({
    triggers: { request: { type: 'Request', kind: 'powerpages' } },
    actions: { Example: action(operationId) },
  });
  assert.match(
    inspectFlowDefinition(flow('UpdateWidget'), {}, { connectors: runtime }).errors.join(' '),
    /ConnectorNotSimulated/,
  );
  assert.match(
    inspectFlowDefinition(flow('Missing'), {}, { connectors: runtime }).errors.join(' '),
    /CONNECTOR_OPERATION_UNKNOWN/,
  );
});

test('actual code-app endpoint validates registered metadata and returns 501 without a handler', async (t) => {
  const runtime = createConnectorRuntime({ packs: [pack] });
  const handler = createCodeAppsHandler({
    apps: () => [
      {
        name: 'invented',
        connectionReferences: [{ key: 'ref', apiId: '/providers/Microsoft.PowerApps/apis/shared_invented' }],
      },
    ],
    sessions: { resolve: () => ({ principalId: 'invented', kind: 'staff' }) },
    user: () => ({ systemuserid: 'invented' }),
    organization: { origin: 'http://127.0.0.1:47001' },
    connectors: codeAppConnectors(runtime),
    csrf: () => 'csrf',
  });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const send = (operation, body) =>
    fetch(`http://127.0.0.1:${server.address().port}/_apps/code/invented/connectors/ref/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': 'csrf' },
      body: JSON.stringify(body),
    });
  for (const [operation, body, status, code] of [
    ['UpdateWidget', { id: 1, body: { name: 'ok' } }, 501, 'ConnectorNotSimulated'],
    ['UpdateWidget', { id: 1 }, 400, 'ConnectorParameterInvalid'],
    ['Missing', {}, 501, 'OperationUnsupported'],
  ]) {
    const response = await send(operation, body);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
});

test('object limits and mixed body forms are enforced before dispatch', () => {
  const doc = structuredClone(definition);
  doc.definitions.Widget = { type: 'object', minProperties: 1, maxProperties: 1 };
  const runtime = createConnectorRuntime({ packs: [{ id: 'x', connectorDefinitions: { shared_invented: doc } }] });
  for (const body of [{}, { a: 1, b: 2 }])
    assert.throws(
      () => runtime.validateOperation('shared_invented', { operationId: 'UpdateWidget', parameters: { id: 1, body } }),
      (e) => e.status === 400,
    );
  assert.throws(
    () =>
      runtime.validateOperation('shared_invented', {
        operationId: 'UpdateWidget',
        parameters: { id: 1, body: { a: 1 }, 'body/b': 2 },
      }),
    (e) => e.status === 400,
  );
  assert.doesNotThrow(() =>
    runtime.validateOperation('shared_invented', { operationId: 'UpdateWidget', parameters: { id: 1, 'body/a': 1 } }),
  );
});

test('code-app connector honors a connection keyed by connector id when selecting a provider', async () => {
  const handler = (name) => ({ operations: { UpdateWidget: () => ({ statusCode: 200, body: { name } }) } });
  const connections = { shared_invented: { connector: 'shared_invented', provider: 'pack:second' } };
  const runtime = createConnectorRuntime({
    connections,
    packs: [
      { ...pack, id: 'first', connectors: { shared_invented: handler('first') } },
      { id: 'second', connectors: { shared_invented: handler('second') } },
    ],
  });
  const answer = await codeAppConnectors(
    runtime,
    connections,
  )({
    reference: { key: 'ref', apiId: 'shared_invented' },
    operationId: 'UpdateWidget',
    body: { id: 1, body: { name: 'ok' } },
  });
  assert.deepEqual(answer.body, { name: 'second' });
  const direct = await runtime.invoke({
    connectorId: 'shared_invented',
    operationId: 'UpdateWidget',
    parameters: { id: 1, body: { name: 'ok' } },
  });
  assert.deepEqual(direct.body, { name: 'second' });
});

test('compiled definitions and returned operation metadata cannot mutate runtime validation', async () => {
  const doc = structuredClone(definition);
  const runtime = createConnectorRuntime({
    packs: [
      {
        id: 'x',
        connectorDefinitions: { shared_invented: doc },
        connectors: { shared_invented: { operations: { UpdateWidget: () => ({ statusCode: 200 }) } } },
      },
    ],
  });
  const operation = runtime.validateOperation('shared_invented', {
    operationId: 'UpdateWidget',
    parameters: { id: 1, body: { name: 'ok' } },
  });
  operation.parameters.length = 0;
  assert.throws(
    () =>
      runtime.invoke({ connectorId: 'shared_invented', operationId: 'UpdateWidget', parameters: { id: 1, body: {} } }),
    (e) => e.code === 'ConnectorParameterInvalid',
  );
  doc.definitions.Widget.required = [];
  assert.throws(
    () =>
      runtime.invoke({ connectorId: 'shared_invented', operationId: 'UpdateWidget', parameters: { id: 1, body: {} } }),
    (e) => e.code === 'ConnectorParameterInvalid',
  );
});

test('local path item references and percent-encoded schema pointers resolve', () => {
  const doc = {
    swagger: '2.0',
    'x-path-items': {
      Item: {
        post: {
          operationId: 'Create',
          parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/A%20B' } }],
          responses: {},
        },
      },
    },
    paths: { '/create': { $ref: '#/x-path-items/Item' } },
    definitions: { 'A B': { type: 'string' } },
  };
  const compiled = compileDefinition(doc);
  assert.equal(
    validateDefinition(compiled, { method: 'POST', path: '/create', parameters: { body: 'ok' } }).operationId,
    'Create',
  );
  assert.throws(
    () => validateDefinition(compiled, { operationId: 'Create', parameters: { body: 1 } }),
    (e) => e.code === 'ConnectorParameterInvalid',
  );
  doc['x-path-items'].Item.post.parameters[0].schema.$ref = '#/definitions/A%ZZ';
  const duplicate = structuredClone(doc);
  duplicate.paths['/other'] = { $ref: '#/x-path-items/Item' };
  assert.throws(() => compileDefinition(duplicate), /duplicate connector operationId/);
  const unsupported = structuredClone(doc);
  unsupported.paths['/create'] = { $ref: 'https://example.test/path' };
  assert.throws(
    () => compileDefinition(unsupported),
    (e) => e.code === 'OperationUnsupported',
  );
  const invalid = compileDefinition(doc);
  assert.throws(
    () => validateDefinition(invalid, { operationId: 'Create', parameters: { body: 'ok' } }),
    (e) => e.code === 'OperationUnsupported',
  );
});

test('flat body ordinary prototype names are allowed and parameter location collisions fail closed', () => {
  const doc = {
    swagger: '2.0',
    paths: {
      '/x': {
        post: {
          operationId: 'X',
          parameters: [
            {
              name: 'body',
              in: 'body',
              required: true,
              schema: {
                type: 'object',
                properties: { toString: { type: 'object', properties: { value: { type: 'integer' } } } },
              },
            },
          ],
          responses: {},
        },
      },
    },
  };
  assert.doesNotThrow(() =>
    validateDefinition(compileDefinition(doc), { operationId: 'X', parameters: { 'body/toString/value': 1 } }),
  );
  assert.throws(
    () => validateDefinition(compileDefinition(doc), { operationId: 'X', parameters: { 'body/constructor/value': 1 } }),
    (e) => e.code === 'ConnectorParameterInvalid',
  );
  const collision = {
    swagger: '2.0',
    paths: {
      '/x/{id}': {
        get: {
          operationId: 'X',
          parameters: [
            { name: 'id', in: 'path', type: 'string' },
            { name: 'id', in: 'query', type: 'integer' },
          ],
          responses: {},
        },
      },
    },
  };
  assert.throws(() => compileDefinition(collision), /parameter.*locations/i);
});

test('Swagger path extensions are ignored and malformed JSON pointer escapes fail', () => {
  const doc = {
    swagger: '2.0',
    paths: {
      'x-note': 'annotation',
      '/x': {
        post: {
          operationId: 'X',
          parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/A~2B' } }],
          responses: {},
        },
      },
    },
    definitions: { 'A~2B': { type: 'string' } },
  };
  const invalidPath = structuredClone(doc);
  invalidPath.paths.bad = {};
  assert.throws(() => compileDefinition(invalidPath), /invalid connector path/);
  const compiled = compileDefinition(doc);
  assert.throws(
    () => validateDefinition(compiled, { operationId: 'X', parameters: { body: 'ok' } }),
    (e) => e.code === 'OperationUnsupported',
  );
  doc.paths['/x'].post.parameters[0].schema.$ref = '#/definitions/A~';
  doc.definitions['A~'] = { type: 'string' };
  assert.throws(
    () => validateDefinition(compileDefinition(doc), { operationId: 'X', parameters: { body: 'ok' } }),
    (e) => e.code === 'OperationUnsupported',
  );
});
