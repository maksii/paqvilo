// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.
// @test-kind unproven: SDK query/result and metadata semantics below still need exact official/native proof; local safety and adapter policies are tagged separately.
import {
  parityAssertions as __paqParityAssertions,
  assertParityBindings as __paqParityBindings,
} from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/code-apps-client.test.mjs:55:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '623f8e67583f51cfb2500b563faf8b532505559f4e83069de8b3140ec02132a0',
    originalAssertions: [
      '350fec7cd9feb07900c68033e8597033bca91f20f4795f7cb2f43a013e134990',
      '38748d2972f60fd6c4c102f1fc863e318c9459a0ce693cefa272bedf23e95688',
      '2694e0f29ddfc5c94d4f6a0269e58b22fe6249a4560f8ad620509582eebdcd51',
      '7131720caa4d64a3b18361295d4a8572b1a9a628d0e0efd2c794ceda085cf9b4',
      '8d6aacdeb652446c2b22b8306b7ce521923352a17444325539dcdbc275a636ea',
      'e9d300a077f383da0b60013b0014b55633b776d4acad9aa0ae766e18602ecb1d',
      'bb4e8d636447d0c768c16d05320272ac681c10a7248264c52dc2dcd5d70118de',
      'fbe2aa5afa2033b71593fe9a88de2c886aab89018d9bcf864aaaa4ae987b708d',
    ],
    originalBodyAstSha256: 'ae9583d0b25501cc396dc02732d1347cc9b0b6d8fa4032e2d8f4232fa6655209',
    originalGuardHashes: [],
    moduleContextAstSha256: 'be7657da77cf3e5e3a172c0f0c9ebcd86715df602df6c2c2a194dddeb2a665bc',
    importRoles: [
      {
        source: '../lib/code-apps-client.js',
        role: 'implementation-under-test',
        reviewedBy: 'platform-worker2',
        reason:
          'Paqvilo Code Apps data client is the implementation whose original query assertions are being qualified; implementation evolution is exercised by those retained assertions, not pinned as test input.',
      },
    ],
    runtimeInputs: [
      {
        kind: 'network',
        role: 'source-derived',
        baselineId: 'mirage/test/code-apps-client.test.mjs:55:0',
        producerAstSha256: 'e09235e3da76870a4d521cbbfefaaa5fb2bc44e071f24023fdfedfa5082b9a64',
        reviewedBy: 'platform-worker2',
        reason:
          'All original network calls use locally authored globalThis.fetch replacements with fixed synthetic responses and restored test hooks. The selected query producer is bound to its exact source closure; no real network response provides original test inputs.',
      },
    ],
    inputDependencies: [],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/code-apps-client.test.mjs:55:0',
          title: 'client sends context token and documented query options with paging',
        },
      ],
      casesSha256: '8b6e98aca0dd2e4634d5372e11c95f5891ffa7ee405f29a52d7f9cba72a972b5',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/code-apps-sdk-operation-official.json',
        sha256: 'ac5b909282301d2d3221ab709520327d8f951bed29b3ec83db1064f3eb6b0c22',
        mode: 'official-package',
        capturePointers: ['/captures/0/sha256', '/captures/1/sha256'],
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
        packagePointer: '/qualificationPackage',
        facts: [
          {
            id: 'query',
            pointer: '/captures/0/rows/0',
            sha256: '49e25fbce8feb2bdce23785b09659fadbfa97fd92d25fee989cbcbb0cf4ae25d',
            replicatedPointers: ['/captures/0/rows/0', '/captures/1/rows/0'],
          },
          {
            id: 'page',
            pointer: '/captures/0/rows/1',
            sha256: '6ea925c7f1e03a6e00688c2853c01e86e0eae535498eaf051d9cc52957d362a2',
            replicatedPointers: ['/captures/0/rows/1', '/captures/1/rows/1'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        '38748d2972f60fd6c4c102f1fc863e318c9459a0ce693cefa272bedf23e95688',
        '2694e0f29ddfc5c94d4f6a0269e58b22fe6249a4560f8ad620509582eebdcd51',
        '7131720caa4d64a3b18361295d4a8572b1a9a628d0e0efd2c794ceda085cf9b4',
        '8d6aacdeb652446c2b22b8306b7ce521923352a17444325539dcdbc275a636ea',
        'e9d300a077f383da0b60013b0014b55633b776d4acad9aa0ae766e18602ecb1d',
      ],
      ['fbe2aa5afa2033b71593fe9a88de2c886aab89018d9bcf864aaaa4ae987b708d'],
    ],
    regionFactIds: [[['query'], ['query'], ['query'], ['query'], ['query']], [['page']]],
  },
]);

import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, dataClient, getStatus } from '../lib/code-apps-client.js';

// @test-kind security: Paqvilo debug telemetry masks an invented unclosed connector key without retaining its secret suffix or unbounded length.
test('debug events mask long unclosed keys from connector operation paths', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const events = [];
  globalThis.fetch = async (url) =>
    url.endsWith('/context') ? new Response('{}', { headers: { 'x-sim-csrf': 'local-token' } }) : new Response('{}');
  configure({ app: 'sample', onEvent: (event) => events.push(event) });
  await dataClient.execute('reference', '('.repeat(20000) + 'private-unclosed-key', {});
  const path = events.at(-1).path;
  assert.equal(path.length, '/_apps/code/sample/connectors/reference/(...)'.length);
  assert.equal(path, '/_apps/code/sample/connectors/reference/(...)');
});

// @test-kind security: local diagnostic events omit fixture payloads/query values and isolate Paqvilo per-load session headers, including observer failures.
test('debug events omit payloads and query values, preserve failures and isolate per-load sessions', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const events = [],
    requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/status')) return new Response('{}');
    if (url.endsWith('/context')) return new Response('{}', { headers: { 'x-sim-csrf': 'private-token' } });
    if (init.method === 'PATCH') return new Response('{"error":{"message":"private-message"}}', { status: 403 });
    return new Response('{"value":[]}');
  };
  configure({ app: 'first', onEvent: (event) => events.push(event) });
  await getStatus();
  assert.equal(requests.length, 1, 'public diagnostics do not require a context request');
  await dataClient.getAll('x_items', { filter: "x_name eq 'private-filter'" });
  await assert.rejects(dataClient.update('x_items', 'private-record', { x_name: 'private-body' }), /private-message/);
  assert.equal(events.at(-1).kind, 'request-error');
  assert.equal(events.at(-1).status, 403);
  assert.equal(events.at(-1).path, '/_apps/code/first/dataverse/x_items(...)');
  assert.doesNotMatch(JSON.stringify(events), /private-/);
  const session = requests[0].init.headers['x-paqvilo-code-app-session'];
  assert.ok(requests.every((r) => r.init.headers['x-paqvilo-code-app-session'] === session));
  configure({
    app: 'second',
    onEvent: () => {
      throw new Error('observer failure');
    },
  });
  await getStatus();
  assert.notEqual(requests.at(-1).init.headers['x-paqvilo-code-app-session'], session);
});

test('client sends context token and documented query options with paging', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/context')) return new Response('{}', { headers: { 'x-sim-csrf': 'local-token' } });
    return new Response(
      JSON.stringify({ value: [{ name: 'A' }], '@odata.count': 3, '@odata.nextLink': '/_api/items?$skiptoken=next' }),
    );
  };
  configure({ app: 'sample' });
  const result = await dataClient.getAll('items', {
    select: ['name'],
    filter: "name eq 'A'",
    orderBy: ['name desc'],
    top: 2,
    maxPageSize: 1,
    count: true,
  });
  assert.deepEqual(result, { data: [{ name: 'A' }], count: 3, skipToken: 'next' });
  const params = new URL(calls[1].url, 'http://localhost').searchParams;

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/code-apps-client.test.mjs:55:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '623f8e67583f51cfb2500b563faf8b532505559f4e83069de8b3140ec02132a0',
        originalAssertions: [
          '350fec7cd9feb07900c68033e8597033bca91f20f4795f7cb2f43a013e134990',
          '38748d2972f60fd6c4c102f1fc863e318c9459a0ce693cefa272bedf23e95688',
          '2694e0f29ddfc5c94d4f6a0269e58b22fe6249a4560f8ad620509582eebdcd51',
          '7131720caa4d64a3b18361295d4a8572b1a9a628d0e0efd2c794ceda085cf9b4',
          '8d6aacdeb652446c2b22b8306b7ce521923352a17444325539dcdbc275a636ea',
          'e9d300a077f383da0b60013b0014b55633b776d4acad9aa0ae766e18602ecb1d',
          'bb4e8d636447d0c768c16d05320272ac681c10a7248264c52dc2dcd5d70118de',
          'fbe2aa5afa2033b71593fe9a88de2c886aab89018d9bcf864aaaa4ae987b708d',
        ],
        originalBodyAstSha256: 'ae9583d0b25501cc396dc02732d1347cc9b0b6d8fa4032e2d8f4232fa6655209',
        originalGuardHashes: [],
        moduleContextAstSha256: 'be7657da77cf3e5e3a172c0f0c9ebcd86715df602df6c2c2a194dddeb2a665bc',
        importRoles: [
          {
            source: '../lib/code-apps-client.js',
            role: 'implementation-under-test',
            reviewedBy: 'platform-worker2',
            reason:
              'Paqvilo Code Apps data client is the implementation whose original query assertions are being qualified; implementation evolution is exercised by those retained assertions, not pinned as test input.',
          },
        ],
        runtimeInputs: [
          {
            kind: 'network',
            role: 'source-derived',
            baselineId: 'mirage/test/code-apps-client.test.mjs:55:0',
            producerAstSha256: 'e09235e3da76870a4d521cbbfefaaa5fb2bc44e071f24023fdfedfa5082b9a64',
            reviewedBy: 'platform-worker2',
            reason:
              'All original network calls use locally authored globalThis.fetch replacements with fixed synthetic responses and restored test hooks. The selected query producer is bound to its exact source closure; no real network response provides original test inputs.',
          },
        ],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/code-apps-client.test.mjs:55:0',
              title: 'client sends context token and documented query options with paging',
            },
          ],
          casesSha256: '8b6e98aca0dd2e4634d5372e11c95f5891ffa7ee405f29a52d7f9cba72a972b5',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/code-apps-sdk-operation-official.json',
            sha256: 'ac5b909282301d2d3221ab709520327d8f951bed29b3ec83db1064f3eb6b0c22',
            mode: 'official-package',
            capturePointers: ['/captures/0/sha256', '/captures/1/sha256'],
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
            packagePointer: '/qualificationPackage',
            facts: [
              {
                id: 'query',
                pointer: '/captures/0/rows/0',
                sha256: '49e25fbce8feb2bdce23785b09659fadbfa97fd92d25fee989cbcbb0cf4ae25d',
                replicatedPointers: ['/captures/0/rows/0', '/captures/1/rows/0'],
              },
              {
                id: 'page',
                pointer: '/captures/0/rows/1',
                sha256: '6ea925c7f1e03a6e00688c2853c01e86e0eae535498eaf051d9cc52957d362a2',
                replicatedPointers: ['/captures/0/rows/1', '/captures/1/rows/1'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '38748d2972f60fd6c4c102f1fc863e318c9459a0ce693cefa272bedf23e95688',
            '2694e0f29ddfc5c94d4f6a0269e58b22fe6249a4560f8ad620509582eebdcd51',
            '7131720caa4d64a3b18361295d4a8572b1a9a628d0e0efd2c794ceda085cf9b4',
            '8d6aacdeb652446c2b22b8306b7ce521923352a17444325539dcdbc275a636ea',
            'e9d300a077f383da0b60013b0014b55633b776d4acad9aa0ae766e18602ecb1d',
          ],
          ['fbe2aa5afa2033b71593fe9a88de2c886aab89018d9bcf864aaaa4ae987b708d'],
        ],
        regionFactIds: [[['query'], ['query'], ['query'], ['query'], ['query']], [['page']]],
      },
    ]);
    assert.equal(params.get('$filter'), "name eq 'A'");
    assert.equal(params.get('$orderby'), 'name desc');
    assert.equal(params.get('$top'), '2');
    assert.equal(params.get('$count'), 'true');
    assert.match(calls[1].init.headers.prefer, /odata.maxpagesize=1/);
  }

  assert.equal(calls[1].init.headers['x-sim-csrf'], 'local-token');
  await dataClient.getAll('items', { skipToken: result.skipToken });

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/code-apps-client.test.mjs:55:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '623f8e67583f51cfb2500b563faf8b532505559f4e83069de8b3140ec02132a0',
        originalAssertions: [
          '350fec7cd9feb07900c68033e8597033bca91f20f4795f7cb2f43a013e134990',
          '38748d2972f60fd6c4c102f1fc863e318c9459a0ce693cefa272bedf23e95688',
          '2694e0f29ddfc5c94d4f6a0269e58b22fe6249a4560f8ad620509582eebdcd51',
          '7131720caa4d64a3b18361295d4a8572b1a9a628d0e0efd2c794ceda085cf9b4',
          '8d6aacdeb652446c2b22b8306b7ce521923352a17444325539dcdbc275a636ea',
          'e9d300a077f383da0b60013b0014b55633b776d4acad9aa0ae766e18602ecb1d',
          'bb4e8d636447d0c768c16d05320272ac681c10a7248264c52dc2dcd5d70118de',
          'fbe2aa5afa2033b71593fe9a88de2c886aab89018d9bcf864aaaa4ae987b708d',
        ],
        originalBodyAstSha256: 'ae9583d0b25501cc396dc02732d1347cc9b0b6d8fa4032e2d8f4232fa6655209',
        originalGuardHashes: [],
        moduleContextAstSha256: 'be7657da77cf3e5e3a172c0f0c9ebcd86715df602df6c2c2a194dddeb2a665bc',
        importRoles: [
          {
            source: '../lib/code-apps-client.js',
            role: 'implementation-under-test',
            reviewedBy: 'platform-worker2',
            reason:
              'Paqvilo Code Apps data client is the implementation whose original query assertions are being qualified; implementation evolution is exercised by those retained assertions, not pinned as test input.',
          },
        ],
        runtimeInputs: [
          {
            kind: 'network',
            role: 'source-derived',
            baselineId: 'mirage/test/code-apps-client.test.mjs:55:0',
            producerAstSha256: 'e09235e3da76870a4d521cbbfefaaa5fb2bc44e071f24023fdfedfa5082b9a64',
            reviewedBy: 'platform-worker2',
            reason:
              'All original network calls use locally authored globalThis.fetch replacements with fixed synthetic responses and restored test hooks. The selected query producer is bound to its exact source closure; no real network response provides original test inputs.',
          },
        ],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/code-apps-client.test.mjs:55:0',
              title: 'client sends context token and documented query options with paging',
            },
          ],
          casesSha256: '8b6e98aca0dd2e4634d5372e11c95f5891ffa7ee405f29a52d7f9cba72a972b5',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/code-apps-sdk-operation-official.json',
            sha256: 'ac5b909282301d2d3221ab709520327d8f951bed29b3ec83db1064f3eb6b0c22',
            mode: 'official-package',
            capturePointers: ['/captures/0/sha256', '/captures/1/sha256'],
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
            packagePointer: '/qualificationPackage',
            facts: [
              {
                id: 'query',
                pointer: '/captures/0/rows/0',
                sha256: '49e25fbce8feb2bdce23785b09659fadbfa97fd92d25fee989cbcbb0cf4ae25d',
                replicatedPointers: ['/captures/0/rows/0', '/captures/1/rows/0'],
              },
              {
                id: 'page',
                pointer: '/captures/0/rows/1',
                sha256: '6ea925c7f1e03a6e00688c2853c01e86e0eae535498eaf051d9cc52957d362a2',
                replicatedPointers: ['/captures/0/rows/1', '/captures/1/rows/1'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '38748d2972f60fd6c4c102f1fc863e318c9459a0ce693cefa272bedf23e95688',
            '2694e0f29ddfc5c94d4f6a0269e58b22fe6249a4560f8ad620509582eebdcd51',
            '7131720caa4d64a3b18361295d4a8572b1a9a628d0e0efd2c794ceda085cf9b4',
            '8d6aacdeb652446c2b22b8306b7ce521923352a17444325539dcdbc275a636ea',
            'e9d300a077f383da0b60013b0014b55633b776d4acad9aa0ae766e18602ecb1d',
          ],
          ['fbe2aa5afa2033b71593fe9a88de2c886aab89018d9bcf864aaaa4ae987b708d'],
        ],
        regionFactIds: [[['query'], ['query'], ['query'], ['query'], ['query']], [['page']]],
      },
    ]);
    assert.equal(new URL(calls[2].url, 'http://localhost').searchParams.get('$skiptoken'), 'next');
  }
});

// @test-kind contract: the bounded Paqvilo client deliberately refuses its unsupported skip/expand options and malformed paging/count input instead of issuing an altered request.
test('unsupported options fail instead of silently changing the query', async () => {
  configure({ app: 'sample' });
  await assert.rejects(dataClient.getAll('items', { skip: 1 }), /does not support skip/);
  await assert.rejects(dataClient.getAll('items', { expand: 'owner' }), /Unsupported Mirage query option: expand/);
  await assert.rejects(dataClient.getAll('items', { maxPageSize: 0 }), /positive integer/);
  await assert.rejects(dataClient.getAll('items', { count: 'yes' }), /count must be a boolean/);
});

// @test-kind contract: the local fetch adapter preserves an invented HTTP 502/statusText when its response body cannot supply a JSON error envelope.
test('HTTP errors preserve status even when the response is not JSON', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url) =>
    url.endsWith('/context')
      ? new Response('{}', { headers: { 'x-sim-csrf': 'token' } })
      : new Response('<html>failure</html>', { status: 502, statusText: 'Bad Gateway' });
  configure({ app: 'sample' });
  await assert.rejects(dataClient.getAll('items'), (error) => error.status === 502 && error.message === 'Bad Gateway');
});

// @test-kind security: Paqvilo browser configuration requires an app name and confines its target to the active origin before any native-host guarantee is considered.
test('configuration rejects missing app names and cross-origin browser targets', (t) => {
  const original = globalThis.location;
  t.after(() => {
    if (original === undefined) delete globalThis.location;
    else globalThis.location = original;
  });
  globalThis.location = { href: 'http://localhost:3000/app', origin: 'http://localhost:3000', search: '' };
  assert.throws(() => configure({ app: '' }), /non-empty app name/);
  assert.throws(() => configure({ app: 'sample', origin: 'https://example.invalid' }), /current origin/);
  assert.doesNotThrow(() => configure({ app: 'sample', origin: 'http://localhost:3000' }));
});

// @test-kind security: a controlled local reconfiguration gate prevents an old app context token from authorizing a request for the newly configured app.
test('reconfiguration while context is in flight never reuses the previous app token', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const requests = [];
  let release;
  let started;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const arrived = new Promise((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url === '/_apps/code/first/context') {
      started();
      await pending;
      return new Response('{}', { headers: { 'x-sim-csrf': 'first-token' } });
    }
    if (url === '/_apps/code/second/context') return new Response('{}', { headers: { 'x-sim-csrf': 'second-token' } });
    return new Response('{"value":[]}');
  };
  configure({ app: 'first' });
  const oldRequest = dataClient.getAll('items');
  await arrived;
  configure({ app: 'second' });
  release();
  await assert.rejects(oldRequest, /configuration changed/);
  await dataClient.getAll('items');
  assert.deepEqual(
    requests.map((request) => request.url),
    ['/_apps/code/first/context', '/_apps/code/second/context', '/_apps/code/second/dataverse/items'],
  );
  assert.equal(requests[2].init.headers['x-sim-csrf'], 'second-token');
});

test('optional SDK query fields set to undefined do not reject a valid read', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url) =>
    url.endsWith('/context')
      ? new Response('{}', { headers: { 'x-sim-csrf': 'token' } })
      : new Response('{"value":[]}');
  configure({ app: 'sample' });
  assert.deepEqual(await dataClient.getAll('items', { partitionId: undefined, skip: undefined }), { data: [] });
});

// @test-kind security: a controlled local fetch gate rejects stale app data after Paqvilo configuration changes rather than exposing it through the new app session.
test('reconfiguration rejects an old app data response already in flight', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let release, started;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const arrived = new Promise((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async (url) => {
    if (url.endsWith('/context')) return new Response('{}', { headers: { 'x-sim-csrf': 'token' } });
    started();
    await pending;
    return new Response('{"value":[{"name":"old app"}]}');
  };
  configure({ app: 'first' });
  const oldRequest = dataClient.getAll('items');
  await arrived;
  configure({ app: 'second' });
  release();
  await assert.rejects(oldRequest, /configuration changed/);
});

// @test-kind security: invalid entity identifiers cannot escape the local Dataverse proxy path or trigger any fetch call.
test('entity set names cannot escape the Dataverse proxy path', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = () => assert.fail('invalid entity set must not issue a request');
  configure({ app: 'sample' });
  for (const name of ['../context', 'items?x=1', 'items/other', ''])
    await assert.rejects(dataClient.getAll(name), /Entity set must be a Dataverse identifier/);
});

// @test-kind security: local origins reject credentials, paths, query, fragment and non-HTTP schemes before fetch; an accepted loopback origin retains its canonical base.
test('explicit origins are canonicalized and invalid origin prefixes are rejected before fetch', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  });
  globalThis.location = { href: 'http://localhost:3000/app', origin: 'http://localhost:3000', search: '' };
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return url.endsWith('/context')
      ? new Response('{}', { headers: { 'x-sim-csrf': 'token' } })
      : new Response('{"value":[]}');
  };
  configure({ app: 'sample', origin: 'http://localhost:3000/' });
  await dataClient.getAll('items');
  assert.deepEqual(urls, [
    'http://localhost:3000/_apps/code/sample/context',
    'http://localhost:3000/_apps/code/sample/dataverse/items',
  ]);
  for (const origin of [
    null,
    1,
    'http://localhost:3000/path',
    'http://localhost:3000/?q=1',
    'http://localhost:3000/#x',
    'http://user:pass@localhost:3000/',
    'ftp://localhost/',
  ])
    assert.throws(() => configure({ app: 'sample', origin }), /Origin must be/);
  assert.equal(urls.length, 2);
});

test('metadata requests select local entity metadata and filter requested columns', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.endsWith('/context')) return new Response('{}', { headers: { 'x-sim-csrf': 'token' } });
    return new Response(
      JSON.stringify({ LogicalName: 'x_item', Attributes: [{ LogicalName: 'x_a' }, { LogicalName: 'x_b' }] }),
    );
  };
  configure({ app: 'sample' });
  const result = await dataClient.getEntityMetadata('x_item', {
    metadata: ['LogicalName'],
    schema: { columns: ['x_b'], oneToMany: true },
  });
  assert.deepEqual(result.data.Attributes, [{ LogicalName: 'x_b' }]);
  const url = new URL(urls[1], 'http://localhost');
  assert.equal(url.pathname, "/_apps/code/sample/dataverse/EntityDefinitions(LogicalName='x_item')");
  assert.equal(url.searchParams.get('$select'), 'LogicalName');
  assert.equal(url.searchParams.get('$expand'), 'Attributes,OneToManyRelationships');
  await assert.rejects(dataClient.getEntityMetadata('x_item', { schema: { columns: ['bad/name'] } }), /identifiers/);
});
