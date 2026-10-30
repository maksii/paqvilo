import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    await executor.uploadFileToRecord('x', 'id', 'file', 'name', new Uint8Array(), 'partition'),
    await executor.downloadFileFromRecord('x', 'id', 'file', 'partition'),
    await executor.deleteFileOrImageFromRecord('x', 'id', 'file', 'partition'),
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

test('SDK metadata operation forwards its documented request to the local client', async () => {
  const calls = [];
  const executor = createCodeAppSdkExecutor({
    client: {
      getEntityMetadata: async (...args) => {
        calls.push(args);
        return { data: { LogicalName: 'x_item' } };
      },
    },
  });
  const options = { metadata: ['LogicalName'], schema: { columns: ['x_name'] } };
  assert.deepEqual(
    await executor.executeAsync({
      dataverseRequest: { action: 'getEntityMetadata', parameters: { tableName: 'x_item', options } },
    }),
    { success: true, data: { LogicalName: 'x_item' } },
  );
  assert.deepEqual(calls, [['x_item', options]]);
});

test('SDK file operations forward mapped entity and preserve download bytes and filename', async () => {
  const calls = [];
  const bytes = new Uint8Array([0, 255, 17]);
  const executor = createCodeAppSdkExecutor({
    entitySets: { logical: 'inventeds' },
    client: {
      uploadFile: async (...args) => {
        calls.push(['upload', ...args]);
        return { data: undefined };
      },
      downloadFile: async (...args) => {
        calls.push(['download', ...args]);
        return { data: bytes, fileName: 'sample.bin' };
      },
      deleteFile: async (...args) => {
        calls.push(['delete', ...args]);
        return { data: undefined };
      },
    },
  });
  assert.equal((await executor.uploadFileToRecord('logical', 'id', 'x_file', 'sample.bin', bytes)).success, true);
  assert.deepEqual(await executor.downloadFileFromRecord('logical', 'id', 'x_file'), {
    success: true,
    data: bytes,
    fileName: 'sample.bin',
  });
  assert.equal((await executor.downloadImageFromRecord('logical', 'id', 'x_image', true)).success, true);
  assert.equal((await executor.deleteFileOrImageFromRecord('logical', 'id', 'x_file')).success, true);
  assert.deepEqual(calls, [
    ['upload', 'inventeds', 'id', 'x_file', 'sample.bin', bytes],
    ['download', 'inventeds', 'id', 'x_file'],
    ['download', 'inventeds', 'id', 'x_image', true],
    ['delete', 'inventeds', 'id', 'x_file'],
  ]);
});

test('partial SDK clients fail unimplemented features with explicit NotSimulated', async () => {
  const executor = createCodeAppSdkExecutor({ client: {} });
  for (const answer of [
    await executor.createRecordAsync('x', {}),
    await executor.retrieveMultipleRecordsAsync('x'),
    await executor.executeAsync({ dataverseRequest: { action: 'getEntityMetadata', parameters: { tableName: 'x' } } }),
    await executor.downloadFileFromRecord('x', 'id', 'file'),
  ]) {
    assert.equal(answer.success, false);
    assert.equal(answer.error.code, 'NotSimulated');
    assert.equal(answer.error.status, 501);
  }
});

test('SDK declaration accepts a strict TypeScript consumer with a partial client', () => {
  const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/code-apps-sdk-consumer.mts', import.meta.url));
  execFileSync(
    process.execPath,
    [
      compiler,
      '--strict',
      '--noEmit',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--target',
      'es2022',
      fixture,
    ],
    { stdio: 'pipe' },
  );
});
