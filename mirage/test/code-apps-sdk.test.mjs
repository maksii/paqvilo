import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeAppSdkExecutor } from '../lib/code-apps-sdk.js';

test('SDK executor maps source names, forwards options, and preserves pagination', async () => {
  const calls = [];
  const client = Object.fromEntries(
    ['create', 'get', 'getAll', 'update', 'delete'].map((method) => [
      method,
      async (...args) => {
        calls.push([method, ...args]);
        return {
          data: method === 'getAll' ? [{ id: 1 }] : { id: 1 },
          ...(method === 'getAll' ? { skipToken: 'next', count: 2 } : {}),
        };
      },
    ]),
  );
  const executor = createCodeAppSdkExecutor({ client, entitySets: { logical: 'inventeds' } });
  const options = { select: ['name'], top: 2, count: true };
  assert.deepEqual(await executor.retrieveMultipleRecordsAsync('logical', options), {
    success: true,
    data: [{ id: 1 }],
    skipToken: 'next',
    count: 2,
  });
  await executor.createRecordAsync('logical', { name: 'A' });
  await executor.retrieveRecordAsync('logical', 'id', options);
  await executor.updateRecordAsync('logical', 'id', { name: 'B' });
  await executor.deleteRecordAsync('logical', 'id');
  assert.deepEqual(calls, [
    ['getAll', 'inventeds', options],
    ['create', 'inventeds', { name: 'A' }],
    ['get', 'inventeds', 'id', options],
    ['update', 'inventeds', 'id', { name: 'B' }],
    ['delete', 'inventeds', 'id'],
  ]);
});

test('SDK executor reports failures and unsupported operations without invoking client', async () => {
  const error = Object.assign(new Error('denied'), { status: 403 });
  const executor = createCodeAppSdkExecutor({
    client: {
      create: async () => {
        throw error;
      },
      update: () => assert.fail(),
      execute: () => assert.fail(),
    },
  });
  assert.deepEqual(await executor.createRecordAsync('x', {}), { success: false, data: undefined, error });
  for (const answer of [
    await executor.updateRecordAsync('x', 'id', {}, 'partition'),
    await executor.retrieveRecordAsync('x', 'id', { partitionId: 'partition' }),
    await executor.retrieveMultipleRecordsAsync('x', { partitionId: 'partition' }),
    await executor.uploadFileToRecord(),
    await executor.downloadFileFromRecord(),
    await executor.downloadImageFromRecord(),
    await executor.deleteFileOrImageFromRecord(),
    await executor.executeAsync({ dataverseRequest: {} }),
  ]) {
    assert.equal(answer.success, false);
    assert.equal(answer.error.status, 501);
  }
});

test('SDK connector operation maps only explicit shape and rejects failing provider status', async () => {
  const calls = [];
  const executor = createCodeAppSdkExecutor({
    client: {
      execute: async (...args) => {
        calls.push(args);
        return { data: { statusCode: 201, body: { value: 7 } } };
      },
    },
  });
  assert.deepEqual(
    await executor.executeAsync({
      connectorOperation: { tableName: 'ref', operationName: 'Echo', parameters: { x: 1 } },
    }),
    { success: true, data: { value: 7 } },
  );
  assert.deepEqual(calls, [['ref', 'Echo', { x: 1 }]]);
  const failed = createCodeAppSdkExecutor({ client: { execute: async () => ({ data: { statusCode: 503 } }) } });
  assert.equal(
    (await failed.executeAsync({ connectorOperation: { tableName: 'ref', operationName: 'Echo' } })).error.status,
    503,
  );
});
