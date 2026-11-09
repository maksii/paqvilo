// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.
// @test-kind unproven: upstream DotLiquid/Adxstudio models and invented contexts are not native evidence; reproduced native assertions carry per-test tags.
import { parityAssertions as __paqParityAssertions } from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '4be71a811eabee67e7535696b973f079740f40f7315e804269d744a89dcbebe7',
    originalAssertions: [
      'f80230d0e0251d99550b47e555b3966bc8c49fc095350ff272f041e3ba2db462',
      '744c40395aca88899f44089ce82689080459d604b559d2308d90d9cf99601628',
      'ecc2f98011bcf88299ac6d668cc7d387b675ea998c4fd7f48095e22862b9e2c6',
      'fc20b96fcd45851163056cb40200791e1d0d25b3c5f51cd92a4c797921ae9bc2',
    ],
    originalBodyAstSha256: '3e80d62b65f121e2a172432b8285ae35dc59ecc2b3d8fc467454a2e34b048044',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
          title: 'tags and outputs are single-line regex tokens and extra filter words are ignored',
        },
      ],
      casesSha256: '40fdcb4e0ad1a13b239a1f2def31a3545374016b8f00bd7a5a7bcfd877be97c9',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
        sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-context-006',
            pointer: '/captures/0/cases/5/facts',
            sha256: '48316a32ff3778d81adb1729c8fe3d065e0d90553545f8f22dca7758d1e8c12e',
            replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
        sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-liquid-051',
            pointer: '/captures/0/cases/50/facts',
            sha256: 'a560f259574ff079fad14846393ca5efa0ac3922ae6fc8e1aa9fa948fc836088',
            replicatedPointers: ['/captures/0/cases/50/facts', '/captures/1/cases/50/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        'ecc2f98011bcf88299ac6d668cc7d387b675ea998c4fd7f48095e22862b9e2c6',
        'fc20b96fcd45851163056cb40200791e1d0d25b3c5f51cd92a4c797921ae9bc2',
      ],
    ],
    regionFactIds: [[['native-original-context-006'], ['native-original-liquid-051']]],
  },
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '557b7cddf2ee445d9e41e71b1eae757135594f0d3b5686c5d6e904cd17b63f03',
    originalAssertions: [
      'bbd59f5d9f63e5299c8a1e026fb598436604ef64b923a40e78b3871bca2093b7',
      '88e8b3eb457797ea989a3eceb480525d0e977f94e47acab61aec59bfe9b71a3f',
      '7e264925f365dcacd5eb6e92fa790c39a0d00690c792f5c0ffe74b2d0828f3af',
      'b43a1577c3068668c5b99c6f80089c1f39ba603491ffd310b4b91225987710a3',
      'a294480c67aaa0cba61574afb0ed625ccde66765b4b1ce48e199b0ab6102cbbb',
    ],
    originalBodyAstSha256: 'a4d68cb6795c03f84e6318a64b91bc19ef20f200c15ea8acf02a8dd32c7bb6f9',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
          title: 'and/or group right to left without precedence and comparisons convert the right operand',
        },
      ],
      casesSha256: '9e6a18c5114e1fc859974c8efe3fbcab1efd5576fb6f86b9a68ea1c852d873c8',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
        sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-liquid-052',
            pointer: '/captures/0/cases/51/facts',
            sha256: '89e023b3a554d935ef256bfe75cee891b9ad0a631b2c75966f19a3bc3f7f975c',
            replicatedPointers: ['/captures/0/cases/51/facts', '/captures/1/cases/51/facts'],
          },
          {
            id: 'native-original-liquid-053',
            pointer: '/captures/0/cases/52/facts',
            sha256: '218b0126b94d8b111ff1004266a12c9b02717f148565df257cedc130b2cf8f3a',
            replicatedPointers: ['/captures/0/cases/52/facts', '/captures/1/cases/52/facts'],
          },
          {
            id: 'native-original-liquid-054',
            pointer: '/captures/0/cases/53/facts',
            sha256: 'c603ad08e6d1eb2ba2c4b874d9ab2ba313ee1794af0b0335706b4d2d5aa5ca57',
            replicatedPointers: ['/captures/0/cases/53/facts', '/captures/1/cases/53/facts'],
          },
          {
            id: 'native-original-liquid-055',
            pointer: '/captures/0/cases/54/facts',
            sha256: '659685f45f8c60caccecc50084610400b08f583052857be8936d61be4654af96',
            replicatedPointers: ['/captures/0/cases/54/facts', '/captures/1/cases/54/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        'bbd59f5d9f63e5299c8a1e026fb598436604ef64b923a40e78b3871bca2093b7',
        '88e8b3eb457797ea989a3eceb480525d0e977f94e47acab61aec59bfe9b71a3f',
        '7e264925f365dcacd5eb6e92fa790c39a0d00690c792f5c0ffe74b2d0828f3af',
      ],
      ['a294480c67aaa0cba61574afb0ed625ccde66765b4b1ce48e199b0ab6102cbbb'],
    ],
    regionFactIds: [
      [['native-original-liquid-052'], ['native-original-liquid-053'], ['native-original-liquid-054']],
      [['native-original-liquid-055']],
    ],
  },
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'd2ff418ff7c425c9cfa533bed35ec95a53e43709c5fb7f0330afa0a4fe415924',
    originalAssertions: [
      '9dad7e4288b9e011aa138f715c457d72fa13b3e52a05a1cb74c3ec671fcefd48',
      '7cc3d6bad1b561fcef0b16e2d22f085134dd908be26073c56817db1367a54e89',
      'a8d52912218e22d896ab7c5b26907cb7a18e8649097a68070bd3295793791f44',
      '3e6cf88f1be42647cc6a3b27efe485812e09f4eae9a7231b09672c76764d90b5',
      'ab75976adff0dab16b5ea6df19196e2cfeca0a15fa38689b8e219c156a49f16e',
    ],
    originalBodyAstSha256: '2a258b128fdc30681aecb2c0cccc5ac6872031bf5322b5d2ce30c8c87cb24e7d',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
          title: 'if/elsif/elseif/unless/case follow DotLiquid block rules',
        },
      ],
      casesSha256: '65dfcba81db724a8b968d722b945245c76096cdf5ed1ad519b48181a98d0084e',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
        sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-liquid-057',
            pointer: '/captures/0/cases/56/facts',
            sha256: '9a272db95d419d98564d5b79d0149e4f31451bda655acf0d831a6a2f72692e0e',
            replicatedPointers: ['/captures/0/cases/56/facts', '/captures/1/cases/56/facts'],
          },
          {
            id: 'native-original-liquid-058',
            pointer: '/captures/0/cases/57/facts',
            sha256: 'ed722407c5352effad4133a752af12ab930f514c410c60ba67efd20d6ad5e807',
            replicatedPointers: ['/captures/0/cases/57/facts', '/captures/1/cases/57/facts'],
          },
          {
            id: 'native-original-liquid-059',
            pointer: '/captures/0/cases/58/facts',
            sha256: '56984fc1ede87ba7bbbd4df878be0c061646d6d282ef68b15d020aad50ed07a2',
            replicatedPointers: ['/captures/0/cases/58/facts', '/captures/1/cases/58/facts'],
          },
          {
            id: 'native-original-liquid-060',
            pointer: '/captures/0/cases/59/facts',
            sha256: 'c79dcbb70c745b505a63c0cdfee8c79da87caaf395ee71e9a28df3f66e3aead9',
            replicatedPointers: ['/captures/0/cases/59/facts', '/captures/1/cases/59/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        '9dad7e4288b9e011aa138f715c457d72fa13b3e52a05a1cb74c3ec671fcefd48',
        '7cc3d6bad1b561fcef0b16e2d22f085134dd908be26073c56817db1367a54e89',
      ],
      [
        '3e6cf88f1be42647cc6a3b27efe485812e09f4eae9a7231b09672c76764d90b5',
        'ab75976adff0dab16b5ea6df19196e2cfeca0a15fa38689b8e219c156a49f16e',
      ],
    ],
    regionFactIds: [
      [['native-original-liquid-057'], ['native-original-liquid-058']],
      [['native-original-liquid-059'], ['native-original-liquid-060']],
    ],
  },
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'b0e44bb6a0294091101c556f6b95f1e1d012970c1677857c60df7e541ade90b0',
    originalAssertions: [
      'd9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20',
      'd696de4b30ced760a21b7af6501cc276cd13a46eecce44f1f74cba88b76017f6',
      'd6524051fc1534dc716e05652061eac6d83ada765641e6e0a3bf60cf2702c910',
    ],
    originalBodyAstSha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
        selectedCallbackSha256: '12340314d1f3b8ae949aa6f00f809a93fbd6ee8bb6f844f800a38a528b415e97',
        selectedAssertionHashes: ['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20'],
        surroundingStatementHashes: [
          'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
          '848f09b974607cd8e2c4b195a9256f3b5d4f70b9e29cd391ca438049e4c35b5d',
          'e92b84cd100dec8e0174c55dc82039e72119a9741bca1ed06598e90ee4bc3e57',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
        selectedCallbackSha256: '55b52cecdec5be4077408ff7cea5c0f5bf5331c582abb402b6742c95553e11c6',
        selectedAssertionHashes: [
          '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
          '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
          'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
          '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
          '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
        ],
        surroundingStatementHashes: [
          'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
          '1c9ac9cb640a04f447f8578b4f719ba882e7e657340fb72f02fbc1d74f8ee34a',
          'dd5d4cac2aeb995373705ab9a950e1107ce03884ce584f50f23f37129101e849',
          '8794650311cde38e587c77490eb1b052ae0ae99fb2be674380eb790752cd3648',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
        selectedCallbackSha256: 'd3fee4218bdaade80b39e7dc2d6e5b142e8a54cbe048ac2576dcd5023d8f207d',
        selectedAssertionHashes: [
          '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
          'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
          '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
          '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
        ],
        surroundingStatementHashes: [
          '3840a3ce0e021dd65cd389f2997ab64b1cbc56bb6a21002a2ea799e4cef9e85d',
          'c2747c1313dd8d84482f524b740cec816d0ee78155cd67f9819330b4364bd47b',
          '3f5927190358e3dad2868037047352eaba08ab71d8c5ddb94320dc67b04dfd71',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
        selectedCallbackSha256: '76907019e385c858c3fb6bae2487dcbc63f19dd0b4d4ca11ceccea937fe16ecb',
        selectedAssertionHashes: ['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b'],
        surroundingStatementHashes: [
          'ef6c5f94853fab3f32775501e1a0fe592a4b75cd2c10ea4d986e05d3c9fe4b13',
          '9c5a8fdc336078a807f6fe9faf7e7ab1f46a29337b2db8a1892af44201641149',
          '5b39bbe5f38b7eacd025834f3f57d62dc0a588dc79a21a80c946fa593450e32c',
        ],
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
          title: 'capture, raw, comment and member-path assignment',
        },
      ],
      casesSha256: '0c2d2970080891b0ac0e102d855631e5d34d3af7618d53e33a8dcc8075b0cd8f',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
        sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-liquid-061',
            pointer: '/captures/0/cases/60/facts',
            sha256: 'b4dcd171250deea306f5d0c9841271ba2dd8237345b9ab1d07dd0928ceaa1bcb',
            replicatedPointers: ['/captures/0/cases/60/facts', '/captures/1/cases/60/facts'],
          },
        ],
      },
    ],
    regionHashes: [['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20']],
    regionFactIds: [[['native-original-liquid-061']]],
  },
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '56e8e232749c0c087ef5756132cbb3e74ff752e47692c5755ea8615fbb49872f',
    originalAssertions: [
      '953a5584ae8dd7bd0b7231a3509035c4ee4c56d7b2c3aea4fbe23564dacde321',
      '18e262d24db43c043d11f4888d068c378b2c4b98a3aae1855d84b8a8c7de3d7d',
      '6862fc15d5e51c3df7c9a6b869a9b7ac1cb17b85406ddaafc36dfde7f060adc8',
      '82328fb3a623ce58e1783540126d05de02ed764240ab9b26a8396b703d4ee858',
      '0713038419ac15dfcd81cb68fc84b3638ca6bd2e1c3e0588a79b3f33361e8f97',
      '9fb0848bad264996f0f86839abf1a294c54bef782e2b83db0eeddcdf8f402b64',
      'b747d855cef7d53b40a5a6ba2f45408a17702419b5427c2df8ebe0626f5458b2',
      '965d4cd3a2c9bc119d8837e1b6b76c204d5db4b9adba3102a01c968070a98a1d',
      'fdfe1d7b57cab51fbb6fa7595d97410d5fbd0ea3d0bbae25d711cc40fbc921ea',
      '400ebc629bf14ea01145b11050eef4a969f9ab83a47a2b12092413bda4c7497f',
      '07c6afd3f3f4d2d63d14ef1419c3cb79e12c00b34d771fd73ece8c8ce4b98b59',
      '4e6460ed11163b1e04e72a8cec267a4da53efc4b9e34b5e27dcd94e7aafec59a',
      'a618bcafa918bf60117474a2ac0e82db0b19d7dc8adee9b02d47dbf48453e96f',
      '55a3cc8adcec41636d9011107eb1421d6835669a558f55e0ef2f21cee9aac7f0',
      'e7ab52fc18dca40f597c349be57d8687aa22e5b8815790da0479039b58b6376b',
      '765022759dd092414bbff48339d8cc71270aa2fc99b5ca1cba82ce852081f052',
    ],
    originalBodyAstSha256: '230896aa5285a7f734dddde8fd951a92f932a01ecdc6279f1fe8a5509abf1d71',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
          title: 'string and escape filters match .NET encoders',
        },
      ],
      casesSha256: '5cc3938958f6c942bacb98468671eaccdbda6072dd965767213f033e54d800ea',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
        sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-context-007',
            pointer: '/captures/0/cases/6/facts',
            sha256: 'd3636841603f18b3fefbaa1e18e94c0a12a306b5a490b47e6a755dd55d384f81',
            replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
          },
          {
            id: 'native-original-context-008',
            pointer: '/captures/0/cases/7/facts',
            sha256: '3cb314a536e5d75fe09ecf8598bcdc920937a2e563cf28560572b1fb398f584f',
            replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
          },
          {
            id: 'native-original-context-009',
            pointer: '/captures/0/cases/8/facts',
            sha256: '6fa538c5126b2433adfd321113894c417e14d013027adc025c3b21cdfa77516f',
            replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
          },
          {
            id: 'native-original-context-011',
            pointer: '/captures/0/cases/10/facts',
            sha256: '38839d81653ab5f5aa14eb5847ae5f1d53e641a28f10a4dfaefb29eae9bf6a9d',
            replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
          },
          {
            id: 'native-original-context-012',
            pointer: '/captures/0/cases/11/facts',
            sha256: '965b80b8d0149b1768e8d3c46d2f68bee302e8b141a8d3f91b25a68afb9f5e1c',
            replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
          },
          {
            id: 'native-original-context-017',
            pointer: '/captures/0/cases/16/facts',
            sha256: 'fd27ab4a2809590aa83f0bdee6b98423176c042c73c194ecf08c089cda7999ec',
            replicatedPointers: ['/captures/0/cases/16/facts', '/captures/1/cases/16/facts'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
        sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-liquid-062',
            pointer: '/captures/0/cases/61/facts',
            sha256: 'd641bbd4237dec845ea3d87b93f107fa0f6024d5c01fd48aa80c463ab76dc181',
            replicatedPointers: ['/captures/0/cases/61/facts', '/captures/1/cases/61/facts'],
          },
          {
            id: 'native-original-liquid-063',
            pointer: '/captures/0/cases/62/facts',
            sha256: 'c0291b114bb6b32a26a189bcf53a85bab9dda711cc161446a1bf6dbbe2e3595a',
            replicatedPointers: ['/captures/0/cases/62/facts', '/captures/1/cases/62/facts'],
          },
          {
            id: 'native-original-liquid-064',
            pointer: '/captures/0/cases/63/facts',
            sha256: '55f8b3ee61047fd18efd009304f45e4db8fb7faf169c51df9b30a18cf8c92ae9',
            replicatedPointers: ['/captures/0/cases/63/facts', '/captures/1/cases/63/facts'],
          },
          {
            id: 'native-original-liquid-065',
            pointer: '/captures/0/cases/64/facts',
            sha256: 'd9db29e0ccdd3086868056a8adc9f176318a88f14e9dc6c4bec3ec025c5b307c',
            replicatedPointers: ['/captures/0/cases/64/facts', '/captures/1/cases/64/facts'],
          },
          {
            id: 'native-original-liquid-066',
            pointer: '/captures/0/cases/65/facts',
            sha256: '4590e739fa6fb92f15920752f45739b1dce93d735c5bc713608f13d4beef104b',
            replicatedPointers: ['/captures/0/cases/65/facts', '/captures/1/cases/65/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        '953a5584ae8dd7bd0b7231a3509035c4ee4c56d7b2c3aea4fbe23564dacde321',
        '18e262d24db43c043d11f4888d068c378b2c4b98a3aae1855d84b8a8c7de3d7d',
        '6862fc15d5e51c3df7c9a6b869a9b7ac1cb17b85406ddaafc36dfde7f060adc8',
      ],
      [
        '0713038419ac15dfcd81cb68fc84b3638ca6bd2e1c3e0588a79b3f33361e8f97',
        '9fb0848bad264996f0f86839abf1a294c54bef782e2b83db0eeddcdf8f402b64',
        'b747d855cef7d53b40a5a6ba2f45408a17702419b5427c2df8ebe0626f5458b2',
        '965d4cd3a2c9bc119d8837e1b6b76c204d5db4b9adba3102a01c968070a98a1d',
      ],
      [
        'a618bcafa918bf60117474a2ac0e82db0b19d7dc8adee9b02d47dbf48453e96f',
        '55a3cc8adcec41636d9011107eb1421d6835669a558f55e0ef2f21cee9aac7f0',
        'e7ab52fc18dca40f597c349be57d8687aa22e5b8815790da0479039b58b6376b',
        '765022759dd092414bbff48339d8cc71270aa2fc99b5ca1cba82ce852081f052',
      ],
    ],
    regionFactIds: [
      [['native-original-context-007'], ['native-original-context-008'], ['native-original-context-009']],
      [
        ['native-original-liquid-062'],
        ['native-original-liquid-063'],
        ['native-original-context-011'],
        ['native-original-context-012'],
      ],
      [
        ['native-original-context-017'],
        ['native-original-liquid-064'],
        ['native-original-liquid-065'],
        ['native-original-liquid-066'],
      ],
    ],
  },
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '67d55aa4ee1371ffd9030296253b73b453bad2178ace16218c9f2a4e5675021c',
    originalAssertions: [
      '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
      '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
      'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
      '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
      '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
      '7b7c4c7aed6a9033a79a1d2d571cc4b963e33b3cab7071063d5ff6574d4145ad',
      '0d67ece8e9fb97b6b18159be923d8030c5931d37ba3d1f2f1f91abfc9badea63',
    ],
    originalBodyAstSha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
        selectedCallbackSha256: '12340314d1f3b8ae949aa6f00f809a93fbd6ee8bb6f844f800a38a528b415e97',
        selectedAssertionHashes: ['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20'],
        surroundingStatementHashes: [
          'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
          '848f09b974607cd8e2c4b195a9256f3b5d4f70b9e29cd391ca438049e4c35b5d',
          'e92b84cd100dec8e0174c55dc82039e72119a9741bca1ed06598e90ee4bc3e57',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
        selectedCallbackSha256: '55b52cecdec5be4077408ff7cea5c0f5bf5331c582abb402b6742c95553e11c6',
        selectedAssertionHashes: [
          '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
          '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
          'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
          '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
          '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
        ],
        surroundingStatementHashes: [
          'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
          '1c9ac9cb640a04f447f8578b4f719ba882e7e657340fb72f02fbc1d74f8ee34a',
          'dd5d4cac2aeb995373705ab9a950e1107ce03884ce584f50f23f37129101e849',
          '8794650311cde38e587c77490eb1b052ae0ae99fb2be674380eb790752cd3648',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
        selectedCallbackSha256: 'd3fee4218bdaade80b39e7dc2d6e5b142e8a54cbe048ac2576dcd5023d8f207d',
        selectedAssertionHashes: [
          '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
          'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
          '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
          '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
        ],
        surroundingStatementHashes: [
          '3840a3ce0e021dd65cd389f2997ab64b1cbc56bb6a21002a2ea799e4cef9e85d',
          'c2747c1313dd8d84482f524b740cec816d0ee78155cd67f9819330b4364bd47b',
          '3f5927190358e3dad2868037047352eaba08ab71d8c5ddb94320dc67b04dfd71',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
        selectedCallbackSha256: '76907019e385c858c3fb6bae2487dcbc63f19dd0b4d4ca11ceccea937fe16ecb',
        selectedAssertionHashes: ['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b'],
        surroundingStatementHashes: [
          'ef6c5f94853fab3f32775501e1a0fe592a4b75cd2c10ea4d986e05d3c9fe4b13',
          '9c5a8fdc336078a807f6fe9faf7e7ab1f46a29337b2db8a1892af44201641149',
          '5b39bbe5f38b7eacd025834f3f57d62dc0a588dc79a21a80c946fa593450e32c',
        ],
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
          title: 'type, number-format and additional filters follow Adxstudio',
        },
      ],
      casesSha256: '8007292caabf6c6e030a48ca66b39a669557f6d4e39cd5d075d0462258d71ac7',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
        sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-liquid-067',
            pointer: '/captures/0/cases/66/facts',
            sha256: 'f1b8422c416ffcbb5da56cf912096e3c2f804135cf25efac484e3c8ae5e398fe',
            replicatedPointers: ['/captures/0/cases/66/facts', '/captures/1/cases/66/facts'],
          },
          {
            id: 'native-original-liquid-068',
            pointer: '/captures/0/cases/67/facts',
            sha256: 'a56148bc3e89e627204e9208350675caef0426a342280831cee54607390e65fd',
            replicatedPointers: ['/captures/0/cases/67/facts', '/captures/1/cases/67/facts'],
          },
          {
            id: 'native-original-liquid-069',
            pointer: '/captures/0/cases/68/facts',
            sha256: '4113ed0c45bd3cb76af4c5040102c9a292c8f6c5028cd5d16bd986a33c7ffff6',
            replicatedPointers: ['/captures/0/cases/68/facts', '/captures/1/cases/68/facts'],
          },
          {
            id: 'native-original-liquid-070',
            pointer: '/captures/0/cases/69/facts',
            sha256: 'a58547fb439f7ed910f25eb40730a7db2c7f2b3714cf0116072fc791d31df909',
            replicatedPointers: ['/captures/0/cases/69/facts', '/captures/1/cases/69/facts'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
        sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-context-018',
            pointer: '/captures/0/cases/17/facts',
            sha256: '5201e2ac07cb1f00f74214df33107d02b316dead4a658e1137cdf48999fe9dd0',
            replicatedPointers: ['/captures/0/cases/17/facts', '/captures/1/cases/17/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
        '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
        'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
        '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
        '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
      ],
    ],
    regionFactIds: [
      [
        ['native-original-liquid-067'],
        ['native-original-liquid-068'],
        ['native-original-liquid-069'],
        ['native-original-context-018'],
        ['native-original-liquid-070'],
      ],
    ],
  },
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'ac8f2f688ec3f38522681a33401dfa1fe5e70bb924fdee384d08379e812d3b45',
    originalAssertions: [
      '0b419c1aa78ade10b7e03d9c57e970a57d1e803c1ba29e33f5c2175aff226602',
      '4d17ba6e4d9f8e64a9bf9f10613ae8e0bbe915b121b3455f8f810347916a91ac',
      '02189ee58243b2a7082fac5e939801216e1dd6ca02fd1f659d26724c282fab2b',
    ],
    originalBodyAstSha256: 'e7c2c5e1d7cb721538a277a84e68277e44c4f1e35494d55345b70af503de4ee9',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
          title: 'URL filters keep absolute and relative forms',
        },
      ],
      casesSha256: '92a46e6b9cde3e6a6b6ab0014934eed9501ffb8ae9037161f35c7a5d12acfe7f',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
        sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-liquid-071',
            pointer: '/captures/0/cases/70/facts',
            sha256: 'b2b7f4c28f44bd55eeff52ed2fd780310bf0da595d566989a7bde6a9e22a50a4',
            replicatedPointers: ['/captures/0/cases/70/facts', '/captures/1/cases/70/facts'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
        sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-context-020',
            pointer: '/captures/0/cases/19/facts',
            sha256: '06c5854c008dfece49133517a511f43091f9c0ec1afd5e7b5845910867683f4b',
            replicatedPointers: ['/captures/0/cases/19/facts', '/captures/1/cases/19/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      ['0b419c1aa78ade10b7e03d9c57e970a57d1e803c1ba29e33f5c2175aff226602'],
      ['02189ee58243b2a7082fac5e939801216e1dd6ca02fd1f659d26724c282fab2b'],
    ],
    regionFactIds: [[['native-original-liquid-071']], [['native-original-context-020']]],
  },
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'fa3794dffd0fac28dc1a6a1ddb7c71062ace8eb2f6633c49e12ef92b3e0d7129',
    originalAssertions: [
      '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
      'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
      '3c09da41fff72113f93f3499024216206bd630b10106512132f2a20d36702ac7',
      '4f9097f0e4d6033b0e94b87132f77d404c46045ce18328cb237787caf1f042da',
      '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
      '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
      '1a4b9388af0cd20e8d8fbd5e63292e52d275000a3acd2c054cb935ea616b20f0',
    ],
    originalBodyAstSha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
        selectedCallbackSha256: '12340314d1f3b8ae949aa6f00f809a93fbd6ee8bb6f844f800a38a528b415e97',
        selectedAssertionHashes: ['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20'],
        surroundingStatementHashes: [
          'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
          '848f09b974607cd8e2c4b195a9256f3b5d4f70b9e29cd391ca438049e4c35b5d',
          'e92b84cd100dec8e0174c55dc82039e72119a9741bca1ed06598e90ee4bc3e57',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
        selectedCallbackSha256: '55b52cecdec5be4077408ff7cea5c0f5bf5331c582abb402b6742c95553e11c6',
        selectedAssertionHashes: [
          '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
          '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
          'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
          '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
          '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
        ],
        surroundingStatementHashes: [
          'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
          '1c9ac9cb640a04f447f8578b4f719ba882e7e657340fb72f02fbc1d74f8ee34a',
          'dd5d4cac2aeb995373705ab9a950e1107ce03884ce584f50f23f37129101e849',
          '8794650311cde38e587c77490eb1b052ae0ae99fb2be674380eb790752cd3648',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
        selectedCallbackSha256: 'd3fee4218bdaade80b39e7dc2d6e5b142e8a54cbe048ac2576dcd5023d8f207d',
        selectedAssertionHashes: [
          '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
          'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
          '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
          '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
        ],
        surroundingStatementHashes: [
          '3840a3ce0e021dd65cd389f2997ab64b1cbc56bb6a21002a2ea799e4cef9e85d',
          'c2747c1313dd8d84482f524b740cec816d0ee78155cd67f9819330b4364bd47b',
          '3f5927190358e3dad2868037047352eaba08ab71d8c5ddb94320dc67b04dfd71',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
        selectedCallbackSha256: '76907019e385c858c3fb6bae2487dcbc63f19dd0b4d4ca11ceccea937fe16ecb',
        selectedAssertionHashes: ['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b'],
        surroundingStatementHashes: [
          'ef6c5f94853fab3f32775501e1a0fe592a4b75cd2c10ea4d986e05d3c9fe4b13',
          '9c5a8fdc336078a807f6fe9faf7e7ab1f46a29337b2db8a1892af44201641149',
          '5b39bbe5f38b7eacd025834f3f57d62dc0a588dc79a21a80c946fa593450e32c',
        ],
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
          title:
            'filter arguments follow the Strainer: a missing parameter without a default and surplus arguments raise inline errors',
        },
      ],
      casesSha256: 'f5a4df733b0cdbf11dad111cc007b2ed2b327856be8eb557409e8e62c640d243',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
        sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-liquid-075',
            pointer: '/captures/0/cases/74/facts',
            sha256: 'c05f997680c4d0e0c6bd6844358ae82c2295f286cd7ccefea7943e44095d67e1',
            replicatedPointers: ['/captures/0/cases/74/facts', '/captures/1/cases/74/facts'],
          },
          {
            id: 'native-original-liquid-076',
            pointer: '/captures/0/cases/75/facts',
            sha256: '32d778a07ec0a0addd53d013d5e4d8c2c141623ad7f1f796d6bab3a26e04fb74',
            replicatedPointers: ['/captures/0/cases/75/facts', '/captures/1/cases/75/facts'],
          },
          {
            id: 'native-original-liquid-077',
            pointer: '/captures/0/cases/76/facts',
            sha256: '7c4b2aa86103a9d0270579c94a5619e4a9485ce2c3f43039555f516bfe4ed9b7',
            replicatedPointers: ['/captures/0/cases/76/facts', '/captures/1/cases/76/facts'],
          },
          {
            id: 'native-original-liquid-078',
            pointer: '/captures/0/cases/77/facts',
            sha256: '9a763d1be73d59d67cbce74848c4e8cc2ee7fed5a2c841c4658b8c7559f26622',
            replicatedPointers: ['/captures/0/cases/77/facts', '/captures/1/cases/77/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
        'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
      ],
      [
        '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
        '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
      ],
    ],
    regionFactIds: [
      [['native-original-liquid-075'], ['native-original-liquid-076']],
      [['native-original-liquid-077'], ['native-original-liquid-078']],
    ],
  },
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'c822287610443bad3bf2d44fde5e405455f6fa86d5b0e99854a14f2ec2f92b36',
    originalAssertions: [
      '4e7f0b71a2fa25eadec877f907f8a4df0e6f2408a9c5dfd8ad7fdce89342f64d',
      '4299ee9c7c46b602b26487510ca7dc6928c1086b420bc4057b55adfdea79473b',
      '8af6e808bc2a6081f3f4e05fdb7794ab993f630ed2fd374123c3ded3934477e4',
      '628b25bda2ec21cc08fade77be49f2f1b7be126de7ffce11707d1da334c4c9c0',
      'dce1a97b90710356da516938ad43f6d68be7447052cbb32d47061c1cbf8523eb',
      '8edeab3e179bd5af5dc76991f7eb4900691d8a3cefbdb97a0abb458a830a2120',
      '97428241e76142c9beca1e8e0f40e7245571a151b6516e8acc4b394337115925',
      'b47190618e1a35c94ba1fa217e4aa1cc65ec9978d0c76c5a8a5369df81c74563',
      '8cede2bb78116415c2c34a0cc60eca5ebdde90cafee7fb4467a4d57026cef13e',
    ],
    originalBodyAstSha256: '458e1c89b1ed4c40474f18e5a1819a271f7d5a80755ba59c5f495cf90bfd7b1c',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
          title:
            'capture names, root brackets, nil string operands, sort comparison and round digits follow DotLiquid master and Adxstudio',
        },
      ],
      casesSha256: '206a5073f987463ce5938be0c3fa06c110bd7cb41206d3ab7d4294cd767a24e8',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
        sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-liquid-081',
            pointer: '/captures/0/cases/80/facts',
            sha256: '7b8d31287da22a6b695ed0204ce144a67ec706046973d8d4e212595ea118fe0e',
            replicatedPointers: ['/captures/0/cases/80/facts', '/captures/1/cases/80/facts'],
          },
          {
            id: 'native-original-liquid-082',
            pointer: '/captures/0/cases/81/facts',
            sha256: '118a4b3b74719c202596ad8ae7a1410032f84c346579e18e9c2a4b4c9db52485',
            replicatedPointers: ['/captures/0/cases/81/facts', '/captures/1/cases/81/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        'b47190618e1a35c94ba1fa217e4aa1cc65ec9978d0c76c5a8a5369df81c74563',
        '8cede2bb78116415c2c34a0cc60eca5ebdde90cafee7fb4467a4d57026cef13e',
      ],
    ],
    regionFactIds: [[['native-original-liquid-081'], ['native-original-liquid-082']]],
  },
  {
    baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '93cef513f7e0cb4141d4db790db2006b3e53f473300d95f79153835edf146ef6',
    originalAssertions: [
      '521907daa4560057042fdc528864c3e786dd9920f0a70ff37230cac8164febeb',
      'c881f3540701130c2cd26918dc398bc5fa22054527e332f2fdc0ba00868cc754',
      '4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b',
    ],
    originalBodyAstSha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
    originalGuardHashes: [],
    moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
    isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
    moduleReview: {
      reviewedBy: '/root',
      reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
          bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
          bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
        {
          titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
          bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root',
          reason: 'Fixture slice independently proves isolation from selected renderer.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
          oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
          currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
          oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
          currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
        {
          titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
          oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
          currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          zeroSelectedCredit: true,
          reviewedBy: '/root/liquid_remediation',
          reason:
            'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root',
          reason: 'Independently reviewed source slice excludes this change.',
          astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
        },
      ],
    },
    importRoles: [
      {
        source: 'parse5',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/importer.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data-error.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-filters.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/render-sweep-body.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../liquid-inventory.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../render-sweep.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../testing/owned-fixture.mjs',
        role: 'test-input',
        reviewedBy: '/root/frontend',
        reason:
          'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
      },
    ],
    runtimeInputs: [],
    lateImports: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
        importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
        source: '../lib/project-config.mjs',
        role: 'post-selected-isolated',
        reviewedBy: '/root',
        reason: 'Sequential later registration executes only after selected assertion completes.',
      },
    ],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
        selectedCallbackSha256: '12340314d1f3b8ae949aa6f00f809a93fbd6ee8bb6f844f800a38a528b415e97',
        selectedAssertionHashes: ['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20'],
        surroundingStatementHashes: [
          'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
          '848f09b974607cd8e2c4b195a9256f3b5d4f70b9e29cd391ca438049e4c35b5d',
          'e92b84cd100dec8e0174c55dc82039e72119a9741bca1ed06598e90ee4bc3e57',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
        selectedCallbackSha256: '55b52cecdec5be4077408ff7cea5c0f5bf5331c582abb402b6742c95553e11c6',
        selectedAssertionHashes: [
          '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
          '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
          'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
          '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
          '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
        ],
        surroundingStatementHashes: [
          'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
          '1c9ac9cb640a04f447f8578b4f719ba882e7e657340fb72f02fbc1d74f8ee34a',
          'dd5d4cac2aeb995373705ab9a950e1107ce03884ce584f50f23f37129101e849',
          '8794650311cde38e587c77490eb1b052ae0ae99fb2be674380eb790752cd3648',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
        selectedCallbackSha256: 'd3fee4218bdaade80b39e7dc2d6e5b142e8a54cbe048ac2576dcd5023d8f207d',
        selectedAssertionHashes: [
          '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
          'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
          '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
          '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
        ],
        surroundingStatementHashes: [
          '3840a3ce0e021dd65cd389f2997ab64b1cbc56bb6a21002a2ea799e4cef9e85d',
          'c2747c1313dd8d84482f524b740cec816d0ee78155cd67f9819330b4364bd47b',
          '3f5927190358e3dad2868037047352eaba08ab71d8c5ddb94320dc67b04dfd71',
        ],
      },
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
        bootstrap: {
          declarations: [
            'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
            '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
            'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
            '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
            'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
            'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
            '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
            '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
            'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
            'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
            '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
            '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
          ],
        },
        plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
        fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
        mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        isolatedFsCount: 18,
        selectedBodySha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
        selectedCallbackSha256: '76907019e385c858c3fb6bae2487dcbc63f19dd0b4d4ca11ceccea937fe16ecb',
        selectedAssertionHashes: ['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b'],
        surroundingStatementHashes: [
          'ef6c5f94853fab3f32775501e1a0fe592a4b75cd2c10ea4d986e05d3c9fe4b13',
          '9c5a8fdc336078a807f6fe9faf7e7ab1f46a29337b2db8a1892af44201641149',
          '5b39bbe5f38b7eacd025834f3f57d62dc0a588dc79a21a80c946fa593450e32c',
        ],
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/testing/owned-fixture.mjs',
        sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
          title: 'date filters use en-US .NET formats on UTC values',
        },
      ],
      casesSha256: 'e3d630ccb79c408c992113f410b7b36203366bf5cec49c5a1c1b3215730bacd6',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
        sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-original-context-019',
            pointer: '/captures/0/cases/18/facts',
            sha256: '2c84db21951dd9113718ae46b7fcc90856a9f824b1ad72cf52434f73e9721795',
            replicatedPointers: ['/captures/0/cases/18/facts', '/captures/1/cases/18/facts'],
          },
        ],
      },
    ],
    regionHashes: [['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b']],
    regionFactIds: [[['native-original-context-019']]],
  },
]);
// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.

import {
  assertParityBindings as __paqParityBindings,
  assertParityBindingsFromSource as __paqParitySourceBindings,
} from '../../scripts/qualify-parity.mjs';
// Power Pages Liquid compatibility. Expected values follow DotLiquid (master sources at
// SyntaxCompatibility.DotLiquid20), the Adxstudio Liquid layer (MIT ADX sources: Web/Mvc/Liquid,
// Cms/*DataAdapter.cs) and the documented examples; mirage/docs/liquid-parity.md lists the
// source of each behaviour and the items that still need a live observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { importPortal } from '../lib/importer.mjs';
import { DataError } from '../lib/data-error.mjs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { FILTER_SIGNATURES, createFilters } from '../lib/liquid-filters.mjs';
import { retainedResponseBody } from '../lib/render-sweep-body.mjs';
import { expressionPaths, inventoryPortal, scanTokens } from '../liquid-inventory.mjs';
import { ciSummary, classifyResponse, idParameterTable, renderSweep, resolveTarget } from '../render-sweep.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '9a4d1c2e-0000-4000-8000-000000000001';
const HOME = '9a4d1c2e-0000-4000-8000-000000000010';
const CHILD = '9a4d1c2e-0000-4000-8000-000000000011';
const MAIN = '9a4d1c2e-0000-4000-8000-000000000020';
const CONTACT = '9a4d1c2e-0000-4000-8000-0000000000c1';
const AD = '9a4d1c2e-0000-4000-8000-0000000000a1';
const AD_PLACEMENT = '9a4d1c2e-0000-4000-8000-0000000000a3';
const POLL = '9a4d1c2e-0000-4000-8000-0000000000b1';
const POLL_PLACEMENT = '9a4d1c2e-0000-4000-8000-0000000000b5';
const NOW = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));

const template = (id, name, source) => ({
  [`web-templates/${id}/${name}.webtemplate.yml`]: `adx_webtemplateid: 9a4d1c2e-0000-4000-8000-0000000003${id}\nadx_name: ${name}`,
  [`web-templates/${id}/${name}.webtemplate.source.html`]: source,
});
const files = {
  'website.yml': `adx_websiteid: ${SITE}\nadx_name: Parity\nadx_defaultlanguage: 9a4d1c2e-0000-4000-8000-0000000000aa`,
  'websitelanguage.yml': '- adx_websitelanguageid: 9a4d1c2e-0000-4000-8000-0000000000aa\n  adx_name: English',
  'web-pages/home/Home.webpage.yml': `adx_webpageid: ${HOME}\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: ${MAIN}`,
  'web-pages/child/Child.webpage.yml': `adx_webpageid: ${CHILD}\nadx_name: Child\nadx_title: Child title\nadx_parentpageid: ${HOME}\nadx_partialurl: child\nadx_pagetemplateid: ${MAIN}`,
  'web-pages/child/Child.webpage.copy.html': '<p>{{ page.title }}</p>',
  'page-templates/Main.pagetemplate.yml': `adx_pagetemplateid: ${MAIN}\nadx_name: Main\nadx_usewebsiteheaderandfooter: false\nadx_webtemplateid: 9a4d1c2e-0000-4000-8000-000000000301`,
  ...template('01', 'Main', "<!doctype html><html><body>{% include 'Page Copy' %}</body></html>"),
  ...template('02', 'Row', '{{ label }}'),
  ...template('03', 'Layout', '<article>{% block main %}default{% endblock %}</article>'),
  ...template('04', 'Child', "{% extends 'Layout' %}{% block main %}{% include 'Row' label: 'Output' %}{% endblock %}"),
  ...template('05', 'Broken', 'before{% if %}after'),
  ...template('06', 'item', '[{{ item }}]'),
  'content-snippets/plain/Plain.contentsnippet.yml':
    'adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000040\nadx_name: Plain',
  'content-snippets/plain/Plain.contentsnippet.value.html': 'Plain <b>text</b>',
  'content-snippets/liquid/Liquid.contentsnippet.yml':
    'adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000041\nadx_name: Liquid',
  'content-snippets/liquid/Liquid.contentsnippet.value.html': 'Sum {{ 1 | plus: 1 }}',
  'sitesetting.yml':
    "- adx_name: Search/Enabled\n  adx_value: 'true'\n- adx_name: Custom/Value\n  adx_value: abc\n- adx_name: DateTime/DateFormat\n  adx_value: dd/MM/yyyy\n- adx_name: DateTime/DateTimeFormat\n  adx_value: dd/MM/yyyy HH:MM",
  'web-pages/grand/Grand.webpage.yml': `adx_webpageid: 9a4d1c2e-0000-4000-8000-000000000012\nadx_name: Grand\nadx_title: Grand title\nadx_parentpageid: ${CHILD}\nadx_partialurl: grand\nadx_pagetemplateid: 9a4d1c2e-0000-4000-8000-000000000021`,
  'web-pages/grand/Grand.webpage.copy.html': '<p>Grand copy</p>',
  'page-templates/Shell.pagetemplate.yml':
    'adx_pagetemplateid: 9a4d1c2e-0000-4000-8000-000000000021\nadx_name: Shell\nadx_usewebsiteheaderandfooter: true\nadx_webtemplateid: 9a4d1c2e-0000-4000-8000-000000000308',
  ...template('08', 'Shell Content', "{% include 'Page Copy' %}"),
  'content-snippets/suffix/Suffix.contentsnippet.yml':
    'adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000042\nadx_name: Browser Title Suffix',
  'content-snippets/suffix/Suffix.contentsnippet.value.html': '&nbsp;· Parity',
  'content-snippets/self/Self.contentsnippet.yml':
    'adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000043\nadx_name: Self',
  'content-snippets/self/Self.contentsnippet.value.html': "a{{ snippets['Self'] }}b",
  'sitemarker.yml': `- adx_name: Child Marker\n  adx_pageid: ${CHILD}\n  adx_sitemarkerid: 9a4d1c2e-0000-4000-8000-000000000050`,
  'weblink-sets/nav/Nav.weblinkset.yml':
    'adx_weblinksetid: 9a4d1c2e-0000-4000-8000-000000000060\nadx_name: Primary Navigation',
  'weblink-sets/nav/Nav.weblinkset.weblink.yml': `- adx_weblinkid: 9a4d1c2e-0000-4000-8000-000000000061\n  adx_name: Child link\n  adx_pageid: ${CHILD}\n  adx_weblinksetid: 9a4d1c2e-0000-4000-8000-000000000060\n  adx_displayorder: 1`,
  'publishingstate.yml':
    '- adx_publishingstateid: 9a4d1c2e-0000-4000-8000-0000000000f1\n  adx_name: Published\n  adx_isvisible: true\n- adx_publishingstateid: 9a4d1c2e-0000-4000-8000-0000000000f2\n  adx_name: Draft\n  adx_isvisible: false',
  'ad.yml': [
    `- adx_adid: ${AD}`,
    '  adx_name: Visible Ad',
    '  adx_title: Ad title',
    '  adx_copy: <p>Copy</p>',
    '  adx_url: ~/child/',
    '  adx_image: ~/banner.png',
    '  adx_imagealttext: Banner',
    '  adx_imageheight: 50',
    '  adx_imagewidth: 100',
    '  adx_openinnewwindow: true',
    '  adx_publishingstateid: 9a4d1c2e-0000-4000-8000-0000000000f1',
    '- adx_adid: 9a4d1c2e-0000-4000-8000-0000000000a2',
    '  adx_name: Draft Ad',
    '  adx_publishingstateid: 9a4d1c2e-0000-4000-8000-0000000000f2',
  ].join('\n'),
  'adplacement.yml': `- adx_adplacementid: ${AD_PLACEMENT}\n  adx_name: Sidebar\n  adx_adplacement_ad:\n  - ${AD}\n  - 9a4d1c2e-0000-4000-8000-0000000000a2`,
  'polls/sample/Sample.poll.yml': `adx_pollid: ${POLL}\nadx_name: Sample\nadx_question: Which?\nadx_submitbuttonlabel: Vote`,
  'polls/sample/Sample.poll.polloption.yml': `- adx_polloptionid: 9a4d1c2e-0000-4000-8000-0000000000b2\n  adx_name: Yes\n  adx_answer: Yes\n  adx_pollid: ${POLL}\n  adx_votes: 3\n- adx_polloptionid: 9a4d1c2e-0000-4000-8000-0000000000b3\n  adx_name: No\n  adx_answer: No\n  adx_pollid: ${POLL}\n  adx_votes: 1`,
  'polls/old/Old.poll.yml':
    'adx_pollid: 9a4d1c2e-0000-4000-8000-0000000000b4\nadx_name: Old\nadx_expirationdate: 2020-01-01T00:00:00Z',
  'poll-placements/Sidebar.pollplacement.yml': `adx_pollplacementid: ${POLL_PLACEMENT}\nadx_name: Sidebar\nadx_pollplacement_poll:\n- ${POLL}\n- 9a4d1c2e-0000-4000-8000-0000000000b4`,
};

async function fixturePortal(t, extra = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'liquid-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ ...files, ...extra })) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return importPortal(dir);
}

/** Renderer over the fixture; render(source, extra, url) returns { html, diagnostics }. */
async function setup(t, options = {}, extraFiles = {}) {
  const portal = await fixturePortal(t, extraFiles);
  const renderer = createPortalRenderer(portal, {
    entity: async (table, id) =>
      table === 'contact' && id === CONTACT ? { contactid: id, fullname: 'Ada', Mixed: 'case' } : null,
    ...options,
  });
  const child = portal.pages.find((page) => page.url === '/child/');
  const render = async (source, extra = {}, url = '/child/') => {
    const context = renderer.contextForPage(child, url, { now: NOW, ...extra });
    const html = await renderer.renderString(source, context);
    return { html, diagnostics: context.__diagnostics };
  };
  return { portal, renderer, render, child };
}

/** Plain renderer without a page context. */
function plain() {
  const renderer = createPortalRenderer({
    templates: {},
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    records: [],
    weblinks: {},
    sitemarkers: {},
    website: {},
    pageTemplates: [],
  });
  return (source, data = {}) => renderer.renderString(source, data);
}

/** Native captures execute each literal expression inside an included source template. */
function nativeInclude() {
  return (source, data = {}) =>
    createPortalRenderer(
      {
        templates: { proof: { id: 'proof', name: 'proof', source } },
        snippets: {},
        settings: {},
        pages: [],
        webFiles: [],
        records: [],
        weblinks: {},
        sitemarkers: {},
        website: {},
        pageTemplates: [],
      },
      {
        observed: {
          liquidRuntimeCompatibility: 'observed',
          liquidFilterErrors: 'observed',
          liquidHtmlVoidSerialization: 'html',
          liquidPathAndQueryFragment: 'query',
          evidence: 'Repeated native 2026-11-08 language include captures; frontend-parity-evidence.json.',
        },
      },
    ).renderString("{% include 'proof' %}", data);
}

// @test-kind parity: all four literal assertions reproduced in two native Power Pages captures on 2026-11-08; language-0 through language-3 in mirage/test/fixtures/frontend-parity-evidence.md.
test('DotLiquid20 whitespace control trims spaces and tabs before a tag and one newline or blank run after it', async () => {
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/liquid-portal-parity.test.mjs:143:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '78a04a91dc568469b70b152d86b104bc853a2f927549753a2d9a38e260147e5d',
      originalAssertions: [
        '0a24912e3007bf3e85647e8adcce043e20fc08dac0ef0d82dc517e624765390a',
        'e0aed56ce6a43a7e68eb6d5262a9bb74ae82c3d20a418307a0a9ed6e3076f498',
        'cfd3097fdabb93039ebf7ce6bbc77e28810017e92a8bf15f51a83079f90fba62',
        'cb91c951bcd06a65e08f33293d5097f058d5b13470fb67826ddfd7cf482c4f13',
      ],
      originalBodyAstSha256: 'f21631070ad127578c53427e6858f5d81f15c072a5c1be3b2786eb2042634741',
      originalGuardHashes: [],
      moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
      isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
      moduleReview: {
        reviewedBy: '/root',
        reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
        corrections: [],
        addedTests: [
          {
            titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
            bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
            zeroOriginalCredit: true,
            interactionReviewed: true,
            reviewedBy: '/root',
            reason: 'Fixture slice independently proves isolation from selected renderer.',
          },
          {
            titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
            bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
            zeroOriginalCredit: true,
            interactionReviewed: true,
            reviewedBy: '/root',
            reason: 'Fixture slice independently proves isolation from selected renderer.',
          },
          {
            titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
            bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
            zeroOriginalCredit: true,
            interactionReviewed: true,
            reviewedBy: '/root',
            reason: 'Fixture slice independently proves isolation from selected renderer.',
          },
        ],
        isolatedRegistrationChanges: [
          {
            titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
            oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
            currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
            zeroSelectedCredit: true,
            reviewedBy: '/root/liquid_remediation',
            reason:
              'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
          },
          {
            titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
            oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
            currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
            zeroSelectedCredit: true,
            reviewedBy: '/root/liquid_remediation',
            reason:
              'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
          },
          {
            titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
            oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
            currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
            zeroSelectedCredit: true,
            reviewedBy: '/root/liquid_remediation',
            reason:
              'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
          },
        ],
        isolatedDeclarations: [
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root',
            reason: 'Independently reviewed source slice excludes this change.',
            astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root',
            reason: 'Independently reviewed source slice excludes this change.',
            astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
          },
        ],
      },
      importRoles: [
        {
          source: 'parse5',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/importer.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/data-error.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/liquid.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/liquid-filters.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/render-sweep-body.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../liquid-inventory.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../render-sweep.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../testing/owned-fixture.mjs',
          role: 'test-input',
          reviewedBy: '/root/frontend',
          reason:
            'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
        },
      ],
      runtimeInputs: [],
      lateImports: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
          importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
          source: '../lib/project-config.mjs',
          role: 'post-selected-isolated',
          reviewedBy: '/root',
          reason: 'Sequential later registration executes only after selected assertion completes.',
        },
      ],
      generatedFixtures: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:143:0',
          bootstrap: {
            declarations: [
              'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
              '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
              'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
              '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
              'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
              'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
              '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
              '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
              'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
              'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
              '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
              '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
            ],
          },
          plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
          fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
          mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          isolatedFsCount: 18,
        },
      ],
      inputDependencies: [
        {
          path: 'mirage/testing/owned-fixture.mjs',
          sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        },
      ],
      sourceBindings: [],
      loopHeaders: [],
      caseUniverse: {
        count: 1,
        cases: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:143:0',
            title:
              'DotLiquid20 whitespace control trims spaces and tabs before a tag and one newline or blank run after it',
          },
        ],
        casesSha256: '49402ec6d5774d634fe194c5894f962b07d40228ddab763f7729a9d50bcf4330',
        sourceBindings: [],
        ancestorLoops: [],
      },
      proofs: [
        {
          path: 'mirage/test/fixtures/power-pages-language-source-native-facts.json',
          sha256: '01d8fb72cc484960a20663cf3f72d0b712508ec0a1fe90e86b3cc891414d2469',
          mode: 'reproduced-native',
          capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
          facts: [
            {
              id: 'language-0',
              pointer: '/captures/0/cases/0/facts',
              sha256: 'cb8de2ce5497c0a531d9c2a37ecccfb5c88f6a136ae884fe39468355887ebe11',
              replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
            },
            {
              id: 'language-1',
              pointer: '/captures/0/cases/1/facts',
              sha256: 'c32dbb7c36093bcfc546012690950aa8d857b7dbd05c5024b61a57c492abb75b',
              replicatedPointers: ['/captures/0/cases/1/facts', '/captures/1/cases/1/facts'],
            },
            {
              id: 'language-2',
              pointer: '/captures/0/cases/2/facts',
              sha256: 'ece8d8fb6faa89d10164d0dc645bbe06adcf964eeffc69952c0bd6c612e7d33f',
              replicatedPointers: ['/captures/0/cases/2/facts', '/captures/1/cases/2/facts'],
            },
            {
              id: 'language-3',
              pointer: '/captures/0/cases/3/facts',
              sha256: 'aacefc270ba41fef9479fc95ab83bcced348cb7fed5395393af5f2ddbb1844c0',
              replicatedPointers: ['/captures/0/cases/3/facts', '/captures/1/cases/3/facts'],
            },
          ],
        },
      ],
    },
  ]);
  const render = plain();
  assert.equal(await render('a  {%- assign x = 1 -%}\n  b'), 'a  b');
  assert.equal(await render('x\n{%- if true -%}\ny\n{%- endif -%}\nz'), 'x\ny\nz');
  assert.equal(await render("[ {{- 'a' -}} ]"), '[a]');
  assert.equal(await render('a\t {%- if true %}b{% endif -%}  \n c'), 'ab\n c');
});

test('tags and outputs are single-line regex tokens and extra filter words are ignored', async () => {
  const render = plain();
  assert.equal(
    await render('{% assign v = "a\nb" %}{{ v }}'),
    'Tag \'{% assign v = "a\nb" %}\' was not properly terminated with regexp: (?-mix:\\%\\})',
  );
  assert.equal(await render("{{ 'x' | upcase downcase }}"), 'X');
  // A quoted fragment wins over a member path: 'abc'.size renders the string.

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '4be71a811eabee67e7535696b973f079740f40f7315e804269d744a89dcbebe7',
        originalAssertions: [
          'f80230d0e0251d99550b47e555b3966bc8c49fc095350ff272f041e3ba2db462',
          '744c40395aca88899f44089ce82689080459d604b559d2308d90d9cf99601628',
          'ecc2f98011bcf88299ac6d668cc7d387b675ea998c4fd7f48095e22862b9e2c6',
          'fc20b96fcd45851163056cb40200791e1d0d25b3c5f51cd92a4c797921ae9bc2',
        ],
        originalBodyAstSha256: '3e80d62b65f121e2a172432b8285ae35dc59ecc2b3d8fc467454a2e34b048044',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
              title: 'tags and outputs are single-line regex tokens and extra filter words are ignored',
            },
          ],
          casesSha256: '40fdcb4e0ad1a13b239a1f2def31a3545374016b8f00bd7a5a7bcfd877be97c9',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
            sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-context-006',
                pointer: '/captures/0/cases/5/facts',
                sha256: '48316a32ff3778d81adb1729c8fe3d065e0d90553545f8f22dca7758d1e8c12e',
                replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-051',
                pointer: '/captures/0/cases/50/facts',
                sha256: 'a560f259574ff079fad14846393ca5efa0ac3922ae6fc8e1aa9fa948fc836088',
                replicatedPointers: ['/captures/0/cases/50/facts', '/captures/1/cases/50/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            'ecc2f98011bcf88299ac6d668cc7d387b675ea998c4fd7f48095e22862b9e2c6',
            'fc20b96fcd45851163056cb40200791e1d0d25b3c5f51cd92a4c797921ae9bc2',
          ],
        ],
        regionFactIds: [[['native-original-context-006'], ['native-original-liquid-051']]],
      },
    ]);
    assert.equal(await render("{{ 'abc'.size }}|{{ s.size }}", { s: 'hello' }), 'abc|5');
    // `!x` is a variable name, not negation.
    assert.equal(await render('{% if !true %}y{% else %}n{% endif %}{% if !false %}y{% else %}n{% endif %}'), 'nn');
  }
});

test('and/or group right to left without precedence and comparisons convert the right operand', async () => {
  const render = plain();

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '557b7cddf2ee445d9e41e71b1eae757135594f0d3b5686c5d6e904cd17b63f03',
        originalAssertions: [
          'bbd59f5d9f63e5299c8a1e026fb598436604ef64b923a40e78b3871bca2093b7',
          '88e8b3eb457797ea989a3eceb480525d0e977f94e47acab61aec59bfe9b71a3f',
          '7e264925f365dcacd5eb6e92fa790c39a0d00690c792f5c0ffe74b2d0828f3af',
          'b43a1577c3068668c5b99c6f80089c1f39ba603491ffd310b4b91225987710a3',
          'a294480c67aaa0cba61574afb0ed625ccde66765b4b1ce48e199b0ab6102cbbb',
        ],
        originalBodyAstSha256: 'a4d68cb6795c03f84e6318a64b91bc19ef20f200c15ea8acf02a8dd32c7bb6f9',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
              title: 'and/or group right to left without precedence and comparisons convert the right operand',
            },
          ],
          casesSha256: '9e6a18c5114e1fc859974c8efe3fbcab1efd5576fb6f86b9a68ea1c852d873c8',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-052',
                pointer: '/captures/0/cases/51/facts',
                sha256: '89e023b3a554d935ef256bfe75cee891b9ad0a631b2c75966f19a3bc3f7f975c',
                replicatedPointers: ['/captures/0/cases/51/facts', '/captures/1/cases/51/facts'],
              },
              {
                id: 'native-original-liquid-053',
                pointer: '/captures/0/cases/52/facts',
                sha256: '218b0126b94d8b111ff1004266a12c9b02717f148565df257cedc130b2cf8f3a',
                replicatedPointers: ['/captures/0/cases/52/facts', '/captures/1/cases/52/facts'],
              },
              {
                id: 'native-original-liquid-054',
                pointer: '/captures/0/cases/53/facts',
                sha256: 'c603ad08e6d1eb2ba2c4b874d9ab2ba313ee1794af0b0335706b4d2d5aa5ca57',
                replicatedPointers: ['/captures/0/cases/53/facts', '/captures/1/cases/53/facts'],
              },
              {
                id: 'native-original-liquid-055',
                pointer: '/captures/0/cases/54/facts',
                sha256: '659685f45f8c60caccecc50084610400b08f583052857be8936d61be4654af96',
                replicatedPointers: ['/captures/0/cases/54/facts', '/captures/1/cases/54/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            'bbd59f5d9f63e5299c8a1e026fb598436604ef64b923a40e78b3871bca2093b7',
            '88e8b3eb457797ea989a3eceb480525d0e977f94e47acab61aec59bfe9b71a3f',
            '7e264925f365dcacd5eb6e92fa790c39a0d00690c792f5c0ffe74b2d0828f3af',
          ],
          ['a294480c67aaa0cba61574afb0ed625ccde66765b4b1ce48e199b0ab6102cbbb'],
        ],
        regionFactIds: [
          [['native-original-liquid-052'], ['native-original-liquid-053'], ['native-original-liquid-054']],
          [['native-original-liquid-055']],
        ],
      },
    ]);
    assert.equal(await render('{% if true or false and false %}y{% else %}n{% endif %}'), 'y');
    assert.equal(await render('{% if false and false or true %}y{% else %}n{% endif %}'), 'n');
    // Convert.ChangeType(right, left.GetType()); strings compare as strings.
    assert.equal(
      await render(
        "{% if '10' > 9 %}y{% else %}n{% endif %}{% if 10 > '9' %}y{% else %}n{% endif %}{% if 1 == '1' %}y{% else %}n{% endif %}{% if '1' == 1 %}y{% else %}n{% endif %}{% if 1 == 1.0 %}y{% else %}n{% endif %}",
      ),
      'nyyyy',
    );
  }

  assert.equal(
    await render(
      "{% if 'abc' contains 'b' %}a{% endif %}{% if list contains 2 %}b{% endif %}{% if 'abc' startswith 'a' %}c{% endif %}{% if list endswith 3 %}d{% endif %}",
      {
        list: [1, 2, 3],
      },
    ),
    'abcd',
  );

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '557b7cddf2ee445d9e41e71b1eae757135594f0d3b5686c5d6e904cd17b63f03',
        originalAssertions: [
          'bbd59f5d9f63e5299c8a1e026fb598436604ef64b923a40e78b3871bca2093b7',
          '88e8b3eb457797ea989a3eceb480525d0e977f94e47acab61aec59bfe9b71a3f',
          '7e264925f365dcacd5eb6e92fa790c39a0d00690c792f5c0ffe74b2d0828f3af',
          'b43a1577c3068668c5b99c6f80089c1f39ba603491ffd310b4b91225987710a3',
          'a294480c67aaa0cba61574afb0ed625ccde66765b4b1ce48e199b0ab6102cbbb',
        ],
        originalBodyAstSha256: 'a4d68cb6795c03f84e6318a64b91bc19ef20f200c15ea8acf02a8dd32c7bb6f9',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
              title: 'and/or group right to left without precedence and comparisons convert the right operand',
            },
          ],
          casesSha256: '9e6a18c5114e1fc859974c8efe3fbcab1efd5576fb6f86b9a68ea1c852d873c8',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-052',
                pointer: '/captures/0/cases/51/facts',
                sha256: '89e023b3a554d935ef256bfe75cee891b9ad0a631b2c75966f19a3bc3f7f975c',
                replicatedPointers: ['/captures/0/cases/51/facts', '/captures/1/cases/51/facts'],
              },
              {
                id: 'native-original-liquid-053',
                pointer: '/captures/0/cases/52/facts',
                sha256: '218b0126b94d8b111ff1004266a12c9b02717f148565df257cedc130b2cf8f3a',
                replicatedPointers: ['/captures/0/cases/52/facts', '/captures/1/cases/52/facts'],
              },
              {
                id: 'native-original-liquid-054',
                pointer: '/captures/0/cases/53/facts',
                sha256: 'c603ad08e6d1eb2ba2c4b874d9ab2ba313ee1794af0b0335706b4d2d5aa5ca57',
                replicatedPointers: ['/captures/0/cases/53/facts', '/captures/1/cases/53/facts'],
              },
              {
                id: 'native-original-liquid-055',
                pointer: '/captures/0/cases/54/facts',
                sha256: '659685f45f8c60caccecc50084610400b08f583052857be8936d61be4654af96',
                replicatedPointers: ['/captures/0/cases/54/facts', '/captures/1/cases/54/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            'bbd59f5d9f63e5299c8a1e026fb598436604ef64b923a40e78b3871bca2093b7',
            '88e8b3eb457797ea989a3eceb480525d0e977f94e47acab61aec59bfe9b71a3f',
            '7e264925f365dcacd5eb6e92fa790c39a0d00690c792f5c0ffe74b2d0828f3af',
          ],
          ['a294480c67aaa0cba61574afb0ed625ccde66765b4b1ce48e199b0ab6102cbbb'],
        ],
        regionFactIds: [
          [['native-original-liquid-052'], ['native-original-liquid-053'], ['native-original-liquid-054']],
          [['native-original-liquid-055']],
        ],
      },
    ]);
    assert.equal(
      await render("{% if 'abc' contains 1 %}y{% endif %}"),
      "Liquid error: Unable to cast object of type 'System.Int32' to type 'System.String'.",
    );
  }
});

test('empty and blank are DotLiquid symbols with master semantics and render as their type name', async () => {
  const render = plain();
  assert.equal(
    await render(
      "{% if '' == empty %}a{% endif %}{% if nil == empty %}b{% endif %}{% if '  ' == blank %}c{% endif %}{% if nil == blank %}d{% endif %}{% if false == blank %}e{% endif %}{% if list == empty %}f{% endif %}",
      { list: [1] },
    ),
    'acde',
  );
  assert.equal(
    await render('{{ empty }}|{% assign a = blank %}{{ a }}'),
    'DotLiquid.Util.Symbol|DotLiquid.Util.Symbol',
  );
  // `user.roles | default: empty` for an anonymous user hands the symbol to join.
  assert.equal(
    await render("{%- assign roles = user.roles | default: empty -%}{{ roles | join: ',' }}"),
    "Liquid error: Object of type 'DotLiquid.Util.Symbol' cannot be converted to type 'System.Collections.IEnumerable'.",
  );
});

test('if/elsif/elseif/unless/case follow DotLiquid block rules', async () => {
  const render = plain();

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'd2ff418ff7c425c9cfa533bed35ec95a53e43709c5fb7f0330afa0a4fe415924',
        originalAssertions: [
          '9dad7e4288b9e011aa138f715c457d72fa13b3e52a05a1cb74c3ec671fcefd48',
          '7cc3d6bad1b561fcef0b16e2d22f085134dd908be26073c56817db1367a54e89',
          'a8d52912218e22d896ab7c5b26907cb7a18e8649097a68070bd3295793791f44',
          '3e6cf88f1be42647cc6a3b27efe485812e09f4eae9a7231b09672c76764d90b5',
          'ab75976adff0dab16b5ea6df19196e2cfeca0a15fa38689b8e219c156a49f16e',
        ],
        originalBodyAstSha256: '2a258b128fdc30681aecb2c0cccc5ac6872031bf5322b5d2ce30c8c87cb24e7d',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
              title: 'if/elsif/elseif/unless/case follow DotLiquid block rules',
            },
          ],
          casesSha256: '65dfcba81db724a8b968d722b945245c76096cdf5ed1ad519b48181a98d0084e',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-057',
                pointer: '/captures/0/cases/56/facts',
                sha256: '9a272db95d419d98564d5b79d0149e4f31451bda655acf0d831a6a2f72692e0e',
                replicatedPointers: ['/captures/0/cases/56/facts', '/captures/1/cases/56/facts'],
              },
              {
                id: 'native-original-liquid-058',
                pointer: '/captures/0/cases/57/facts',
                sha256: 'ed722407c5352effad4133a752af12ab930f514c410c60ba67efd20d6ad5e807',
                replicatedPointers: ['/captures/0/cases/57/facts', '/captures/1/cases/57/facts'],
              },
              {
                id: 'native-original-liquid-059',
                pointer: '/captures/0/cases/58/facts',
                sha256: '56984fc1ede87ba7bbbd4df878be0c061646d6d282ef68b15d020aad50ed07a2',
                replicatedPointers: ['/captures/0/cases/58/facts', '/captures/1/cases/58/facts'],
              },
              {
                id: 'native-original-liquid-060',
                pointer: '/captures/0/cases/59/facts',
                sha256: 'c79dcbb70c745b505a63c0cdfee8c79da87caaf395ee71e9a28df3f66e3aead9',
                replicatedPointers: ['/captures/0/cases/59/facts', '/captures/1/cases/59/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '9dad7e4288b9e011aa138f715c457d72fa13b3e52a05a1cb74c3ec671fcefd48',
            '7cc3d6bad1b561fcef0b16e2d22f085134dd908be26073c56817db1367a54e89',
          ],
          [
            '3e6cf88f1be42647cc6a3b27efe485812e09f4eae9a7231b09672c76764d90b5',
            'ab75976adff0dab16b5ea6df19196e2cfeca0a15fa38689b8e219c156a49f16e',
          ],
        ],
        regionFactIds: [
          [['native-original-liquid-057'], ['native-original-liquid-058']],
          [['native-original-liquid-059'], ['native-original-liquid-060']],
        ],
      },
    ]);
    assert.equal(
      await render('{% if false %}a{% elsif true %}b{% endif %}{% if false %}a{% elseif true %}c{% endif %}'),
      'bc',
    );
    // If ignores markup after else; case rejects it.
    assert.equal(await render('{% if false %}a{% else if false %}b{% endif %}'), 'b');
  }

  assert.equal(
    await render('{% case 1 %}{% when 2 %}x{% else foo %}y{% endcase %}'),
    "Syntax Error in 'case' tag - Valid else condition: {% else %} (no parameters)",
  );

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'd2ff418ff7c425c9cfa533bed35ec95a53e43709c5fb7f0330afa0a4fe415924',
        originalAssertions: [
          '9dad7e4288b9e011aa138f715c457d72fa13b3e52a05a1cb74c3ec671fcefd48',
          '7cc3d6bad1b561fcef0b16e2d22f085134dd908be26073c56817db1367a54e89',
          'a8d52912218e22d896ab7c5b26907cb7a18e8649097a68070bd3295793791f44',
          '3e6cf88f1be42647cc6a3b27efe485812e09f4eae9a7231b09672c76764d90b5',
          'ab75976adff0dab16b5ea6df19196e2cfeca0a15fa38689b8e219c156a49f16e',
        ],
        originalBodyAstSha256: '2a258b128fdc30681aecb2c0cccc5ac6872031bf5322b5d2ce30c8c87cb24e7d',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
              title: 'if/elsif/elseif/unless/case follow DotLiquid block rules',
            },
          ],
          casesSha256: '65dfcba81db724a8b968d722b945245c76096cdf5ed1ad519b48181a98d0084e',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-057',
                pointer: '/captures/0/cases/56/facts',
                sha256: '9a272db95d419d98564d5b79d0149e4f31451bda655acf0d831a6a2f72692e0e',
                replicatedPointers: ['/captures/0/cases/56/facts', '/captures/1/cases/56/facts'],
              },
              {
                id: 'native-original-liquid-058',
                pointer: '/captures/0/cases/57/facts',
                sha256: 'ed722407c5352effad4133a752af12ab930f514c410c60ba67efd20d6ad5e807',
                replicatedPointers: ['/captures/0/cases/57/facts', '/captures/1/cases/57/facts'],
              },
              {
                id: 'native-original-liquid-059',
                pointer: '/captures/0/cases/58/facts',
                sha256: '56984fc1ede87ba7bbbd4df878be0c061646d6d282ef68b15d020aad50ed07a2',
                replicatedPointers: ['/captures/0/cases/58/facts', '/captures/1/cases/58/facts'],
              },
              {
                id: 'native-original-liquid-060',
                pointer: '/captures/0/cases/59/facts',
                sha256: 'c79dcbb70c745b505a63c0cdfee8c79da87caaf395ee71e9a28df3f66e3aead9',
                replicatedPointers: ['/captures/0/cases/59/facts', '/captures/1/cases/59/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '9dad7e4288b9e011aa138f715c457d72fa13b3e52a05a1cb74c3ec671fcefd48',
            '7cc3d6bad1b561fcef0b16e2d22f085134dd908be26073c56817db1367a54e89',
          ],
          [
            '3e6cf88f1be42647cc6a3b27efe485812e09f4eae9a7231b09672c76764d90b5',
            'ab75976adff0dab16b5ea6df19196e2cfeca0a15fa38689b8e219c156a49f16e',
          ],
        ],
        regionFactIds: [
          [['native-original-liquid-057'], ['native-original-liquid-058']],
          [['native-original-liquid-059'], ['native-original-liquid-060']],
        ],
      },
    ]);
    assert.equal(
      await render(
        '{% case 2 %}{% when 1 or 2 %}x{% endcase %}{% case 2 %}{% when 3, 2 %}y{% endcase %}{% case 5 %}{% when 1 %}a{% else %}z{% endcase %}',
      ),
      'xyz',
    );
    assert.equal(await render('{% unless false %}u{% else %}v{% endunless %}'), 'u');
  }
});

// @test-kind parity: all original source expressions reproduced twice through native include templates on 2026-11-08; language4–8 in frontend-parity-evidence.json.
// @parity-evidence: retained source plan and literal native response fragments license the observed-mode include context and exact expected errors; default-mode expectations remain below as diagnostics.
test('for loops support limit, offset, reversed, variable ranges, else, forloop, break and continue', async () => {
  assert.equal(
    createHash('sha256').update(nativeInclude.toString()).digest('hex'),
    '28cbe2a0b49b078d468e95b722040fe7f7c39380564b82f74fa74ef2f36576c4',
  );
  const render = nativeInclude();
  assert.equal(
    await render(
      '{% for i in (1..5) limit: 2 offset: 1 %}{{ i }}{% endfor %}|{% for i in (1..3) reversed %}{{ i }}{% endfor %}|{% for i in missing %}x{% else %}none{% endfor %}',
    ),
    'Liquid syntax error: for tag does not expect else tag',
  );
  assert.equal(await render('{% assign n = 3 %}{% for i in (1..n) %}{{ i }}{% endfor %}'), '123');
  assert.equal(
    await render(
      '{% for i in (1..3) %}{{ forloop.index }}{{ forloop.index0 }}{{ forloop.rindex }}{{ forloop.rindex0 }}{{ forloop.first }}{{ forloop.last }}{{ forloop.length }},{% endfor %}',
    ),
    '1032truefalse3,2121falsefalse3,3210falsetrue3,',
  );
  assert.equal(
    await render(
      '{% for i in (1..5) %}{% if i == 2 %}{% continue %}{% endif %}{% if i == 4 %}{% break %}{% endif %}{{ i }}{% endfor %}',
    ),
    '13',
  );
  assert.equal(
    await render(
      '{% for i in (1..2) %}{% else whatever %}{% endfor %}{% for i in none %}{% else whatever %}e{% endfor %}',
    ),
    'Liquid syntax error: for tag does not expect else tag',
  );
});

// @test-kind parity: all original source expressions reproduced twice through native include templates on 2026-11-08; language9–11 in frontend-parity-evidence.json.
// @parity-evidence: retained source plan and literal native response fragments license the observed-mode include context and exact expected errors; default-mode expectations remain below as diagnostics.
test('cycle, tablerow, increment and decrement keep DotLiquid output', async () => {
  const render = nativeInclude();
  assert.equal(
    await render(
      "{% for i in (1..4) %}{% cycle 'a', 'b', 'c' %}{% endfor %}|{% cycle 'g': 'x', 'y' %}{% cycle 'g': 'x', 'y' %}",
    ),
    'abca|xy',
  );
  // TableRow uses TextWriter.WriteLine (CRLF on the Windows host).
  assert.equal(
    await render(
      '{% tablerow i in (1..3) cols: 2 %}{{ i }}{{ tablerowloop.col }}{{ tablerowloop.col_last }}{% endtablerow %}',
    ),
    '<tr class="row1">\r\n<td class="col1">11false</td><td class="col2">22true</td></tr>\r\n<tr class="row2"><td class="col1">31false</td></tr>\r\n',
  );
  assert.equal(
    await render('{% increment c %}{% increment c %}{% decrement d %}{% decrement d %}|{{ c }}'),
    "Liquid syntax error: Unknown tag 'increment'",
  );
});

test('capture, raw, comment and member-path assignment', async (t) => {
  const render = plain();
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'b0e44bb6a0294091101c556f6b95f1e1d012970c1677857c60df7e541ade90b0',
        originalAssertions: [
          'd9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20',
          'd696de4b30ced760a21b7af6501cc276cd13a46eecce44f1f74cba88b76017f6',
          'd6524051fc1534dc716e05652061eac6d83ada765641e6e0a3bf60cf2702c910',
        ],
        originalBodyAstSha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
            selectedCallbackSha256: '12340314d1f3b8ae949aa6f00f809a93fbd6ee8bb6f844f800a38a528b415e97',
            selectedAssertionHashes: ['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20'],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '848f09b974607cd8e2c4b195a9256f3b5d4f70b9e29cd391ca438049e4c35b5d',
              'e92b84cd100dec8e0174c55dc82039e72119a9741bca1ed06598e90ee4bc3e57',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
            selectedCallbackSha256: '55b52cecdec5be4077408ff7cea5c0f5bf5331c582abb402b6742c95553e11c6',
            selectedAssertionHashes: [
              '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
              '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
              'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
              '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
              '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
            ],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '1c9ac9cb640a04f447f8578b4f719ba882e7e657340fb72f02fbc1d74f8ee34a',
              'dd5d4cac2aeb995373705ab9a950e1107ce03884ce584f50f23f37129101e849',
              '8794650311cde38e587c77490eb1b052ae0ae99fb2be674380eb790752cd3648',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
            selectedCallbackSha256: 'd3fee4218bdaade80b39e7dc2d6e5b142e8a54cbe048ac2576dcd5023d8f207d',
            selectedAssertionHashes: [
              '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
              'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
              '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
              '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
            ],
            surroundingStatementHashes: [
              '3840a3ce0e021dd65cd389f2997ab64b1cbc56bb6a21002a2ea799e4cef9e85d',
              'c2747c1313dd8d84482f524b740cec816d0ee78155cd67f9819330b4364bd47b',
              '3f5927190358e3dad2868037047352eaba08ab71d8c5ddb94320dc67b04dfd71',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
            selectedCallbackSha256: '76907019e385c858c3fb6bae2487dcbc63f19dd0b4d4ca11ceccea937fe16ecb',
            selectedAssertionHashes: ['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b'],
            surroundingStatementHashes: [
              'ef6c5f94853fab3f32775501e1a0fe592a4b75cd2c10ea4d986e05d3c9fe4b13',
              '9c5a8fdc336078a807f6fe9faf7e7ab1f46a29337b2db8a1892af44201641149',
              '5b39bbe5f38b7eacd025834f3f57d62dc0a588dc79a21a80c946fa593450e32c',
            ],
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
              title: 'capture, raw, comment and member-path assignment',
            },
          ],
          casesSha256: '0c2d2970080891b0ac0e102d855631e5d34d3af7618d53e33a8dcc8075b0cd8f',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-061',
                pointer: '/captures/0/cases/60/facts',
                sha256: 'b4dcd171250deea306f5d0c9841271ba2dd8237345b9ab1d07dd0928ceaa1bcb',
                replicatedPointers: ['/captures/0/cases/60/facts', '/captures/1/cases/60/facts'],
              },
            ],
          },
        ],
        regionHashes: [['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20']],
        regionFactIds: [[['native-original-liquid-061']]],
      },
    ]);
    assert.equal(
      await render(
        '{% capture x %}a{{ 1 }}{% endcapture %}{{ x }}|{% raw %}{{ x }}{% endraw %}|{% comment %}hidden{% endcomment %}',
      ),
      'a1|{{ x }}|',
    );
  }
  const { render: pageRender } = await setup(t);
  // Assign creates a variable literally named "page.title"; the page drop is unchanged.
  assert.equal(
    (await pageRender("{% assign page.title = 'Changed' %}{{ page.title }}|{{ ['page.title'] }}")).html,
    'Child title|Changed',
  );
  // Variable names are case-insensitive (Adxstudio InvariantCultureNamingConvention).
  assert.equal((await pageRender('{{ PAGE.title }}|{% assign Foo = 1 %}{{ foo }}')).html, 'Child title|1');
});

test('string and escape filters match .NET encoders', async () => {
  const render = plain();

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '56e8e232749c0c087ef5756132cbb3e74ff752e47692c5755ea8615fbb49872f',
        originalAssertions: [
          '953a5584ae8dd7bd0b7231a3509035c4ee4c56d7b2c3aea4fbe23564dacde321',
          '18e262d24db43c043d11f4888d068c378b2c4b98a3aae1855d84b8a8c7de3d7d',
          '6862fc15d5e51c3df7c9a6b869a9b7ac1cb17b85406ddaafc36dfde7f060adc8',
          '82328fb3a623ce58e1783540126d05de02ed764240ab9b26a8396b703d4ee858',
          '0713038419ac15dfcd81cb68fc84b3638ca6bd2e1c3e0588a79b3f33361e8f97',
          '9fb0848bad264996f0f86839abf1a294c54bef782e2b83db0eeddcdf8f402b64',
          'b747d855cef7d53b40a5a6ba2f45408a17702419b5427c2df8ebe0626f5458b2',
          '965d4cd3a2c9bc119d8837e1b6b76c204d5db4b9adba3102a01c968070a98a1d',
          'fdfe1d7b57cab51fbb6fa7595d97410d5fbd0ea3d0bbae25d711cc40fbc921ea',
          '400ebc629bf14ea01145b11050eef4a969f9ab83a47a2b12092413bda4c7497f',
          '07c6afd3f3f4d2d63d14ef1419c3cb79e12c00b34d771fd73ece8c8ce4b98b59',
          '4e6460ed11163b1e04e72a8cec267a4da53efc4b9e34b5e27dcd94e7aafec59a',
          'a618bcafa918bf60117474a2ac0e82db0b19d7dc8adee9b02d47dbf48453e96f',
          '55a3cc8adcec41636d9011107eb1421d6835669a558f55e0ef2f21cee9aac7f0',
          'e7ab52fc18dca40f597c349be57d8687aa22e5b8815790da0479039b58b6376b',
          '765022759dd092414bbff48339d8cc71270aa2fc99b5ca1cba82ce852081f052',
        ],
        originalBodyAstSha256: '230896aa5285a7f734dddde8fd951a92f932a01ecdc6279f1fe8a5509abf1d71',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
              title: 'string and escape filters match .NET encoders',
            },
          ],
          casesSha256: '5cc3938958f6c942bacb98468671eaccdbda6072dd965767213f033e54d800ea',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
            sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-context-007',
                pointer: '/captures/0/cases/6/facts',
                sha256: 'd3636841603f18b3fefbaa1e18e94c0a12a306b5a490b47e6a755dd55d384f81',
                replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
              },
              {
                id: 'native-original-context-008',
                pointer: '/captures/0/cases/7/facts',
                sha256: '3cb314a536e5d75fe09ecf8598bcdc920937a2e563cf28560572b1fb398f584f',
                replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
              },
              {
                id: 'native-original-context-009',
                pointer: '/captures/0/cases/8/facts',
                sha256: '6fa538c5126b2433adfd321113894c417e14d013027adc025c3b21cdfa77516f',
                replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
              },
              {
                id: 'native-original-context-011',
                pointer: '/captures/0/cases/10/facts',
                sha256: '38839d81653ab5f5aa14eb5847ae5f1d53e641a28f10a4dfaefb29eae9bf6a9d',
                replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
              },
              {
                id: 'native-original-context-012',
                pointer: '/captures/0/cases/11/facts',
                sha256: '965b80b8d0149b1768e8d3c46d2f68bee302e8b141a8d3f91b25a68afb9f5e1c',
                replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
              },
              {
                id: 'native-original-context-017',
                pointer: '/captures/0/cases/16/facts',
                sha256: 'fd27ab4a2809590aa83f0bdee6b98423176c042c73c194ecf08c089cda7999ec',
                replicatedPointers: ['/captures/0/cases/16/facts', '/captures/1/cases/16/facts'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-062',
                pointer: '/captures/0/cases/61/facts',
                sha256: 'd641bbd4237dec845ea3d87b93f107fa0f6024d5c01fd48aa80c463ab76dc181',
                replicatedPointers: ['/captures/0/cases/61/facts', '/captures/1/cases/61/facts'],
              },
              {
                id: 'native-original-liquid-063',
                pointer: '/captures/0/cases/62/facts',
                sha256: 'c0291b114bb6b32a26a189bcf53a85bab9dda711cc161446a1bf6dbbe2e3595a',
                replicatedPointers: ['/captures/0/cases/62/facts', '/captures/1/cases/62/facts'],
              },
              {
                id: 'native-original-liquid-064',
                pointer: '/captures/0/cases/63/facts',
                sha256: '55f8b3ee61047fd18efd009304f45e4db8fb7faf169c51df9b30a18cf8c92ae9',
                replicatedPointers: ['/captures/0/cases/63/facts', '/captures/1/cases/63/facts'],
              },
              {
                id: 'native-original-liquid-065',
                pointer: '/captures/0/cases/64/facts',
                sha256: 'd9db29e0ccdd3086868056a8adc9f176318a88f14e9dc6c4bec3ec025c5b307c',
                replicatedPointers: ['/captures/0/cases/64/facts', '/captures/1/cases/64/facts'],
              },
              {
                id: 'native-original-liquid-066',
                pointer: '/captures/0/cases/65/facts',
                sha256: '4590e739fa6fb92f15920752f45739b1dce93d735c5bc713608f13d4beef104b',
                replicatedPointers: ['/captures/0/cases/65/facts', '/captures/1/cases/65/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '953a5584ae8dd7bd0b7231a3509035c4ee4c56d7b2c3aea4fbe23564dacde321',
            '18e262d24db43c043d11f4888d068c378b2c4b98a3aae1855d84b8a8c7de3d7d',
            '6862fc15d5e51c3df7c9a6b869a9b7ac1cb17b85406ddaafc36dfde7f060adc8',
          ],
          [
            '0713038419ac15dfcd81cb68fc84b3638ca6bd2e1c3e0588a79b3f33361e8f97',
            '9fb0848bad264996f0f86839abf1a294c54bef782e2b83db0eeddcdf8f402b64',
            'b747d855cef7d53b40a5a6ba2f45408a17702419b5427c2df8ebe0626f5458b2',
            '965d4cd3a2c9bc119d8837e1b6b76c204d5db4b9adba3102a01c968070a98a1d',
          ],
          [
            'a618bcafa918bf60117474a2ac0e82db0b19d7dc8adee9b02d47dbf48453e96f',
            '55a3cc8adcec41636d9011107eb1421d6835669a558f55e0ef2f21cee9aac7f0',
            'e7ab52fc18dca40f597c349be57d8687aa22e5b8815790da0479039b58b6376b',
            '765022759dd092414bbff48339d8cc71270aa2fc99b5ca1cba82ce852081f052',
          ],
        ],
        regionFactIds: [
          [['native-original-context-007'], ['native-original-context-008'], ['native-original-context-009']],
          [
            ['native-original-liquid-062'],
            ['native-original-liquid-063'],
            ['native-original-context-011'],
            ['native-original-context-012'],
          ],
          [
            ['native-original-context-017'],
            ['native-original-liquid-064'],
            ['native-original-liquid-065'],
            ['native-original-liquid-066'],
          ],
        ],
      },
    ]);
    assert.equal(
      await render('{{ s | escape }}|{{ s | h }}', { s: `<p>é & "'</p>` }),
      '&lt;p&gt;&#233; &amp; &quot;&#39;&lt;/p&gt;|&lt;p&gt;&#233; &amp; &quot;&#39;&lt;/p&gt;',
    );
    assert.equal(
      await render('{{ s | url_escape }}|{{ s | url_encode }}', { s: 'This & that//' }),
      'This+%26+that%2F%2F|This+%26+that%2F%2F',
    );
    assert.equal(
      await render('{{ s | xml_escape }}', { s: `<a href="x">'&` }),
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;',
    );
  }

  assert.equal(await render('{{ s | escape_once }}', { s: '1 &lt; 2 & 3' }), '1 &lt; 2 &amp; 3');

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '56e8e232749c0c087ef5756132cbb3e74ff752e47692c5755ea8615fbb49872f',
        originalAssertions: [
          '953a5584ae8dd7bd0b7231a3509035c4ee4c56d7b2c3aea4fbe23564dacde321',
          '18e262d24db43c043d11f4888d068c378b2c4b98a3aae1855d84b8a8c7de3d7d',
          '6862fc15d5e51c3df7c9a6b869a9b7ac1cb17b85406ddaafc36dfde7f060adc8',
          '82328fb3a623ce58e1783540126d05de02ed764240ab9b26a8396b703d4ee858',
          '0713038419ac15dfcd81cb68fc84b3638ca6bd2e1c3e0588a79b3f33361e8f97',
          '9fb0848bad264996f0f86839abf1a294c54bef782e2b83db0eeddcdf8f402b64',
          'b747d855cef7d53b40a5a6ba2f45408a17702419b5427c2df8ebe0626f5458b2',
          '965d4cd3a2c9bc119d8837e1b6b76c204d5db4b9adba3102a01c968070a98a1d',
          'fdfe1d7b57cab51fbb6fa7595d97410d5fbd0ea3d0bbae25d711cc40fbc921ea',
          '400ebc629bf14ea01145b11050eef4a969f9ab83a47a2b12092413bda4c7497f',
          '07c6afd3f3f4d2d63d14ef1419c3cb79e12c00b34d771fd73ece8c8ce4b98b59',
          '4e6460ed11163b1e04e72a8cec267a4da53efc4b9e34b5e27dcd94e7aafec59a',
          'a618bcafa918bf60117474a2ac0e82db0b19d7dc8adee9b02d47dbf48453e96f',
          '55a3cc8adcec41636d9011107eb1421d6835669a558f55e0ef2f21cee9aac7f0',
          'e7ab52fc18dca40f597c349be57d8687aa22e5b8815790da0479039b58b6376b',
          '765022759dd092414bbff48339d8cc71270aa2fc99b5ca1cba82ce852081f052',
        ],
        originalBodyAstSha256: '230896aa5285a7f734dddde8fd951a92f932a01ecdc6279f1fe8a5509abf1d71',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
              title: 'string and escape filters match .NET encoders',
            },
          ],
          casesSha256: '5cc3938958f6c942bacb98468671eaccdbda6072dd965767213f033e54d800ea',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
            sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-context-007',
                pointer: '/captures/0/cases/6/facts',
                sha256: 'd3636841603f18b3fefbaa1e18e94c0a12a306b5a490b47e6a755dd55d384f81',
                replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
              },
              {
                id: 'native-original-context-008',
                pointer: '/captures/0/cases/7/facts',
                sha256: '3cb314a536e5d75fe09ecf8598bcdc920937a2e563cf28560572b1fb398f584f',
                replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
              },
              {
                id: 'native-original-context-009',
                pointer: '/captures/0/cases/8/facts',
                sha256: '6fa538c5126b2433adfd321113894c417e14d013027adc025c3b21cdfa77516f',
                replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
              },
              {
                id: 'native-original-context-011',
                pointer: '/captures/0/cases/10/facts',
                sha256: '38839d81653ab5f5aa14eb5847ae5f1d53e641a28f10a4dfaefb29eae9bf6a9d',
                replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
              },
              {
                id: 'native-original-context-012',
                pointer: '/captures/0/cases/11/facts',
                sha256: '965b80b8d0149b1768e8d3c46d2f68bee302e8b141a8d3f91b25a68afb9f5e1c',
                replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
              },
              {
                id: 'native-original-context-017',
                pointer: '/captures/0/cases/16/facts',
                sha256: 'fd27ab4a2809590aa83f0bdee6b98423176c042c73c194ecf08c089cda7999ec',
                replicatedPointers: ['/captures/0/cases/16/facts', '/captures/1/cases/16/facts'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-062',
                pointer: '/captures/0/cases/61/facts',
                sha256: 'd641bbd4237dec845ea3d87b93f107fa0f6024d5c01fd48aa80c463ab76dc181',
                replicatedPointers: ['/captures/0/cases/61/facts', '/captures/1/cases/61/facts'],
              },
              {
                id: 'native-original-liquid-063',
                pointer: '/captures/0/cases/62/facts',
                sha256: 'c0291b114bb6b32a26a189bcf53a85bab9dda711cc161446a1bf6dbbe2e3595a',
                replicatedPointers: ['/captures/0/cases/62/facts', '/captures/1/cases/62/facts'],
              },
              {
                id: 'native-original-liquid-064',
                pointer: '/captures/0/cases/63/facts',
                sha256: '55f8b3ee61047fd18efd009304f45e4db8fb7faf169c51df9b30a18cf8c92ae9',
                replicatedPointers: ['/captures/0/cases/63/facts', '/captures/1/cases/63/facts'],
              },
              {
                id: 'native-original-liquid-065',
                pointer: '/captures/0/cases/64/facts',
                sha256: 'd9db29e0ccdd3086868056a8adc9f176318a88f14e9dc6c4bec3ec025c5b307c',
                replicatedPointers: ['/captures/0/cases/64/facts', '/captures/1/cases/64/facts'],
              },
              {
                id: 'native-original-liquid-066',
                pointer: '/captures/0/cases/65/facts',
                sha256: '4590e739fa6fb92f15920752f45739b1dce93d735c5bc713608f13d4beef104b',
                replicatedPointers: ['/captures/0/cases/65/facts', '/captures/1/cases/65/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '953a5584ae8dd7bd0b7231a3509035c4ee4c56d7b2c3aea4fbe23564dacde321',
            '18e262d24db43c043d11f4888d068c378b2c4b98a3aae1855d84b8a8c7de3d7d',
            '6862fc15d5e51c3df7c9a6b869a9b7ac1cb17b85406ddaafc36dfde7f060adc8',
          ],
          [
            '0713038419ac15dfcd81cb68fc84b3638ca6bd2e1c3e0588a79b3f33361e8f97',
            '9fb0848bad264996f0f86839abf1a294c54bef782e2b83db0eeddcdf8f402b64',
            'b747d855cef7d53b40a5a6ba2f45408a17702419b5427c2df8ebe0626f5458b2',
            '965d4cd3a2c9bc119d8837e1b6b76c204d5db4b9adba3102a01c968070a98a1d',
          ],
          [
            'a618bcafa918bf60117474a2ac0e82db0b19d7dc8adee9b02d47dbf48453e96f',
            '55a3cc8adcec41636d9011107eb1421d6835669a558f55e0ef2f21cee9aac7f0',
            'e7ab52fc18dca40f597c349be57d8687aa22e5b8815790da0479039b58b6376b',
            '765022759dd092414bbff48339d8cc71270aa2fc99b5ca1cba82ce852081f052',
          ],
        ],
        regionFactIds: [
          [['native-original-context-007'], ['native-original-context-008'], ['native-original-context-009']],
          [
            ['native-original-liquid-062'],
            ['native-original-liquid-063'],
            ['native-original-context-011'],
            ['native-original-context-012'],
          ],
          [
            ['native-original-context-017'],
            ['native-original-liquid-064'],
            ['native-original-liquid-065'],
            ['native-original-liquid-066'],
          ],
        ],
      },
    ]);
    assert.equal(await render("{{ 'a b' | url_encode }}|{{ 'a+b%20c' | url_decode }}"), 'a+b|a b c');
    assert.equal(await render("{{ 'capitalize me' | capitalize }}|{{ 'élan' | upcase }}"), 'Capitalize Me|ÉLAN');
    assert.equal(
      await render('{{ s | truncate: 10 }}|{{ s | truncate_words: 2 }}', { s: 'This is a long sentence' }),
      'This is...|This is...',
    );
    assert.equal(
      await render("{{ s | split: ',' | size }}|{{ s | split: ',' | join: '|' }}", { s: 'a,b,,c' }),
      '3|a|b|c',
    );
  }

  assert.equal(
    await render('{{ s | strip_newlines }}|{{ s | newline_to_br }}', { s: 'a\nb\r\nc' }),
    'abc|a<br />\nb<br />\r\nc',
  );
  assert.equal(
    await render('{{ s | strip_html }}', { s: '<p>Hello <b>World</b></p><script>x</script>' }),
    'Hello World',
  );
  assert.equal(
    await render('{{ s | text_to_html }}', { s: 'Line one\nLine two\n\nhttp://example.com x' }),
    '<p>Line one<br />Line two</p><p><a href="http://example.com/" rel="nofollow">http://example.com/</a> x</p>',
  );
  assert.equal(
    await render('{{ s | html_safe_escape }}', { s: '<img src="images/myimage.jpg" onerror="alert(1);">' }),
    '<img src="images/myimage.jpg" />',
  );

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '56e8e232749c0c087ef5756132cbb3e74ff752e47692c5755ea8615fbb49872f',
        originalAssertions: [
          '953a5584ae8dd7bd0b7231a3509035c4ee4c56d7b2c3aea4fbe23564dacde321',
          '18e262d24db43c043d11f4888d068c378b2c4b98a3aae1855d84b8a8c7de3d7d',
          '6862fc15d5e51c3df7c9a6b869a9b7ac1cb17b85406ddaafc36dfde7f060adc8',
          '82328fb3a623ce58e1783540126d05de02ed764240ab9b26a8396b703d4ee858',
          '0713038419ac15dfcd81cb68fc84b3638ca6bd2e1c3e0588a79b3f33361e8f97',
          '9fb0848bad264996f0f86839abf1a294c54bef782e2b83db0eeddcdf8f402b64',
          'b747d855cef7d53b40a5a6ba2f45408a17702419b5427c2df8ebe0626f5458b2',
          '965d4cd3a2c9bc119d8837e1b6b76c204d5db4b9adba3102a01c968070a98a1d',
          'fdfe1d7b57cab51fbb6fa7595d97410d5fbd0ea3d0bbae25d711cc40fbc921ea',
          '400ebc629bf14ea01145b11050eef4a969f9ab83a47a2b12092413bda4c7497f',
          '07c6afd3f3f4d2d63d14ef1419c3cb79e12c00b34d771fd73ece8c8ce4b98b59',
          '4e6460ed11163b1e04e72a8cec267a4da53efc4b9e34b5e27dcd94e7aafec59a',
          'a618bcafa918bf60117474a2ac0e82db0b19d7dc8adee9b02d47dbf48453e96f',
          '55a3cc8adcec41636d9011107eb1421d6835669a558f55e0ef2f21cee9aac7f0',
          'e7ab52fc18dca40f597c349be57d8687aa22e5b8815790da0479039b58b6376b',
          '765022759dd092414bbff48339d8cc71270aa2fc99b5ca1cba82ce852081f052',
        ],
        originalBodyAstSha256: '230896aa5285a7f734dddde8fd951a92f932a01ecdc6279f1fe8a5509abf1d71',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
              title: 'string and escape filters match .NET encoders',
            },
          ],
          casesSha256: '5cc3938958f6c942bacb98468671eaccdbda6072dd965767213f033e54d800ea',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
            sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-context-007',
                pointer: '/captures/0/cases/6/facts',
                sha256: 'd3636841603f18b3fefbaa1e18e94c0a12a306b5a490b47e6a755dd55d384f81',
                replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
              },
              {
                id: 'native-original-context-008',
                pointer: '/captures/0/cases/7/facts',
                sha256: '3cb314a536e5d75fe09ecf8598bcdc920937a2e563cf28560572b1fb398f584f',
                replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
              },
              {
                id: 'native-original-context-009',
                pointer: '/captures/0/cases/8/facts',
                sha256: '6fa538c5126b2433adfd321113894c417e14d013027adc025c3b21cdfa77516f',
                replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
              },
              {
                id: 'native-original-context-011',
                pointer: '/captures/0/cases/10/facts',
                sha256: '38839d81653ab5f5aa14eb5847ae5f1d53e641a28f10a4dfaefb29eae9bf6a9d',
                replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
              },
              {
                id: 'native-original-context-012',
                pointer: '/captures/0/cases/11/facts',
                sha256: '965b80b8d0149b1768e8d3c46d2f68bee302e8b141a8d3f91b25a68afb9f5e1c',
                replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
              },
              {
                id: 'native-original-context-017',
                pointer: '/captures/0/cases/16/facts',
                sha256: 'fd27ab4a2809590aa83f0bdee6b98423176c042c73c194ecf08c089cda7999ec',
                replicatedPointers: ['/captures/0/cases/16/facts', '/captures/1/cases/16/facts'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-062',
                pointer: '/captures/0/cases/61/facts',
                sha256: 'd641bbd4237dec845ea3d87b93f107fa0f6024d5c01fd48aa80c463ab76dc181',
                replicatedPointers: ['/captures/0/cases/61/facts', '/captures/1/cases/61/facts'],
              },
              {
                id: 'native-original-liquid-063',
                pointer: '/captures/0/cases/62/facts',
                sha256: 'c0291b114bb6b32a26a189bcf53a85bab9dda711cc161446a1bf6dbbe2e3595a',
                replicatedPointers: ['/captures/0/cases/62/facts', '/captures/1/cases/62/facts'],
              },
              {
                id: 'native-original-liquid-064',
                pointer: '/captures/0/cases/63/facts',
                sha256: '55f8b3ee61047fd18efd009304f45e4db8fb7faf169c51df9b30a18cf8c92ae9',
                replicatedPointers: ['/captures/0/cases/63/facts', '/captures/1/cases/63/facts'],
              },
              {
                id: 'native-original-liquid-065',
                pointer: '/captures/0/cases/64/facts',
                sha256: 'd9db29e0ccdd3086868056a8adc9f176318a88f14e9dc6c4bec3ec025c5b307c',
                replicatedPointers: ['/captures/0/cases/64/facts', '/captures/1/cases/64/facts'],
              },
              {
                id: 'native-original-liquid-066',
                pointer: '/captures/0/cases/65/facts',
                sha256: '4590e739fa6fb92f15920752f45739b1dce93d735c5bc713608f13d4beef104b',
                replicatedPointers: ['/captures/0/cases/65/facts', '/captures/1/cases/65/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '953a5584ae8dd7bd0b7231a3509035c4ee4c56d7b2c3aea4fbe23564dacde321',
            '18e262d24db43c043d11f4888d068c378b2c4b98a3aae1855d84b8a8c7de3d7d',
            '6862fc15d5e51c3df7c9a6b869a9b7ac1cb17b85406ddaafc36dfde7f060adc8',
          ],
          [
            '0713038419ac15dfcd81cb68fc84b3638ca6bd2e1c3e0588a79b3f33361e8f97',
            '9fb0848bad264996f0f86839abf1a294c54bef782e2b83db0eeddcdf8f402b64',
            'b747d855cef7d53b40a5a6ba2f45408a17702419b5427c2df8ebe0626f5458b2',
            '965d4cd3a2c9bc119d8837e1b6b76c204d5db4b9adba3102a01c968070a98a1d',
          ],
          [
            'a618bcafa918bf60117474a2ac0e82db0b19d7dc8adee9b02d47dbf48453e96f',
            '55a3cc8adcec41636d9011107eb1421d6835669a558f55e0ef2f21cee9aac7f0',
            'e7ab52fc18dca40f597c349be57d8687aa22e5b8815790da0479039b58b6376b',
            '765022759dd092414bbff48339d8cc71270aa2fc99b5ca1cba82ce852081f052',
          ],
        ],
        regionFactIds: [
          [['native-original-context-007'], ['native-original-context-008'], ['native-original-context-009']],
          [
            ['native-original-liquid-062'],
            ['native-original-liquid-063'],
            ['native-original-context-011'],
            ['native-original-context-012'],
          ],
          [
            ['native-original-context-017'],
            ['native-original-liquid-064'],
            ['native-original-liquid-065'],
            ['native-original-liquid-066'],
          ],
        ],
      },
    ]);
    assert.equal(
      await render('{{ s | html_safe_escape }}', { s: '<p onclick="x()">ok<script>bad()</script></p>' }),
      '<p>ok</p>',
    );
    // DotLiquid20 replace/replace_first use .NET regular expressions.
    assert.equal(
      await render(
        "{{ 'a.b' | replace: '.', '-' }}|{{ 'a.b' | replace_first: '.', '-' }}|{{ 'aXbX' | remove: 'X' }}|{{ 'aXbX' | remove_first: 'X' }}",
      ),
      '---|-.b|ab|abX',
    );
    assert.equal(await render("{{ 'a(b' | replace: '(', '[' }}"), `Liquid error: parsing "(" - Not enough )'s.`);
    assert.equal(
      await render("{{ 'x' | slice: 0 }}|{{ 'abc' | slice: 1, 2 }}|{{ 'a' | append: 'b' }}|{{ 'a' | prepend: 'b' }}"),
      'x|bc|ab|ba',
    );
  }
});

// @test-kind parity: all original source expressions reproduced twice through native include templates on 2026-11-08; language12–19 in frontend-parity-evidence.json.
// @parity-evidence: retained source plan and literal native response fragments license the observed-mode include context and exact expected errors; default-mode expectations remain below as diagnostics.
test('math filters promote real operands to decimal, divide integers, round to even and format decimals without trailing zeros', async () => {
  const render = nativeInclude();
  // DotLiquid >= 2.1 DoMathsOperation (the Power Pages docs still list the 2.0 truncating examples).
  assert.equal(await render('{{ 10 | plus: 1.1 }}|{{ 10 | minus: 1.1 }}|{{ 10 | times: 2.2 }}'), '11.1|8.9|22');
  assert.equal(
    await render('{{ 10 | divided_by: 3 }}|{{ 10.0 | divided_by: 3 }}|{{ 10 | modulo: 3 }}|{{ 5 | divided_by: 2.0 }}'),
    '3|3.3333333333333333333333333333|1|2.5',
  );
  assert.equal(
    await render('{{ 1 | divided_by: 0 }}'),
    'Liquid error: Exception has been thrown by the target of an invocation.',
  );
  assert.equal(
    await render(
      '{{ 4.5612 | round: 2 }}|{{ 2.5 | round }}|{{ 3.5 | round }}|{{ 2.675 | round: 2 }}|{{ nil | round }}',
    ),
    '4.56|2|4|2.68|0',
  );
  // Adxstudio MathFilters.Ceil/Floor return int; nil is 0.
  assert.equal(await render("{{ 1.2 | ceil }}|{{ 1.8 | floor }}|{{ '3.7' | floor }}|{{ nil | ceil }}"), '2|1|3|0');
  assert.equal(await render('{{ 1.50 }}|{{ 12.5 | times: 10 }}|{{ 0.1 | plus: 0.2 }}'), '1.5|125|0.3');
  // Plus concatenates string input; other mismatches raise the expression error.
  assert.equal(await render("{{ '1' | plus: 1 }}|{{ 1 | plus: 'a' }}"), '11|Liquid error: Parameter count mismatch.');
  assert.equal(await render('{{ -5 | abs }}|{{ 5 | at_least: 7 }}|{{ 5 | at_most: 3 }}'), '5|7|3');
});

test('type, number-format and additional filters follow Adxstudio', async (t) => {
  const render = plain();
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '67d55aa4ee1371ffd9030296253b73b453bad2178ace16218c9f2a4e5675021c',
        originalAssertions: [
          '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
          '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
          'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
          '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
          '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
          '7b7c4c7aed6a9033a79a1d2d571cc4b963e33b3cab7071063d5ff6574d4145ad',
          '0d67ece8e9fb97b6b18159be923d8030c5931d37ba3d1f2f1f91abfc9badea63',
        ],
        originalBodyAstSha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
            selectedCallbackSha256: '12340314d1f3b8ae949aa6f00f809a93fbd6ee8bb6f844f800a38a528b415e97',
            selectedAssertionHashes: ['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20'],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '848f09b974607cd8e2c4b195a9256f3b5d4f70b9e29cd391ca438049e4c35b5d',
              'e92b84cd100dec8e0174c55dc82039e72119a9741bca1ed06598e90ee4bc3e57',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
            selectedCallbackSha256: '55b52cecdec5be4077408ff7cea5c0f5bf5331c582abb402b6742c95553e11c6',
            selectedAssertionHashes: [
              '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
              '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
              'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
              '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
              '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
            ],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '1c9ac9cb640a04f447f8578b4f719ba882e7e657340fb72f02fbc1d74f8ee34a',
              'dd5d4cac2aeb995373705ab9a950e1107ce03884ce584f50f23f37129101e849',
              '8794650311cde38e587c77490eb1b052ae0ae99fb2be674380eb790752cd3648',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
            selectedCallbackSha256: 'd3fee4218bdaade80b39e7dc2d6e5b142e8a54cbe048ac2576dcd5023d8f207d',
            selectedAssertionHashes: [
              '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
              'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
              '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
              '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
            ],
            surroundingStatementHashes: [
              '3840a3ce0e021dd65cd389f2997ab64b1cbc56bb6a21002a2ea799e4cef9e85d',
              'c2747c1313dd8d84482f524b740cec816d0ee78155cd67f9819330b4364bd47b',
              '3f5927190358e3dad2868037047352eaba08ab71d8c5ddb94320dc67b04dfd71',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
            selectedCallbackSha256: '76907019e385c858c3fb6bae2487dcbc63f19dd0b4d4ca11ceccea937fe16ecb',
            selectedAssertionHashes: ['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b'],
            surroundingStatementHashes: [
              'ef6c5f94853fab3f32775501e1a0fe592a4b75cd2c10ea4d986e05d3c9fe4b13',
              '9c5a8fdc336078a807f6fe9faf7e7ab1f46a29337b2db8a1892af44201641149',
              '5b39bbe5f38b7eacd025834f3f57d62dc0a588dc79a21a80c946fa593450e32c',
            ],
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
              title: 'type, number-format and additional filters follow Adxstudio',
            },
          ],
          casesSha256: '8007292caabf6c6e030a48ca66b39a669557f6d4e39cd5d075d0462258d71ac7',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-067',
                pointer: '/captures/0/cases/66/facts',
                sha256: 'f1b8422c416ffcbb5da56cf912096e3c2f804135cf25efac484e3c8ae5e398fe',
                replicatedPointers: ['/captures/0/cases/66/facts', '/captures/1/cases/66/facts'],
              },
              {
                id: 'native-original-liquid-068',
                pointer: '/captures/0/cases/67/facts',
                sha256: 'a56148bc3e89e627204e9208350675caef0426a342280831cee54607390e65fd',
                replicatedPointers: ['/captures/0/cases/67/facts', '/captures/1/cases/67/facts'],
              },
              {
                id: 'native-original-liquid-069',
                pointer: '/captures/0/cases/68/facts',
                sha256: '4113ed0c45bd3cb76af4c5040102c9a292c8f6c5028cd5d16bd986a33c7ffff6',
                replicatedPointers: ['/captures/0/cases/68/facts', '/captures/1/cases/68/facts'],
              },
              {
                id: 'native-original-liquid-070',
                pointer: '/captures/0/cases/69/facts',
                sha256: 'a58547fb439f7ed910f25eb40730a7db2c7f2b3714cf0116072fc791d31df909',
                replicatedPointers: ['/captures/0/cases/69/facts', '/captures/1/cases/69/facts'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
            sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-context-018',
                pointer: '/captures/0/cases/17/facts',
                sha256: '5201e2ac07cb1f00f74214df33107d02b316dead4a658e1137cdf48999fe9dd0',
                replicatedPointers: ['/captures/0/cases/17/facts', '/captures/1/cases/17/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
            '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
            'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
            '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
            '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
          ],
        ],
        regionFactIds: [
          [
            ['native-original-liquid-067'],
            ['native-original-liquid-068'],
            ['native-original-liquid-069'],
            ['native-original-context-018'],
            ['native-original-liquid-070'],
          ],
        ],
      },
    ]);
    assert.equal(
      await render(
        "{{ 'on' | boolean }}|{{ 'no' | boolean }}|{{ 'x' | boolean }}|{{ 'enabled' | boolean }}|{{ 'disabled' | boolean }}",
      ),
      'true|false||true|false',
    );
    assert.equal(
      await render("{{ '10.1' | integer }}|{{ '10' | integer }}|{{ '1.50' | decimal }}|{{ 5 | string }}"),
      '|10|1.5|5',
    );
    assert.equal(
      await render("[{{ '' | default: 'x' }}]|[{{ nil | default: 'x' }}]|[{{ false | default: 'x' }}]"),
      '[]|[x]|[false]',
    );
    assert.equal(
      await render('{{ n | file_size }}|{{ n | file_size: 2 }}|{{ 2050 | file_size: 0 }}', { n: 10000000 }),
      '9.5 MB|9.54 MB|2 KB',
    );
    assert.equal(
      await render(
        "{{ 1234.5678 | decimals: 2 }}|{{ 1234.5 | max_decimals: 2 }}|{{ 1234.5678 | invariant_culture_decimal_value: 2 }}|{{ 1234.5 | format: 'N2' }}",
      ),
      '1,234.57|1,234.5|1234.57|1,234.50',
    );
  }
  const { render: pageRender } = await setup(t);
  const user = { id: CONTACT, contactid: CONTACT, fullname: 'Ada', roles: ['Editors'] };
  assert.equal(
    (await pageRender("{{ user | has_role: 'Editors' }}|{{ user | has_role: 'Admins' }}", { user })).html,
    'true|false',
  );
  assert.equal((await pageRender("{% assign code = '{{ page.title }}' %}{{ code | liquid }}")).html, 'Child title');
});

test('date filters use en-US .NET formats on UTC values', async () => {
  const render = plain();
  assert.equal(
    await render(
      "{{ now }}|{{ now | date: 'g' }}|{{ now | date: 'MMMM dd, yyyy' }}|{{ now | date_add_days: 1.5 | date_to_iso8601 }}|{{ now | date_to_rfc822 }}",
      { now: NOW },
    ),
    '1/2/2026 3:04:05 AM|1/2/2026 3:04 AM|January 02, 2026|2026-01-03T15:04:05Z|Fri, 02 Jan 2026 03:04:05 Z',
  );
  const d = new Date(Date.UTC(2024, 0, 31, 13, 5, 0));
  assert.equal(
    await render("{{ d | date_add_months: 1 | date: 'd' }}|{{ d | date_add_years: -1 | date: 'yyyy' }}", { d }),
    '2/29/2024|2023',
  );
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '93cef513f7e0cb4141d4db790db2006b3e53f473300d95f79153835edf146ef6',
        originalAssertions: [
          '521907daa4560057042fdc528864c3e786dd9920f0a70ff37230cac8164febeb',
          'c881f3540701130c2cd26918dc398bc5fa22054527e332f2fdc0ba00868cc754',
          '4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b',
        ],
        originalBodyAstSha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
            selectedCallbackSha256: '12340314d1f3b8ae949aa6f00f809a93fbd6ee8bb6f844f800a38a528b415e97',
            selectedAssertionHashes: ['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20'],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '848f09b974607cd8e2c4b195a9256f3b5d4f70b9e29cd391ca438049e4c35b5d',
              'e92b84cd100dec8e0174c55dc82039e72119a9741bca1ed06598e90ee4bc3e57',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
            selectedCallbackSha256: '55b52cecdec5be4077408ff7cea5c0f5bf5331c582abb402b6742c95553e11c6',
            selectedAssertionHashes: [
              '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
              '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
              'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
              '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
              '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
            ],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '1c9ac9cb640a04f447f8578b4f719ba882e7e657340fb72f02fbc1d74f8ee34a',
              'dd5d4cac2aeb995373705ab9a950e1107ce03884ce584f50f23f37129101e849',
              '8794650311cde38e587c77490eb1b052ae0ae99fb2be674380eb790752cd3648',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
            selectedCallbackSha256: 'd3fee4218bdaade80b39e7dc2d6e5b142e8a54cbe048ac2576dcd5023d8f207d',
            selectedAssertionHashes: [
              '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
              'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
              '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
              '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
            ],
            surroundingStatementHashes: [
              '3840a3ce0e021dd65cd389f2997ab64b1cbc56bb6a21002a2ea799e4cef9e85d',
              'c2747c1313dd8d84482f524b740cec816d0ee78155cd67f9819330b4364bd47b',
              '3f5927190358e3dad2868037047352eaba08ab71d8c5ddb94320dc67b04dfd71',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
            selectedCallbackSha256: '76907019e385c858c3fb6bae2487dcbc63f19dd0b4d4ca11ceccea937fe16ecb',
            selectedAssertionHashes: ['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b'],
            surroundingStatementHashes: [
              'ef6c5f94853fab3f32775501e1a0fe592a4b75cd2c10ea4d986e05d3c9fe4b13',
              '9c5a8fdc336078a807f6fe9faf7e7ab1f46a29337b2db8a1892af44201641149',
              '5b39bbe5f38b7eacd025834f3f57d62dc0a588dc79a21a80c946fa593450e32c',
            ],
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
              title: 'date filters use en-US .NET formats on UTC values',
            },
          ],
          casesSha256: 'e3d630ccb79c408c992113f410b7b36203366bf5cec49c5a1c1b3215730bacd6',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
            sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-context-019',
                pointer: '/captures/0/cases/18/facts',
                sha256: '2c84db21951dd9113718ae46b7fcc90856a9f824b1ad72cf52434f73e9721795',
                replicatedPointers: ['/captures/0/cases/18/facts', '/captures/1/cases/18/facts'],
              },
            ],
          },
        ],
        regionHashes: [['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b']],
        regionFactIds: [[['native-original-context-019']]],
      },
    ]);
    assert.equal(
      await render("{{ s | date: 'yyyy' }}|{{ 'garbage' | date: 'yyyy' }}", { s: '2024-05-07T07:20:46Z' }),
      '2024|garbage',
    );
  }
});

test('URL filters keep absolute and relative forms', async () => {
  const render = plain();

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'ac8f2f688ec3f38522681a33401dfa1fe5e70bb924fdee384d08379e812d3b45',
        originalAssertions: [
          '0b419c1aa78ade10b7e03d9c57e970a57d1e803c1ba29e33f5c2175aff226602',
          '4d17ba6e4d9f8e64a9bf9f10613ae8e0bbe915b121b3455f8f810347916a91ac',
          '02189ee58243b2a7082fac5e939801216e1dd6ca02fd1f659d26724c282fab2b',
        ],
        originalBodyAstSha256: 'e7c2c5e1d7cb721538a277a84e68277e44c4f1e35494d55345b70af503de4ee9',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
              title: 'URL filters keep absolute and relative forms',
            },
          ],
          casesSha256: '92a46e6b9cde3e6a6b6ab0014934eed9501ffb8ae9037161f35c7a5d12acfe7f',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-071',
                pointer: '/captures/0/cases/70/facts',
                sha256: 'b2b7f4c28f44bd55eeff52ed2fd780310bf0da595d566989a7bde6a9e22a50a4',
                replicatedPointers: ['/captures/0/cases/70/facts', '/captures/1/cases/70/facts'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
            sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-context-020',
                pointer: '/captures/0/cases/19/facts',
                sha256: '06c5854c008dfece49133517a511f43091f9c0ec1afd5e7b5845910867683f4b',
                replicatedPointers: ['/captures/0/cases/19/facts', '/captures/1/cases/19/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          ['0b419c1aa78ade10b7e03d9c57e970a57d1e803c1ba29e33f5c2175aff226602'],
          ['02189ee58243b2a7082fac5e939801216e1dd6ca02fd1f659d26724c282fab2b'],
        ],
        regionFactIds: [[['native-original-liquid-071']], [['native-original-context-020']]],
      },
    ]);
    assert.equal(
      await render(
        "{{ 'https://example.com/path?page=1' | add_query: 'foo', 'bar' }}|{{ '/path?page=1' | add_query: 'page', 2 }}|{{ 'https://example.com/path?foo=bar&page=2' | remove_query: 'page' }}",
      ),
      'https://example.com/path?page=1&foo=bar|/path?page=2|https://example.com/path?foo=bar',
    );
  }

  // A relative URL keeps its own path text and fragment.
  assert.equal(
    await render("{{ 'path?a=1#f' | add_query: 'b', 2 }}|{{ '../next/?id=1' | add_query: 'tab', 'x' }}"),
    'path?a=1&b=2#f|../next/?id=1&tab=x',
  );

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'ac8f2f688ec3f38522681a33401dfa1fe5e70bb924fdee384d08379e812d3b45',
        originalAssertions: [
          '0b419c1aa78ade10b7e03d9c57e970a57d1e803c1ba29e33f5c2175aff226602',
          '4d17ba6e4d9f8e64a9bf9f10613ae8e0bbe915b121b3455f8f810347916a91ac',
          '02189ee58243b2a7082fac5e939801216e1dd6ca02fd1f659d26724c282fab2b',
        ],
        originalBodyAstSha256: 'e7c2c5e1d7cb721538a277a84e68277e44c4f1e35494d55345b70af503de4ee9',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
              title: 'URL filters keep absolute and relative forms',
            },
          ],
          casesSha256: '92a46e6b9cde3e6a6b6ab0014934eed9501ffb8ae9037161f35c7a5d12acfe7f',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-071',
                pointer: '/captures/0/cases/70/facts',
                sha256: 'b2b7f4c28f44bd55eeff52ed2fd780310bf0da595d566989a7bde6a9e22a50a4',
                replicatedPointers: ['/captures/0/cases/70/facts', '/captures/1/cases/70/facts'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
            sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-context-020',
                pointer: '/captures/0/cases/19/facts',
                sha256: '06c5854c008dfece49133517a511f43091f9c0ec1afd5e7b5845910867683f4b',
                replicatedPointers: ['/captures/0/cases/19/facts', '/captures/1/cases/19/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          ['0b419c1aa78ade10b7e03d9c57e970a57d1e803c1ba29e33f5c2175aff226602'],
          ['02189ee58243b2a7082fac5e939801216e1dd6ca02fd1f659d26724c282fab2b'],
        ],
        regionFactIds: [[['native-original-liquid-071']], [['native-original-context-020']]],
      },
    ]);
    assert.equal(
      await render(
        "{{ u | base }}|{{ u | host }}|{{ u | path }}|{{ '/path?foo=bar&page=2' | path_and_query }}|{{ u | port }}|{{ u | scheme }}",
        {
          u: 'https://example.com/path?foo=bar&page=2',
        },
      ),
      'https://example.com|example.com|/path|/path?foo=bar&page=2|443|https',
    );
  }
});

test('array filters', async () => {
  const render = plain();
  const list = [
    { a: 1, b: 'x' },
    { a: 2, b: 'x' },
    { a: 3, b: 'y' },
  ];
  // EnumerableFilters.where compares with object.Equals (no conversion).
  assert.equal(
    await render(
      "{{ list | where: 'a', 1 | size }}|{{ list | where: 'a', '1' | size }}|{{ list | order_by: 'a', 'desc' | map: 'a' | join: ',' }}|{{ list | group_by: 'b' | size }}|{{ list | select: 'a' | join: ',' }}",
      { list },
    ),
    '1|0|3,2,1|2|1,2,3',
  );
  assert.equal(
    await render(
      "{{ l | batch: 2 | size }}|{{ l | skip: 1 | take: 1 | first }}|{{ l | concat: m | size }}|{{ l | reverse | join: '' }}",
      { l: [1, 2, 3], m: [4] },
    ),
    '2|2|4|321',
  );
  assert.equal(
    await render("{{ a | uniq | join: '' }}|{{ a | compact | size }}", { a: ['b', 'a', 'b', null] }),
    'ba|3',
  );
  assert.equal(
    await render(
      "{{ 'abc' | size }}|{{ l | size }}|{{ l | first }}|{{ l | last }}|{{ 'abc' | first }}|{{ l.first }}|{{ l.last }}|{{ l.size }}",
      { l: [1, 2, 3] },
    ),
    '3|3|1|3|a|1|3|3',
  );
});

test('unknown filters return their input unchanged and are reported', async (t) => {
  const { render } = await setup(t);
  const result = await render(
    "{{ '{\"a\":1}' | json_parse }}|{{ 1.5 | number }}|{{ now | date_to_is08601 }}|{{ 'r' | raw }}",
  );
  assert.equal(result.html, '{"a":1}|1.5|1/2/2026 3:04:05 AM|r');
  assert.deepEqual(
    result.diagnostics
      .filter((d) => d.code === 'liquid-unknown-filter')
      .map((d) => d.filter)
      .sort(),
    ['date_to_is08601', 'json_parse', 'number', 'raw'],
  );
});

test('json writes request values verbatim and serialises other values like the local filter contract', async (t) => {
  const render = plain();
  const { render: page } = await setup(t);
  const echo = async (value) =>
    (
      await page(
        "{{ request.params['page'] | default: 1 | json }}",
        {},
        value === undefined ? '/child/' : `/child/?page=${encodeURIComponent(value)}`,
      )
    ).html;
  const inputs = ['-', ' - ', ' ', '"-"', '"" ""', '1.50', '[]', 'true'];
  const outputs = [];
  for (const input of inputs) outputs.push(await echo(input));
  assert.deepEqual(outputs, ['-', ' - ', ' ', '&quot;-&quot;', '&quot;&quot; &quot;&quot;', '1.50', '[]', 'true']);
  assert.deepEqual([await echo('01'), await echo('1'), await echo(undefined)], ['01', '1', '1']);
  const reports = [
    '{%- capture info -%}',
    '  {%- if id -%}',
    '    {% for item in items %}',
    '      {%- if item.id == id -%}',
    '        {{ item.info }}',
    '      {%- endif -%}',
    '    {% endfor %}',
    '  {%- endif -%}',
    '{%- endcapture -%}',
    "const headerHtml = {{ info | default: '' | json  }};",
  ].join('\r\n');
  assert.equal(
    await render(reports, {
      id: '00000000-0000-0000-0000-000000000000',
      items: [
        { id: 'a', info: 'x' },
        { id: 'b', info: 'y' },
      ],
    }),
    'const headerHtml = "";',
  );
  assert.equal(
    await render("const headerHtml = {{ info | default: '' | json }};", { info: '    " "\r\n' }),
    'const headerHtml = "" "";',
  );
  assert.equal(await render('{{ info | json }}', { info: '        `a\n\t"b"\n`\r\n' }), '"`a\n\t"b"\n`"');
  assert.equal(
    await render('[{{ s | json }}]|[{{ e | json }}]|[{{ q | json }}]', { s: ' \r\n\t', e: '', q: ' a"b ' }),
    '[""]|[""]|["a"b"]',
  );
  // Booleans, numbers, nil, arrays, hashes and dates keep the Json.NET-style serialisation.
  assert.equal(
    await render('{{ t | json }}|{{ f | json }}|{{ nil | json }}|{{ 1.5 | json }}', { t: true, f: false }),
    'true|false|null|1.5',
  );
  assert.equal(
    await render('{{ list | json }}|{{ hash | json }}|{{ d | json }}', {
      list: [1, 'a', null],
      hash: { a: 1, b: [true] },
      d: new Date(Date.UTC(2024, 4, 7, 7, 20, 46)),
    }),
    '[1,"a",null]|{"a":1,"b":[true]}|"2024-05-07T07:20:46Z"',
  );
  const loop = { name: 'x' };
  loop.self = loop;
  assert.equal(
    await render('{{ v | json }}', { v: loop }),
    "Liquid error: Self referencing loop detected for property 'self'.",
  );
});

// @test-kind parity: Every unchanged original assertion is bound to repeated native source/input/result facts.
// @parity-evidence: Manifest guarantee liquid-combined-mirage-test-liquid-portal-parity-test-mjs-581-0; exact capsule/run/fact/source bindings are asserted below.
test('split follows DotLiquid StandardFilters.Split', async () => {
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/liquid-portal-parity.test.mjs:581:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '869d12b8c351d01c0bb0921f58493d056030bbaf01b29078acf384700cc2c991',
      originalAssertions: [
        'a6cdee07bd01ac18632c644d7e618506940034ae487f4545a5d6b183fc17011b',
        '6dfd612287660d6a4e4b37d6f68f81322bcb2ab4b96543dded06016af1f09d47',
        '061646c82b8ea78c3c51770359ec4dc03c44142eeed79ff21b7ba65e2810402d',
      ],
      originalBodyAstSha256: 'd6e39815d48f07e792fbba3991530ad3e111faec6ffc3583688891d4baffb6ae',
      originalGuardHashes: [],
      moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
      isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
      moduleReview: {
        reviewedBy: '/root',
        reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
        corrections: [],
        addedTests: [
          {
            titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
            bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
            zeroOriginalCredit: true,
            interactionReviewed: true,
            reviewedBy: '/root',
            reason: 'Fixture slice independently proves isolation from selected renderer.',
          },
          {
            titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
            bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
            zeroOriginalCredit: true,
            interactionReviewed: true,
            reviewedBy: '/root',
            reason: 'Fixture slice independently proves isolation from selected renderer.',
          },
          {
            titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
            bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
            zeroOriginalCredit: true,
            interactionReviewed: true,
            reviewedBy: '/root',
            reason: 'Fixture slice independently proves isolation from selected renderer.',
          },
        ],
        isolatedRegistrationChanges: [
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root',
            reason: 'Independently reviewed source slice excludes this change.',
            titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
            oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
            currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root',
            reason: 'Independently reviewed source slice excludes this change.',
            titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
            oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
            currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root',
            reason: 'Independently reviewed source slice excludes this change.',
            titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
            oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
            currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
          },
        ],
        isolatedDeclarations: [
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root',
            reason: 'Independently reviewed source slice excludes this change.',
            astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root',
            reason: 'Independently reviewed source slice excludes this change.',
            astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
          },
        ],
      },
      importRoles: [
        {
          source: 'parse5',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/importer.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/data-error.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/liquid.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/liquid-filters.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/render-sweep-body.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../liquid-inventory.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../render-sweep.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../testing/owned-fixture.mjs',
          role: 'test-input',
          reviewedBy: '/root/frontend',
          reason:
            'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
        },
      ],
      runtimeInputs: [],
      lateImports: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
          importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
          source: '../lib/project-config.mjs',
          role: 'post-selected-isolated',
          reviewedBy: '/root',
          reason: 'Sequential later registration executes only after selected assertion completes.',
        },
      ],
      generatedFixtures: [
        {
          baselineId: 'mirage/test/liquid-portal-parity.test.mjs:581:0',
          bootstrap: {
            declarations: [
              'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
              '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
              'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
              '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
              'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
              'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
              '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
              '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
              'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
              'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
              '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
              '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
            ],
          },
          plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
          fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
          mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          isolatedFsCount: 18,
        },
      ],
      inputDependencies: [
        {
          path: 'mirage/testing/owned-fixture.mjs',
          sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        },
      ],
      sourceBindings: [],
      loopHeaders: [],
      caseUniverse: {
        count: 1,
        cases: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:581:0',
            title: 'split follows DotLiquid StandardFilters.Split',
          },
        ],
        casesSha256: 'c5c8538bb64f98465a7d478c3dcb5e4f5cd3b49c78676473ca5b74eab079e823',
        sourceBindings: [],
        ancestorLoops: [],
      },
      proofs: [
        {
          path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
          sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
          mode: 'reproduced-native',
          capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
          facts: [
            {
              id: 'native-original-liquid-073',
              pointer: '/captures/0/cases/72/facts',
              sha256: '5022290072f40c2769691cbe13faac9b5a782ffbe6afde0aca0a924c5fe7c10d',
              replicatedPointers: ['/captures/0/cases/72/facts', '/captures/1/cases/72/facts'],
            },
            {
              id: 'native-original-liquid-074',
              pointer: '/captures/0/cases/73/facts',
              sha256: '1b8e87b2b4ce6305dd732a64942694275e6018b9ffe8c00df73822e93f781e73',
              replicatedPointers: ['/captures/0/cases/73/facts', '/captures/1/cases/73/facts'],
            },
          ],
        },
        {
          path: 'mirage/test/fixtures/power-pages-original-scalar-context-evidence.json',
          sha256: '74de4dd966374dc7e824090264e7f1b9598243f4c607a899e9ecfc399f32975c',
          mode: 'reproduced-native',
          capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
          facts: [
            {
              id: 'native-original-context-025',
              pointer: '/captures/0/cases/24/facts',
              sha256: 'c76a6688844f714d2062619e617f56b53986189fd0be9b98562a8629721517e9',
              replicatedPointers: ['/captures/0/cases/24/facts', '/captures/1/cases/24/facts'],
            },
          ],
        },
      ],
    },
  ]);
  const render = plain();
  // IsNullOrWhiteSpace(input) ? new[] { input } : input.Split(pattern, RemoveEmptyEntries)
  assert.equal(
    await render("{{ '' | split: ',' | size }}|{{ nil | split: ',' | size }}|{{ ' ' | split: ',' | size }}"),
    '1|1|1',
  );
  assert.equal(
    await render(
      "{{ 'abc' | split: ',' | size }}|{{ 'abc' | split: ',' | first }}|{{ 'a,,b,' | split: ',' | join: '|' }}",
    ),
    '1|abc|a|b',
  );
  assert.equal(
    await render("{% assign parts = v | split: ',' %}{% for p in parts %}[{{ p }}]{% endfor %}", { v: null }),
    '[]',
  );
});

test('filter arguments follow the Strainer: a missing parameter without a default and surplus arguments raise inline errors', async () => {
  const render = plain();
  // Strainer.Invoke fills the widest overload with default values: a parameter without one raises
  // a SyntaxException naming it, and surplus arguments make MethodInfo.Invoke throw.
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'fa3794dffd0fac28dc1a6a1ddb7c71062ace8eb2f6633c49e12ef92b3e0d7129',
        originalAssertions: [
          '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
          'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
          '3c09da41fff72113f93f3499024216206bd630b10106512132f2a20d36702ac7',
          '4f9097f0e4d6033b0e94b87132f77d404c46045ce18328cb237787caf1f042da',
          '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
          '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
          '1a4b9388af0cd20e8d8fbd5e63292e52d275000a3acd2c054cb935ea616b20f0',
        ],
        originalBodyAstSha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
            selectedCallbackSha256: '12340314d1f3b8ae949aa6f00f809a93fbd6ee8bb6f844f800a38a528b415e97',
            selectedAssertionHashes: ['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20'],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '848f09b974607cd8e2c4b195a9256f3b5d4f70b9e29cd391ca438049e4c35b5d',
              'e92b84cd100dec8e0174c55dc82039e72119a9741bca1ed06598e90ee4bc3e57',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
            selectedCallbackSha256: '55b52cecdec5be4077408ff7cea5c0f5bf5331c582abb402b6742c95553e11c6',
            selectedAssertionHashes: [
              '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
              '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
              'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
              '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
              '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
            ],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '1c9ac9cb640a04f447f8578b4f719ba882e7e657340fb72f02fbc1d74f8ee34a',
              'dd5d4cac2aeb995373705ab9a950e1107ce03884ce584f50f23f37129101e849',
              '8794650311cde38e587c77490eb1b052ae0ae99fb2be674380eb790752cd3648',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
            selectedCallbackSha256: 'd3fee4218bdaade80b39e7dc2d6e5b142e8a54cbe048ac2576dcd5023d8f207d',
            selectedAssertionHashes: [
              '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
              'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
              '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
              '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
            ],
            surroundingStatementHashes: [
              '3840a3ce0e021dd65cd389f2997ab64b1cbc56bb6a21002a2ea799e4cef9e85d',
              'c2747c1313dd8d84482f524b740cec816d0ee78155cd67f9819330b4364bd47b',
              '3f5927190358e3dad2868037047352eaba08ab71d8c5ddb94320dc67b04dfd71',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
            selectedCallbackSha256: '76907019e385c858c3fb6bae2487dcbc63f19dd0b4d4ca11ceccea937fe16ecb',
            selectedAssertionHashes: ['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b'],
            surroundingStatementHashes: [
              'ef6c5f94853fab3f32775501e1a0fe592a4b75cd2c10ea4d986e05d3c9fe4b13',
              '9c5a8fdc336078a807f6fe9faf7e7ab1f46a29337b2db8a1892af44201641149',
              '5b39bbe5f38b7eacd025834f3f57d62dc0a588dc79a21a80c946fa593450e32c',
            ],
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
              title:
                'filter arguments follow the Strainer: a missing parameter without a default and surplus arguments raise inline errors',
            },
          ],
          casesSha256: 'f5a4df733b0cdbf11dad111cc007b2ed2b327856be8eb557409e8e62c640d243',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-075',
                pointer: '/captures/0/cases/74/facts',
                sha256: 'c05f997680c4d0e0c6bd6844358ae82c2295f286cd7ccefea7943e44095d67e1',
                replicatedPointers: ['/captures/0/cases/74/facts', '/captures/1/cases/74/facts'],
              },
              {
                id: 'native-original-liquid-076',
                pointer: '/captures/0/cases/75/facts',
                sha256: '32d778a07ec0a0addd53d013d5e4d8c2c141623ad7f1f796d6bab3a26e04fb74',
                replicatedPointers: ['/captures/0/cases/75/facts', '/captures/1/cases/75/facts'],
              },
              {
                id: 'native-original-liquid-077',
                pointer: '/captures/0/cases/76/facts',
                sha256: '7c4b2aa86103a9d0270579c94a5619e4a9485ce2c3f43039555f516bfe4ed9b7',
                replicatedPointers: ['/captures/0/cases/76/facts', '/captures/1/cases/76/facts'],
              },
              {
                id: 'native-original-liquid-078',
                pointer: '/captures/0/cases/77/facts',
                sha256: '9a763d1be73d59d67cbce74848c4e8cc2ee7fed5a2c841c4658b8c7559f26622',
                replicatedPointers: ['/captures/0/cases/77/facts', '/captures/1/cases/77/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
            'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
          ],
          [
            '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
            '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
          ],
        ],
        regionFactIds: [
          [['native-original-liquid-075'], ['native-original-liquid-076']],
          [['native-original-liquid-077'], ['native-original-liquid-078']],
        ],
      },
    ]);
    assert.equal(
      await render("{{ 'a' | append }}"),
      "Liquid syntax error: Error - Filter 'append' does not have a default value for 'string' and no value was supplied",
    );
    assert.equal(
      await render("{{ 'a' | append: 'b', 'c' }}|{{ -3 | abs: 1 }}"),
      'Liquid error: Parameter count mismatch.|Liquid error: Parameter count mismatch.',
    );
  }
  assert.equal(
    await render('{{ now | date }}', { now: NOW }),
    "Liquid syntax error: Error - Filter 'date' does not have a default value for 'format' and no value was supplied",
  );
  // Adxstudio signatures replace DotLiquid's: where(input, key, value) needs a value and
  // default(input, default) takes no allow_false argument.
  assert.equal(
    await render("{{ l | where: 'a' }}", { l: [] }),
    "Liquid syntax error: Error - Filter 'where' does not have a default value for 'value' and no value was supplied",
  );
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'fa3794dffd0fac28dc1a6a1ddb7c71062ace8eb2f6633c49e12ef92b3e0d7129',
        originalAssertions: [
          '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
          'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
          '3c09da41fff72113f93f3499024216206bd630b10106512132f2a20d36702ac7',
          '4f9097f0e4d6033b0e94b87132f77d404c46045ce18328cb237787caf1f042da',
          '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
          '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
          '1a4b9388af0cd20e8d8fbd5e63292e52d275000a3acd2c054cb935ea616b20f0',
        ],
        originalBodyAstSha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:281:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'dbe54f064c018bfcef873fd048267ec5eb1b0afe6efe0f47ec4ba63ea618c4a8',
            selectedCallbackSha256: '12340314d1f3b8ae949aa6f00f809a93fbd6ee8bb6f844f800a38a528b415e97',
            selectedAssertionHashes: ['d9708f71dc91a5fbb386523b8c83fe6583b7882bec387bf95e12e14b3593ee20'],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '848f09b974607cd8e2c4b195a9256f3b5d4f70b9e29cd391ca438049e4c35b5d',
              'e92b84cd100dec8e0174c55dc82039e72119a9741bca1ed06598e90ee4bc3e57',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:384:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '45d734880a0dc5d70006656dd0c9d4bb3051d96c3a41d22e6cd2497055a37ae5',
            selectedCallbackSha256: '55b52cecdec5be4077408ff7cea5c0f5bf5331c582abb402b6742c95553e11c6',
            selectedAssertionHashes: [
              '342f32e8cadd2bf69b9e672078e017200a3b6012781f1cd1dbf85ad3107c8565',
              '6d42ac878ee1a3ca4854bada79d0fcf47bc9fcf2483b9494ab113cb41894a82b',
              'ff3e2a02bee7c34939ff294a2a534c65fb4e2ef8fe0c960d58987b7c839712c1',
              '3cbf8baee709980745bf201d2e3ade16d28711cc1cd84381b4d981879c518b0c',
              '67519582101de547a39393b0ce05726079a3516d54fdfbd106f4a751adbc91e9',
            ],
            surroundingStatementHashes: [
              'c28ead0ec6b85e007a07a0505138e0fa9a74c78ea0118592b9b6a446af2aaa84',
              '1c9ac9cb640a04f447f8578b4f719ba882e7e657340fb72f02fbc1d74f8ee34a',
              'dd5d4cac2aeb995373705ab9a950e1107ce03884ce584f50f23f37129101e849',
              '8794650311cde38e587c77490eb1b052ae0ae99fb2be674380eb790752cd3648',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: '1a907bee31f639ec981815aa175e6d4ddccd482d9d4b1618bafdfb171a1d0f80',
            selectedCallbackSha256: 'd3fee4218bdaade80b39e7dc2d6e5b142e8a54cbe048ac2576dcd5023d8f207d',
            selectedAssertionHashes: [
              '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
              'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
              '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
              '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
            ],
            surroundingStatementHashes: [
              '3840a3ce0e021dd65cd389f2997ab64b1cbc56bb6a21002a2ea799e4cef9e85d',
              'c2747c1313dd8d84482f524b740cec816d0ee78155cd67f9819330b4364bd47b',
              '3f5927190358e3dad2868037047352eaba08ab71d8c5ddb94320dc67b04dfd71',
            ],
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:419:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
            selectedBodySha256: 'c92504da2daefd89907eb0989a49ecc92661bcc0f33fe0dec36001e6cc596f59',
            selectedCallbackSha256: '76907019e385c858c3fb6bae2487dcbc63f19dd0b4d4ca11ceccea937fe16ecb',
            selectedAssertionHashes: ['4d21d0aeeed3721362ee8b26f22e30f78f03194eb99682e1ad670b77df257b9b'],
            surroundingStatementHashes: [
              'ef6c5f94853fab3f32775501e1a0fe592a4b75cd2c10ea4d986e05d3c9fe4b13',
              '9c5a8fdc336078a807f6fe9faf7e7ab1f46a29337b2db8a1892af44201641149',
              '5b39bbe5f38b7eacd025834f3f57d62dc0a588dc79a21a80c946fa593450e32c',
            ],
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:600:0',
              title:
                'filter arguments follow the Strainer: a missing parameter without a default and surplus arguments raise inline errors',
            },
          ],
          casesSha256: 'f5a4df733b0cdbf11dad111cc007b2ed2b327856be8eb557409e8e62c640d243',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-075',
                pointer: '/captures/0/cases/74/facts',
                sha256: 'c05f997680c4d0e0c6bd6844358ae82c2295f286cd7ccefea7943e44095d67e1',
                replicatedPointers: ['/captures/0/cases/74/facts', '/captures/1/cases/74/facts'],
              },
              {
                id: 'native-original-liquid-076',
                pointer: '/captures/0/cases/75/facts',
                sha256: '32d778a07ec0a0addd53d013d5e4d8c2c141623ad7f1f796d6bab3a26e04fb74',
                replicatedPointers: ['/captures/0/cases/75/facts', '/captures/1/cases/75/facts'],
              },
              {
                id: 'native-original-liquid-077',
                pointer: '/captures/0/cases/76/facts',
                sha256: '7c4b2aa86103a9d0270579c94a5619e4a9485ce2c3f43039555f516bfe4ed9b7',
                replicatedPointers: ['/captures/0/cases/76/facts', '/captures/1/cases/76/facts'],
              },
              {
                id: 'native-original-liquid-078',
                pointer: '/captures/0/cases/77/facts',
                sha256: '9a763d1be73d59d67cbce74848c4e8cc2ee7fed5a2c841c4658b8c7559f26622',
                replicatedPointers: ['/captures/0/cases/77/facts', '/captures/1/cases/77/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '96caeb4b938ec39df4ae21a362fc8ad90bac2a99f856f27edf458a8b7df78e02',
            'a508a34e10ae8f17b4d6028fb3ba1d765bbde747dc8a58d0b45cbaef0f0b95e2',
          ],
          [
            '0c7fdda07421f2ac40126d613e17ffea35437ed2990f152aaa7424d6436a17fb',
            '1a01487be39f5139978606476a57bcfd2f0c9004be6322fee12cdaa1de2c0fe5',
          ],
        ],
        regionFactIds: [
          [['native-original-liquid-075'], ['native-original-liquid-076']],
          [['native-original-liquid-077'], ['native-original-liquid-078']],
        ],
      },
    ]);
    assert.equal(
      await render("{{ false | default: 'bar', allow_false: true }}"),
      'Liquid error: Parameter count mismatch.',
    );
    // An Adxstudio overload with another parameter count is added next to DotLiquid's
    // currency(input, languageTag = null); one argument selects the widest, which needs a record.
    assert.equal(
      await render('{{ 5 | currency }}'),
      "Liquid syntax error: Error - Filter 'currency' does not have a default value for 'record' and no value was supplied",
    );
  }
  // Parameters with defaults may be omitted; filters without a known signature are not checked.
  assert.equal(
    await render(
      "{{ 'hello world' | truncate }}|{{ 5.6 | round }}|{{ 'a' | json: 1 }}|{{ 'a' | missing_filter: 1, 2 }}",
    ),
    'hello world|6|"a"|a',
  );
});

test('the Strainer signature table covers the filter catalogue', () => {
  const catalogue = Object.keys(createFilters({}));
  // json and html_safe_escape are Power Pages filters without a published signature.
  assert.deepEqual(catalogue.filter((name) => !Object.hasOwn(FILTER_SIGNATURES, name)).sort(), [
    'html_safe_escape',
    'json',
  ]);
  assert.deepEqual(
    Object.keys(FILTER_SIGNATURES).filter((name) => !catalogue.includes(name)),
    [],
  );
});

test('capture names, root brackets, nil string operands, sort comparison and round digits follow DotLiquid master and Adxstudio', async () => {
  const render = plain();
  // Capture names match \A\s*([\w-]+)\s*\Z; anything else is a syntax error.
  assert.equal(await render('{% capture foo-a %}x{% endcapture %}{{ foo-a }}'), 'x');
  assert.equal(
    await render('a{% capture foo bar %}x{% endcapture %}b'),
    "Syntax Error in 'capture' tag - Valid syntax: capture [var]",
  );
  // Context.TryGetVariable calls Resolve(...).ToString() on a root bracket, which throws for nil.
  assert.equal(
    await render("{{ [missing] }}|{{ ['x'] }}|{{ [name] }}", { x: 1, name: 'x' }),
    'Liquid error: Object reference not set to an instance of an object.|1|1',
  );
  // Append and prepend interpolate their operands: $"{input}{@string}".
  assert.equal(await render("{{ nil | append: 'b' }}|{{ nil | prepend: 'a' }}"), 'b|a');
  // Sort compares with StringComparer.OrdinalIgnoreCase at DotLiquid20: characters of a string
  // ordinally, strings without case, and values that are not IComparable fail.
  assert.equal(
    await render("{{ 'BzAa4' | sort | join: '' }}|{{ l | sort | join: '' }}|{{ l | sort_natural | join: '' }}", {
      l: ['b', 'A', 'a', 'B'],
    }),
    '4ABaz|AabB|AabB',
  );
  assert.equal(
    await render('{{ h | sort }}', { h: [{ a: 1 }, { a: 2 }] }),
    'Liquid error: Failed to compare two elements in the array.',
  );
  assert.equal(await render("{{ h | sort: 'a' | map: 'a' | join: ',' }}", { h: [{ a: 2 }, { a: 1 }] }), '1,2');
  // Adxstudio round: Math.Round(decimal, decimals) accepts 0 to 28 digits.

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'c822287610443bad3bf2d44fde5e405455f6fa86d5b0e99854a14f2ec2f92b36',
        originalAssertions: [
          '4e7f0b71a2fa25eadec877f907f8a4df0e6f2408a9c5dfd8ad7fdce89342f64d',
          '4299ee9c7c46b602b26487510ca7dc6928c1086b420bc4057b55adfdea79473b',
          '8af6e808bc2a6081f3f4e05fdb7794ab993f630ed2fd374123c3ded3934477e4',
          '628b25bda2ec21cc08fade77be49f2f1b7be126de7ffce11707d1da334c4c9c0',
          'dce1a97b90710356da516938ad43f6d68be7447052cbb32d47061c1cbf8523eb',
          '8edeab3e179bd5af5dc76991f7eb4900691d8a3cefbdb97a0abb458a830a2120',
          '97428241e76142c9beca1e8e0f40e7245571a151b6516e8acc4b394337115925',
          'b47190618e1a35c94ba1fa217e4aa1cc65ec9978d0c76c5a8a5369df81c74563',
          '8cede2bb78116415c2c34a0cc60eca5ebdde90cafee7fb4467a4d57026cef13e',
        ],
        originalBodyAstSha256: '458e1c89b1ed4c40474f18e5a1819a271f7d5a80755ba59c5f495cf90bfd7b1c',
        originalGuardHashes: [],
        moduleContextAstSha256: 'c29709dd66951275511d749fc8017156732627148d5ae796bf75932c627c4441',
        isolationRegistrationsAstSha256: '85fdc3ef5ee30090919d11dd0f3d5da6308775bea63229a5e0eb5ec9d31481b0',
        moduleReview: {
          reviewedBy: '/root',
          reason: 'Reviewed source-only renderer isolation and unrelated test changes.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: 'af67ecb3e06d3cc65eb4ce23646b6fa01498240a6fe148af8b688447a8da6dfa',
              bodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: 'd28de5c3aedf32998e033390a84719085da022ee234bab35b854fec7409468e5',
              bodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
            {
              titleExpressionSha256: '576b400c5efa1ca5f5202831175c757d0e897d6c97b79b92c0b7e5294f1740b1',
              bodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root',
              reason: 'Fixture slice independently proves isolation from selected renderer.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              titleExpressionSha256: '376c2e02d434e8f1f7666bf2820b84f5169e69d8e90f6e3423f0344c415264b1',
              oldBodyAstSha256: '785d7c1beba990d17121e7fc7426249a5a3bcdc19ea28d1e676d80276d971af3',
              currentBodyAstSha256: '2f65432ce34e0c5a61f1dc3cc4b100f2082a821ed7518605a621e9db1cb8eb60',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '650b157895bd64a09a7044f0a789b693d77f66b14c023687fbd7efd9f59a1219',
              oldBodyAstSha256: 'f837785441f3863d82792e71a069455cf433820992fc2aa8361ffe43e7dc8c08',
              currentBodyAstSha256: 'b19365252f1478769a21e672772e3f7bc8e59c6ce75ccef2285a7f1adb6b2fee',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
            {
              titleExpressionSha256: '69fd0717a22c4305b7ed4714f05057a338a1951c9b031fc3e079fcef2176be16',
              oldBodyAstSha256: '9fc3c72822b4e74b4aab5ecb8c898134f2ed3a173511289e5a0abb6510b96fdf',
              currentBodyAstSha256: '6532305697b504919a567d45d61282822605ab0573b9129b07e9bc7be9e2ac12',
              zeroSelectedCredit: true,
              reviewedBy: '/root/liquid_remediation',
              reason:
                'Unselected renderer migration and source-identical original diagnostic test are separately retained; module and all registration behavior require independent isolation validation.',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root',
              reason: 'Independently reviewed source slice excludes this change.',
              astSha256: '11409cd21c6ff6ccbf02175fc274ecb78466f0a2db349c6bcbb4d4b5492fc7da',
            },
          ],
        },
        importRoles: [
          {
            source: 'parse5',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/importer.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data-error.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-filters.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/render-sweep-body.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../liquid-inventory.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../render-sweep.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../testing/owned-fixture.mjs',
            role: 'test-input',
            reviewedBy: '/root/frontend',
            reason:
              'Temporary-directory ownership helper only; its complete static source closure is baseline and runtime byte-bound because it establishes test setup.',
          },
        ],
        runtimeInputs: [],
        lateImports: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:1612:0',
            importAstSha256: 'aa8127bc85b05123f9b222db39c83e5997fad62b78dc0d4fc2cf737595aacd82',
            source: '../lib/project-config.mjs',
            role: 'post-selected-isolated',
            reviewedBy: '/root',
            reason: 'Sequential later registration executes only after selected assertion completes.',
          },
        ],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:151:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:164:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:210:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:299:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:439:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
          {
            baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
            bootstrap: {
              declarations: [
                'ebfadac106333462d544cef676304282a2c5e5a5a45d52f5e3a3be068f6a3039',
                '180f4a50f0332f3c5b9219994bdb07b36c2c112fef444b92b1ffbcba7867c791',
                'f91c742cfa862d6d7a68e85ea4c18dbfb5132d497a2413d22724fe6c89f2d912',
                '8e44924076a2503bac458ed957a2c88aeabae7e072ded50c95cf58c7066d2555',
                'e79045b6896d2c9583be79c8ddf3f2e54baede3727de78a99df4a47fb1163858',
                'add4ac494616becc7a802b739425e68f545be6c8921388b8580a2f831597753e',
                '3ad0403d261ea86c11b89b305afe03fcdbfe7dce12036cbab0f6c7adb7edeae9',
                '0df5f4290bf351799720ad06daa637da30b0bbeb11ec4cdb17a952050533b46f',
                'ae24317e2d79983fe07e4125edcd0fd6e8a0173f49ea06eac27d740f0604bc43',
                'f42f429e250e1ca2688179a2b2af22560dbbf8791b4a9a051570440999c88073',
                '9347673803fc4cdff789b63719c2aba0db8be98f2ec188a6a9fff754e3457ad9',
                '29aa7008e5ebd2447e9449c1cdf8e40b09c5f144815d86b38c0a1296d670dcf4',
              ],
            },
            plainSha256: '5401e47c3dab6bc9bc13e1b4654d77d428efca6a32693e5684451e7afeb50435',
            fixtureSha256: '945229659bb208071780e0e628f4a0af871cc79a09ac087b4bfe340db5c4eed4',
            mapsSha256: '1290684a48cb8f9e5e9746294d4e03d9deb73755e97a698e5ca6934046cbedb2',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            isolatedFsCount: 18,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/testing/owned-fixture.mjs',
            sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-portal-parity.test.mjs:654:0',
              title:
                'capture names, root brackets, nil string operands, sort comparison and round digits follow DotLiquid master and Adxstudio',
            },
          ],
          casesSha256: '206a5073f987463ce5938be0c3fa06c110bd7cb41206d3ab7d4294cd767a24e8',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/power-pages-existing-liquid-evidence.json',
            sha256: '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-original-liquid-081',
                pointer: '/captures/0/cases/80/facts',
                sha256: '7b8d31287da22a6b695ed0204ce144a67ec706046973d8d4e212595ea118fe0e',
                replicatedPointers: ['/captures/0/cases/80/facts', '/captures/1/cases/80/facts'],
              },
              {
                id: 'native-original-liquid-082',
                pointer: '/captures/0/cases/81/facts',
                sha256: '118a4b3b74719c202596ad8ae7a1410032f84c346579e18e9c2a4b4c9db52485',
                replicatedPointers: ['/captures/0/cases/81/facts', '/captures/1/cases/81/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            'b47190618e1a35c94ba1fa217e4aa1cc65ec9978d0c76c5a8a5369df81c74563',
            '8cede2bb78116415c2c34a0cc60eca5ebdde90cafee7fb4467a4d57026cef13e',
          ],
        ],
        regionFactIds: [[['native-original-liquid-081'], ['native-original-liquid-082']]],
      },
    ]);
    assert.equal(await render('{{ 5.666 | round: 2 }}|{{ 5.666 | round: 28 }}'), '5.67|5.666');
    assert.equal(
      await render('{{ 5.666 | round: -1 }}'),
      'Liquid error: Decimal can only round to between 0 and 28 digits of precision.\r\nParameter name: decimals',
    );
  }
});

test('errors render inline, parse failures render their bare message and missing templates render the platform text', async (t) => {
  const { render, renderer, portal } = await setup(t);
  let result = await render('a{{ 1 | divided_by: 0 }}b');
  assert.equal(result.html, 'aLiquid error: Attempted to divide by zero.b');
  assert.equal(result.diagnostics[0].code, 'liquid-error');
  result = await render('a{% nosuch %}b');
  assert.equal(result.html, "Unknown tag 'nosuch'");
  assert.equal(result.diagnostics[0].code, 'liquid-syntax-error');
  result = await render("<{% include 'Broken' %}>");
  assert.match(result.html, /^<Liquid syntax error: .+>$/);
  result = await render("<{% include 'Nope' %}>");
  assert.equal(result.html, '<Template "Nope" not found.>');
  assert.equal(result.diagnostics[0].code, 'liquid-template-not-found');
  // A failing page template still answers 200 with the rendered text.
  portal.templates[portal.pageTemplates[0].webTemplateId].source =
    '<!doctype html><html><body>{% nosuch %}</body></html>';
  const page = await renderer.renderPage('/child/');
  assert.equal(page.status, 200);
  assert.equal(page.html, "Unknown tag 'nosuch'");
});

test('include, extends and block resolve web templates by case-insensitive name before runtime templates', async (t) => {
  const { render } = await setup(t);
  assert.equal((await render("{% include 'Child' %}")).html, '<article>Output</article>');
  assert.equal((await render("{% include 'row' label: 'B' %}|[{{ label }}]")).html, 'B|[]');
  assert.equal((await render("{% include 'item' for list %}", { list: [1, 2, 3] })).html, '[1][2][3]');
  assert.equal((await render("{% include 'item' with 'x' %}")).html, '[x]');
  // The page copy include uses the runtime page_copy template (editable markup for non-editors;
  // TagBuilder class attribute through the AntiXSS attribute encoder).
  assert.equal(
    (await render("{% include 'page_copy' %}")).html,
    '<div class="xrm-editable-html&#32;xrm-attribute&#32;page-copy"><div class="xrm-attribute-value"><p>Child title</p></div></div>',
  );
});

test('page, sitemap, weblinks, sitemarkers, settings and snippets objects', async (t) => {
  const { render } = await setup(t);
  assert.equal(
    (
      await render(
        '{{ page.title }}|{{ page.url }}|{{ page.parent.title }}|{{ page.breadcrumbs.size }}|{{ page.id }}|{{ page.adx_name }}|[{{ page.ADX_NAME }}]',
      )
    ).html,
    `Child title|/child/|Home|1|${CHILD}|Child|[]`,
  );
  assert.equal(
    (
      await render(
        "{{ sitemap.current.title }}|{{ sitemap.root.title }}|{{ sitemap.root.children.size }}|{{ sitemap['/child/'].title }}",
      )
    ).html,
    'Child title|Home|1|Child title',
  );
  assert.equal(
    (
      await render(
        "{{ weblinks['Primary Navigation'].weblinks.size }}|{{ weblinks['Primary Navigation'].weblinks[0].name }}|{{ weblinks['Primary Navigation'].weblinks[0].url }}",
      )
    ).html,
    '1|Child link|/child/',
  );
  assert.equal((await render("{{ sitemarkers['Child Marker'].url }}|[{{ sitemarkers['Nope'] }}]")).html, '/child/|[]');
  assert.equal(
    (await render("{{ settings['Search/Enabled'] }}|{{ settings['Custom/Value'] }}|[{{ settings['Missing'] }}]")).html,
    'true|abc|[]',
  );
  // Snippet values are rendered as Liquid in the current context.
  assert.equal(
    (await render("{{ snippets['Plain'] }}|{{ snippets.Liquid }}|[{{ snippets['Missing'] }}]")).html,
    'Plain <b>text</b>|Sum 2|[]',
  );
  assert.equal((await render('{{ page }}|{{ website }}')).html, '|');
  // Snippet values are rendered on access; a snippet that includes itself stops with an inline error.
  assert.equal((await render("{{ snippets['Self'] }}")).html, 'aLiquid error: Recursive content snippet Selfb');
});

test('the managed Page Copy template nests the editable wrapper and the layout carries the platform body attributes', async (t) => {
  const { render, renderer } = await setup(t);
  const copy = await render("{% include 'Page Copy' %}");
  assert.equal(
    copy.html,
    '<div class="page-copy"><div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value"><p>Child title</p></div></div></div>',
  );
  assert.ok(copy.diagnostics.some((d) => d.code === 'liquid-managed-template-source'));
  const page = await renderer.renderPage('/child/grand/');
  assert.equal(page.status, 200);
  assert.ok(page.html.includes('<title>Grand title &nbsp;· Parity</title>'));
  assert.ok(
    page.html.includes(
      '<body data-sitemap-state="/child/grand/:/child/:/" data-dateformat="dd/MM/yyyy" data-timeformat="h:mm tt" data-datetimeformat="dd/MM/yyyy HH:MM" data-app-path="/" data-ckeditor-basepath="/js/BaseHtmlContentDesigner/Libs/msdyncrm_/libs/ckeditor/" data-case-deflection-url="/_services/search/' +
        SITE +
        '">',
    ),
  );
  assert.ok(
    page.html.includes(
      '<div class="page-copy"><div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value"><p>Grand copy</p>',
    ),
  );
});

test('request, params, website, user and now objects with default HTML encoding of user and request', async (t) => {
  const { render } = await setup(t);
  const url = '/child/?q=%3Cb%3E&x=1';
  let result = await render(
    "{{ request.path }}|{{ request.path_and_query }}|{{ request.query }}|{{ request.params.q }}|{{ request.params['q'] | escape }}|{{ request.params.size }}|{{ params.x }}",
    {},
    url,
  );
  assert.equal(result.html, '/child/|/child/?q=%3Cb%3E&amp;x=1|?q=%3Cb%3E&amp;x=1|&lt;b&gt;|&lt;b&gt;|2|1');
  assert.equal((await render('{% if user %}signed{% else %}anon{% endif %}')).html, 'anon');
  const user = {
    id: CONTACT,
    contactid: CONTACT,
    fullname: 'Ada <Lovelace>',
    roles: ['Authenticated Users', 'Editors'],
  };
  result = await render(
    "{{ user.fullname }}|{{ user.fullname | escape }}|{{ user.roles | join: ',' }}|{% if user.roles contains 'Editors' %}e{% endif %}",
    { user },
  );
  assert.equal(result.html, 'Ada &lt;Lovelace&gt;|Ada &lt;Lovelace&gt;|Authenticated Users,Editors|e');
  assert.equal(
    (await render('{{ website.name }}|{{ website.sign_in_url }}|{{ website.sign_out_url }}|{{ website.id }}')).html,
    `Parity|/SignIn?returnUrl=%2Fchild%2F|/Account/Login/LogOff?returnUrl=%2Fchild%2F|${SITE}`,
  );
  assert.equal((await render("{{ now | date: 'yyyy-MM-dd' }}")).html, '2026-01-02');
  // Site/EnableDefaultHtmlEncoding = false restores raw output.
  const unencoded = await setup(
    t,
    {},
    { 'sitesetting.yml': "- adx_name: Site/EnableDefaultHtmlEncoding\n  adx_value: 'false'" },
  );
  assert.equal((await unencoded.render('{{ request.params.q }}', {}, url)).html, '<b>');
});

test('entities load records by GUID; attribute names are exact and drop properties are not', async (t) => {
  const { render } = await setup(t);
  const result = await render(
    `{% assign c = entities.contact['${CONTACT}'] %}{{ c.fullname }}|{{ c.Mixed }}|[{{ c.mixed }}]|{{ c.ID }}|{{ c.logical_name }}|{{ entities['contact']['{${CONTACT.toUpperCase()}}'].fullname }}|[{{ entities.contact['missing'].fullname }}]`,
  );
  assert.equal(result.html, `Ada|case|[]|${CONTACT}|contact|Ada|[]`);
  assert.deepEqual(result.diagnostics, []);
});

test('simulator infrastructure errors abort the render; Liquid and Dataverse errors render inline', async (t) => {
  const LIVE = '9a4d1c2e-0000-4000-8000-0000000000d1';
  const DENIED = '9a4d1c2e-0000-4000-8000-0000000000d2';
  const { render, renderer, portal } = await setup(t, {
    entity: async (table, id) => {
      if (id === LIVE)
        throw Object.assign(new Error('Live data read returned HTTP 403.'), { status: 403, code: 'LIVE_BRIDGE' });
      if (id === DENIED) throw new DataError('Read permission denied', 403, 'PermissionDenied');
      return null;
    },
    fetchXml: async () => {
      throw new DataError('FetchXML condition requires attribute', 400, 'InvalidFetchXml');
    },
    renderComponent: async () => {
      throw Object.assign(new Error("Component entityform 'x' requires a form/view schema."), {
        status: 501,
        code: 'COMPONENT_SCHEMA_REQUIRED',
      });
    },
  });
  // Table permissions: a record the user cannot read is nil (EntitySetDrop).
  assert.equal((await render(`[{{ entities.contact['${DENIED}'].fullname }}]`)).html, '[]');
  // Dataverse faults keep DotLiquid's inline rendering.
  assert.equal(
    (await render("{% fetchxml q %}<fetch><entity name='contact'/></fetch>{% endfetchxml %}after")).html,
    'Liquid error: FetchXML condition requires attributeafter',
  );
  await assert.rejects(render(`{{ entities.contact['${LIVE}'].fullname }}`), (error) => error.code === 'LIVE_BRIDGE');
  await assert.rejects(render("{% entityform name: 'x' %}"), (error) => error.code === 'COMPONENT_SCHEMA_REQUIRED');
  // renderPage turns the propagated failure into the page status.
  portal.templates[portal.pageTemplates[0].webTemplateId].source =
    `<!doctype html><html><body>{{ entities.contact['${LIVE}'].fullname }}</body></html>`;
  const page = await renderer.renderPage('/child/');
  assert.equal(page.status, 403);
  assert.match(page.html, /Live data read returned HTTP 403/);
});

test('polls and ads objects follow the Adxstudio data adapters', async (t) => {
  const { render } = await setup(t);
  assert.equal(
    (
      await render(
        "{% assign ad = ads['Visible Ad'] %}{{ ad.title }}|{{ ad.redirect_url }}|{{ ad.image.url }}|{{ ad.image.alternate_text }}|{{ ad.image.height }}|{{ ad.open_in_new_window }}|{{ ad.copy }}|{{ ad.adx_name }}|{{ ad.logical_name }}|{{ ad.ad_url }}",
      )
    ).html,
    `Ad title|/child/|/banner.png|Banner|50|true|<p>Copy</p>|Visible Ad|adx_ad|/_services/ads/${SITE}/${AD}`,
  );
  // Hidden publishing states are filtered out; placements list only accepted ads.
  assert.equal(
    (
      await render(
        "[{{ ads['Draft Ad'] }}]|{{ ads.placements['Sidebar'].ads.size }}|{{ ads.placements.Sidebar.random_url }}",
      )
    ).html,
    `[]|1|/_services/ads/${SITE}/placements/${AD_PLACEMENT}/random`,
  );
  assert.equal(
    (
      await render(
        "{% assign poll = polls['Sample'] %}{{ poll.question }}|{{ poll.submit_button_label }}|{{ poll.votes }}|{% for o in poll.options %}{{ o.answer }}:{{ o.votes }}:{{ o.percentage }};{% endfor %}|{{ poll.has_user_voted }}|{{ poll.submit_url }}",
      )
    ).html,
    `Which?|Vote|4|Yes:3:75;No:1:25;|false|/_services/polls/${SITE}/SubmitPoll?id=${POLL}`,
  );
  // Expired polls are not selectable, by name or through a placement.
  assert.equal(
    (
      await render(
        "[{{ polls['Old'] }}]|{{ polls.placements['Sidebar'].polls.size }}|{{ polls.placements[id].random_url }}",
        { id: POLL_PLACEMENT },
      )
    ).html,
    `[]|1|/_services/polls/${SITE}/placements/${POLL_PLACEMENT}/random`,
  );
});

test('ad and poll services render one placement item with its web template or the MasterPortal view template', async (t) => {
  const squash = (html) => html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
  const { render } = await setup(t);
  // The embedded ad and poll templates render the placeholders that the services fill.
  assert.equal(
    squash(
      (
        await render(
          "{% include 'ad' ad_placement_name: 'Sidebar' %}{% include 'poll' poll_placement_name: 'Sidebar' %}",
        )
      ).html,
    ),
    `<div class="ad" data-url="/_services/ads/${SITE}/placements/${AD_PLACEMENT}/random"></div>` +
      `<div class="poll" data-url="/_services/polls/${SITE}/placements/${POLL_PLACEMENT}/random" data-submit-url="/_services/polls/${SITE}/SubmitPoll?id=${POLL_PLACEMENT}"></div>`,
  );
  // AdController.RandomAd: Views/Ad/Ad.ascx renders AdTemplate.ascx with ad and show_copy.
  assert.equal(
    squash((await render("{% assign ad_placement_name = 'Sidebar' %}{% mirage_ad %}")).html),
    '<div><a class="ad-link" href="/child/" title="Ad title"><h5 class="ad-title">Ad title</h5><img class="ad-link-image center-block" src="/banner.png" alt="Banner" height="50" width="100" style="height:50px;width:100px;"></a><div class="ad-copy"><p>Copy</p></div></div>',
  );
  // PollController.RandomPoll: Views/Poll/Poll.ascx renders PollTemplate.ascx with poll; the expired
  // poll in the placement is not selectable.
  const poll = squash((await render("{% assign poll_placement_name = 'Sidebar' %}{% mirage_poll %}")).html);
  assert.ok(
    poll.startsWith(
      `<div><div class="poll-questionpanel" data-id="${POLL}" data-name="Sample"><h5 class="poll-question">Which?</h5>`,
    ),
    poll,
  );
  assert.deepEqual(
    [...poll.matchAll(/<span class="poll-option">([^<]*)<\/span>/g)].map((m) => m[1]),
    ['Yes', 'No'],
  );
  for (const part of [
    '>Vote</button>',
    '>View results</button>',
    '<p>Total votes: 4</p>',
    '>Return to poll</button>',
    '<span class="poll-percentage pull-right">75%</span>',
  ])
    assert.ok(poll.includes(part), part);
  // Placement actions (WebFormsContent.master sidebar): AdPlacementTemplate and PollPlacementTemplate
  // with random true render the placeholders that the services fill.
  assert.equal(
    squash((await render("{% assign ad_placement_name = 'Sidebar' %}{% mirage_ad_placement %}")).html),
    `<div class="ad" data-url="/_services/ads/${SITE}/placements/${AD_PLACEMENT}/random"></div>`,
  );
  const panel = squash((await render("{% assign poll_placement_name = 'Sidebar' %}{% mirage_poll_placement %}")).html);
  assert.ok(
    panel.startsWith(
      '<div class="content-panel panel panel-default"><div class="panel-heading"><h4><span class="fa fa-question-circle" aria-hidden="true"></span>',
    ),
    panel,
  );
  assert.ok(panel.includes('>Poll</span></span></h4></div>'), panel);
  assert.ok(
    panel.endsWith(
      `<div class="panel-body poll random" data-url="/_services/polls/${SITE}/placements/${POLL_PLACEMENT}/random" data-submit-url="/_services/polls/${SITE}/SubmitPoll?id=${POLL_PLACEMENT}"></div></div>`,
    ),
    panel,
  );
  const observed = await setup(
    t,
    {},
    {
      'ad.yml': `- adx_adid: ${AD}\n  adx_name: Placeholder\n  adx_url: ~/\n  adx_openinnewwindow: false`,
      'polls/sample/Sample.poll.yml': `adx_pollid: ${POLL}\nadx_name: Sample\nadx_question: Which?\nadx_submitbuttonlabel: Vote\nadx_active: false`,
      'polls/sample/Sample.poll.polloption.yml': `- adx_polloptionid: 9a4d1c2e-0000-4000-8000-0000000000b3\n  adx_name: No\n  adx_answer: No\n  adx_pollid: ${POLL}\n  adx_votes: 2\n  adx_displayorder: 2\n- adx_polloptionid: 9a4d1c2e-0000-4000-8000-0000000000b2\n  adx_name: Yes\n  adx_answer: Yes\n  adx_pollid: ${POLL}\n  adx_votes: 7\n  adx_displayorder: 1`,
    },
  );
  assert.equal(
    squash((await observed.render("{% assign ad_placement_name = 'Sidebar' %}{% mirage_ad %}")).html),
    '<div><a class="ad-link" href="/" title=""></a></div>',
  );
  const served = squash((await observed.render("{% assign poll_placement_name = 'Sidebar' %}{% mirage_poll %}")).html);
  assert.deepEqual(
    [...served.matchAll(/<span class="poll-option">([^<]*)<\/span>/g)].map((m) => m[1]),
    ['Yes', 'No'],
  );
  assert.ok(served.includes('<span class="poll-percentage pull-right">78%</span>'), served);
  // An item with a web template renders through it; the ad or poll name selects directly.
  const templated = await setup(
    t,
    {},
    {
      'polls/sample/Sample.poll.yml': `adx_pollid: ${POLL}\nadx_name: Sample\nadx_question: Which?\nadx_webtemplateid: 9a4d1c2e-0000-4000-8000-000000000309`,
      ...template('09', 'Poll View', '<b>{{ poll.name }}|{{ poll.votes }}</b>'),
    },
  );
  assert.equal((await templated.render("{% assign poll_name = 'Sample' %}{% mirage_poll %}")).html, '<b>Sample|4</b>');
  assert.equal(
    (await templated.render(`{% assign poll_placement_name = '${POLL_PLACEMENT}' %}{% mirage_poll %}`)).html,
    '<b>Sample|4</b>',
  );
});

test('editable, substitution and component tags keep their contracts', async (t) => {
  const calls = [];
  const { render } = await setup(t, {
    renderComponent: async (tag, args) => {
      calls.push([tag, args]);
      return tag === 'entitylist'
        ? { html: '<table></table>', context: { entitylist: { name: args.name } } }
        : `<${tag}/>`;
    },
  });
  assert.equal(
    (await render("{% editable page 'adx_copy' type: 'html', liquid: true %}")).html,
    '<div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value"><p>Child title</p></div></div>',
  );
  assert.equal((await render('{% substitution %}sub{% endsubstitution %}')).html, 'sub');
  assert.equal(
    (
      await render(
        "{% entityform name: 'Edit' %}{% entitylist name: 'Contacts' %}[{{ entitylist.name }}]{% endentitylist %}{% chart chart_id: 'c' %}",
      )
    ).html,
    '<entityform/><table></table>[Contacts]<chart/>',
  );
  assert.deepEqual(calls, [
    ['entityform', { name: 'Edit' }],
    ['entitylist', { name: 'Contacts' }],
    ['chart', { chart_id: 'c' }],
  ]);
  const { render: bare } = await setup(t);
  const result = await bare("{% powerbi path: 'x' %}");
  assert.match(result.html, /data-mirage-component="powerbi" role="alert"/);
  assert.equal(result.diagnostics[0].code, 'unsupported-platform-component');
});

test('a snippet record without a value is nil and its editable wrapper is marked no-value', async (t) => {
  const { render } = await setup(
    t,
    {},
    {
      'content-snippets/empty/Empty.en-US.contentsnippet.yml':
        'adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000044\nadx_contentsnippetlanguageid: 9a4d1c2e-0000-4000-8000-0000000000ab\nadx_name: Empty/Snippet',
    },
  );
  const html = (await render("{% editable snippets 'Empty/Snippet' type: 'text' %}")).html;
  assert.deepEqual(/class="([^"]*)"/.exec(html)[1].split('&#32;').sort(), [
    'no-value',
    'xrm-attribute',
    'xrm-editable-text',
  ]);
  assert.ok(html.endsWith(' data-languageContext="English"><div class="xrm-attribute-value"></div></div>'), html);
  // Dataverse stores empty text as null: the value is nil for output, conditions and default.
  assert.equal(
    (
      await render(
        "[{{ snippets['Empty/Snippet'] }}]{% if snippets['Empty/Snippet'] %}set{% else %}nil{% endif %}|{{ snippets['Empty/Snippet'] | default: 'Fallback' }}",
      )
    ).html,
    '[]nil|Fallback',
  );
  // A snippet with a value keeps the plain wrapper.
  assert.equal(
    (await render("{% editable snippets 'Plain' type: 'html' %}")).html,
    '<div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value">Plain <b>text</b></div></div>',
  );
});

test('fetchxml exposes results, totals and the query text', async (t) => {
  let received;
  const { render } = await setup(t, {
    fetchXml: async (xml) => {
      received = xml;
      return { entities: [{ fullname: 'Alpha' }, { fullname: 'Beta' }], total_record_count: 2, more_records: false };
    },
  });
  const result = await render(
    "{% fetchxml q %}<fetch><entity name='contact'><filter><condition attribute='fullname' operator='eq' value='{{ page.title }}' /></filter></entity></fetch>{% endfetchxml %}{% for e in q.results.entities %}{{ e.fullname }};{% endfor %}|{{ q.results.total_record_count }}|{{ q.results.more_records }}",
  );
  assert.equal(result.html, 'Alpha;Beta;|2|false');
  assert.match(received, /value='Child title'/);
  // Without a table permission granting read the results are empty, not an error.
  const denied = await setup(t, {
    fetchXml: async () => {
      throw new DataError('Table permission denies read on contact', 403, 'PermissionDenied');
    },
  });
  assert.equal(
    (
      await denied.render(
        "{% fetchxml q %}<fetch><entity name='contact'/></fetch>{% endfetchxml %}{{ q.results.entities.size }}|{{ q.permission_granted }}",
      )
    ).html,
    '0|false',
  );
});

test('Liquid inventory counts tags, filters and objects and classifies support', async (t) => {
  const portal = await fixturePortal(t, {
    ...template(
      '07',
      'Probe',
      "{% for i in list %}{{ i | nosuch }}{{ i | json }}{{ forloop.index }}{% endfor %}{{ request.params['id'] | escape }}{{ blogs.posts }}{% else if x %}",
    ),
  });
  const report = await inventoryPortal(portal);
  const status = (list, name) => list.find((entry) => entry.name === name)?.status;
  assert.equal(status(report.tags, 'for'), 'supported');
  assert.equal(status(report.tags, 'endfor'), 'structural');
  assert.equal(status(report.filters, 'escape'), 'supported');
  assert.equal(status(report.filters, 'json'), 'supported');
  assert.equal(status(report.filters, 'nosuch'), 'unknown');
  assert.equal(status(report.objects, 'request'), 'global');
  assert.equal(status(report.objects, 'forloop'), 'contextual');
  assert.equal(status(report.objects, 'i'), 'local');
  assert.equal(status(report.objects, 'blogs'), 'unsupported');
  assert.equal(status(report.properties, 'request.params'), 'supported');
  assert.equal(status(report.properties, 'forloop.index'), 'supported');
  assert.deepEqual(
    report.unsupported.map((entry) => `${entry.kind}:${entry.name}`),
    ['object:blogs'],
  );
  assert.ok(report.includes.some((entry) => entry.name === 'Page Copy' && entry.resolution === 'runtime-managed'));
  assert.ok(report.syntaxErrors.some((entry) => entry.source === 'web-template:Broken'));
  assert.deepEqual(
    scanTokens('a{% raw %}{{ x }}{% endraw %}{{- y -}}', new Set(['raw'])).map((token) => token.markup.trim()),
    ['raw', 'endraw', 'y'],
  );
  assert.deepEqual(
    expressionPaths("snippets['A b'] | default: page.title, 'x' | date: fmt").map(
      (entry) => `${entry.root}.${entry.member}`,
    ),
    ['snippets.A b', 'page.title', 'fmt.null'],
  );
});

test('render sweep classifies Liquid errors and local injection into non-document responses', () => {
  const injected = classifyResponse({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: '<script src="/__sim-static/vendor/x.js"></script>{"a":1}',
    diagnostics: [{ code: 'liquid-unknown-filter', message: 'json' }],
  });
  assert.equal(injected.document, false);
  assert.deepEqual(injected.injected, ['sim-static']);
  assert.equal(injected.liquidNotices.length, 1);
  const page = classifyResponse({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><body>Liquid error: boom<script data-paqvilo-mirage-runtime></script></body></html>',
    diagnostics: [{ code: 'liquid-runtime-error', message: 'boom' }],
  });
  assert.equal(page.document, true);
  assert.deepEqual(page.injected, []);
  assert.deepEqual(page.inlineErrors, ['Liquid error: boom']);
  assert.equal(page.liquidErrors.length, 1);
  assert.equal(idParameterTable(["{% assign p = entities['sample_product'][request.params.id] %}"]), 'sample_product');
  assert.equal(
    idParameterTable([
      '<fetch><entity name="sample_change"><filter><condition attribute="sample_changeid" operator="eq" value="{{ params[\'id\'] }}" /></filter></entity></fetch>',
    ]),
    'sample_change',
  );
  assert.equal(idParameterTable(['{{ request.params.page }}']), null);
});

test('render sweep samples authored content after oversized runtime injection without hiding response classification', () => {
  const authored =
    '<!doctype html><html><body>[]rows=2<script>const marker="data-paqvilo-mirage-runtime";</script></body></html>';
  const injected = `<script data-paqvilo-mirage-runtime>${'/* local runtime */'.repeat(1500)}</script><script src="/__sim-static/pages.js" data-paqvilo-mirage-runtime></script>`;
  assert.ok(injected.length > 20_000);
  assert.deepEqual(retainedResponseBody(injected + authored, 'text/html; charset=utf-8'), {
    body: authored,
    bodyTruncated: false,
    bodyOmittedRuntimeScripts: 2,
  });
  assert.deepEqual(retainedResponseBody('a'.repeat(20_001), 'text/plain'), {
    body: 'a'.repeat(20_000),
    bodyTruncated: true,
    bodyOmittedRuntimeScripts: 0,
  });
  const classified = classifyResponse({
    status: 200,
    contentType: 'application/json',
    body: injected + '{"rows":2}',
    diagnostics: [],
  });
  assert.equal(classified.document, false);
  assert.deepEqual(classified.injected, ['sim-static', 'sim-runtime']);
  assert.equal(classified.bytes, Buffer.byteLength(injected + '{"rows":2}'));
});

test('render sweep body sampling handles deeply nested authored markup before the sample limit', () => {
  const authored = '<div>'.repeat(12_000) + 'synthetic' + '</div>'.repeat(12_000);
  const sample = retainedResponseBody(authored, 'text/html');
  assert.equal(sample.body, authored.slice(0, 20_000));
  assert.equal(sample.bodyTruncated, true);
  assert.equal(sample.bodyOmittedRuntimeScripts, 0);
});

test('render sweep preserves literal runtime marker markup in non-HTML samples', () => {
  const markup = '<script data-paqvilo-mirage-runtime>synthetic</script>';
  for (const [body, contentType] of [
    [JSON.stringify({ markup }), 'application/json'],
    [markup, 'text/plain'],
    [markup, null],
  ])
    assert.deepEqual(retainedResponseBody(body, contentType), {
      body,
      bodyTruncated: false,
      bodyOmittedRuntimeScripts: 0,
    });
});

test("user web-role relationship and enhanced attribute aliases follow the site's data model", async (t) => {
  // Standard model: adx_webrole_contact lists adx_webrole records.
  const { render } = await setup(
    t,
    {},
    {
      'webrole.yml':
        '- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e1\n  adx_name: Editors\n- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e2\n  adx_name: Readers',
    },
  );
  const user = { id: CONTACT, contactid: CONTACT, fullname: 'Ada', roles: ['Editors'] };
  assert.equal(
    (
      await render(
        '{{ user.adx_webrole_contact.size }}|{{ user.adx_webrole_contact[0].adx_name }}|{{ user.adx_webrole_contact[0].logical_name }}|[{{ user.powerpagecomponent_mspp_webrole_contact }}]',
        { user },
      )
    ).html,
    '1|Editors|adx_webrole|[]',
  );
  // Enhanced model: powerpagecomponent_mspp_webrole_contact lists powerpagecomponent rows, and
  // bare content columns are readable with adx_ and mspp_ prefixes.
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'liquid-enhanced-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const component = (id, type, name, content) =>
    `<powerpagecomponent powerpagecomponentid="${id}"><content>${JSON.stringify(content).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</content><name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>0</statecode></powerpagecomponent>`;
  const write = async (name, body) => {
    await fs.mkdir(path.join(dir, path.dirname(name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  };
  await write(
    'Assets/powerpagesites.xml',
    `<powerpagesites><powerpagesite powerpagesiteid="${SITE}"><content>{"website_language": 1033}</content><name>Enhanced</name></powerpagesite></powerpagesites>`,
  );
  await write(
    'powerpagecomponents/a/powerpagecomponent.xml',
    component('9a4d1c2e-0000-4000-8000-0000000000f5', 11, 'Publisher', {
      anonymoususersrole: false,
      authenticatedusersrole: false,
    }),
  );
  await write(
    'powerpagecomponents/b/powerpagecomponent.xml',
    component('9a4d1c2e-0000-4000-8000-0000000000f6', 8, 'Main', { source: '{{ page.title }}' }),
  );
  await write(
    'powerpagecomponents/c/powerpagecomponent.xml',
    component('9a4d1c2e-0000-4000-8000-0000000000f7', 6, 'Main', {
      webtemplateid: '9a4d1c2e-0000-4000-8000-0000000000f6',
      usewebsiteheaderandfooter: false,
    }),
  );
  await write(
    'powerpagecomponents/d/powerpagecomponent.xml',
    component('9a4d1c2e-0000-4000-8000-0000000000f8', 2, 'Home', {
      partialurl: '/',
      pagetemplateid: '9a4d1c2e-0000-4000-8000-0000000000f7',
    }),
  );
  const portal = await importPortal(dir);
  assert.equal(portal.format, 'enhanced');
  const renderer = createPortalRenderer(portal);
  const context = renderer.contextForPage(portal.pages[0], '/', {
    user: { id: CONTACT, contactid: CONTACT, roles: ['Publisher'] },
  });
  assert.equal(
    await renderer.renderString(
      '{% for r in user.powerpagecomponent_mspp_webrole_contact %}{{ r.name }}:{{ r.logical_name }}{% endfor %}|[{{ user.adx_webrole_contact }}]|{{ page.partialurl }}|{{ page.adx_partialurl }}|{{ page.mspp_partialurl }}|{{ website.mspp_website_language }}',
      context,
    ),
    'Publisher:powerpagecomponent|[]|/|/|/|1033',
  );
});

test('render sweep resolves export directories and Mirage projects and summarises each persona for CI', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'render-sweep-target-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'portal'));
  await fs.mkdir(path.join(dir, 'solution'));
  const fromSource = await resolveTarget({
    source: path.join(dir, 'portal'),
    portal: 'demo',
    solutionRoots: [path.join(dir, 'solution')],
  });
  assert.equal(fromSource.id, 'demo');
  assert.equal(fromSource.sourceDir, path.join(dir, 'portal'));
  assert.deepEqual(fromSource.solutionRoots, [path.join(dir, 'solution')]);
  assert.equal(fromSource.stateFile, null);
  await fs.writeFile(path.join(dir, 'project.yml'), 'version: 2\nportals:\n  - id: demo\n    path: ./portal\n');
  const fromProject = await resolveTarget({
    project: path.join(dir, 'project.yml'),
    portal: 'demo',
    solutionRoots: [],
  });
  assert.equal(fromProject.id, 'demo');
  assert.equal(path.basename(fromProject.sourceDir), 'portal');
  assert.match(fromProject.stateFile, /demo[\\/]state\.json$/);
  await assert.rejects(
    resolveTarget({ project: path.join(dir, 'project.yml'), portal: 'missing', solutionRoots: [] }),
    /not configured/,
  );
  const run = {
    persona: 'anonymous',
    pages: 2,
    requests: 3,
    byStatus: { 200: 2, 302: 1 },
    liquidErrorPages: ['/a/'],
    liquidDiagnosticCounts: { 'liquid-error': 2, 'liquid-unknown-filter': 1 },
    injectedNonDocuments: [],
    failures: [],
  };
  assert.deepEqual(ciSummary({ portal: 'demo', inventory: { unsupported: [], syntaxErrors: [{}] } }, run), {
    portal: 'demo',
    persona: 'anonymous',
    pages: 2,
    requests: 3,
    statuses: { 200: 2, 302: 1 },
    liquidErrorPages: 1,
    liquidErrors: 2,
    unknownFilterUses: 1,
    missingTemplateUses: 0,
    unsupported: 0,
    authoredSyntaxErrors: 1,
    permissionRowMultiplication: [],
    injectedNonDocuments: 0,
    failures: 0,
  });
});

test("render sweep personas change only the identity and keep the state's rows", async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'render-sweep-personas-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const portalFiles = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Personas`,
    'webrole.yml':
      '- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e1\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true\n- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e2\n  adx_name: Editors\n- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e3\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'web-pages/home/Home.webpage.yml': `adx_webpageid: ${HOME}\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: ${MAIN}`,
    'page-templates/Main.pagetemplate.yml': `adx_pagetemplateid: ${MAIN}\nadx_name: Main\nadx_usewebsiteheaderandfooter: false\nadx_webtemplateid: 9a4d1c2e-0000-4000-8000-000000000301`,
    ...template(
      '01',
      'Main',
      "<!doctype html><html><body>[{{ user.roles | join: ',' }}]{% fetchxml q %}<fetch><entity name='item'/></fetch>{% endfetchxml %}rows={{ q.results.entities.size }}</body></html>",
    ),
  };
  for (const [name, content] of Object.entries(portalFiles)) {
    const target = path.join(dir, 'portal', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await fs.mkdir(path.join(dir, 'solutions'));
  const state = {
    mappings: { item: { entitySet: 'items', idColumn: 'itemid' } },
    tables: {
      item: [
        { itemid: '1', name: 'One' },
        { itemid: '2', name: 'Two' },
      ],
    },
    permissions: [],
    plugins: [],
    settings: { permissionMode: 'permissive' },
    simulator: { mode: 'local', pageMode: 'local', identity: { id: null, roles: [] }, live: {}, endpoints: [] },
  };
  const stateFile = path.join(dir, 'state', 'state.json');
  await fs.mkdir(path.dirname(stateFile));
  await fs.writeFile(stateFile, JSON.stringify(state));
  const before = await fs.readFile(stateFile, 'utf8');
  const report = await renderSweep({
    source: path.join(dir, 'portal'),
    portal: 'personas',
    solutionRoots: [path.join(dir, 'solutions')],
    state: stateFile,
    persona: 'all',
    keepBodies: true,
  });
  const bodies = Object.fromEntries(
    report.runs.map((run) => {
      const result = run.results.find((result) => result.url === '/');
      assert.equal(result.bodyTruncated, false);
      const text = (node) =>
        ['script', 'style'].includes(node.tagName)
          ? ''
          : node.nodeName === '#text'
            ? node.value
            : (node.childNodes ?? []).map(text).join('');
      return [run.persona, text(parse(result.body))];
    }),
  );
  assert.match(bodies.anonymous, /\[\]rows=2/);
  assert.match(bodies.authenticated, /\[Authenticated Users\]rows=2/);
  assert.match(bodies['all-roles'], /\[(?=[^\]]*Authenticated Users)(?=[^\]]*Editors)[^\]]*\]rows=2/);
  assert.doesNotMatch(bodies['all-roles'], /Anonymous Users/);
  assert.ok(report.runs.every((run) => run.state.preset === null));
  assert.equal(await fs.readFile(stateFile, 'utf8'), before);
});

test('web link sets with the same name are reachable by ID and the first active set wins by name', async (t) => {
  const first = '9a4d1c2e-0000-4000-8000-000000000071';
  const second = '9a4d1c2e-0000-4000-8000-000000000072';
  const third = '9a4d1c2e-0000-4000-8000-000000000073';
  const set = (id, linkName) => ({
    id,
    name: 'Default',
    weblinks: [{ id: `${id}-l`, name: linkName, url: '/', weblinks: [], metadata: {} }],
  });
  const { renderer, portal, child } = await setup(t);
  // Importer contract: weblinkSets lists every active set; weblinks maps a name to its first set.
  portal.weblinkSets = [set(first, 'First'), set(second, 'Second'), set(third, 'Third')];
  portal.weblinks = { ...portal.weblinks, Default: portal.weblinkSets[0] };
  const context = renderer.contextForPage(child, '/child/', { now: NOW });
  assert.equal(
    await renderer.renderString(
      `{{ weblinks['Default'].weblinks[0].name }}|{{ weblinks['${second}'].weblinks[0].name }}|{{ weblinks['{${third.toUpperCase()}}'].weblinks[0].name }}|[{{ weblinks['default'] }}]|[{{ weblinks['9a4d1c2e-0000-4000-8000-0000000000ff'] }}]`,
      context,
    ),
    'First|Second|Third|[]|[]',
  );
});

test('the platform layout carries the language attributes and links content stylesheets of the page path', async (t) => {
  const css = (id, name, parent, order, extra = '') => ({
    [`web-files/${name}.webfile.yml`]: `adx_webfileid: 9a4d1c2e-0000-4000-8000-0000000004${id}\nadx_name: ${name}\nadx_partialurl: ${name}\nadx_parentpageid: ${parent}${order == null ? '' : `\nadx_displayorder: ${order}`}${extra}`,
    [`web-files/${name}`]: `/* ${name} */`,
  });
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Parity\nadx_website_language: 1031`,
    ...css('01', 'second.css', HOME, 2),
    ...css('02', 'first.css', HOME, 1),
    ...css('03', 'bootstrap.min.css', HOME, 0),
    ...css('04', 'child.css', CHILD, 0),
    ...css('05', 'inactive.css', HOME, 0, '\nstatecode: 1'),
    ...css('06', 'script.js', HOME, 0),
    ...css('07', 'beta.css', HOME, 3),
    ...css('08', 'alpha.css', HOME, 3),
  };
  const { renderer, portal } = await setup(t, {}, files);
  const page = await renderer.renderPage('/child/grand/');
  assert.equal(page.status, 200);
  // crm-lcid is the LCID of the request's website language (English here), not adx_website_language.
  assert.match(
    page.html,
    /<html lang="en-US" dir="ltr" crm-lang="en-US" crm-lcid="1033" data-lang="en-US" same-site-mode="None">/,
  );
  const headLinks = (html) =>
    [...html.slice(0, html.indexOf('</head>')).matchAll(/<link href="([^"]+)" rel="stylesheet" \/>/g)].map(
      (match) => match[1],
    );
  // bootstrap.min.css first, then the root's styles by display order and name, then the child
  // page's; the URLs carry no cache-busting query (the reference site's layout links them bare).
  assert.deepEqual(headLinks(page.html), [
    '/bootstrap.min.css',
    '/first.css',
    '/second.css',
    '/alpha.css',
    '/beta.css',
    '/child/child.css',
  ]);
  // same-site-mode is the HTTP/SameSite/Default setting when the site defines it.
  portal.settings['HTTP/SameSite/Default'] = 'Lax';
  assert.match(
    (await createPortalRenderer(portal).renderPage('/child/grand/')).html,
    /<html [^>]*same-site-mode="Lax">/,
  );
  delete portal.settings['HTTP/SameSite/Default'];
  // The home page has a bootstrap.min.css child, so the default is "web-file"; the observed
  // per-site setting "platform" links the platform's Bootstrap instead.
  portal.observed = { bootstrapStylesheet: 'platform', evidence: 'synthetic' };
  const observedPlatform = (await createPortalRenderer(portal).renderPage('/child/grand/')).html;
  assert.equal((observedPlatform.match(/bootstrap\.min\.css/g) ?? []).length, 1);
  assert.match(observedPlatform, /href="\/css\/bootstrap\.min\.css"/);
  assert.equal(headLinks(observedPlatform)[0], '/first.css');
  delete portal.observed;
  // Head/Bootstrap replaces the bootstrap link; without either the platform's own
  // /css/bootstrap.min.css is linked once, and no web-file Bootstrap appears.
  portal.snippets['Head/Bootstrap'] = '<link rel="stylesheet" href="/custom-bootstrap.css">';
  const withSnippet = (await renderer.renderPage('/child/grand/')).html;
  assert.match(withSnippet, /<link rel="stylesheet" href="\/custom-bootstrap\.css">/);
  assert.doesNotMatch(withSnippet, /bootstrap\.min\.css/);
  delete portal.snippets['Head/Bootstrap'];
  portal.webFiles = portal.webFiles.filter((file) => !file.url.endsWith('bootstrap.min.css'));
  const platformBootstrap = (await createPortalRenderer(portal).renderPage('/child/grand/')).html;
  assert.equal((platformBootstrap.match(/bootstrap\.min\.css/g) ?? []).length, 1);
  assert.match(platformBootstrap, /href="\/css\/bootstrap\.min\.css"/);
});

test('website languages follow the import and the request: the wet-boew bilingual export', async (t) => {
  // test/fixtures/wet-boew-bilingual: an unmodified subset of alfredofosu/wet-boew-power-pages-template
  // (MIT, commit b568a61; see its README.md and licenses/wet-boew-power-pages-template.txt). English (en) is the default
  // language, French (fr) the second; MultiLanguage/DisplayLanguageCodeInURL is true. Its website
  // languages share their portal language's ID and take code, LCID and display name from
  // .portalconfig/portallanguage.yml.
  const ENGLISH = '479653ed-6561-4160-a081-e917bb73b148';
  const FRENCH = 'fba5eb7d-a87b-f011-b4cc-000d3ae86a1f';
  const portal = await importPortal(fileURLToPath(new URL('./fixtures/wet-boew-bilingual/', import.meta.url)));
  assert.deepEqual(
    portal.websiteLanguages.map(({ id, portalLanguageId, code, lcid, displayName, isDefault }) => ({
      id,
      portalLanguageId,
      code,
      lcid,
      displayName,
      isDefault,
    })),
    [
      { id: ENGLISH, portalLanguageId: ENGLISH, code: 'en', lcid: 1033, displayName: 'English', isDefault: true },
      { id: FRENCH, portalLanguageId: FRENCH, code: 'fr', lcid: 1036, displayName: 'Français', isDefault: false },
    ],
  );
  const renderer = createPortalRenderer(portal);
  const overview = portal.pages.find((page) => page.url === '/overview/');
  const view = (source, url, extra = {}) =>
    renderer.renderString(source, renderer.contextForPage(overview, url, extra));
  const squash = (html) => html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
  const probe =
    '{{ website.selected_language.code }}|{{ website.selected_language.name }}|' +
    '{% for language in website.languages %}{{ language.code }}={{ language.name }}={{ language.url_substitution }};{% endfor %}|' +
    "{{ page.available_languages.size }}|{{ page.title }}|{{ snippets['GCWeb/App/Name'] }}|{{ resx.Poll_Results_Label }}|" +
    "{% for link in weblinks['Default'].weblinks %}{{ link.name }},{% endfor %}";
  // The default language (English) when the path has no language code; a code that starts the path
  // selects the language and the language URLs keep the path without it. Page title, snippets,
  // resource strings and the per-language "Default" web link set follow the selection.
  assert.equal(
    await view(probe, '/overview/?x=1'),
    'en|English|en=English=en/overview/?x=1;fr=Français=fr/overview/?x=1;|2|Overview|Application Name|View results|Home,Overview,First Section,Second Section,',
  );
  assert.equal(
    await view(probe, '/fr/overview/?x=1'),
    "fr|Français|en=English=en/overview/?x=1;fr=Français=fr/overview/?x=1;|2|Aperçu|Nom de l'application|Afficher les résultats|Accueil,Aperçu,Première section,Deuxième section,",
  );
  // The server passes the code its language route removed; hosts read the request's language.
  assert.equal(
    await view('{{ website.selected_language.code }}|{{ page.title }}', '/overview/', { languageCode: 'FR' }),
    'fr|Aperçu',
  );
  assert.deepEqual(renderer.contextForPage(overview, '/fr/overview/').__language, {
    id: FRENCH,
    code: 'fr',
    lcid: 1036,
    name: 'Français',
    isDefault: false,
  });
  assert.equal(renderer.requestLanguage(new URL('http://localhost/fr/overview/')).path, '/overview/');
  // The export's own Languages Dropdown template (page.languages, url_substitution).
  assert.equal(
    squash(await view("{% include 'Languages Dropdown' %}", '/fr/overview/')),
    '<ul class="dropdown-menu" role="menu"><li role="menuitem"><a class="dropdown-item" href="/en/overview/" title="English" data-code="en">English</a></li><li role="menuitem"><a class="dropdown-item" href="/fr/overview/" title="Français" data-code="fr">Français</a></li></ul>',
  );
  // Editable snippets carry the request language's display name.
  assert.match(
    await view("{% editable snippets 'GCWeb/App/Name' type: 'text' %}", '/fr/overview/'),
    /data-languageContext="Fran&#231;ais"><div class="xrm-attribute-value">Nom de l'application<\/div>/,
  );
  // The page shell: html language attributes, the localized title and copy, and the export's
  // header language toggle (GCWeb/App/Header) pointing at the other language.
  const french = await renderer.renderPage('/fr/overview/');
  assert.match(french.html, /<html lang="fr" dir="ltr" crm-lang="fr" crm-lcid="1036" data-lang="fr"/);
  assert.ok(
    french.html.includes('<div class="xrm-attribute-value">Aperçu</div>') &&
      french.html.includes('<a lang="en" href="/en/overview/">'),
  );
  const english = await renderer.renderPage('/overview/');
  assert.match(english.html, /<html lang="en" dir="ltr" crm-lang="en" crm-lcid="1033" data-lang="en"/);
  assert.ok(
    english.html.includes('<div class="xrm-attribute-value">Overview</div>') &&
      english.html.includes('<a lang="fr" href="/fr/overview/">'),
  );
  // Without website languages (legacy exports) there is no language object; the layout uses the
  // culture of the website language LCID.
  const legacy = await setup(
    t,
    {},
    {
      'website.yml': `adx_websiteid: ${SITE}\nadx_name: Legacy\nadx_website_language: 1031`,
      'websitelanguage.yml': '[]',
    },
  );
  assert.equal((await legacy.render('[{{ website.languages.size }}][{{ website.selected_language }}]')).html, '[0][]');
  assert.match(
    (await legacy.renderer.renderPage('/child/grand/')).html,
    /<html lang="de-DE" dir="ltr" crm-lang="de-DE" crm-lcid="1031" data-lang="de-DE"/,
  );
  // A single-language export keeps one language and English resources.
  const { render } = await setup(t);
  assert.equal(
    (
      await render(
        '{{ website.languages.size }}|{{ website.selected_language.code }}|{{ website.selected_language.url }}',
      )
    ).html,
    '1|en-US|en-US/child/',
  );
});

test('the observed bootstrapStylesheet setting is validated with its evidence', async () => {
  const { observedConfig } = await import('../lib/project-config.mjs');
  assert.deepEqual(
    observedConfig({ bootstrapStylesheet: 'platform', evidence: 'fixture/reports/home-stylesheet.json' }),
    {
      bootstrapStylesheet: 'platform',
      evidence: 'fixture/reports/home-stylesheet.json',
    },
  );
  assert.throws(
    () => observedConfig({ bootstrapStylesheet: 'cdn', evidence: 'x' }),
    /bootstrapStylesheet must be platform or web-file/,
  );
  assert.throws(() => observedConfig({ bootstrapStylesheet: 'web-file' }), /evidence/);
});

// @test-kind unproven: retained diagnostic/default-mode compatibility assertions; native include behavior is qualified separately above.
test('diagnostic/default mode: for loops support limit, offset, reversed, variable ranges, else, forloop, break and continue', async () => {
  const render = plain();
  assert.equal(
    await render(
      '{% for i in (1..5) limit: 2 offset: 1 %}{{ i }}{% endfor %}|{% for i in (1..3) reversed %}{{ i }}{% endfor %}|{% for i in missing %}x{% else %}none{% endfor %}',
    ),
    '23|321|none',
  );
  assert.equal(await render('{% assign n = 3 %}{% for i in (1..n) %}{{ i }}{% endfor %}'), '123');
  assert.equal(
    await render(
      '{% for i in (1..3) %}{{ forloop.index }}{{ forloop.index0 }}{{ forloop.rindex }}{{ forloop.rindex0 }}{{ forloop.first }}{{ forloop.last }}{{ forloop.length }},{% endfor %}',
    ),
    '1032truefalse3,2121falsefalse3,3210falsetrue3,',
  );
  assert.equal(
    await render(
      '{% for i in (1..5) %}{% if i == 2 %}{% continue %}{% endif %}{% if i == 4 %}{% break %}{% endif %}{{ i }}{% endfor %}',
    ),
    '13',
  );
  assert.equal(
    await render(
      '{% for i in (1..2) %}{% else whatever %}{% endfor %}{% for i in none %}{% else whatever %}e{% endfor %}',
    ),
    'e',
  );
});

// @test-kind unproven: retained diagnostic/default-mode compatibility assertions; native include behavior is qualified separately above.
test('diagnostic/default mode: cycle, tablerow, increment and decrement keep DotLiquid output', async () => {
  const render = plain();
  assert.equal(
    await render(
      "{% for i in (1..4) %}{% cycle 'a', 'b', 'c' %}{% endfor %}|{% cycle 'g': 'x', 'y' %}{% cycle 'g': 'x', 'y' %}",
    ),
    'abca|xy',
  );
  // TableRow uses TextWriter.WriteLine (CRLF on the Windows host).
  assert.equal(
    await render(
      '{% tablerow i in (1..3) cols: 2 %}{{ i }}{{ tablerowloop.col }}{{ tablerowloop.col_last }}{% endtablerow %}',
    ),
    '<tr class="row1">\r\n<td class="col1">11false</td><td class="col2">22true</td></tr>\r\n<tr class="row2"><td class="col1">31false</td></tr>\r\n',
  );
  assert.equal(
    await render('{% increment c %}{% increment c %}{% decrement d %}{% decrement d %}|{{ c }}'),
    '01-1-2|2',
  );
});

// @test-kind unproven: retained diagnostic/default-mode compatibility assertions; native include behavior is qualified separately above.
test('diagnostic/default mode: math filters promote real operands to decimal, divide integers, round to even and format decimals without trailing zeros', async () => {
  const render = plain();
  // DotLiquid >= 2.1 DoMathsOperation (the Power Pages docs still list the 2.0 truncating examples).
  assert.equal(await render('{{ 10 | plus: 1.1 }}|{{ 10 | minus: 1.1 }}|{{ 10 | times: 2.2 }}'), '11.1|8.9|22');
  assert.equal(
    await render('{{ 10 | divided_by: 3 }}|{{ 10.0 | divided_by: 3 }}|{{ 10 | modulo: 3 }}|{{ 5 | divided_by: 2.0 }}'),
    '3|3.3333333333333333333333333333|1|2.5',
  );
  assert.equal(await render('{{ 1 | divided_by: 0 }}'), 'Liquid error: Attempted to divide by zero.');
  assert.equal(
    await render(
      '{{ 4.5612 | round: 2 }}|{{ 2.5 | round }}|{{ 3.5 | round }}|{{ 2.675 | round: 2 }}|{{ nil | round }}',
    ),
    '4.56|2|4|2.68|0',
  );
  // Adxstudio MathFilters.Ceil/Floor return int; nil is 0.
  assert.equal(await render("{{ 1.2 | ceil }}|{{ 1.8 | floor }}|{{ '3.7' | floor }}|{{ nil | ceil }}"), '2|1|3|0');
  assert.equal(await render('{{ 1.50 }}|{{ 12.5 | times: 10 }}|{{ 0.1 | plus: 0.2 }}'), '1.5|125|0.3');
  // Plus concatenates string input; other mismatches raise the expression error.
  assert.equal(
    await render("{{ '1' | plus: 1 }}|{{ 1 | plus: 'a' }}"),
    "11|Liquid error: The binary operator Add is not defined for the types 'System.Int32' and 'System.String'.",
  );
  assert.equal(await render('{{ -5 | abs }}|{{ 5 | at_least: 7 }}|{{ 5 | at_most: 3 }}'), '5|7|3');
});

// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.
test('parity source bindings 79a601a3e3b1d321', () => {
  __paqParitySourceBindings(import.meta.url);
});
