import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getClient } from '@microsoft/power-apps/data';
import { setDataOperationExecutor } from '@microsoft/power-apps/internal/data';
import { configure, getContext } from 'paqvilo/mirage/lib/code-apps-client.js';
import { createCodeAppSdkExecutor } from 'paqvilo/mirage/code-apps';
import { createCodeAppsHandler } from 'paqvilo/mirage/lib/code-apps-http.mjs';

test('Microsoft SDK 1.5 generated-style data client uses the Mirage executor over the loopback bridge', async (t) => {
  const records = new Map();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const requests = [];
  const handler = createCodeAppsHandler({
    apps: () => [{ name: 'sdk-example', connectionReferences: [{ key: 'sample-connector' }] }],
    sessions: { resolve: () => ({ kind: 'staff', principalId: 'staff' }) },
    user: () => ({ systemuserid: 'staff', fullname: 'Avery Invented' }),
    organization: { origin: 'http://127.0.0.1', organizationId: 'org', environmentId: 'env', tenantId: 'tenant' },
    csrf: () => 'local-csrf',
    dataverse: async (request) => {
      requests.push(request);
      if (request.method === 'POST') {
        const row = { ...request.body, x_itemid: id };
        records.set(id, row);
        return { status: 201, body: row };
      }
      if (request.method === 'PATCH') {
        Object.assign(records.get(id), request.body);
        return { status: 200, body: records.get(id) };
      }
      if (request.method === 'DELETE') {
        records.delete(id);
        return { status: 204 };
      }
      if (request.path.includes('(')) return { status: 200, body: records.get(id) };
      return { status: 200, body: { value: [...records.values()] } };
    },
    connectors: async ({ operationId }) =>
      operationId === 'Echo' ? { statusCode: 200, body: { value: 'simulated' } } : undefined,
  });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => originalFetch(new URL(url, origin), options);
  t.after(() => {
    globalThis.fetch = originalFetch;
    setDataOperationExecutor(undefined);
  });
  configure({ app: 'sdk-example' });
  assert.equal((await getContext()).user.fullName, 'Avery Invented');
  setDataOperationExecutor(createCodeAppSdkExecutor({ entitySets: { Items: 'x_items' } }));
  const client = getClient({ Items: { tableId: 'x_item', apis: {} } });
  const created = await client.createRecordAsync('Items', { x_name: 'First' });
  assert.equal(created.success, true);
  assert.equal(created.data.x_itemid, id);
  assert.equal((await client.retrieveRecordAsync('Items', id)).data.x_name, 'First');
  assert.equal((await client.retrieveMultipleRecordsAsync('Items')).data.length, 1);
  assert.equal((await client.updateRecordAsync('Items', id, { x_name: 'Updated' })).success, true);
  assert.equal((await client.retrieveRecordAsync('Items', id)).data.x_name, 'Updated');
  assert.equal((await client.deleteRecordAsync('Items', id)).success, true);
  assert.deepEqual((await client.retrieveMultipleRecordsAsync('Items')).data, []);
  assert.ok(requests.every((request) => request.path.startsWith('/api/data/v9.2/x_items')));
  const operation = (operationName) => ({
    connectorOperation: { tableName: 'sample-connector', operationName, parameters: {} },
  });
  const echoed = await client.executeAsync(operation('Echo'));
  assert.equal(echoed.success, true);
  assert.deepEqual(echoed.data, { value: 'simulated' });
  const missing = await client.executeAsync(operation('Missing'));
  assert.equal(missing.success, false);
  assert.equal(missing.error.code, 'ConnectorNotSimulated');
  assert.equal(missing.error.status, 501);
});
