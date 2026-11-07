import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { codeAppConnectors } from '../lib/organization-host.mjs';
import { createCodeAppsHandler } from '../lib/code-apps-http.mjs';

const STAFF = '77777777-7777-4777-8777-777777777777';
test('code app connector resolves its project connection and reports unsupported calls through HTTP', async (t) => {
  const calls = [];
  const connections = {
    ref: { connector: 'x_invented', provider: 'pack:invented', settings: { parameters: { marker: 'local' } } },
  };
  const packs = [
    {
      id: 'invented',
      connectors: {
        x_invented: {
          operations: {
            Echo: (request, context) => {
              calls.push({ request, context });
              return { statusCode: 200, body: request.parameters };
            },
          },
        },
      },
    },
  ];
  const connectors = createConnectorRuntime({ connections, packs });
  const app = {
    name: 'invented',
    connectionReferences: [
      { key: 'ref', apiId: 'x_invented', dataSources: ['Alias'] },
      { key: 'unknown', apiId: 'x_missing', dataSources: [] },
    ],
  };
  const notes = [];
  const handler = createCodeAppsHandler({
    apps: () => [app],
    sessions: { resolve: () => ({ principalId: STAFF, kind: 'staff' }) },
    user: () => ({ systemuserid: STAFF }),
    connectors: codeAppConnectors(connectors, connections),
    csrf: () => 'csrf',
    diagnostic: (note) => notes.push(note),
  });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = (path) =>
    fetch(`http://127.0.0.1:${server.address().port}/_apps/code/invented/connectors/${path}`, {
      method: 'POST',
      headers: { 'x-sim-csrf': 'csrf', 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
  const ok = await post('Alias/Echo');
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).body, { hello: 'world' });
  assert.equal(calls[0].context.connectionId, 'ref');
  assert.equal(calls[0].context.initiatingUserId, STAFF);
  assert.equal(calls[0].context.settings.parameters.marker, 'local');
  for (const path of ['unknown/Anything', 'ref/Unsupported']) {
    const response = await post(path);
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error.code, 'ConnectorNotSimulated');
  }
  assert.equal(notes.filter((n) => n.code === 'CODEAPP_CONNECTOR_NOT_SIMULATED').length, 2);
});

test('connector-id connection fallback uses its selected provider before declaring an operation unsupported', async () => {
  const calls = [];
  const connections = { x_invented: { connector: 'x_invented', provider: 'pack:selected' } };
  const packs = [
    {
      id: 'selected',
      connectors: {
        x_invented: {
          operations: {
            Echo: () => {
              calls.push('selected');
              return { statusCode: 200, body: 'ok' };
            },
          },
        },
      },
    },
    { id: 'other', connectors: { x_invented: { operations: { Other: () => ({ statusCode: 200 }) } } } },
  ];
  const runtime = createConnectorRuntime({ connections, packs });
  const invoke = codeAppConnectors(runtime, connections);
  const reference = { key: 'reference-id', apiId: 'x_invented' };
  assert.deepEqual(await invoke({ reference, operationId: 'Echo', principal: { principalId: STAFF } }), {
    statusCode: 200,
    body: 'ok',
  });
  assert.equal(await invoke({ reference, operationId: 'Other', principal: { principalId: STAFF } }), undefined);
  assert.deepEqual(calls, ['selected']);
});
