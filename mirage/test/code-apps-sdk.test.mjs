// @test-kind unproven: local model of the code-apps SDK executor and its partial clients; no native recording yet.
import {
  parityAssertions as __paqParityAssertions,
  assertParityBindings as __paqParityBindings,
} from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/code-apps-sdk.test.mjs:93:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'bff23d7332bac80f328f0d66fbf684368aff497464839d75b101676f2413014c',
    originalAssertions: [
      'ed8f150d4df6685811b8e63b483ab94d6870490147600364e91f39a319308d2b',
      '989cfea950dba92636840b7c0bc35c3633c504fe7dfa1399eed1007f2afdfa2b',
    ],
    originalBodyAstSha256: '3e5725a7a32fb9dc835956abaae24d9a292d380e98bca8d393f3e06b295a8c9b',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c76ff7f507b31d6fe3366fea09d08e5cdca4ee150b54c636520fe6a0c341cbaf',
    isolationRegistrationsAstSha256: '4ffeb7d9cf2250b1b73aa35ecce6681012880a82965f0b3a7d73ff4934164b65',
    importRoles: [
      {
        source: '../lib/code-apps-sdk.js',
        role: 'implementation-under-test',
        reviewedBy: 'root',
        reason: 'Paqvilo SDK adapter is the implementation exercised by the selected original result assertion.',
      },
    ],
    runtimeInputs: [],
    inputDependencies: [],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/code-apps-sdk.test.mjs:93:0',
          title: 'SDK metadata operation forwards its documented request to the local client',
        },
      ],
      casesSha256: '756d9a4f2e8067c35abe61765fd66b8bd155863cadfbec0a792012f017c11ec4',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/code-apps-sdk-metadata-official-next-v1.json',
        sha256: '4f5b1b20cbb6264bf25ff5b25b714df3a29f907335ee2ba687c6c73ecacfedfb',
        mode: 'official-package',
        capturePointers: ['/captures/0/receiptSha256', '/captures/1/receiptSha256'],
        package: {
          ecosystem: 'npm',
          id: '@microsoft/power-apps',
          version: '1.5.0',
          sha256: 'bd67d0e0235a5499c004f419d0da30a27d188a8bd4c47e535fb34d5d52c6efa2',
          source: 'https://registry.npmjs.org/@microsoft/power-apps/-/power-apps-1.5.0.tgz',
          integrity: 'sha512-aOJ6/eOfUm2xIqLbIPOQIeAbgjFWTQcFrdmnLQH5eCKQavth1dK8LRKn4s9uVtOE/Tay+Ijf0M1OJVcwChfO7A==',
          executedSourceClosure: [
            {
              path: 'dist/internal/data/core/common/types.js',
              sha256: '427f1c36e1f619e04b8ef2dfe5d2aa5b126b5951377a4619cf649ca886df8eff',
            },
            {
              path: 'dist/internal/data/core/common/utils.js',
              sha256: '56ff5e95f506715d3b54901de38cb0fd49e3c64ad452000af48c987209ebaea4',
            },
            {
              path: 'dist/internal/data/core/data/executors/connectorDataOperationExecutor.js',
              sha256: '303f5982723081c684027f863e7a350b0b7d8a20db24ead4ed385af5dcf7eff2',
            },
            {
              path: 'dist/internal/data/core/data/executors/dataverseDataOperationExecutor.js',
              sha256: '0264264e0d0dd3dd6265db3d4a384c3f57ad4a9cc831c2c3b79fb05e33810348',
            },
            {
              path: 'dist/internal/data/core/data/executors/shared/stringQueryOptions.js',
              sha256: '8a4038b8d1490920d1ef9bb045bc258140d86983908e4774b23d4548396d3f07',
            },
            {
              path: 'dist/internal/data/core/error/codes.js',
              sha256: '6792ffde4f208c369bdf01f9f34139de61e04dc311eaef4889f5916f10a101da',
            },
            {
              path: 'dist/internal/data/core/error/constants.js',
              sha256: 'd79a4dba4a5074c1857125006b39c2d598cd856d43cafbb227e94cc00e6d64d4',
            },
            {
              path: 'dist/internal/data/core/error/error.js',
              sha256: '62facb139cac70ba13fbab32b542a2f5be1e36b2309048b22e8e487b70e85a23',
            },
            {
              path: 'dist/internal/data/core/error/messages.js',
              sha256: '3ca4b51e635b234b78e25e14f8b5fbf276a6a79ca0a8b40d5c6555c9d367eecc',
            },
            {
              path: 'dist/internal/data/core/error/types.js',
              sha256: '08821c3f9761057540579af7c06c820bfac437d5dc4e83b560a4e23a35ce8a7d',
            },
            {
              path: 'dist/internal/data/core/error/util.js',
              sha256: '64284d491b095d591208dad524a712586853a0a88958f9da7c963e812214e959',
            },
            {
              path: 'dist/internal/data/core/telemetry/log.js',
              sha256: '364793b13106dac107b0e1f5c309518ef1e52650775194828bf475df7be2ee4d',
            },
            {
              path: 'dist/internal/data/core/types/index.js',
              sha256: '504a98a426bbf938b17672c318f35a329810ac28e044d56d08e98a17859f57ed',
            },
          ],
        },
        packagePointer: '/package',
        facts: [
          {
            id: 'metadata-result',
            pointer: '/captures/0/row',
            sha256: '0bef47874d74a9ffbc38c615779ca5c89d3d2910db5e918cac53df721333b3c8',
            replicatedPointers: ['/captures/0/row', '/captures/1/row'],
          },
        ],
      },
    ],
    regionHashes: [['ed8f150d4df6685811b8e63b483ab94d6870490147600364e91f39a319308d2b']],
    regionFactIds: [[['metadata-result']]],
  },
]);
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
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/code-apps-sdk.test.mjs:93:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'bff23d7332bac80f328f0d66fbf684368aff497464839d75b101676f2413014c',
        originalAssertions: [
          'ed8f150d4df6685811b8e63b483ab94d6870490147600364e91f39a319308d2b',
          '989cfea950dba92636840b7c0bc35c3633c504fe7dfa1399eed1007f2afdfa2b',
        ],
        originalBodyAstSha256: '3e5725a7a32fb9dc835956abaae24d9a292d380e98bca8d393f3e06b295a8c9b',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c76ff7f507b31d6fe3366fea09d08e5cdca4ee150b54c636520fe6a0c341cbaf',
        isolationRegistrationsAstSha256: '4ffeb7d9cf2250b1b73aa35ecce6681012880a82965f0b3a7d73ff4934164b65',
        importRoles: [
          {
            source: '../lib/code-apps-sdk.js',
            role: 'implementation-under-test',
            reviewedBy: 'root',
            reason: 'Paqvilo SDK adapter is the implementation exercised by the selected original result assertion.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/code-apps-sdk.test.mjs:93:0',
              title: 'SDK metadata operation forwards its documented request to the local client',
            },
          ],
          casesSha256: '756d9a4f2e8067c35abe61765fd66b8bd155863cadfbec0a792012f017c11ec4',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/code-apps-sdk-metadata-official-next-v1.json',
            sha256: '4f5b1b20cbb6264bf25ff5b25b714df3a29f907335ee2ba687c6c73ecacfedfb',
            mode: 'official-package',
            capturePointers: ['/captures/0/receiptSha256', '/captures/1/receiptSha256'],
            package: {
              ecosystem: 'npm',
              id: '@microsoft/power-apps',
              version: '1.5.0',
              sha256: 'bd67d0e0235a5499c004f419d0da30a27d188a8bd4c47e535fb34d5d52c6efa2',
              source: 'https://registry.npmjs.org/@microsoft/power-apps/-/power-apps-1.5.0.tgz',
              integrity:
                'sha512-aOJ6/eOfUm2xIqLbIPOQIeAbgjFWTQcFrdmnLQH5eCKQavth1dK8LRKn4s9uVtOE/Tay+Ijf0M1OJVcwChfO7A==',
              executedSourceClosure: [
                {
                  path: 'dist/internal/data/core/common/types.js',
                  sha256: '427f1c36e1f619e04b8ef2dfe5d2aa5b126b5951377a4619cf649ca886df8eff',
                },
                {
                  path: 'dist/internal/data/core/common/utils.js',
                  sha256: '56ff5e95f506715d3b54901de38cb0fd49e3c64ad452000af48c987209ebaea4',
                },
                {
                  path: 'dist/internal/data/core/data/executors/connectorDataOperationExecutor.js',
                  sha256: '303f5982723081c684027f863e7a350b0b7d8a20db24ead4ed385af5dcf7eff2',
                },
                {
                  path: 'dist/internal/data/core/data/executors/dataverseDataOperationExecutor.js',
                  sha256: '0264264e0d0dd3dd6265db3d4a384c3f57ad4a9cc831c2c3b79fb05e33810348',
                },
                {
                  path: 'dist/internal/data/core/data/executors/shared/stringQueryOptions.js',
                  sha256: '8a4038b8d1490920d1ef9bb045bc258140d86983908e4774b23d4548396d3f07',
                },
                {
                  path: 'dist/internal/data/core/error/codes.js',
                  sha256: '6792ffde4f208c369bdf01f9f34139de61e04dc311eaef4889f5916f10a101da',
                },
                {
                  path: 'dist/internal/data/core/error/constants.js',
                  sha256: 'd79a4dba4a5074c1857125006b39c2d598cd856d43cafbb227e94cc00e6d64d4',
                },
                {
                  path: 'dist/internal/data/core/error/error.js',
                  sha256: '62facb139cac70ba13fbab32b542a2f5be1e36b2309048b22e8e487b70e85a23',
                },
                {
                  path: 'dist/internal/data/core/error/messages.js',
                  sha256: '3ca4b51e635b234b78e25e14f8b5fbf276a6a79ca0a8b40d5c6555c9d367eecc',
                },
                {
                  path: 'dist/internal/data/core/error/types.js',
                  sha256: '08821c3f9761057540579af7c06c820bfac437d5dc4e83b560a4e23a35ce8a7d',
                },
                {
                  path: 'dist/internal/data/core/error/util.js',
                  sha256: '64284d491b095d591208dad524a712586853a0a88958f9da7c963e812214e959',
                },
                {
                  path: 'dist/internal/data/core/telemetry/log.js',
                  sha256: '364793b13106dac107b0e1f5c309518ef1e52650775194828bf475df7be2ee4d',
                },
                {
                  path: 'dist/internal/data/core/types/index.js',
                  sha256: '504a98a426bbf938b17672c318f35a329810ac28e044d56d08e98a17859f57ed',
                },
              ],
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'metadata-result',
                pointer: '/captures/0/row',
                sha256: '0bef47874d74a9ffbc38c615779ca5c89d3d2910db5e918cac53df721333b3c8',
                replicatedPointers: ['/captures/0/row', '/captures/1/row'],
              },
            ],
          },
        ],
        regionHashes: [['ed8f150d4df6685811b8e63b483ab94d6870490147600364e91f39a319308d2b']],
        regionFactIds: [[['metadata-result']]],
      },
    ]);
    assert.deepEqual(
      await executor.executeAsync({
        dataverseRequest: { action: 'getEntityMetadata', parameters: { tableName: 'x_item', options } },
      }),
      { success: true, data: { LogicalName: 'x_item' } },
    );
  }
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

// @test-kind contract: an explicitly empty Paqvilo adapter reports its own NotSimulated/501 boundary for four absent methods; this makes no native SDK feature-support claim.
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

// @test-kind tooling: verifies the public SDK declaration compiles for a strict consumer.
test('SDK declaration accepts a strict TypeScript consumer with a partial client', () => {
  const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/code-apps-sdk-consumer.mts', import.meta.url));
  assert.doesNotThrow(() =>
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
    ),
  );
});
