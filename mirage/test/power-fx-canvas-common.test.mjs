// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.
// @test-kind unproven: Every unselected original assertion remains explicitly unproven; only the separately protected exact official matches below receive parity.
import { parityAssertions as __paqParityAssertions } from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:6:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '53e39ff0651c835f353253ac16c255582964c6fda22b13a8663d7293e80bdcae',
    originalAssertions: [
      'b9c710e70b325e65fdbe4b5297487e5b07e1eaa61e9729d336a096ae347e959e',
      '83803425215b05038f797b950cc83dbe20db32844eeed2fb86e100971086157d',
      'c1dc64e268d90d9b65b4706d609269330eafba6e858babe9067ffb8ff53ba94d',
      'e7194f00d814cd42b78688c3ae75e0dfa8eed9aed4690242a41ba7c596ca0c6c',
      'd98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0',
      '886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0',
      '9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da',
      '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
      '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
    ],
    originalBodyAstSha256: 'f1270cd8f2543663e8ea4821272e9503ebb0afe94595ab53552a742199e5fbd7',
    originalGuardHashes: [],
    moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
    moduleReview: {
      reviewedBy: 'canvas_official',
      reason:
        'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
      corrections: [
        {
          baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
          oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
          currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
          sameGuarantee: true,
          guaranteeId: 'official-20261109-partial-0',
          factIds: ['rand-invalid-kind-24'],
          reviewedBy: 'canvas_official',
          reason:
            'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
        },
      ],
      addedTests: [],
    },
    importRoles: [
      {
        source: '../lib/power-fx.mjs',
        role: 'implementation-under-test',
        reviewedBy: 'canvas_official',
        reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
      },
    ],
    runtimeInputs: [],
    inputDependencies: [],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: ['Canvas color approximation follows native channel and fade results'],
      casesSha256: '9aa69d233c3e7b90d213b08c14a8dc8f9092a33e28c617449942a309f4f4b0ed',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
        sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
        mode: 'official-package',
        capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
        package: {
          id: 'Microsoft.PowerFx.Interpreter',
          version: '1.99.0.0',
          versionKind: 'assembly',
          sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
          artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
          source: 'https://github.com/microsoft/Power-Fx',
        },
        packagePointer: '/package',
        facts: [
          {
            id: 'assert-35d7c9d174415e6f80c5',
            pointer: '/runs/0/results/38',
            sha256: '18a316c126fbfeb39e21f84803fce73339ba502c3b3013ce0750abd73adab365',
            replicatedPointers: ['/runs/0/results/38', '/runs/1/results/38'],
          },
          {
            id: 'assert-0e27dccf42d5a7bc6182',
            pointer: '/runs/0/results/39',
            sha256: 'af64ba2cd53f3dfcae9ee73295e66c00005f2d49f75a07fe4c351f2b108aebf4',
            replicatedPointers: ['/runs/0/results/39', '/runs/1/results/39'],
          },
          {
            id: 'assert-bcf36d84cea0209e39b2',
            pointer: '/runs/0/results/40',
            sha256: '1a2425e69cbdd0316c09b8199a5fb919e199b8c7a22afd4d14ca2c1484c5cd7f',
            replicatedPointers: ['/runs/0/results/40', '/runs/1/results/40'],
          },
          {
            id: 'assert-2899fea03402a0ac8fda',
            pointer: '/runs/0/results/41',
            sha256: 'f998c47778da08d38105ff87dd47f9c1529925a7293436a12a188a42b61c3e28',
            replicatedPointers: ['/runs/0/results/41', '/runs/1/results/41'],
          },
          {
            id: 'rand-invalid-kind-24',
            pointer: '/runs/0/results/50',
            sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
            replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
          },
        ],
      },
    ],
    regionHashes: [
      ['d98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0'],
      ['886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0'],
      ['9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da'],
      ['751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199'],
    ],
    regionFactIds: [
      [['assert-35d7c9d174415e6f80c5']],
      [['assert-0e27dccf42d5a7bc6182']],
      [['assert-bcf36d84cea0209e39b2']],
      [['assert-2899fea03402a0ac8fda']],
    ],
  },
  {
    baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'cb946154a1b9b3a9fc4bfd39e67b902adf03ac91fd3db5caa709ed5ecdf85de2',
    originalAssertions: [
      '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
      '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
      '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
      '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
      'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
      '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
      'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
    ],
    baselineOriginalAssertions: [
      '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
      '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
      '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
      '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
      'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
      '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
      '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
    ],
    originalBodyAstSha256: 'e065aa4c9ebffca66f126a8b815e9cbfc9e5f087094ab814bfb250f302c071a1',
    baselineBodyAstSha256: '987fa6fd7c4509ceaffccc678928b9520431deac802c5ceec5b5615c1658b005',
    originalGuardHashes: [],
    moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
    moduleReview: {
      reviewedBy: 'canvas_official',
      reason:
        'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
      corrections: [
        {
          baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
          oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
          currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
          sameGuarantee: true,
          guaranteeId: 'official-20261109-partial-0',
          factIds: ['rand-invalid-kind-24'],
          reviewedBy: 'canvas_official',
          reason:
            'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
        },
      ],
      addedTests: [],
    },
    importRoles: [
      {
        source: '../lib/power-fx.mjs',
        role: 'implementation-under-test',
        reviewedBy: 'canvas_official',
        reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
      },
    ],
    runtimeInputs: [],
    inputDependencies: [],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: ['Rand and RandBetween honor an injected random source and bounded integer ranges'],
      casesSha256: '85a1ecb97a1f42ba5b1164a4c6db32586e1ef7227ba5453d6b64dd2c480df191',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
        sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
        mode: 'official-package',
        capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
        package: {
          id: 'Microsoft.PowerFx.Interpreter',
          version: '1.99.0.0',
          versionKind: 'assembly',
          sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
          artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
          source: 'https://github.com/microsoft/Power-Fx',
        },
        packagePointer: '/package',
        facts: [
          {
            id: 'assert-48bcc406ab1a19fba2fa',
            pointer: '/runs/0/results/45',
            sha256: '45b9a113a264e3ee6ea2e8ed7ebeade4d076392f169a1893d6cd1860be811c71',
            replicatedPointers: ['/runs/0/results/45', '/runs/1/results/45'],
          },
          {
            id: 'assert-2da7d6f899cb11ba3480',
            pointer: '/runs/0/results/46',
            sha256: '4d311949052ab659fe0961d86420f3f0a0fc8b06a1b2b6abb9519f5fb437c98c',
            replicatedPointers: ['/runs/0/results/46', '/runs/1/results/46'],
          },
          {
            id: 'assert-4f724607ed3d08f0da52',
            pointer: '/runs/0/results/47',
            sha256: '5496d5654dff5ec1daaebb973cee0b0e5b86c9dc1052622927be81ea013006cb',
            replicatedPointers: ['/runs/0/results/47', '/runs/1/results/47'],
          },
          {
            id: 'assert-7967fdf2f2049f7192ad',
            pointer: '/runs/0/results/48',
            sha256: 'ecec08b7ac10c9f506b1b1f79101d26e698918817739bea8bff5d02c9f9c0d61',
            replicatedPointers: ['/runs/0/results/48', '/runs/1/results/48'],
          },
          {
            id: 'assert-82356c1bc5375e4effc8',
            pointer: '/runs/0/results/49',
            sha256: '33ef4c1463d9a39303b7c9b819abebc3c297cbe49a01e508d0eb5eb07a23076c',
            replicatedPointers: ['/runs/0/results/49', '/runs/1/results/49'],
          },
          {
            id: 'rand-invalid-kind-24',
            pointer: '/runs/0/results/50',
            sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
            replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
          },
        ],
      },
    ],
    regionHashes: [
      ['5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31'],
      ['6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376'],
      ['574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2'],
      ['8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e'],
      ['e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93'],
      ['e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a'],
    ],
    regionFactIds: [
      [['assert-48bcc406ab1a19fba2fa']],
      [['assert-2da7d6f899cb11ba3480']],
      [['assert-4f724607ed3d08f0da52']],
      [['assert-7967fdf2f2049f7192ad']],
      [['assert-82356c1bc5375e4effc8']],
      [['rand-invalid-kind-24']],
    ],
  },
]);

import {
  assertParityBindings as __paqParityBindings,
  assertParityBindingsFromSource as __paqParitySourceBindings,
} from '../../scripts/qualify-parity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorKind, FxDataSource, FxError, evaluateFx, powerFxEngine } from '../lib/power-fx.mjs';
const run = (formula) => powerFxEngine.evaluateSync(formula).value;

test('Canvas color approximation follows native channel and fade results', () => {
  assert.equal(run('RGBA(1.5,2.5,3.5,0.5)'), 'rgba(1, 2, 3, 0.502)');
  assert.equal(run('ColorValue("#12345680")'), 'rgba(18, 52, 86, 0.502)');
  assert.equal(run('ColorFade(RGBA(100,150,200,1),0.5)'), 'rgba(177, 202, 227, 1)');
  assert.equal(run('ColorFade(RGBA(1,3,5,1),-0.5)'), 'rgba(0, 1, 2, 1)');

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:6:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '53e39ff0651c835f353253ac16c255582964c6fda22b13a8663d7293e80bdcae',
        originalAssertions: [
          'b9c710e70b325e65fdbe4b5297487e5b07e1eaa61e9729d336a096ae347e959e',
          '83803425215b05038f797b950cc83dbe20db32844eeed2fb86e100971086157d',
          'c1dc64e268d90d9b65b4706d609269330eafba6e858babe9067ffb8ff53ba94d',
          'e7194f00d814cd42b78688c3ae75e0dfa8eed9aed4690242a41ba7c596ca0c6c',
          'd98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0',
          '886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0',
          '9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'f1270cd8f2543663e8ea4821272e9503ebb0afe94595ab53552a742199e5fbd7',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Canvas color approximation follows native channel and fade results'],
          casesSha256: '9aa69d233c3e7b90d213b08c14a8dc8f9092a33e28c617449942a309f4f4b0ed',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-35d7c9d174415e6f80c5',
                pointer: '/runs/0/results/38',
                sha256: '18a316c126fbfeb39e21f84803fce73339ba502c3b3013ce0750abd73adab365',
                replicatedPointers: ['/runs/0/results/38', '/runs/1/results/38'],
              },
              {
                id: 'assert-0e27dccf42d5a7bc6182',
                pointer: '/runs/0/results/39',
                sha256: 'af64ba2cd53f3dfcae9ee73295e66c00005f2d49f75a07fe4c351f2b108aebf4',
                replicatedPointers: ['/runs/0/results/39', '/runs/1/results/39'],
              },
              {
                id: 'assert-bcf36d84cea0209e39b2',
                pointer: '/runs/0/results/40',
                sha256: '1a2425e69cbdd0316c09b8199a5fb919e199b8c7a22afd4d14ca2c1484c5cd7f',
                replicatedPointers: ['/runs/0/results/40', '/runs/1/results/40'],
              },
              {
                id: 'assert-2899fea03402a0ac8fda',
                pointer: '/runs/0/results/41',
                sha256: 'f998c47778da08d38105ff87dd47f9c1529925a7293436a12a188a42b61c3e28',
                replicatedPointers: ['/runs/0/results/41', '/runs/1/results/41'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['d98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0'],
          ['886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0'],
          ['9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da'],
          ['751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199'],
        ],
        regionFactIds: [
          [['assert-35d7c9d174415e6f80c5']],
          [['assert-0e27dccf42d5a7bc6182']],
          [['assert-bcf36d84cea0209e39b2']],
          [['assert-2899fea03402a0ac8fda']],
        ],
      },
    ]);
    assert.equal(run('Color.Red = ColorValue("Red")'), true);
  }

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:6:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '53e39ff0651c835f353253ac16c255582964c6fda22b13a8663d7293e80bdcae',
        originalAssertions: [
          'b9c710e70b325e65fdbe4b5297487e5b07e1eaa61e9729d336a096ae347e959e',
          '83803425215b05038f797b950cc83dbe20db32844eeed2fb86e100971086157d',
          'c1dc64e268d90d9b65b4706d609269330eafba6e858babe9067ffb8ff53ba94d',
          'e7194f00d814cd42b78688c3ae75e0dfa8eed9aed4690242a41ba7c596ca0c6c',
          'd98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0',
          '886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0',
          '9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'f1270cd8f2543663e8ea4821272e9503ebb0afe94595ab53552a742199e5fbd7',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Canvas color approximation follows native channel and fade results'],
          casesSha256: '9aa69d233c3e7b90d213b08c14a8dc8f9092a33e28c617449942a309f4f4b0ed',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-35d7c9d174415e6f80c5',
                pointer: '/runs/0/results/38',
                sha256: '18a316c126fbfeb39e21f84803fce73339ba502c3b3013ce0750abd73adab365',
                replicatedPointers: ['/runs/0/results/38', '/runs/1/results/38'],
              },
              {
                id: 'assert-0e27dccf42d5a7bc6182',
                pointer: '/runs/0/results/39',
                sha256: 'af64ba2cd53f3dfcae9ee73295e66c00005f2d49f75a07fe4c351f2b108aebf4',
                replicatedPointers: ['/runs/0/results/39', '/runs/1/results/39'],
              },
              {
                id: 'assert-bcf36d84cea0209e39b2',
                pointer: '/runs/0/results/40',
                sha256: '1a2425e69cbdd0316c09b8199a5fb919e199b8c7a22afd4d14ca2c1484c5cd7f',
                replicatedPointers: ['/runs/0/results/40', '/runs/1/results/40'],
              },
              {
                id: 'assert-2899fea03402a0ac8fda',
                pointer: '/runs/0/results/41',
                sha256: 'f998c47778da08d38105ff87dd47f9c1529925a7293436a12a188a42b61c3e28',
                replicatedPointers: ['/runs/0/results/41', '/runs/1/results/41'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['d98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0'],
          ['886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0'],
          ['9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da'],
          ['751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199'],
        ],
        regionFactIds: [
          [['assert-35d7c9d174415e6f80c5']],
          [['assert-0e27dccf42d5a7bc6182']],
          [['assert-bcf36d84cea0209e39b2']],
          [['assert-2899fea03402a0ac8fda']],
        ],
      },
    ]);
    assert.equal(run('ColorValue(Blank())'), null);
  }

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:6:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '53e39ff0651c835f353253ac16c255582964c6fda22b13a8663d7293e80bdcae',
        originalAssertions: [
          'b9c710e70b325e65fdbe4b5297487e5b07e1eaa61e9729d336a096ae347e959e',
          '83803425215b05038f797b950cc83dbe20db32844eeed2fb86e100971086157d',
          'c1dc64e268d90d9b65b4706d609269330eafba6e858babe9067ffb8ff53ba94d',
          'e7194f00d814cd42b78688c3ae75e0dfa8eed9aed4690242a41ba7c596ca0c6c',
          'd98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0',
          '886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0',
          '9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'f1270cd8f2543663e8ea4821272e9503ebb0afe94595ab53552a742199e5fbd7',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Canvas color approximation follows native channel and fade results'],
          casesSha256: '9aa69d233c3e7b90d213b08c14a8dc8f9092a33e28c617449942a309f4f4b0ed',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-35d7c9d174415e6f80c5',
                pointer: '/runs/0/results/38',
                sha256: '18a316c126fbfeb39e21f84803fce73339ba502c3b3013ce0750abd73adab365',
                replicatedPointers: ['/runs/0/results/38', '/runs/1/results/38'],
              },
              {
                id: 'assert-0e27dccf42d5a7bc6182',
                pointer: '/runs/0/results/39',
                sha256: 'af64ba2cd53f3dfcae9ee73295e66c00005f2d49f75a07fe4c351f2b108aebf4',
                replicatedPointers: ['/runs/0/results/39', '/runs/1/results/39'],
              },
              {
                id: 'assert-bcf36d84cea0209e39b2',
                pointer: '/runs/0/results/40',
                sha256: '1a2425e69cbdd0316c09b8199a5fb919e199b8c7a22afd4d14ca2c1484c5cd7f',
                replicatedPointers: ['/runs/0/results/40', '/runs/1/results/40'],
              },
              {
                id: 'assert-2899fea03402a0ac8fda',
                pointer: '/runs/0/results/41',
                sha256: 'f998c47778da08d38105ff87dd47f9c1529925a7293436a12a188a42b61c3e28',
                replicatedPointers: ['/runs/0/results/41', '/runs/1/results/41'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['d98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0'],
          ['886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0'],
          ['9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da'],
          ['751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199'],
        ],
        regionFactIds: [
          [['assert-35d7c9d174415e6f80c5']],
          [['assert-0e27dccf42d5a7bc6182']],
          [['assert-bcf36d84cea0209e39b2']],
          [['assert-2899fea03402a0ac8fda']],
        ],
      },
    ]);
    assert.equal(run('ColorValue("")'), null);
  }

  const error = evaluateFx('RGBA(256,0,0,1)').value;
  assert.ok(error instanceof FxError);

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:6:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '53e39ff0651c835f353253ac16c255582964c6fda22b13a8663d7293e80bdcae',
        originalAssertions: [
          'b9c710e70b325e65fdbe4b5297487e5b07e1eaa61e9729d336a096ae347e959e',
          '83803425215b05038f797b950cc83dbe20db32844eeed2fb86e100971086157d',
          'c1dc64e268d90d9b65b4706d609269330eafba6e858babe9067ffb8ff53ba94d',
          'e7194f00d814cd42b78688c3ae75e0dfa8eed9aed4690242a41ba7c596ca0c6c',
          'd98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0',
          '886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0',
          '9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'f1270cd8f2543663e8ea4821272e9503ebb0afe94595ab53552a742199e5fbd7',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Canvas color approximation follows native channel and fade results'],
          casesSha256: '9aa69d233c3e7b90d213b08c14a8dc8f9092a33e28c617449942a309f4f4b0ed',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-35d7c9d174415e6f80c5',
                pointer: '/runs/0/results/38',
                sha256: '18a316c126fbfeb39e21f84803fce73339ba502c3b3013ce0750abd73adab365',
                replicatedPointers: ['/runs/0/results/38', '/runs/1/results/38'],
              },
              {
                id: 'assert-0e27dccf42d5a7bc6182',
                pointer: '/runs/0/results/39',
                sha256: 'af64ba2cd53f3dfcae9ee73295e66c00005f2d49f75a07fe4c351f2b108aebf4',
                replicatedPointers: ['/runs/0/results/39', '/runs/1/results/39'],
              },
              {
                id: 'assert-bcf36d84cea0209e39b2',
                pointer: '/runs/0/results/40',
                sha256: '1a2425e69cbdd0316c09b8199a5fb919e199b8c7a22afd4d14ca2c1484c5cd7f',
                replicatedPointers: ['/runs/0/results/40', '/runs/1/results/40'],
              },
              {
                id: 'assert-2899fea03402a0ac8fda',
                pointer: '/runs/0/results/41',
                sha256: 'f998c47778da08d38105ff87dd47f9c1529925a7293436a12a188a42b61c3e28',
                replicatedPointers: ['/runs/0/results/41', '/runs/1/results/41'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['d98431379f9c3402557b62bacdd729936e61383ee5cf3ef561862acebadd72a0'],
          ['886fc13fb60a0c91fbff69cabf01fb13a2aa7c621ad02ef11c48e37799744ad0'],
          ['9baa025f14378e29607d1cd5a7ea639e16ddca16110063e0469b1bcd513cd6da'],
          ['751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199'],
        ],
        regionFactIds: [
          [['assert-35d7c9d174415e6f80c5']],
          [['assert-0e27dccf42d5a7bc6182']],
          [['assert-bcf36d84cea0209e39b2']],
          [['assert-2899fea03402a0ac8fda']],
        ],
      },
    ]);
    assert.equal(error.errors[0].Kind, ErrorKind.InvalidArgument);
  }
});

// @test-kind parity: Unchanged original assertions reproduced in two independent processes against unmodified official Microsoft Power Fx assemblies.
// @parity-evidence: Manifest guarantee official-batch-0; exact capsule/run/fact/source bindings are asserted below.
test('Search matches columns case-insensitively and blank returns all rows', () => {
  // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:19:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '2b8572cebe64d45d178ef5b647eb29427e67564675f5a688a5bfb7c84cb41e23',
      originalAssertions: [
        '36cac86dd39cf57f0731a065fcff33d2c4a4842f7c24db0f94a1c952856d9c3c',
        '7bf96726e58903c7a5d853456e2fbab9a464bf34653e3ae25f0970916f3e25de',
        '38f306bcb04eae41eb9071b3552580b64490492eb381fa33dd0e54819fd3d509',
      ],
      originalBodyAstSha256: '3ff59d16aeb08ae12a8f23471918d6fb35a97a847812573fa834472bd3c80443',
      originalGuardHashes: [],
      moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
      moduleReview: {
        reviewedBy: 'canvas_official',
        reason:
          'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
        corrections: [
          {
            baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
            oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
            currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
            sameGuarantee: true,
            guaranteeId: 'legacy-common-0',
            factIds: ['rand-invalid-kind-24'],
            reviewedBy: 'canvas_official',
            reason:
              'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
          },
        ],
        addedTests: [],
      },
      importRoles: [
        {
          source: '../lib/power-fx.mjs',
          role: 'implementation-under-test',
          reviewedBy: 'canvas_official',
          reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
        },
      ],
      runtimeInputs: [],
      inputDependencies: [],
      sourceBindings: [
        { name: 'run', initializerAstSha256: '576f577c2c5208d88d9ca2fa1da808ab8a1eb82b04017aef3b07cb35e30adc61' },
      ],
      loopHeaders: [],
      caseUniverse: {
        count: 1,
        cases: ['Search matches columns case-insensitively and blank returns all rows'],
        casesSha256: 'b1cb4d2bce85c7dc9ff413380a983b52e641b7928c38e96fb5ccdcf0f93e288a',
        sourceBindings: [
          { name: 'run', initializerAstSha256: '576f577c2c5208d88d9ca2fa1da808ab8a1eb82b04017aef3b07cb35e30adc61' },
        ],
        ancestorLoops: [],
      },
      proofs: [
        {
          path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
          sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
          mode: 'official-package',
          capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
          package: {
            id: 'Microsoft.PowerFx.Interpreter',
            version: '1.99.0.0',
            versionKind: 'assembly',
            sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
            artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
            source: 'https://github.com/microsoft/Power-Fx',
          },
          packagePointer: '/package',
          facts: [
            {
              id: 'assert-6849f594d6dd4bd784d5',
              pointer: '/runs/0/results/42',
              sha256: 'b8e9199ab6dd4dbe5732394012006a8254f52c9dad5f28be045db3136cb910b4',
              replicatedPointers: ['/runs/0/results/42', '/runs/1/results/42'],
            },
            {
              id: 'assert-ab5dac8cdf9b640ac45f',
              pointer: '/runs/0/results/43',
              sha256: 'a0ab2ae7f836b43b3b6208efce6a01b3442595aeda6f70f46350c1dc6be5cb2d',
              replicatedPointers: ['/runs/0/results/43', '/runs/1/results/43'],
            },
            {
              id: 'assert-e1a9858820057c74d2bd',
              pointer: '/runs/0/results/44',
              sha256: '6cc19b9028598a7ad721b46f0881fd0d420b75bf8fcd2609bbadecb30b10772b',
              replicatedPointers: ['/runs/0/results/44', '/runs/1/results/44'],
            },
            {
              id: 'assert-65c781fa46275e4125ce',
              pointer: '/runs/0/results/51',
              sha256: '56a5c26d58d1e61d5ab6d2bbfc872ca5f90cad7d0709934bd5a0d8318728950e',
              replicatedPointers: ['/runs/0/results/51', '/runs/1/results/51'],
            },
          ],
        },
        {
          path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
          sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
          mode: 'official-package',
          capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
          package: {
            id: 'Microsoft.PowerFx.Interpreter',
            version: '1.99.0.0',
            versionKind: 'assembly',
            sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
            artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
            source: 'https://github.com/microsoft/Power-Fx',
          },
          packagePointer: '/package',
          facts: [
            {
              id: 'rand-invalid-kind-24',
              pointer: '/runs/0/results/50',
              sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
              replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
            },
          ],
        },
      ],
    },
  ]);
  assert.equal(run('CountRows(Search([{Name:"Alpha"},{Name:"Beta"}], "PH", Name))'), 1);
  assert.equal(run('CountRows(Search([{Name:Blank()},{Name:"Beta"}], "", Name))'), 2);
  assert.equal(run('CountRows(Search([{Name:"Alpha", City:"York"}], "OR", Name, City))'), 1);
});

test('Rand and RandBetween honor an injected random source and bounded integer ranges', () => {
  const evaluate = (formula, random) => powerFxEngine.evaluateSync(formula, { host: { random } }).value;

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'cb946154a1b9b3a9fc4bfd39e67b902adf03ac91fd3db5caa709ed5ecdf85de2',
        originalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
        ],
        baselineOriginalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'e065aa4c9ebffca66f126a8b815e9cbfc9e5f087094ab814bfb250f302c071a1',
        baselineBodyAstSha256: '987fa6fd7c4509ceaffccc678928b9520431deac802c5ceec5b5615c1658b005',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Rand and RandBetween honor an injected random source and bounded integer ranges'],
          casesSha256: '85a1ecb97a1f42ba5b1164a4c6db32586e1ef7227ba5453d6b64dd2c480df191',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-48bcc406ab1a19fba2fa',
                pointer: '/runs/0/results/45',
                sha256: '45b9a113a264e3ee6ea2e8ed7ebeade4d076392f169a1893d6cd1860be811c71',
                replicatedPointers: ['/runs/0/results/45', '/runs/1/results/45'],
              },
              {
                id: 'assert-2da7d6f899cb11ba3480',
                pointer: '/runs/0/results/46',
                sha256: '4d311949052ab659fe0961d86420f3f0a0fc8b06a1b2b6abb9519f5fb437c98c',
                replicatedPointers: ['/runs/0/results/46', '/runs/1/results/46'],
              },
              {
                id: 'assert-4f724607ed3d08f0da52',
                pointer: '/runs/0/results/47',
                sha256: '5496d5654dff5ec1daaebb973cee0b0e5b86c9dc1052622927be81ea013006cb',
                replicatedPointers: ['/runs/0/results/47', '/runs/1/results/47'],
              },
              {
                id: 'assert-7967fdf2f2049f7192ad',
                pointer: '/runs/0/results/48',
                sha256: 'ecec08b7ac10c9f506b1b1f79101d26e698918817739bea8bff5d02c9f9c0d61',
                replicatedPointers: ['/runs/0/results/48', '/runs/1/results/48'],
              },
              {
                id: 'assert-82356c1bc5375e4effc8',
                pointer: '/runs/0/results/49',
                sha256: '33ef4c1463d9a39303b7c9b819abebc3c297cbe49a01e508d0eb5eb07a23076c',
                replicatedPointers: ['/runs/0/results/49', '/runs/1/results/49'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31'],
          ['6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376'],
          ['574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2'],
          ['8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e'],
          ['e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93'],
          ['e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a'],
        ],
        regionFactIds: [
          [['assert-48bcc406ab1a19fba2fa']],
          [['assert-2da7d6f899cb11ba3480']],
          [['assert-4f724607ed3d08f0da52']],
          [['assert-7967fdf2f2049f7192ad']],
          [['assert-82356c1bc5375e4effc8']],
          [['rand-invalid-kind-24']],
        ],
      },
    ]);
    assert.equal(
      evaluate('Rand()', () => 0.25),
      0.25,
    );
  }

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'cb946154a1b9b3a9fc4bfd39e67b902adf03ac91fd3db5caa709ed5ecdf85de2',
        originalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
        ],
        baselineOriginalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'e065aa4c9ebffca66f126a8b815e9cbfc9e5f087094ab814bfb250f302c071a1',
        baselineBodyAstSha256: '987fa6fd7c4509ceaffccc678928b9520431deac802c5ceec5b5615c1658b005',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Rand and RandBetween honor an injected random source and bounded integer ranges'],
          casesSha256: '85a1ecb97a1f42ba5b1164a4c6db32586e1ef7227ba5453d6b64dd2c480df191',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-48bcc406ab1a19fba2fa',
                pointer: '/runs/0/results/45',
                sha256: '45b9a113a264e3ee6ea2e8ed7ebeade4d076392f169a1893d6cd1860be811c71',
                replicatedPointers: ['/runs/0/results/45', '/runs/1/results/45'],
              },
              {
                id: 'assert-2da7d6f899cb11ba3480',
                pointer: '/runs/0/results/46',
                sha256: '4d311949052ab659fe0961d86420f3f0a0fc8b06a1b2b6abb9519f5fb437c98c',
                replicatedPointers: ['/runs/0/results/46', '/runs/1/results/46'],
              },
              {
                id: 'assert-4f724607ed3d08f0da52',
                pointer: '/runs/0/results/47',
                sha256: '5496d5654dff5ec1daaebb973cee0b0e5b86c9dc1052622927be81ea013006cb',
                replicatedPointers: ['/runs/0/results/47', '/runs/1/results/47'],
              },
              {
                id: 'assert-7967fdf2f2049f7192ad',
                pointer: '/runs/0/results/48',
                sha256: 'ecec08b7ac10c9f506b1b1f79101d26e698918817739bea8bff5d02c9f9c0d61',
                replicatedPointers: ['/runs/0/results/48', '/runs/1/results/48'],
              },
              {
                id: 'assert-82356c1bc5375e4effc8',
                pointer: '/runs/0/results/49',
                sha256: '33ef4c1463d9a39303b7c9b819abebc3c297cbe49a01e508d0eb5eb07a23076c',
                replicatedPointers: ['/runs/0/results/49', '/runs/1/results/49'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31'],
          ['6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376'],
          ['574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2'],
          ['8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e'],
          ['e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93'],
          ['e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a'],
        ],
        regionFactIds: [
          [['assert-48bcc406ab1a19fba2fa']],
          [['assert-2da7d6f899cb11ba3480']],
          [['assert-4f724607ed3d08f0da52']],
          [['assert-7967fdf2f2049f7192ad']],
          [['assert-82356c1bc5375e4effc8']],
          [['rand-invalid-kind-24']],
        ],
      },
    ]);
    assert.equal(
      evaluate('RandBetween(2,2)', () => 0.9),
      2,
    );
  }

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'cb946154a1b9b3a9fc4bfd39e67b902adf03ac91fd3db5caa709ed5ecdf85de2',
        originalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
        ],
        baselineOriginalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'e065aa4c9ebffca66f126a8b815e9cbfc9e5f087094ab814bfb250f302c071a1',
        baselineBodyAstSha256: '987fa6fd7c4509ceaffccc678928b9520431deac802c5ceec5b5615c1658b005',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Rand and RandBetween honor an injected random source and bounded integer ranges'],
          casesSha256: '85a1ecb97a1f42ba5b1164a4c6db32586e1ef7227ba5453d6b64dd2c480df191',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-48bcc406ab1a19fba2fa',
                pointer: '/runs/0/results/45',
                sha256: '45b9a113a264e3ee6ea2e8ed7ebeade4d076392f169a1893d6cd1860be811c71',
                replicatedPointers: ['/runs/0/results/45', '/runs/1/results/45'],
              },
              {
                id: 'assert-2da7d6f899cb11ba3480',
                pointer: '/runs/0/results/46',
                sha256: '4d311949052ab659fe0961d86420f3f0a0fc8b06a1b2b6abb9519f5fb437c98c',
                replicatedPointers: ['/runs/0/results/46', '/runs/1/results/46'],
              },
              {
                id: 'assert-4f724607ed3d08f0da52',
                pointer: '/runs/0/results/47',
                sha256: '5496d5654dff5ec1daaebb973cee0b0e5b86c9dc1052622927be81ea013006cb',
                replicatedPointers: ['/runs/0/results/47', '/runs/1/results/47'],
              },
              {
                id: 'assert-7967fdf2f2049f7192ad',
                pointer: '/runs/0/results/48',
                sha256: 'ecec08b7ac10c9f506b1b1f79101d26e698918817739bea8bff5d02c9f9c0d61',
                replicatedPointers: ['/runs/0/results/48', '/runs/1/results/48'],
              },
              {
                id: 'assert-82356c1bc5375e4effc8',
                pointer: '/runs/0/results/49',
                sha256: '33ef4c1463d9a39303b7c9b819abebc3c297cbe49a01e508d0eb5eb07a23076c',
                replicatedPointers: ['/runs/0/results/49', '/runs/1/results/49'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31'],
          ['6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376'],
          ['574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2'],
          ['8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e'],
          ['e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93'],
          ['e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a'],
        ],
        regionFactIds: [
          [['assert-48bcc406ab1a19fba2fa']],
          [['assert-2da7d6f899cb11ba3480']],
          [['assert-4f724607ed3d08f0da52']],
          [['assert-7967fdf2f2049f7192ad']],
          [['assert-82356c1bc5375e4effc8']],
          [['rand-invalid-kind-24']],
        ],
      },
    ]);
    assert.equal(
      evaluate('RandBetween(-1,1)', () => 0),
      -1,
    );
  }

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'cb946154a1b9b3a9fc4bfd39e67b902adf03ac91fd3db5caa709ed5ecdf85de2',
        originalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
        ],
        baselineOriginalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'e065aa4c9ebffca66f126a8b815e9cbfc9e5f087094ab814bfb250f302c071a1',
        baselineBodyAstSha256: '987fa6fd7c4509ceaffccc678928b9520431deac802c5ceec5b5615c1658b005',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Rand and RandBetween honor an injected random source and bounded integer ranges'],
          casesSha256: '85a1ecb97a1f42ba5b1164a4c6db32586e1ef7227ba5453d6b64dd2c480df191',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-48bcc406ab1a19fba2fa',
                pointer: '/runs/0/results/45',
                sha256: '45b9a113a264e3ee6ea2e8ed7ebeade4d076392f169a1893d6cd1860be811c71',
                replicatedPointers: ['/runs/0/results/45', '/runs/1/results/45'],
              },
              {
                id: 'assert-2da7d6f899cb11ba3480',
                pointer: '/runs/0/results/46',
                sha256: '4d311949052ab659fe0961d86420f3f0a0fc8b06a1b2b6abb9519f5fb437c98c',
                replicatedPointers: ['/runs/0/results/46', '/runs/1/results/46'],
              },
              {
                id: 'assert-4f724607ed3d08f0da52',
                pointer: '/runs/0/results/47',
                sha256: '5496d5654dff5ec1daaebb973cee0b0e5b86c9dc1052622927be81ea013006cb',
                replicatedPointers: ['/runs/0/results/47', '/runs/1/results/47'],
              },
              {
                id: 'assert-7967fdf2f2049f7192ad',
                pointer: '/runs/0/results/48',
                sha256: 'ecec08b7ac10c9f506b1b1f79101d26e698918817739bea8bff5d02c9f9c0d61',
                replicatedPointers: ['/runs/0/results/48', '/runs/1/results/48'],
              },
              {
                id: 'assert-82356c1bc5375e4effc8',
                pointer: '/runs/0/results/49',
                sha256: '33ef4c1463d9a39303b7c9b819abebc3c297cbe49a01e508d0eb5eb07a23076c',
                replicatedPointers: ['/runs/0/results/49', '/runs/1/results/49'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31'],
          ['6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376'],
          ['574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2'],
          ['8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e'],
          ['e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93'],
          ['e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a'],
        ],
        regionFactIds: [
          [['assert-48bcc406ab1a19fba2fa']],
          [['assert-2da7d6f899cb11ba3480']],
          [['assert-4f724607ed3d08f0da52']],
          [['assert-7967fdf2f2049f7192ad']],
          [['assert-82356c1bc5375e4effc8']],
          [['rand-invalid-kind-24']],
        ],
      },
    ]);
    assert.equal(
      evaluate('RandBetween(-1,1)', () => 0.999999),
      1,
    );
  }

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'cb946154a1b9b3a9fc4bfd39e67b902adf03ac91fd3db5caa709ed5ecdf85de2',
        originalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
        ],
        baselineOriginalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'e065aa4c9ebffca66f126a8b815e9cbfc9e5f087094ab814bfb250f302c071a1',
        baselineBodyAstSha256: '987fa6fd7c4509ceaffccc678928b9520431deac802c5ceec5b5615c1658b005',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Rand and RandBetween honor an injected random source and bounded integer ranges'],
          casesSha256: '85a1ecb97a1f42ba5b1164a4c6db32586e1ef7227ba5453d6b64dd2c480df191',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-48bcc406ab1a19fba2fa',
                pointer: '/runs/0/results/45',
                sha256: '45b9a113a264e3ee6ea2e8ed7ebeade4d076392f169a1893d6cd1860be811c71',
                replicatedPointers: ['/runs/0/results/45', '/runs/1/results/45'],
              },
              {
                id: 'assert-2da7d6f899cb11ba3480',
                pointer: '/runs/0/results/46',
                sha256: '4d311949052ab659fe0961d86420f3f0a0fc8b06a1b2b6abb9519f5fb437c98c',
                replicatedPointers: ['/runs/0/results/46', '/runs/1/results/46'],
              },
              {
                id: 'assert-4f724607ed3d08f0da52',
                pointer: '/runs/0/results/47',
                sha256: '5496d5654dff5ec1daaebb973cee0b0e5b86c9dc1052622927be81ea013006cb',
                replicatedPointers: ['/runs/0/results/47', '/runs/1/results/47'],
              },
              {
                id: 'assert-7967fdf2f2049f7192ad',
                pointer: '/runs/0/results/48',
                sha256: 'ecec08b7ac10c9f506b1b1f79101d26e698918817739bea8bff5d02c9f9c0d61',
                replicatedPointers: ['/runs/0/results/48', '/runs/1/results/48'],
              },
              {
                id: 'assert-82356c1bc5375e4effc8',
                pointer: '/runs/0/results/49',
                sha256: '33ef4c1463d9a39303b7c9b819abebc3c297cbe49a01e508d0eb5eb07a23076c',
                replicatedPointers: ['/runs/0/results/49', '/runs/1/results/49'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31'],
          ['6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376'],
          ['574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2'],
          ['8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e'],
          ['e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93'],
          ['e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a'],
        ],
        regionFactIds: [
          [['assert-48bcc406ab1a19fba2fa']],
          [['assert-2da7d6f899cb11ba3480']],
          [['assert-4f724607ed3d08f0da52']],
          [['assert-7967fdf2f2049f7192ad']],
          [['assert-82356c1bc5375e4effc8']],
          [['rand-invalid-kind-24']],
        ],
      },
    ]);
    assert.equal(
      evaluate('RandBetween(1.1,1.1)', () => 0),
      2,
    );
  }

  const error = evaluateFx('RandBetween(3,2)', { host: { random: () => 0 } }).value;
  assert.ok(error instanceof FxError);
  // @parity-evidence: power-fx-batch-official-evidence.json reproduces RandBetween(3,2) with the unchanged random host twice and reports Numeric24.
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'cb946154a1b9b3a9fc4bfd39e67b902adf03ac91fd3db5caa709ed5ecdf85de2',
        originalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
        ],
        baselineOriginalAssertions: [
          '5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31',
          '6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376',
          '574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2',
          '8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e',
          'e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93',
          '0f9d3f445661fa56fb6972d75f6d57b796ac7e30f0f25a3dfc81657011fa1525',
          '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
        ],
        originalBodyAstSha256: 'e065aa4c9ebffca66f126a8b815e9cbfc9e5f087094ab814bfb250f302c071a1',
        baselineBodyAstSha256: '987fa6fd7c4509ceaffccc678928b9520431deac802c5ceec5b5615c1658b005',
        originalGuardHashes: [],
        moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
        moduleReview: {
          reviewedBy: 'canvas_official',
          reason:
            'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
          corrections: [
            {
              baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
              oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
              currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
              sameGuarantee: true,
              guaranteeId: 'official-20261109-partial-0',
              factIds: ['rand-invalid-kind-24'],
              reviewedBy: 'canvas_official',
              reason:
                'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
            },
          ],
          addedTests: [],
        },
        importRoles: [
          {
            source: '../lib/power-fx.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'canvas_official',
            reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['Rand and RandBetween honor an injected random source and bounded integer ranges'],
          casesSha256: '85a1ecb97a1f42ba5b1164a4c6db32586e1ef7227ba5453d6b64dd2c480df191',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
            sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
            mode: 'official-package',
            capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
            package: {
              id: 'Microsoft.PowerFx.Interpreter',
              version: '1.99.0.0',
              versionKind: 'assembly',
              sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
              artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
              source: 'https://github.com/microsoft/Power-Fx',
            },
            packagePointer: '/package',
            facts: [
              {
                id: 'assert-48bcc406ab1a19fba2fa',
                pointer: '/runs/0/results/45',
                sha256: '45b9a113a264e3ee6ea2e8ed7ebeade4d076392f169a1893d6cd1860be811c71',
                replicatedPointers: ['/runs/0/results/45', '/runs/1/results/45'],
              },
              {
                id: 'assert-2da7d6f899cb11ba3480',
                pointer: '/runs/0/results/46',
                sha256: '4d311949052ab659fe0961d86420f3f0a0fc8b06a1b2b6abb9519f5fb437c98c',
                replicatedPointers: ['/runs/0/results/46', '/runs/1/results/46'],
              },
              {
                id: 'assert-4f724607ed3d08f0da52',
                pointer: '/runs/0/results/47',
                sha256: '5496d5654dff5ec1daaebb973cee0b0e5b86c9dc1052622927be81ea013006cb',
                replicatedPointers: ['/runs/0/results/47', '/runs/1/results/47'],
              },
              {
                id: 'assert-7967fdf2f2049f7192ad',
                pointer: '/runs/0/results/48',
                sha256: 'ecec08b7ac10c9f506b1b1f79101d26e698918817739bea8bff5d02c9f9c0d61',
                replicatedPointers: ['/runs/0/results/48', '/runs/1/results/48'],
              },
              {
                id: 'assert-82356c1bc5375e4effc8',
                pointer: '/runs/0/results/49',
                sha256: '33ef4c1463d9a39303b7c9b819abebc3c297cbe49a01e508d0eb5eb07a23076c',
                replicatedPointers: ['/runs/0/results/49', '/runs/1/results/49'],
              },
              {
                id: 'rand-invalid-kind-24',
                pointer: '/runs/0/results/50',
                sha256: '05d2a4ca9f696b909795ccd9a3d7e90381ba4da1926fac7771c174ef9bd5547b',
                replicatedPointers: ['/runs/0/results/50', '/runs/1/results/50'],
              },
            ],
          },
        ],
        regionHashes: [
          ['5344474c3af9d7b39000a17b382f864c101f8ce9cb63bbf3dfef4e793efb9e31'],
          ['6f081043473a139bb17059bcd235d7ea11e0bf7a33a505695aad9d0f713b4376'],
          ['574f1f0aa8df9c0319d77c88d0c9c1c08769769c915a97f064ef356336f891e2'],
          ['8567e8f080dc6a172c85147345240914e010744fe1d15fdd9b0129ebbc337e8e'],
          ['e148681a44449e41e72e39a9ad2b98de9b4a64ae94475d7c76fd33aeed503c93'],
          ['e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a'],
        ],
        regionFactIds: [
          [['assert-48bcc406ab1a19fba2fa']],
          [['assert-2da7d6f899cb11ba3480']],
          [['assert-4f724607ed3d08f0da52']],
          [['assert-7967fdf2f2049f7192ad']],
          [['assert-82356c1bc5375e4effc8']],
          [['rand-invalid-kind-24']],
        ],
      },
    ]);
    assert.equal(error.errors[0].Kind, ErrorKind.Numeric);
  }
});

// @test-kind parity: Unchanged original assertions reproduced in two independent processes against unmodified official Microsoft Power Fx assemblies.
// @parity-evidence: Manifest guarantee official-batch-0; exact capsule/run/fact/source bindings are asserted below.
test('EncodeUrl encodes reserved and Unicode characters as in PAC', () => {
  // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:52:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '97744a8071387e1ef870f3fc2cb7c0e31b140ee6dc8a5f4eaf066a5a6185baa7',
      originalAssertions: ['30f5e630c26b6dc4d8a325a89e1df140be40c672b4dbb5b3a4b8f383753c545b'],
      originalBodyAstSha256: '19eced9d10ff585df0855f18815fe129076cdda4081f7afa8be7b5453c8b1d0a',
      originalGuardHashes: [],
      moduleContextAstSha256: '1a2a2b8fc5ea5ee705f31ccd1024a76d2aac84c5b502dc12d3c6ce3a3e16c6e1',
      moduleReview: {
        reviewedBy: 'canvas_official',
        reason:
          'Existing owner-scoped RandBetween correction is independently reproduced in the official random host; selected partial assertions remain unchanged.',
        corrections: [
          {
            baselineId: 'mirage/test/power-fx-canvas-common.test.mjs:25:0',
            oldAstSha256: '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199',
            currentAstSha256: 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a',
            sameGuarantee: true,
            guaranteeId: 'legacy-common-0',
            factIds: ['rand-invalid-kind-24'],
            reviewedBy: 'canvas_official',
            reason:
              'The exact original RandBetween(3,2) and injected random zero twice produce Numeric error kind 24 in the official host.',
          },
        ],
        addedTests: [],
      },
      importRoles: [
        {
          source: '../lib/power-fx.mjs',
          role: 'implementation-under-test',
          reviewedBy: 'canvas_official',
          reason: 'The Power Fx runtime is the implementation under test and remains intentionally changeable.',
        },
      ],
      runtimeInputs: [],
      inputDependencies: [],
      sourceBindings: [
        { name: 'run', initializerAstSha256: '576f577c2c5208d88d9ca2fa1da808ab8a1eb82b04017aef3b07cb35e30adc61' },
      ],
      loopHeaders: [],
      caseUniverse: {
        count: 1,
        cases: ['EncodeUrl encodes reserved and Unicode characters as in PAC'],
        casesSha256: 'f80d4454a525af1a23a4bb48658812e0df400ca18d8cdb18ad775b53e66e1ba5',
        sourceBindings: [
          { name: 'run', initializerAstSha256: '576f577c2c5208d88d9ca2fa1da808ab8a1eb82b04017aef3b07cb35e30adc61' },
        ],
        ancestorLoops: [],
      },
      proofs: [
        {
          path: 'mirage/test/fixtures/power-fx-batch-official-evidence.json',
          sha256: '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
          mode: 'official-package',
          capturePointers: ['/runs/0/receiptSha256', '/runs/1/receiptSha256'],
          package: {
            id: 'Microsoft.PowerFx.Interpreter',
            version: '1.99.0.0',
            versionKind: 'assembly',
            sha256: 'f06ed03f9599741990e2db49bbb495b88b5655faab89d5a5017dbec9c75ac780',
            artifactKind: 'Unmodified Microsoft assembly shipped in official PAC 2.13.1',
            source: 'https://github.com/microsoft/Power-Fx',
          },
          packagePointer: '/package',
          facts: [
            {
              id: 'assert-6849f594d6dd4bd784d5',
              pointer: '/runs/0/results/42',
              sha256: 'b8e9199ab6dd4dbe5732394012006a8254f52c9dad5f28be045db3136cb910b4',
              replicatedPointers: ['/runs/0/results/42', '/runs/1/results/42'],
            },
            {
              id: 'assert-ab5dac8cdf9b640ac45f',
              pointer: '/runs/0/results/43',
              sha256: 'a0ab2ae7f836b43b3b6208efce6a01b3442595aeda6f70f46350c1dc6be5cb2d',
              replicatedPointers: ['/runs/0/results/43', '/runs/1/results/43'],
            },
            {
              id: 'assert-e1a9858820057c74d2bd',
              pointer: '/runs/0/results/44',
              sha256: '6cc19b9028598a7ad721b46f0881fd0d420b75bf8fcd2609bbadecb30b10772b',
              replicatedPointers: ['/runs/0/results/44', '/runs/1/results/44'],
            },
            {
              id: 'assert-65c781fa46275e4125ce',
              pointer: '/runs/0/results/51',
              sha256: '56a5c26d58d1e61d5ab6d2bbfc872ca5f90cad7d0709934bd5a0d8318728950e',
              replicatedPointers: ['/runs/0/results/51', '/runs/1/results/51'],
            },
          ],
        },
      ],
    },
  ]);
  assert.equal(run('EncodeUrl("a b&/é!~*\'()")'), 'a%20b%26%2F%C3%A9%21~%2A%27%28%29');
});

test('Choices refuses an unknown provider without invoking it', () => {
  let invoked = false;
  const source = new FxDataSource('DS', {
    choices: () => {
      invoked = true;
      return { kind: 'choice', values: [] };
    },
  });
  const result = evaluateFx('Choices(DS.Status)', { values: { DS: source } });
  assert.ok(result.value instanceof FxError);
  assert.equal(result.value.errors[0].Kind, ErrorKind.NotSupported);
  assert.equal(invoked, false);
});

// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.
test('parity source bindings dd1313af441e6137', () => {
  // @parity-evidence: Tooling-only exposure of the existing source/run/fact/case validator; the same helper and module URL execute once, with every protected binding unchanged.
  assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));
});

if (ErrorKind.Numeric !== 24) throw new Error('official ErrorKind.Numeric binding changed');
