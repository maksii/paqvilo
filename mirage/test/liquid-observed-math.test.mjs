// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.
// @test-kind unproven: finite observed-mode Liquid cases and intentional diagnostic defaults; only source-identical reproduced assertions carry parity overrides.
import { parityAssertions as __paqParityAssertions } from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/liquid-observed-math.test.mjs:32:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'e962ef8992b9d71eaa7532391895a861d279f8add05aa4f92e5312e97224b791',
    originalAssertions: [
      '698928bbcaf1a4e5ae564550512bd361970d23bda2b2560f124722b27db8a900',
      '8064a7139d16b48ffe10ffbe9231da1eb5e1ca5b37c8999309a2c748dcc62f98',
    ],
    originalBodyAstSha256: '35eb61681ad6fabee04b5c5fa7ad03a05d2a5cae144e1866156a8eb77e8f2b5b',
    originalGuardHashes: [],
    moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
    isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
    moduleReview: {
      reviewedBy: '/root/frontend',
      reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
          bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root/frontend',
          reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
          oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
          currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
          oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
          currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
          oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
          currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
          oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
          currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
      },
    ],
    runtimeInputs: [],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
        selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
        selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
      },
    ],
    memoryContextCertificates: [
      {
        kind: 'unchanged-memory-context-input',
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:32:0',
        assertionSha256: '8064a7139d16b48ffe10ffbe9231da1eb5e1ca5b37c8999309a2c748dcc62f98',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        constructionSha256: 'f16d58621616b66c2db05d8c4d2c86acf90fb4663a1dd8b5c701087acdd6868a',
        callbackSha256: '35eb61681ad6fabee04b5c5fa7ad03a05d2a5cae144e1866156a8eb77e8f2b5b',
        orderedPrefixSha256: '62ea0bad899409d4ab507c8242e05fb6665e0efe7314fe7a092d4a2edbe1cd21',
        operationSha256: '5e4d7a1b97ddf3b1268e94566b19183adad717c34d62cb5dbf6960e8dedd3649',
        sourceSha256: '277d9c6c6417e647e4c8cd6c14eff7488347cad82e6013fb124b934d31d7e96b',
        context: 'omitted',
        receiver: 'retained-engine',
        moduleIsolationRequired: true,
        rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
        nativeParityProven: false,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
      },
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
      },
    ],
    additionalInputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:32:0',
          title: 'observed decimal string multiplication converts literals and source settings through the renderer',
        },
      ],
      casesSha256: 'da991dd089267af0796a743d7460302626fdc449c022b3479a18768c734e583f',
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
            id: 'native-original-liquid-009',
            pointer: '/captures/0/cases/8/facts',
            sha256: 'eb57b7224040955246dca5906bcfe95adcfcd8fcc41784bf3efe26511ae2e3e7',
            replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
          },
        ],
      },
    ],
    regionHashes: [['8064a7139d16b48ffe10ffbe9231da1eb5e1ca5b37c8999309a2c748dcc62f98']],
    regionFactIds: [[['native-original-liquid-009']]],
  },
  {
    baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'bf37e95bd06d16d2c3722e312ec6570300b9355f5c53b77839efd71abc875f90',
    originalAssertions: [
      '924fb48684bb80c0fb215c3cb3d93dd4d5612ca5e5da5c089f21eb8ddf65ae99',
      'a8479eb7b4ed5c65fc726646c82ac76b3a43fd59a55f3bac442296d9e3e8b808',
      'f15a172e15c0aade72438a05a02e934d88f49fde481358ff37cd3f417bb760e2',
      '6d51e771c2eed7cc370046671987db3fcb0b0f1919b1c685737eb2dedab62de4',
    ],
    originalBodyAstSha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
    originalGuardHashes: [],
    moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
    isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
    moduleReview: {
      reviewedBy: '/root/frontend',
      reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
          bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root/frontend',
          reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
          oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
          currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
          oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
          currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
          oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
          currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
          oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
          currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
      },
    ],
    runtimeInputs: [],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
        selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
        selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
      },
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
      },
    ],
    additionalInputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
          title:
            'observed conversion does not widen other operators or change null, decimal arithmetic and integer repetition',
        },
      ],
      casesSha256: '7e6bf1fca40007f27cfd7a5f403f2c881d27d87a43e5f9ddba64d39736d08686',
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
            id: 'native-original-liquid-010',
            pointer: '/captures/0/cases/9/facts',
            sha256: '21c8bec57718c52b59f50c9afa11210ed7d2b4761e9e118f160515b109ceace7',
            replicatedPointers: ['/captures/0/cases/9/facts', '/captures/1/cases/9/facts'],
          },
          {
            id: 'native-original-liquid-011',
            pointer: '/captures/0/cases/10/facts',
            sha256: '6f89e2bbc36b776c005e133709a5d046928fde62d68096ea9828ed37fbd572fe',
            replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        '924fb48684bb80c0fb215c3cb3d93dd4d5612ca5e5da5c089f21eb8ddf65ae99',
        'a8479eb7b4ed5c65fc726646c82ac76b3a43fd59a55f3bac442296d9e3e8b808',
      ],
    ],
    regionFactIds: [[['native-original-liquid-010'], ['native-original-liquid-011']]],
  },
  {
    baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '977bfb80c7547102824080332a24ba52c5fa547062107e9ef2ef572c13456143',
    originalAssertions: [
      '592769a9ff775ef748aec0b4890fadd9e7534d0e90a5b05f4e5aa3bec99234f7',
      '04c23d425b8336d57d4145fc8791946f5965d5e33a7724828b294646815c4cfd',
      'd2edcc05f55ea9a5b4324ba74bce1abebfac9f6af825d33c67623906f27e25b6',
    ],
    originalBodyAstSha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
    originalGuardHashes: [],
    moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
    isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
    moduleReview: {
      reviewedBy: '/root/frontend',
      reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
          bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root/frontend',
          reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
          oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
          currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
          oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
          currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
          oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
          currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
          oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
          currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
      },
    ],
    runtimeInputs: [],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
        selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
        selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
      },
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
      },
    ],
    additionalInputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
          title: 'observed followups distinguish string math, negative batches and empty collection types',
        },
      ],
      casesSha256: '778fe0ab00ffad0cadfbf242afef6dec2b681d307c660bfdf57258f3209ad941',
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
            id: 'native-original-liquid-025',
            pointer: '/captures/0/cases/24/facts',
            sha256: '34e9d912b028bc7211b5732175bb184bdc95b6395d4038fda7e5bd5f0aecff0c',
            replicatedPointers: ['/captures/0/cases/24/facts', '/captures/1/cases/24/facts'],
          },
        ],
      },
    ],
    regionHashes: [['592769a9ff775ef748aec0b4890fadd9e7534d0e90a5b05f4e5aa3bec99234f7']],
    regionFactIds: [[['native-original-liquid-025']]],
  },
  {
    baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'f6a8730031274bfad771d7218f90c8af1238d7ba553cd28307c34fc9e3b41598',
    originalAssertions: [
      '4aa10a2dd1478b9bfe948e031a1c9fdc324098f757e267a7a4cd3a8568967627',
      '72e1363b17ae492c75be8e5e9faebd5f4b89f6bed0b5d0e564f397a10cc093b1',
      'b57ec480b77b587346fead4bb04bbc32c911898fd82b9bd3d0d132608ac04175',
    ],
    originalBodyAstSha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
    originalGuardHashes: [],
    moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
    isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
    moduleReview: {
      reviewedBy: '/root/frontend',
      reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
          bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root/frontend',
          reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
          oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
          currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
          oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
          currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
          oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
          currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
          oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
          currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
      },
    ],
    runtimeInputs: [],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
        selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
        selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
      },
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
      },
    ],
    additionalInputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
          title: 'observed decimal-zero division remains a numeric scalar through verified downstream filters',
        },
      ],
      casesSha256: 'cf2104ba67fed93b08c39dc4c7e5326b850540a5aeeaf7e895707b988cce2e69',
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
            id: 'native-original-liquid-026',
            pointer: '/captures/0/cases/25/facts',
            sha256: 'a57b3c792693cb71504ad3d3dbc919a5dba9492ead21d9ca50ac621d838e724e',
            replicatedPointers: ['/captures/0/cases/25/facts', '/captures/1/cases/25/facts'],
          },
          {
            id: 'native-original-liquid-028',
            pointer: '/captures/0/cases/27/facts',
            sha256: '3b485ba378a470e8bafcfe83c4bbd2a5efc2f27a75927fef354efc5e760e461a',
            replicatedPointers: ['/captures/0/cases/27/facts', '/captures/1/cases/27/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      ['4aa10a2dd1478b9bfe948e031a1c9fdc324098f757e267a7a4cd3a8568967627'],
      ['b57ec480b77b587346fead4bb04bbc32c911898fd82b9bd3d0d132608ac04175'],
    ],
    regionFactIds: [[['native-original-liquid-026']], [['native-original-liquid-028']]],
  },
  {
    baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'c21a17d617421f508c9aacaac7b4a81a01829f5512821d818173853784752310',
    originalAssertions: [
      '4ff5978f12323d64507c4fd027dcd2f96d654c39744c52cde8cb792f26907008',
      '4b73513c0fbdc419cd12d47cf55c45c1c7fa0fa2a7653ae87738fb828425c31e',
      'cfe73628c2e7364b689c032d12ee56f27b79dea0098ac22bac9a8017aebf3e00',
    ],
    originalBodyAstSha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
    originalGuardHashes: [],
    moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
    isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
    moduleReview: {
      reviewedBy: '/root/frontend',
      reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
          bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root/frontend',
          reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
          oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
          currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
          oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
          currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
          oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
          currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
          oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
          currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
      },
    ],
    runtimeInputs: [],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
        selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
        selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
      },
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
      },
    ],
    additionalInputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
          title:
            'observed filter registration preserves unknown-filter passthrough and required currency parameter names',
        },
      ],
      casesSha256: '12579396348e97ef7289d4629069126ead3dbd948c57dcfdbfbc4b813c683a95',
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
            id: 'native-original-liquid-029',
            pointer: '/captures/0/cases/28/facts',
            sha256: '681aa86faf2fdfa21ac602747ca500e9eef0ecd0f460efcf41aeacb12dced31e',
            replicatedPointers: ['/captures/0/cases/28/facts', '/captures/1/cases/28/facts'],
          },
          {
            id: 'native-original-liquid-030',
            pointer: '/captures/0/cases/29/facts',
            sha256: '139bb65880f91ceb5563b31c708740c00c6dbfdf784d6ef92fbbb29093b43639',
            replicatedPointers: ['/captures/0/cases/29/facts', '/captures/1/cases/29/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        '4ff5978f12323d64507c4fd027dcd2f96d654c39744c52cde8cb792f26907008',
        '4b73513c0fbdc419cd12d47cf55c45c1c7fa0fa2a7653ae87738fb828425c31e',
      ],
    ],
    regionFactIds: [[['native-original-liquid-029'], ['native-original-liquid-030']]],
  },
  {
    baselineId: 'mirage/test/liquid-observed-math.test.mjs:225:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'd7499d25afbe24ebc8219b26bcadfb6824e4f7eaed413345850f58a35fe5204a',
    originalAssertions: [
      '0aaa40cc8db8855023b53e668a8e64c9263ce9fab7fe96a456c786f81e8c9bb2',
      '08ed0f7acd4ae6990e55e135e99ebf977ab1b048bc5f7025bb3cb31d07b63a0d',
    ],
    originalBodyAstSha256: '7a1b28f25dc3c8fd72ab6e2350fcd4e6f83b7bc35945df876b3f71357c443911',
    originalGuardHashes: [],
    moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
    isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
    moduleReview: {
      reviewedBy: '/root/frontend',
      reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
          bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root/frontend',
          reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
          oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
          currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
          oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
          currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
          oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
          currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
          oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
          currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
      },
    ],
    runtimeInputs: [],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
        selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
        selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
      },
    ],
    memoryContextCertificates: [
      {
        kind: 'unchanged-memory-context-input',
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:225:0',
        assertionSha256: '08ed0f7acd4ae6990e55e135e99ebf977ab1b048bc5f7025bb3cb31d07b63a0d',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        constructionSha256: '18f925f2ea6b8ac6042aa0cb3e7d6765e2b13f4dd9cf4debc4d338b66c23fccd',
        callbackSha256: '7a1b28f25dc3c8fd72ab6e2350fcd4e6f83b7bc35945df876b3f71357c443911',
        orderedPrefixSha256: '7891991c8a17f15014b13dd686e9a9d9069783152fab5eb066ffb874d8bec326',
        operationSha256: '848468ce19c508d2c0a4f83228305b1196ec10857747f53978d5889f7193a394',
        sourceSha256: 'e534663148e80aee71bdb2344bf87e26ed8cbf046841ffdd7d9c8385393f69d3',
        context: 'omitted',
        receiver: 'fresh-inline',
        moduleIsolationRequired: true,
        rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
        nativeParityProven: false,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
      },
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
      },
    ],
    additionalInputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:225:0',
          title: 'observed newline serialization changes generated breaks while preserving user text',
        },
      ],
      casesSha256: '33e258e5b5c650a7145aafe296f4938f95de42a53d959c7bc953d8c2f2904136',
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
            id: 'native-original-liquid-037',
            pointer: '/captures/0/cases/36/facts',
            sha256: '75865a2a42b66056eeee6b5bf99ee550061b61985c45394bc2709cb0db02ae60',
            replicatedPointers: ['/captures/0/cases/36/facts', '/captures/1/cases/36/facts'],
          },
        ],
      },
    ],
    regionHashes: [['08ed0f7acd4ae6990e55e135e99ebf977ab1b048bc5f7025bb3cb31d07b63a0d']],
    regionFactIds: [[['native-original-liquid-037']]],
  },
  {
    baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'd9679dd25481e3dd5342726b30a382a926f53783c37310ad620225963c350671',
    originalAssertions: [
      '68b34db5a18261cd3bdd792d85897c77a66050a49065882057c503e0517fe41f',
      'c640f01fefa3f6435268d01cfd7f4335d3a925f92e40b390b6ca4bd53e7de3ee',
      '9975aff9cc4c52b3a31b288b2647d1b8013862a7be9907e3ba5aa2e6282ff5f8',
      '69ccacabe4f18ad8b2f2cd7057de4449ee1c0c2341ac25445a703349f88b25cb',
      'ca73cc428fde6b5978a850fe6a7d0d9e2fb348b12095671bce1c1033e957d759',
    ],
    originalBodyAstSha256: 'd5f0572084f5ea7fc0da65218f7bda55163a82a04c2c5c00120f4c5159f4fb05',
    originalGuardHashes: [],
    moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
    isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
    moduleReview: {
      reviewedBy: '/root/frontend',
      reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
          bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root/frontend',
          reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
          oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
          currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
          oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
          currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
          oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
          currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
          oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
          currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
      },
    ],
    runtimeInputs: [],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
        selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
        selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
      },
    ],
    memoryContextCertificates: [
      {
        kind: 'unchanged-memory-context-input',
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
        assertionSha256: '9975aff9cc4c52b3a31b288b2647d1b8013862a7be9907e3ba5aa2e6282ff5f8',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        constructionSha256: 'ec58f366eedbb4f516de3538ecb235208ff55f2a2a16cddde4bb988fe31e289d',
        callbackSha256: 'd5f0572084f5ea7fc0da65218f7bda55163a82a04c2c5c00120f4c5159f4fb05',
        orderedPrefixSha256: '136a458811ed8acfc7d7ba010faf2fd25042f73126072ab3a9cecb00a873e609',
        operationSha256: '8f3aebe4b22c1570c0fccaa52c01dead52fc9f0a44a56a72900a1cbce41e4698',
        sourceSha256: 'f4d1ef2a7ae619d2a27fbe53c993310a046f93a96cd7221fbdf9c3f7e30f8463',
        context: 'omitted',
        receiver: 'retained-engine',
        moduleIsolationRequired: true,
        rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
        nativeParityProven: false,
      },
      {
        kind: 'unchanged-memory-context-input',
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
        assertionSha256: '69ccacabe4f18ad8b2f2cd7057de4449ee1c0c2341ac25445a703349f88b25cb',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        constructionSha256: 'ec58f366eedbb4f516de3538ecb235208ff55f2a2a16cddde4bb988fe31e289d',
        callbackSha256: 'd5f0572084f5ea7fc0da65218f7bda55163a82a04c2c5c00120f4c5159f4fb05',
        orderedPrefixSha256: 'cc09b729505b8ecddde748d41b6f463c549e96982297b62d69159672b3845cf6',
        operationSha256: 'aae3d0266d4880c3196a61a653fc83ed6adc25bb43c064fdfb1c064c68d93644',
        sourceSha256: 'dfc05e99f9bfc2b6f40d25fbea7192308898b0fb08f03060d8ac75f829e8e2c6',
        context: 'omitted',
        receiver: 'retained-engine',
        moduleIsolationRequired: true,
        rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
        nativeParityProven: false,
      },
      {
        kind: 'unchanged-memory-context-input',
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
        assertionSha256: 'ca73cc428fde6b5978a850fe6a7d0d9e2fb348b12095671bce1c1033e957d759',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        constructionSha256: 'ec58f366eedbb4f516de3538ecb235208ff55f2a2a16cddde4bb988fe31e289d',
        callbackSha256: 'd5f0572084f5ea7fc0da65218f7bda55163a82a04c2c5c00120f4c5159f4fb05',
        orderedPrefixSha256: '753881c18948187a4538872cce576c6be206de26ede00011962024347b88adfe',
        operationSha256: '5def1c05b128f6a26b4a52f028a90a5ead7a9f693870821feac3051b57f4f6ff',
        sourceSha256: 'ece9f4a82fe38192fd17b83ebc524edd46dea17372336693c99c0d312fdf13ea',
        context: 'omitted',
        receiver: 'retained-engine',
        moduleIsolationRequired: true,
        rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
        nativeParityProven: false,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
      },
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
      },
    ],
    additionalInputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
          title: 'observed path_and_query includes fragments in a present query without changing other URL filters',
        },
      ],
      casesSha256: '2ce53be68232d77022c536c93f206a767ca3380551de0242229683ee4fa95762',
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
            id: 'native-original-liquid-038',
            pointer: '/captures/0/cases/37/facts',
            sha256: 'bb22f11ff98552d6517a3ab3cd735ab47b668af05895e55cc26582f4f129b2fa',
            replicatedPointers: ['/captures/0/cases/37/facts', '/captures/1/cases/37/facts'],
          },
          {
            id: 'native-original-liquid-039',
            pointer: '/captures/0/cases/38/facts',
            sha256: '3fabe9df97c53872a5d9883b5f10fa4bad38e3763e7aa9b9231fc09a43689924',
            replicatedPointers: ['/captures/0/cases/38/facts', '/captures/1/cases/38/facts'],
          },
          {
            id: 'native-original-liquid-040',
            pointer: '/captures/0/cases/39/facts',
            sha256: '96915a47e42860d2d7aa2170fa3670c99432dfaadbbfa617b88dc6581b0c03b5',
            replicatedPointers: ['/captures/0/cases/39/facts', '/captures/1/cases/39/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        '9975aff9cc4c52b3a31b288b2647d1b8013862a7be9907e3ba5aa2e6282ff5f8',
        '69ccacabe4f18ad8b2f2cd7057de4449ee1c0c2341ac25445a703349f88b25cb',
        'ca73cc428fde6b5978a850fe6a7d0d9e2fb348b12095671bce1c1033e957d759',
      ],
    ],
    regionFactIds: [[['native-original-liquid-038'], ['native-original-liquid-039'], ['native-original-liquid-040']]],
  },
  {
    baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
    originalAssertions: [
      'd877639c31780b9e10e93c1b2dba281b612a384aef6a70bb1b166289eb17ccce',
      'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
      '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
      '8f8ba20dc5d71c6940c94d96348fb13693137c2565f60864cbbedfd4d17bcbc7',
      '8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb',
    ],
    baselineOriginalAssertions: [
      'd877639c31780b9e10e93c1b2dba281b612a384aef6a70bb1b166289eb17ccce',
      '17ac1f6aa0b190229eb76d1bc544285a5882f22d46262d674997f2a4dd438058',
      '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
      '8f8ba20dc5d71c6940c94d96348fb13693137c2565f60864cbbedfd4d17bcbc7',
      '8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb',
    ],
    originalBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
    baselineBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
    originalGuardHashes: [],
    moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
    isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
    moduleReview: {
      reviewedBy: '/root/frontend',
      reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
      corrections: [
        {
          sameGuarantee: true,
          reviewedBy: '/root/frontend',
          reason:
            'Repeated native original-liquid-033 executes the identical literal source under the unchanged explicit html mode. Only the expected attribute encoding changes to the exact native entity bytes; no source, producer, input or output normalization.',
          oldAstSha256: '17ac1f6aa0b190229eb76d1bc544285a5882f22d46262d674997f2a4dd438058',
          currentAstSha256: 'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
          guaranteeId: 'liquid-combined-mirage-test-liquid-observed-math-test-mjs-202-0',
          factIds: ['native-original-liquid-033-corrected-expected'],
        },
      ],
      addedTests: [
        {
          titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
          bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
          zeroOriginalCredit: true,
          interactionReviewed: true,
          reviewedBy: '/root/frontend',
          reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
        },
      ],
      isolatedRegistrationChanges: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
          oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
          currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
          oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
          currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
          oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
          currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
        },
      ],
      isolatedDeclarations: [
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
        },
        {
          zeroSelectedCredit: true,
          reviewedBy: '/root/frontend',
          reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
          astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
      },
    ],
    runtimeInputs: [],
    generatedFixtures: [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
        selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
        selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
      },
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
        selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
      },
    ],
    memoryContextCertificates: [
      {
        kind: 'unchanged-memory-context-input',
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
        assertionSha256: 'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        constructionSha256: '18f925f2ea6b8ac6042aa0cb3e7d6765e2b13f4dd9cf4debc4d338b66c23fccd',
        callbackSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        orderedPrefixSha256: '52a4fbeb6134656847b975fc8de4b68699a063410adbb5106a4a19c56de793ce',
        operationSha256: 'f91ffbe034fad7f430d1c9bcd47c716e97916b75a81da9f37d93fc39fc504678',
        sourceSha256: 'c428667abbe2f1e87fba71c24e7cdea7f291b02716d14953c1428223a7126a09',
        context: 'omitted',
        receiver: 'retained-engine',
        moduleIsolationRequired: true,
        rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
        nativeParityProven: false,
      },
      {
        kind: 'unchanged-memory-context-input',
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
        assertionSha256: '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        constructionSha256: '18f925f2ea6b8ac6042aa0cb3e7d6765e2b13f4dd9cf4debc4d338b66c23fccd',
        callbackSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        orderedPrefixSha256: '22bbfc8b66ddb444cd84b4b830641b2afc5e0a8c300029380fb77928060151a7',
        operationSha256: '09ceef3fedfe385ab2550de0c46db2668c036911b0079d788580af5d76fab12a',
        sourceSha256: '2edf9b0bfcfe17071e89c3b493b29bbfe73fb58e3df07636117e93ee6f575802',
        context: 'omitted',
        receiver: 'retained-engine',
        moduleIsolationRequired: true,
        rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
        nativeParityProven: false,
      },
      {
        kind: 'unchanged-memory-context-input',
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
        assertionSha256: '8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb',
        helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
        constructionSha256: 'd55a43edd5f0fd6fe0ec2cda6f54f82cfbb0e65e0709468d957808c34a1d7f34',
        callbackSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        orderedPrefixSha256: 'fcac2c70ac7adcec3e15298b65294c53d62e4e0ff6b07b5a041705279f8c55f8',
        operationSha256: '50c35ac8dc5737b05f3bc88ca79f4987a2ab00ef6a1279c2793a8090ac113830',
        sourceSha256: '5219cfa09c68a5e6906b1f6dcd73d4bc2312571f42e9f15fdd44ead5d15220f6',
        context: 'omitted',
        receiver: 'retained-engine',
        moduleIsolationRequired: true,
        rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
        nativeParityProven: false,
      },
    ],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
      },
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
      },
    ],
    additionalInputDependencies: [
      {
        path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
        sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-cases.json',
        sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
      {
        path: 'mirage/test/fixtures/power-pages-contract-expected.json',
        sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
        reviewedBy: '/root/frontend',
        reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
      },
    ],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
          title:
            'observed HTML void serialization preserves sanitized attributes and independently gates input elements',
        },
      ],
      casesSha256: '153c8aa51fd87400d086ad2eab55397198fb74e689ce38a76ed18dda833caeac',
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
            id: 'native-original-liquid-033-corrected-expected',
            pointer: '/captures/0/cases/32/facts',
            sha256: '2ea294b7f411f93206de064ac82ad5664bea322066b331c2e874ce75cc4ca46a',
            replicatedPointers: ['/captures/0/cases/32/facts', '/captures/1/cases/32/facts'],
          },
          {
            id: 'native-original-liquid-034',
            pointer: '/captures/0/cases/33/facts',
            sha256: '8121c283f309279075c136ade417d0c6ebe9b1476ef93cb4c3148e017958800a',
            replicatedPointers: ['/captures/0/cases/33/facts', '/captures/1/cases/33/facts'],
          },
          {
            id: 'native-original-liquid-036',
            pointer: '/captures/0/cases/35/facts',
            sha256: 'ba221abef554f38f0eb3fa958cb047acbf8d62b5b59f0ac17e6fe863976e6928',
            replicatedPointers: ['/captures/0/cases/35/facts', '/captures/1/cases/35/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
        '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
      ],
      ['8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb'],
    ],
    regionFactIds: [
      [['native-original-liquid-033-corrected-expected'], ['native-original-liquid-034']],
      [['native-original-liquid-036']],
    ],
  },
]);
// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.

import {
  assertParityBindings as __paqParityBindings,
  assertParityBindingsFromSource as __paqParitySourceBindings,
} from '../../scripts/qualify-parity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createPortalRenderer } from '../lib/liquid.mjs';

function renderer(observed, options = {}) {
  return createPortalRenderer(
    {
      templates: {},
      snippets: {},
      settings: { 'Fixture/Quantity': '2' },
      pages: [],
      webFiles: [],
      records: [],
      weblinks: {},
      sitemarkers: {},
      website: {},
      pageTemplates: [],
      observed,
    },
    options,
  );
}

test('decimal string multiplication remains the pinned reference unless explicitly observed', async () => {
  const source = "{{ '2' | times: 1.0 }}";
  const expected =
    "Liquid error: The binary operator Multiply is not defined for the types 'System.String' and 'System.Decimal'.";
  assert.equal(await renderer().renderString(source), expected);
  assert.equal(await renderer({ liquidDecimalStringMultiply: 'dotliquid' }).renderString(source), expected);
});

test('observed decimal string multiplication converts literals and source settings through the renderer', async () => {
  const engine = renderer({ liquidDecimalStringMultiply: 'convert' });
  const context = engine.contextForPage({ id: '00000000-0000-4000-8000-000000000001', url: '/', metadata: {} }, '/');
  const source =
    "{{ '2' | times: 1.0 }}|{{ settings['Fixture/Quantity'] | times: 1.0 }}|{{ '2' | decimal | times: 1.0 }}|{{ 2 | times: 1.0 }}";
  assert.equal(await engine.renderString(source, context), '2|2|2|2');

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:32:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'e962ef8992b9d71eaa7532391895a861d279f8add05aa4f92e5312e97224b791',
        originalAssertions: [
          '698928bbcaf1a4e5ae564550512bd361970d23bda2b2560f124722b27db8a900',
          '8064a7139d16b48ffe10ffbe9231da1eb5e1ca5b37c8999309a2c748dcc62f98',
        ],
        originalBodyAstSha256: '35eb61681ad6fabee04b5c5fa7ad03a05d2a5cae144e1866156a8eb77e8f2b5b',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
              oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
              currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        memoryContextCertificates: [
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:32:0',
            assertionSha256: '8064a7139d16b48ffe10ffbe9231da1eb5e1ca5b37c8999309a2c748dcc62f98',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: 'f16d58621616b66c2db05d8c4d2c86acf90fb4663a1dd8b5c701087acdd6868a',
            callbackSha256: '35eb61681ad6fabee04b5c5fa7ad03a05d2a5cae144e1866156a8eb77e8f2b5b',
            orderedPrefixSha256: '62ea0bad899409d4ab507c8242e05fb6665e0efe7314fe7a092d4a2edbe1cd21',
            operationSha256: '5e4d7a1b97ddf3b1268e94566b19183adad717c34d62cb5dbf6960e8dedd3649',
            sourceSha256: '277d9c6c6417e647e4c8cd6c14eff7488347cad82e6013fb124b934d31d7e96b',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:32:0',
              title:
                'observed decimal string multiplication converts literals and source settings through the renderer',
            },
          ],
          casesSha256: 'da991dd089267af0796a743d7460302626fdc449c022b3479a18768c734e583f',
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
                id: 'native-original-liquid-009',
                pointer: '/captures/0/cases/8/facts',
                sha256: 'eb57b7224040955246dca5906bcfe95adcfcd8fcc41784bf3efe26511ae2e3e7',
                replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
              },
            ],
          },
        ],
        regionHashes: [['8064a7139d16b48ffe10ffbe9231da1eb5e1ca5b37c8999309a2c748dcc62f98']],
        regionFactIds: [[['native-original-liquid-009']]],
      },
    ]);
    assert.equal(
      await engine.renderString("{{ 'not-a-number' | times: 1.0 }}"),
      'Liquid error: Input string was not in a correct format.',
    );
  }
});

test('observed conversion does not widen other operators or change null, decimal arithmetic and integer repetition', async () => {
  const engine = renderer({ liquidDecimalStringMultiply: 'convert' });

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'bf37e95bd06d16d2c3722e312ec6570300b9355f5c53b77839efd71abc875f90',
        originalAssertions: [
          '924fb48684bb80c0fb215c3cb3d93dd4d5612ca5e5da5c089f21eb8ddf65ae99',
          'a8479eb7b4ed5c65fc726646c82ac76b3a43fd59a55f3bac442296d9e3e8b808',
          'f15a172e15c0aade72438a05a02e934d88f49fde481358ff37cd3f417bb760e2',
          '6d51e771c2eed7cc370046671987db3fcb0b0f1919b1c685737eb2dedab62de4',
        ],
        originalBodyAstSha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
              oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
              currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
              title:
                'observed conversion does not widen other operators or change null, decimal arithmetic and integer repetition',
            },
          ],
          casesSha256: '7e6bf1fca40007f27cfd7a5f403f2c881d27d87a43e5f9ddba64d39736d08686',
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
                id: 'native-original-liquid-010',
                pointer: '/captures/0/cases/9/facts',
                sha256: '21c8bec57718c52b59f50c9afa11210ed7d2b4761e9e118f160515b109ceace7',
                replicatedPointers: ['/captures/0/cases/9/facts', '/captures/1/cases/9/facts'],
              },
              {
                id: 'native-original-liquid-011',
                pointer: '/captures/0/cases/10/facts',
                sha256: '6f89e2bbc36b776c005e133709a5d046928fde62d68096ea9828ed37fbd572fe',
                replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '924fb48684bb80c0fb215c3cb3d93dd4d5612ca5e5da5c089f21eb8ddf65ae99',
            'a8479eb7b4ed5c65fc726646c82ac76b3a43fd59a55f3bac442296d9e3e8b808',
          ],
        ],
        regionFactIds: [[['native-original-liquid-010'], ['native-original-liquid-011']]],
      },
    ]);
    assert.equal(
      await engine.renderString('{{ nil | times: 1.0 }}|{{ 10 | times: 2.2 }}|{{ 10.0 | divided_by: 3 }}'),
      '|22|3.3333333333333333333333333333',
    );
    assert.equal(
      await engine.renderString(
        "{% assign repeated = '2' | times: 2 %}{{ repeated | size }}:{{ repeated | join: ',' }}",
      ),
      '2:2,2',
    );
  }

  assert.equal(
    await engine.renderString("{{ '2' | minus: 1.0 }}"),
    "Liquid error: The binary operator Subtract is not defined for the types 'System.String' and 'System.Decimal'.",
  );
  assert.equal(
    await engine.renderString("{{ 2 | times: '2' }}"),
    "Liquid error: The binary operator Multiply is not defined for the types 'System.Int32' and 'System.String'.",
  );
});

// @test-kind parity: native batch01 exact numeric-string multiplication and independently published batch29 literal-wrapped reproduction return2; checksum-bound historical facts below.
// @parity-evidence: identical pure expression bytes and matching literal-wrapper output qualify the existing effective-convert-mode result; diagnostic defaults and other expressions remain unproven.
test('explicit renderer observations override a portal observation', async () => {
  const engine = renderer(
    { liquidDecimalStringMultiply: 'dotliquid' },
    { observed: { liquidDecimalStringMultiply: 'convert' } },
  );
  const nativeFacts = readFileSync(new URL('./fixtures/power-pages-historical-numeric-facts.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(nativeFacts).digest('hex'),
    '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
  );
  assert.equal(JSON.parse(nativeFacts).source, "{{ '2' | times: 1.0 }}");
  assert.equal(JSON.parse(nativeFacts).output, '2');
  assert.equal(await engine.renderString("{{ '2' | times: 1.0 }}"), '2');
});

// @test-kind parity: Both fresh native source-bound include rounds reproduce every unchanged original literal result/error assertion in this registration; automatic actual-context replay matches exactly.
// @parity-evidence: Manifest guarantee existing-liquid-liquid-observed-math-test-mjs-72-0; exact capsule/run/fact/source bindings are asserted below.
test('observed times dispatch preserves the verified integer operand and string-array rejection envelopes', async () => {
  // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/liquid-observed-math.test.mjs:72:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '2b34588b760d807115cbe98fb1de46a3d96946b08882a98d5968520f20659936',
      originalAssertions: [
        'c68eff8f04a17a7678fb8a3b6fab82af0a492f466c4a0235c716b08e1efa036f',
        '22e0ab844ee9e0ede61c03cb3075e11bf8c2193a1cba003c1ac33141e7181a35',
        '18f5af6865df0e927732022800a310ce2cbef894b3a4688c0d0adbd9d84abfe3',
        'dc3bfbc72f862374ed7e2783d28f9620f2711ff7c32aab8765f8eb3778466c83',
      ],
      originalBodyAstSha256: 'c935335072928d1b7e11533d90cf64c42f62bcb3cb7c5dd64591140a62605674',
      originalGuardHashes: [],
      moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
      isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
      moduleReview: {
        reviewedBy: '/root/frontend',
        reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
        corrections: [],
        addedTests: [
          {
            titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
            bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
            zeroOriginalCredit: true,
            interactionReviewed: true,
            reviewedBy: '/root/frontend',
            reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
          },
        ],
        isolatedRegistrationChanges: [
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
            oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
            currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
            oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
            currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
            oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
            currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
            oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
            currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
          },
        ],
        isolatedDeclarations: [
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
          },
        ],
      },
      importRoles: [
        {
          source: '../lib/liquid.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
        },
      ],
      runtimeInputs: [],
      generatedFixtures: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:72:0',
          helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
          inputSha256: '4b7f855142baf35cfdddd24f66a3d47a1195383ded3b2733e98828f0bf49d494',
          selectedBodySha256: 'c935335072928d1b7e11533d90cf64c42f62bcb3cb7c5dd64591140a62605674',
        },
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:115:0',
          helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
          inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
          selectedBodySha256: '9b35c9289b06671cc1ed67c82c1b3ab5fbdc238feba8805290e79cb8779a35df',
        },
      ],
      inputDependencies: [
        {
          path: 'mirage/test/fixtures/power-pages-contract-cases.json',
          sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        },
        {
          path: 'mirage/test/fixtures/power-pages-contract-expected.json',
          sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        },
        {
          path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
          sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        },
      ],
      sourceBindings: [],
      loopHeaders: [],
      caseUniverse: {
        count: 1,
        cases: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:72:0',
            title:
              'observed times dispatch preserves the verified integer operand and string-array rejection envelopes',
          },
        ],
        casesSha256: '049a576754025154d1df685765eb7f5ec6c5fe6fbfaf54505d52641416701358',
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
              id: 'native-original-liquid-014',
              pointer: '/captures/0/cases/13/facts',
              sha256: '28f139f6ca3c290eba5dbab6ee6eae5c58be270b83e943224ae11d53c8dca72d',
              replicatedPointers: ['/captures/0/cases/13/facts', '/captures/1/cases/13/facts'],
            },
            {
              id: 'native-original-liquid-015',
              pointer: '/captures/0/cases/14/facts',
              sha256: 'a4532d991f042057a47e73cfe3cd279694221ec656cf19735e727a2cd796d6f5',
              replicatedPointers: ['/captures/0/cases/14/facts', '/captures/1/cases/14/facts'],
            },
            {
              id: 'native-original-liquid-016',
              pointer: '/captures/0/cases/15/facts',
              sha256: 'c97a7bcaf7d11284d6ea8b6e03d2eb0e65ae1c84ac479912c918fc9d11a29d3b',
              replicatedPointers: ['/captures/0/cases/15/facts', '/captures/1/cases/15/facts'],
            },
            {
              id: 'native-original-liquid-017',
              pointer: '/captures/0/cases/16/facts',
              sha256: '4a76fe0ad61a26725770e1a6a820435cd58fdf1105d53971d453cdfef62b5a45',
              replicatedPointers: ['/captures/0/cases/16/facts', '/captures/1/cases/16/facts'],
            },
          ],
        },
      ],
    },
  ]);
  const engine = renderer({ liquidTimesDispatch: 'observed' });
  assert.equal(
    await engine.renderString("{{ 2 | times: '2' }}|{{ 2 | times: 'bad' }}"),
    'Liquid error: Parameter count mismatch.|Liquid error: Parameter count mismatch.',
  );
  assert.equal(
    await engine.renderString("{% assign values = 'a,b' | split: ',' %}{{ values | times: 2 }}"),
    'Liquid error: Parameter count mismatch.',
  );
  assert.equal(
    await engine.renderString("{% assign values = 'a,b' | split: ',' %}{{ values | times: 2.0 }}"),
    "Liquid error: Unable to cast object of type 'System.String[]' to type 'System.IConvertible'.",
  );
  assert.equal(
    await engine.renderString(
      "{% assign values = 'abc' | times: 2 %}{{ values }}|{{ values | size }}|{{ values | join: ',' }}",
    ),
    'abcabc|2|abc,abc',
  );
});

test('times dispatch is independently opt-in and does not infer unobserved collection or numeric operand types', async () => {
  const original = renderer();
  assert.equal(
    await original.renderString("{{ 2 | times: '2' }}"),
    "Liquid error: The binary operator Multiply is not defined for the types 'System.Int32' and 'System.String'.",
  );
  assert.equal(
    await original.renderString("{% assign values = 'a,b' | split: ',' %}{{ values | times: 2 }}"),
    "Liquid error: The binary operator Multiply is not defined for the types 'System.Object[]' and 'System.Int32'.",
  );
  const observed = renderer({ liquidTimesDispatch: 'observed' });
  // @parity-evidence: power-pages-existing-liquid-evidence.json SHA256 241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0, both captures original-liquid-018 reproduce decimal-times-string result 4; the default diagnostic calls above remain unchanged.
  assert.equal(await observed.renderString("{{ 2.0 | times: '2' }}"), '4');
  assert.equal(
    await observed.renderString('{{ values | times: 2.0 }}', { values: [1, 'two'] }),
    "Liquid error: The binary operator Multiply is not defined for the types 'System.Object[]' and 'System.Decimal'.",
  );
});

// @test-kind parity: Both fresh native source-bound include rounds reproduce every unchanged original literal result/error assertion in this registration; automatic actual-context replay matches exactly.
// @parity-evidence: Manifest guarantee existing-liquid-liquid-observed-math-test-mjs-115-0; exact capsule/run/fact/source bindings are asserted below.
test('observed filter errors preserve the verified invocation and collection envelopes', async () => {
  // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/liquid-observed-math.test.mjs:115:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '8b234d2feff6abdea1188d1ce035c01850ff5b5ffad22c8f6c18ed2b048174f6',
      originalAssertions: [
        '999761982d6d18eb9bb26c60cd5feeade4d252bd1def989a257373ad3b058bd4',
        '87824b6ec3bde3f6f14916ae4c84f0b4ec7c05dd1cb38b22a74c7c900cc54f61',
        '761e947fd94207ee1195761c852696d5bdccffba748e98ab3668eeb4508223ce',
        '1a1ce7585505667589abe247f3e66c9b536d886fe6ce6dcb88d4912780ac8113',
      ],
      originalBodyAstSha256: '9b35c9289b06671cc1ed67c82c1b3ab5fbdc238feba8805290e79cb8779a35df',
      originalGuardHashes: [],
      moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
      isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
      moduleReview: {
        reviewedBy: '/root/frontend',
        reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
        corrections: [],
        addedTests: [
          {
            titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
            bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
            zeroOriginalCredit: true,
            interactionReviewed: true,
            reviewedBy: '/root/frontend',
            reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
          },
        ],
        isolatedRegistrationChanges: [
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
            oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
            currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
            oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
            currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
            oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
            currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
            oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
            currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
          },
        ],
        isolatedDeclarations: [
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
          },
          {
            zeroSelectedCredit: true,
            reviewedBy: '/root/frontend',
            reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
            astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
          },
        ],
      },
      importRoles: [
        {
          source: '../lib/liquid.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
        },
      ],
      runtimeInputs: [],
      generatedFixtures: [
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:72:0',
          helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
          inputSha256: '4b7f855142baf35cfdddd24f66a3d47a1195383ded3b2733e98828f0bf49d494',
          selectedBodySha256: 'c935335072928d1b7e11533d90cf64c42f62bcb3cb7c5dd64591140a62605674',
        },
        {
          baselineId: 'mirage/test/liquid-observed-math.test.mjs:115:0',
          helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
          inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
          selectedBodySha256: '9b35c9289b06671cc1ed67c82c1b3ab5fbdc238feba8805290e79cb8779a35df',
        },
      ],
      inputDependencies: [
        {
          path: 'mirage/test/fixtures/power-pages-contract-cases.json',
          sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
        },
        {
          path: 'mirage/test/fixtures/power-pages-contract-expected.json',
          sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
        },
        {
          path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
          sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
        },
      ],
      sourceBindings: [],
      loopHeaders: [],
      caseUniverse: {
        count: 1,
        cases: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:115:0',
            title: 'observed filter errors preserve the verified invocation and collection envelopes',
          },
        ],
        casesSha256: 'd4157a656b10b999ea8043c8314a7c23d31192abd38a65813365ca580676c8ec',
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
              id: 'native-original-liquid-019',
              pointer: '/captures/0/cases/18/facts',
              sha256: 'e97de6106a9d4da31315bf817ec0f328a8086fe3bd3953fe3530e089c6755a03',
              replicatedPointers: ['/captures/0/cases/18/facts', '/captures/1/cases/18/facts'],
            },
            {
              id: 'native-original-liquid-020',
              pointer: '/captures/0/cases/19/facts',
              sha256: 'fff16de8ac609bd915d83ef5b4d9d6641fffc2ea0bf35561ddf96200ab33fa81',
              replicatedPointers: ['/captures/0/cases/19/facts', '/captures/1/cases/19/facts'],
            },
            {
              id: 'native-original-liquid-021',
              pointer: '/captures/0/cases/20/facts',
              sha256: '1c27e6bfae25f36c114633bbb3402b5ef34423ba78be9dc490e1381d97a4e1d8',
              replicatedPointers: ['/captures/0/cases/20/facts', '/captures/1/cases/20/facts'],
            },
            {
              id: 'native-original-liquid-022',
              pointer: '/captures/0/cases/21/facts',
              sha256: 'b41926100c4cf9ff00432d8e8d730ccdd957d31be2d500dcb8b41365e765ba73',
              replicatedPointers: ['/captures/0/cases/21/facts', '/captures/1/cases/21/facts'],
            },
          ],
        },
      ],
    },
  ]);
  const engine = renderer({ liquidFilterErrors: 'observed' });
  assert.equal(
    await engine.renderString('a{{ 1 | divided_by: 0 }}b'),
    'aLiquid error: Exception has been thrown by the target of an invocation.b',
  );
  assert.equal(
    await engine.renderString("a{{ 'invalid-number' | minus: 1 }}b"),
    'aLiquid error: Parameter count mismatch.b',
  );
  assert.equal(
    await engine.renderString("{% assign values = 'c,a,b,a' | split: ',' %}a{{ values | batch: 0 | size }}b"),
    'aLiquid error: Value must be positive and non-zero.\r\nParameter name: sizeb',
  );
  assert.equal(
    await engine.renderString("{% assign values = 'c,a,b,a' | split: ',' %}a{{ values | then_by: 'size' | size }}b"),
    "aLiquid error: Object of type 'System.String[]' cannot be converted to type 'System.Linq.IOrderedEnumerable`1[System.Object]'.b",
  );
});

test('filter error observations keep default contracts and unobserved argument shapes', async () => {
  const original = renderer(),
    observed = renderer({ liquidFilterErrors: 'observed' });
  assert.equal(await original.renderString('{{ 1 | divided_by: 0 }}'), 'Liquid error: Attempted to divide by zero.');
  // @parity-evidence: power-pages-existing-liquid-evidence.json SHA256 241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0, both captures original-liquid-023 reproduce decimal/integer-zero result infinity. Preserve both original calls in their order and every finite loop input; separately retain the default diagnostic expectation.
  for (const source of ['{{ 1.0 | divided_by: 0 }}', "{{ values | then_by: 'size' }}"]) {
    const observedResult = await observed.renderString(source, { values: [1, 'two'] });
    const originalResult = await original.renderString(source, { values: [1, 'two'] });
    assert.equal(observedResult, source === '{{ 1.0 | divided_by: 0 }}' ? '∞' : originalResult, source);
    if (source === '{{ 1.0 | divided_by: 0 }}')
      assert.equal(originalResult, 'Liquid error: Attempted to divide by zero.');
  }
  assert.equal(
    await observed.renderString(
      "{% assign values = 'a,b' | split: ',' | order_by: 'size' %}{{ values | then_by: 'size' | join: ',' }}",
    ),
    'a,b',
  );
});

test('observed followups distinguish string math, negative batches and empty collection types', async () => {
  const engine = renderer({ liquidFilterErrors: 'observed' });

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '977bfb80c7547102824080332a24ba52c5fa547062107e9ef2ef572c13456143',
        originalAssertions: [
          '592769a9ff775ef748aec0b4890fadd9e7534d0e90a5b05f4e5aa3bec99234f7',
          '04c23d425b8336d57d4145fc8791946f5965d5e33a7724828b294646815c4cfd',
          'd2edcc05f55ea9a5b4324ba74bce1abebfac9f6af825d33c67623906f27e25b6',
        ],
        originalBodyAstSha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
              oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
              currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
              title: 'observed followups distinguish string math, negative batches and empty collection types',
            },
          ],
          casesSha256: '778fe0ab00ffad0cadfbf242afef6dec2b681d307c660bfdf57258f3209ad941',
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
                id: 'native-original-liquid-025',
                pointer: '/captures/0/cases/24/facts',
                sha256: '34e9d912b028bc7211b5732175bb184bdc95b6395d4038fda7e5bd5f0aecff0c',
                replicatedPointers: ['/captures/0/cases/24/facts', '/captures/1/cases/24/facts'],
              },
            ],
          },
        ],
        regionHashes: [['592769a9ff775ef748aec0b4890fadd9e7534d0e90a5b05f4e5aa3bec99234f7']],
        regionFactIds: [[['native-original-liquid-025']]],
      },
    ]);
    assert.equal(
      await engine.renderString("{{ '2' | minus: 1 }}|{{ 'bad' | minus: 1.0 }}|{{ 1 | divided_by: '0' }}"),
      'Liquid error: Parameter count mismatch.|Liquid error: Input string was not in a correct format.|Liquid error: Parameter count mismatch.',
    );
  }

  assert.equal(
    await engine.renderString('{{ values | batch: -1 }}', { values: [] }),
    'Liquid error: Value must be positive and non-zero.\r\nParameter name: size',
  );
  assert.equal(
    await engine.renderString("{{ values | then_by: 'size' }}", { values: [] }),
    "Liquid error: Object of type 'System.Linq.Enumerable+WhereArrayIterator`1[System.Object]' cannot be converted to type 'System.Linq.IOrderedEnumerable`1[System.Object]'.",
  );
});

test('observed decimal-zero division remains a numeric scalar through verified downstream filters', async () => {
  const engine = renderer({ liquidFilterErrors: 'observed' });

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'f6a8730031274bfad771d7218f90c8af1238d7ba553cd28307c34fc9e3b41598',
        originalAssertions: [
          '4aa10a2dd1478b9bfe948e031a1c9fdc324098f757e267a7a4cd3a8568967627',
          '72e1363b17ae492c75be8e5e9faebd5f4b89f6bed0b5d0e564f397a10cc093b1',
          'b57ec480b77b587346fead4bb04bbc32c911898fd82b9bd3d0d132608ac04175',
        ],
        originalBodyAstSha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
              oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
              currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
              title: 'observed decimal-zero division remains a numeric scalar through verified downstream filters',
            },
          ],
          casesSha256: 'cf2104ba67fed93b08c39dc4c7e5326b850540a5aeeaf7e895707b988cce2e69',
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
                id: 'native-original-liquid-026',
                pointer: '/captures/0/cases/25/facts',
                sha256: 'a57b3c792693cb71504ad3d3dbc919a5dba9492ead21d9ca50ac621d838e724e',
                replicatedPointers: ['/captures/0/cases/25/facts', '/captures/1/cases/25/facts'],
              },
              {
                id: 'native-original-liquid-028',
                pointer: '/captures/0/cases/27/facts',
                sha256: '3b485ba378a470e8bafcfe83c4bbd2a5efc2f27a75927fef354efc5e760e461a',
                replicatedPointers: ['/captures/0/cases/27/facts', '/captures/1/cases/27/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          ['4aa10a2dd1478b9bfe948e031a1c9fdc324098f757e267a7a4cd3a8568967627'],
          ['b57ec480b77b587346fead4bb04bbc32c911898fd82b9bd3d0d132608ac04175'],
        ],
        regionFactIds: [[['native-original-liquid-026']], [['native-original-liquid-028']]],
      },
    ]);
    assert.equal(
      await engine.renderString(
        '{% assign v = 1 | divided_by: 0.0 %}{{ v }}|{{ v | size }}|{{ v | plus: 1 }}|{{ v | times: 2 }}',
      ),
      '∞|0|∞|∞',
    );
  }

  assert.equal(
    await renderer().renderString('{{ 1 | divided_by: 0.0 }}'),
    'Liquid error: Attempted to divide by zero.',
  );

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'f6a8730031274bfad771d7218f90c8af1238d7ba553cd28307c34fc9e3b41598',
        originalAssertions: [
          '4aa10a2dd1478b9bfe948e031a1c9fdc324098f757e267a7a4cd3a8568967627',
          '72e1363b17ae492c75be8e5e9faebd5f4b89f6bed0b5d0e564f397a10cc093b1',
          'b57ec480b77b587346fead4bb04bbc32c911898fd82b9bd3d0d132608ac04175',
        ],
        originalBodyAstSha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
              oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
              currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
              title: 'observed decimal-zero division remains a numeric scalar through verified downstream filters',
            },
          ],
          casesSha256: 'cf2104ba67fed93b08c39dc4c7e5326b850540a5aeeaf7e895707b988cce2e69',
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
                id: 'native-original-liquid-026',
                pointer: '/captures/0/cases/25/facts',
                sha256: 'a57b3c792693cb71504ad3d3dbc919a5dba9492ead21d9ca50ac621d838e724e',
                replicatedPointers: ['/captures/0/cases/25/facts', '/captures/1/cases/25/facts'],
              },
              {
                id: 'native-original-liquid-028',
                pointer: '/captures/0/cases/27/facts',
                sha256: '3b485ba378a470e8bafcfe83c4bbd2a5efc2f27a75927fef354efc5e760e461a',
                replicatedPointers: ['/captures/0/cases/27/facts', '/captures/1/cases/27/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          ['4aa10a2dd1478b9bfe948e031a1c9fdc324098f757e267a7a4cd3a8568967627'],
          ['b57ec480b77b587346fead4bb04bbc32c911898fd82b9bd3d0d132608ac04175'],
        ],
        regionFactIds: [[['native-original-liquid-026']], [['native-original-liquid-028']]],
      },
    ]);
    assert.equal(await engine.renderString('{{ 10.0 | divided_by: 3 }}'), '3.3333333333333333333333333333');
  }
});

test('observed filter registration preserves unknown-filter passthrough and required currency parameter names', async () => {
  const engine = renderer({ liquidFilterRegistration: 'observed' });

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'c21a17d617421f508c9aacaac7b4a81a01829f5512821d818173853784752310',
        originalAssertions: [
          '4ff5978f12323d64507c4fd027dcd2f96d654c39744c52cde8cb792f26907008',
          '4b73513c0fbdc419cd12d47cf55c45c1c7fa0fa2a7653ae87738fb828425c31e',
          'cfe73628c2e7364b689c032d12ee56f27b79dea0098ac22bac9a8017aebf3e00',
        ],
        originalBodyAstSha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
              oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
              currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
              title:
                'observed filter registration preserves unknown-filter passthrough and required currency parameter names',
            },
          ],
          casesSha256: '12579396348e97ef7289d4629069126ead3dbd948c57dcfdbfbc4b813c683a95',
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
                id: 'native-original-liquid-029',
                pointer: '/captures/0/cases/28/facts',
                sha256: '681aa86faf2fdfa21ac602747ca500e9eef0ecd0f460efcf41aeacb12dced31e',
                replicatedPointers: ['/captures/0/cases/28/facts', '/captures/1/cases/28/facts'],
              },
              {
                id: 'native-original-liquid-030',
                pointer: '/captures/0/cases/29/facts',
                sha256: '139bb65880f91ceb5563b31c708740c00c6dbfdf784d6ef92fbbb29093b43639',
                replicatedPointers: ['/captures/0/cases/29/facts', '/captures/1/cases/29/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '4ff5978f12323d64507c4fd027dcd2f96d654c39744c52cde8cb792f26907008',
            '4b73513c0fbdc419cd12d47cf55c45c1c7fa0fa2a7653ae87738fb828425c31e',
          ],
        ],
        regionFactIds: [[['native-original-liquid-029'], ['native-original-liquid-030']]],
      },
    ]);
    assert.equal(
      await engine.renderString(
        "{{ '<b>x</b>' | json }}|{% assign v = 'c,a,b,a' | split: ',' %}{{ v | json | join: ',' }}|{{ v | sort_natural | join: ',' }}",
      ),
      '<b>x</b>|c,a,b,a|c,a,b,a',
    );
    assert.equal(
      await engine.renderString("{{ 1234.5 | currency }}|{{ 1234.5 | currency: 'amount' }}"),
      "Liquid syntax error: Error - Filter 'currency' does not have a default value for 'record' and no value was supplied|Liquid syntax error: Error - Filter 'currency' does not have a default value for 'attribute' and no value was supplied",
    );
  }

  assert.equal(
    await renderer().renderString("{{ '<b>x</b>' | json }}|{{ 1234.5 | currency: 'en-US' }}"),
    '"<b>x</b>"|$1,234.50',
  );
});

test('observed HTML void serialization preserves sanitized attributes and independently gates input elements', async () => {
  const engine = renderer({ liquidHtmlVoidSerialization: 'html' });
  assert.equal(await renderer().renderString("{{ '<img src=x>' | html_safe_escape }}"), '<img src="x" />');
  // @parity-evidence: power-pages-existing-liquid-evidence.json SHA256 241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0, both captures original-liquid-033 preserve the attribute's slash and encode its greater-than character as &gt;.
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
        originalAssertions: [
          'd877639c31780b9e10e93c1b2dba281b612a384aef6a70bb1b166289eb17ccce',
          'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
          '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
          '8f8ba20dc5d71c6940c94d96348fb13693137c2565f60864cbbedfd4d17bcbc7',
          '8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb',
        ],
        baselineOriginalAssertions: [
          'd877639c31780b9e10e93c1b2dba281b612a384aef6a70bb1b166289eb17ccce',
          '17ac1f6aa0b190229eb76d1bc544285a5882f22d46262d674997f2a4dd438058',
          '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
          '8f8ba20dc5d71c6940c94d96348fb13693137c2565f60864cbbedfd4d17bcbc7',
          '8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb',
        ],
        originalBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        baselineBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Repeated native original-liquid-033 executes the identical literal source under the unchanged explicit html mode. Only the expected attribute encoding changes to the exact native entity bytes; no source, producer, input or output normalization.',
              oldAstSha256: '17ac1f6aa0b190229eb76d1bc544285a5882f22d46262d674997f2a4dd438058',
              currentAstSha256: 'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
              guaranteeId: 'liquid-combined-mirage-test-liquid-observed-math-test-mjs-202-0',
              factIds: ['native-original-liquid-033-corrected-expected'],
            },
          ],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        memoryContextCertificates: [
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
            assertionSha256: 'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: '18f925f2ea6b8ac6042aa0cb3e7d6765e2b13f4dd9cf4debc4d338b66c23fccd',
            callbackSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            orderedPrefixSha256: '52a4fbeb6134656847b975fc8de4b68699a063410adbb5106a4a19c56de793ce',
            operationSha256: 'f91ffbe034fad7f430d1c9bcd47c716e97916b75a81da9f37d93fc39fc504678',
            sourceSha256: 'c428667abbe2f1e87fba71c24e7cdea7f291b02716d14953c1428223a7126a09',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
            assertionSha256: '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: '18f925f2ea6b8ac6042aa0cb3e7d6765e2b13f4dd9cf4debc4d338b66c23fccd',
            callbackSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            orderedPrefixSha256: '22bbfc8b66ddb444cd84b4b830641b2afc5e0a8c300029380fb77928060151a7',
            operationSha256: '09ceef3fedfe385ab2550de0c46db2668c036911b0079d788580af5d76fab12a',
            sourceSha256: '2edf9b0bfcfe17071e89c3b493b29bbfe73fb58e3df07636117e93ee6f575802',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
            assertionSha256: '8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: 'd55a43edd5f0fd6fe0ec2cda6f54f82cfbb0e65e0709468d957808c34a1d7f34',
            callbackSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            orderedPrefixSha256: 'fcac2c70ac7adcec3e15298b65294c53d62e4e0ff6b07b5a041705279f8c55f8',
            operationSha256: '50c35ac8dc5737b05f3bc88ca79f4987a2ab00ef6a1279c2793a8090ac113830',
            sourceSha256: '5219cfa09c68a5e6906b1f6dcd73d4bc2312571f42e9f15fdd44ead5d15220f6',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
              title:
                'observed HTML void serialization preserves sanitized attributes and independently gates input elements',
            },
          ],
          casesSha256: '153c8aa51fd87400d086ad2eab55397198fb74e689ce38a76ed18dda833caeac',
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
                id: 'native-original-liquid-033-corrected-expected',
                pointer: '/captures/0/cases/32/facts',
                sha256: '2ea294b7f411f93206de064ac82ad5664bea322066b331c2e874ce75cc4ca46a',
                replicatedPointers: ['/captures/0/cases/32/facts', '/captures/1/cases/32/facts'],
              },
              {
                id: 'native-original-liquid-034',
                pointer: '/captures/0/cases/33/facts',
                sha256: '8121c283f309279075c136ade417d0c6ebe9b1476ef93cb4c3148e017958800a',
                replicatedPointers: ['/captures/0/cases/33/facts', '/captures/1/cases/33/facts'],
              },
              {
                id: 'native-original-liquid-036',
                pointer: '/captures/0/cases/35/facts',
                sha256: 'ba221abef554f38f0eb3fa958cb047acbf8d62b5b59f0ac17e6fe863976e6928',
                replicatedPointers: ['/captures/0/cases/35/facts', '/captures/1/cases/35/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
            '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
          ],
          ['8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb'],
        ],
        regionFactIds: [
          [['native-original-liquid-033-corrected-expected'], ['native-original-liquid-034']],
          [['native-original-liquid-036']],
        ],
      },
    ]);
    assert.equal(
      await engine.renderString('{{ \'<img src=x alt="value/>suffix"><br><hr>\' | html_safe_escape }}'),
      '<img src="x" alt="value/&gt;suffix"><br><hr>',
    );
    assert.equal(
      await engine.renderString(
        "{{ '<b onclick=alert(1)>label</b><img src=javascript:alert(1) onerror=alert(1)><script>alert(1)</script>' | html_safe_escape }}",
      ),
      '<b>label</b><img>',
    );
  }
  assert.equal(await engine.renderString("{{ '<input type=text value=probe disabled>' | html_safe_escape }}"), '');
  const inputs = renderer({ liquidHtmlVoidSerialization: 'html', liquidHtmlSafeInput: 'observed' });
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
        originalAssertions: [
          'd877639c31780b9e10e93c1b2dba281b612a384aef6a70bb1b166289eb17ccce',
          'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
          '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
          '8f8ba20dc5d71c6940c94d96348fb13693137c2565f60864cbbedfd4d17bcbc7',
          '8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb',
        ],
        baselineOriginalAssertions: [
          'd877639c31780b9e10e93c1b2dba281b612a384aef6a70bb1b166289eb17ccce',
          '17ac1f6aa0b190229eb76d1bc544285a5882f22d46262d674997f2a4dd438058',
          '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
          '8f8ba20dc5d71c6940c94d96348fb13693137c2565f60864cbbedfd4d17bcbc7',
          '8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb',
        ],
        originalBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
        baselineBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Repeated native original-liquid-033 executes the identical literal source under the unchanged explicit html mode. Only the expected attribute encoding changes to the exact native entity bytes; no source, producer, input or output normalization.',
              oldAstSha256: '17ac1f6aa0b190229eb76d1bc544285a5882f22d46262d674997f2a4dd438058',
              currentAstSha256: 'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
              guaranteeId: 'liquid-combined-mirage-test-liquid-observed-math-test-mjs-202-0',
              factIds: ['native-original-liquid-033-corrected-expected'],
            },
          ],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        memoryContextCertificates: [
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
            assertionSha256: 'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: '18f925f2ea6b8ac6042aa0cb3e7d6765e2b13f4dd9cf4debc4d338b66c23fccd',
            callbackSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            orderedPrefixSha256: '52a4fbeb6134656847b975fc8de4b68699a063410adbb5106a4a19c56de793ce',
            operationSha256: 'f91ffbe034fad7f430d1c9bcd47c716e97916b75a81da9f37d93fc39fc504678',
            sourceSha256: 'c428667abbe2f1e87fba71c24e7cdea7f291b02716d14953c1428223a7126a09',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
            assertionSha256: '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: '18f925f2ea6b8ac6042aa0cb3e7d6765e2b13f4dd9cf4debc4d338b66c23fccd',
            callbackSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            orderedPrefixSha256: '22bbfc8b66ddb444cd84b4b830641b2afc5e0a8c300029380fb77928060151a7',
            operationSha256: '09ceef3fedfe385ab2550de0c46db2668c036911b0079d788580af5d76fab12a',
            sourceSha256: '2edf9b0bfcfe17071e89c3b493b29bbfe73fb58e3df07636117e93ee6f575802',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
            assertionSha256: '8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: 'd55a43edd5f0fd6fe0ec2cda6f54f82cfbb0e65e0709468d957808c34a1d7f34',
            callbackSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            orderedPrefixSha256: 'fcac2c70ac7adcec3e15298b65294c53d62e4e0ff6b07b5a041705279f8c55f8',
            operationSha256: '50c35ac8dc5737b05f3bc88ca79f4987a2ab00ef6a1279c2793a8090ac113830',
            sourceSha256: '5219cfa09c68a5e6906b1f6dcd73d4bc2312571f42e9f15fdd44ead5d15220f6',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:202:0',
              title:
                'observed HTML void serialization preserves sanitized attributes and independently gates input elements',
            },
          ],
          casesSha256: '153c8aa51fd87400d086ad2eab55397198fb74e689ce38a76ed18dda833caeac',
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
                id: 'native-original-liquid-033-corrected-expected',
                pointer: '/captures/0/cases/32/facts',
                sha256: '2ea294b7f411f93206de064ac82ad5664bea322066b331c2e874ce75cc4ca46a',
                replicatedPointers: ['/captures/0/cases/32/facts', '/captures/1/cases/32/facts'],
              },
              {
                id: 'native-original-liquid-034',
                pointer: '/captures/0/cases/33/facts',
                sha256: '8121c283f309279075c136ade417d0c6ebe9b1476ef93cb4c3148e017958800a',
                replicatedPointers: ['/captures/0/cases/33/facts', '/captures/1/cases/33/facts'],
              },
              {
                id: 'native-original-liquid-036',
                pointer: '/captures/0/cases/35/facts',
                sha256: 'ba221abef554f38f0eb3fa958cb047acbf8d62b5b59f0ac17e6fe863976e6928',
                replicatedPointers: ['/captures/0/cases/35/facts', '/captures/1/cases/35/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            'd8039af227ae702b4244a89c0a53aab2a72d78113be87166046d43cb3ef9e2b5',
            '91e312458e5826ae29d6cf4658244a06af20aa99882e337e2581d02ea791e594',
          ],
          ['8760f0e8fb98226a9fafe8dd7ef80eda2a698e934e8a08f09440070388e24aeb'],
        ],
        regionFactIds: [
          [['native-original-liquid-033-corrected-expected'], ['native-original-liquid-034']],
          [['native-original-liquid-036']],
        ],
      },
    ]);
    assert.equal(
      await inputs.renderString(
        "{{ '<input type=text value=probe disabled onclick=alert(1) formaction=javascript:alert(1)>' | html_safe_escape }}",
      ),
      '<input type="text" value="probe" disabled="">',
    );
  }
});

test('observed newline serialization changes generated breaks while preserving user text', async () => {
  const source = '{% capture v %}first\nsecond{% endcapture %}{{ v | newline_to_br }}|{{ v | text_to_html }}';
  assert.equal(await renderer().renderString(source), 'first<br />\nsecond|<p>first<br />second</p>');

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:225:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'd7499d25afbe24ebc8219b26bcadfb6824e4f7eaed413345850f58a35fe5204a',
        originalAssertions: [
          '0aaa40cc8db8855023b53e668a8e64c9263ce9fab7fe96a456c786f81e8c9bb2',
          '08ed0f7acd4ae6990e55e135e99ebf977ab1b048bc5f7025bb3cb31d07b63a0d',
        ],
        originalBodyAstSha256: '7a1b28f25dc3c8fd72ab6e2350fcd4e6f83b7bc35945df876b3f71357c443911',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
              oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
              currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        memoryContextCertificates: [
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:225:0',
            assertionSha256: '08ed0f7acd4ae6990e55e135e99ebf977ab1b048bc5f7025bb3cb31d07b63a0d',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: '18f925f2ea6b8ac6042aa0cb3e7d6765e2b13f4dd9cf4debc4d338b66c23fccd',
            callbackSha256: '7a1b28f25dc3c8fd72ab6e2350fcd4e6f83b7bc35945df876b3f71357c443911',
            orderedPrefixSha256: '7891991c8a17f15014b13dd686e9a9d9069783152fab5eb066ffb874d8bec326',
            operationSha256: '848468ce19c508d2c0a4f83228305b1196ec10857747f53978d5889f7193a394',
            sourceSha256: 'e534663148e80aee71bdb2344bf87e26ed8cbf046841ffdd7d9c8385393f69d3',
            context: 'omitted',
            receiver: 'fresh-inline',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:225:0',
              title: 'observed newline serialization changes generated breaks while preserving user text',
            },
          ],
          casesSha256: '33e258e5b5c650a7145aafe296f4938f95de42a53d959c7bc953d8c2f2904136',
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
                id: 'native-original-liquid-037',
                pointer: '/captures/0/cases/36/facts',
                sha256: '75865a2a42b66056eeee6b5bf99ee550061b61985c45394bc2709cb0db02ae60',
                replicatedPointers: ['/captures/0/cases/36/facts', '/captures/1/cases/36/facts'],
              },
            ],
          },
        ],
        regionHashes: [['08ed0f7acd4ae6990e55e135e99ebf977ab1b048bc5f7025bb3cb31d07b63a0d']],
        regionFactIds: [[['native-original-liquid-037']]],
      },
    ]);
    assert.equal(
      await renderer({ liquidHtmlVoidSerialization: 'html' }).renderString(source),
      'first<br>\nsecond|<p>first<br>second</p>',
    );
  }
});

test('observed path_and_query includes fragments in a present query without changing other URL filters', async () => {
  const engine = renderer({ liquidPathAndQueryFragment: 'query' });
  const source = "{{ 'https://example.test:8443/path?existing=one#fragment' | path_and_query }}";
  assert.equal(await renderer().renderString(source), '/path?existing=one');
  assert.equal(await engine.renderString(source), '/path?existing=one%23fragment');

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'd9679dd25481e3dd5342726b30a382a926f53783c37310ad620225963c350671',
        originalAssertions: [
          '68b34db5a18261cd3bdd792d85897c77a66050a49065882057c503e0517fe41f',
          'c640f01fefa3f6435268d01cfd7f4335d3a925f92e40b390b6ca4bd53e7de3ee',
          '9975aff9cc4c52b3a31b288b2647d1b8013862a7be9907e3ba5aa2e6282ff5f8',
          '69ccacabe4f18ad8b2f2cd7057de4449ee1c0c2341ac25445a703349f88b25cb',
          'ca73cc428fde6b5978a850fe6a7d0d9e2fb348b12095671bce1c1033e957d759',
        ],
        originalBodyAstSha256: 'd5f0572084f5ea7fc0da65218f7bda55163a82a04c2c5c00120f4c5159f4fb05',
        originalGuardHashes: [],
        moduleContextAstSha256: '52b35ee431df6c946b3fdd09ef525cb582a3d6c9c6a53072ca404fe186ae53b9',
        isolationRegistrationsAstSha256: '586094b427c2d0d0769856849292d9ebe2987a50964d04acd090a977f0821d9c',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason: 'Reviewed exact unrelated callbacks and proof helper inputs for zero-credit guard migration.',
          corrections: [],
          addedTests: [
            {
              titleExpressionSha256: '34c94cf9c035857ef220146d95842b2933cc085bc8bdecad94140297999bcc25',
              bodyAstSha256: 'c6cb7eee8c5d91ec1456af091c898f9b9d7fb3389377e1437fa9940658cb6642',
              zeroOriginalCredit: true,
              interactionReviewed: true,
              reviewedBy: '/root/frontend',
              reason: 'Reviewed independent fresh-renderer proof test remains zero original credit.',
            },
          ],
          isolatedRegistrationChanges: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '4e92e8ea7ebac2d83f660c9ac7f5cf13085fa7e3451122608e705b400e02b461',
              oldBodyAstSha256: '8800040c504fea48469be6fc2287b7fe4eee5fe3098b67146487001b44262180',
              currentBodyAstSha256: 'be1d12dcc0cc704afd59f9455af22911cb61daa76cc3bf79eaafa88e645e13e5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '06c3443ce5932eed09420113fc93439c52661d23c4908683059e7225052823d8',
              oldBodyAstSha256: 'c6d24374aa96da2d7b02b62a8ae3be509d7d8ef3331caa4bb92c167cb4d2430d',
              currentBodyAstSha256: '0153bca2bffe41c070982c4b90a75cf9980bdb6dec166a6a074935fe8789d8bb',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '6a5a3006d5afeeae91ff7e2c55e6fd6380b3f205aea38f07aaea5cde3490dbf6',
              oldBodyAstSha256: '2a558f25b0d1ac221ee296c883557260322dc350e1817fdcbc24f3ec56aac516',
              currentBodyAstSha256: '70b6d00b1dfba3b53fe6a4f67a1006ab0e009585bfd55575a6b8a447242c9aa7',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              titleExpressionSha256: '7215e8e081368eeba32ba85d1b7adda5aba455e4d2e848a4697dfb3bf98f8d82',
              oldBodyAstSha256: 'f5accb81fe9655f176c17514bb2ed2b417a2417e1421a315395adf7e183b5778',
              currentBodyAstSha256: '039199bd7fe89b1be877395ea5df05159c34a294dc883efa4b740c545d6bb927',
            },
          ],
          isolatedDeclarations: [
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: 'd42d983f180543d55fa9ea63f80e9cebadaa08c0994aa36f87fde93a9b8a7ea5',
            },
            {
              zeroSelectedCredit: true,
              reviewedBy: '/root/frontend',
              reason: 'Independently reviewed selected fresh renderer slice remains isolated.',
              astSha256: '43a046a8398467e354e5ef01392ed48239e13949463a624802dd762806bce927',
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production Liquid renderer implementation exercised by these unchanged source-local literal assertions; runtime remains mutable for remediation.',
          },
        ],
        runtimeInputs: [],
        generatedFixtures: [
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:44:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: '3d9ff89d92be7578af19a8b21d2fc2d08897ac56d1426d102a6d08d083bb6dbb',
            selectedBodySha256: '393f7055f6ec665b81991faa11bc23cc548237e417548cc489286ca10eca8123',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:153:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '964bc796a68076de12b1ecdca2343b5753a464447ba48cb2af766e4927cd53a8',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:169:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'f32be36cc7b16f8c9c2480d4ec11c34ab3a1e89cdc2a9eaab15bfab9ed602e88',
            selectedBodySha256: '74783e5853023aa12cd2e28859460ad875adb082892fbf9c701b10d2b644c710',
          },
          {
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:184:0',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            inputSha256: 'b531180d644761ea9c0b73de769df19e5ba964fa187421ad208b3b886026cb61',
            selectedBodySha256: '04eb4fb0db83705762d763fac72616e5fa34e20b136278d42e4e40388107cbb4',
          },
        ],
        memoryContextCertificates: [
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
            assertionSha256: '9975aff9cc4c52b3a31b288b2647d1b8013862a7be9907e3ba5aa2e6282ff5f8',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: 'ec58f366eedbb4f516de3538ecb235208ff55f2a2a16cddde4bb988fe31e289d',
            callbackSha256: 'd5f0572084f5ea7fc0da65218f7bda55163a82a04c2c5c00120f4c5159f4fb05',
            orderedPrefixSha256: '136a458811ed8acfc7d7ba010faf2fd25042f73126072ab3a9cecb00a873e609',
            operationSha256: '8f3aebe4b22c1570c0fccaa52c01dead52fc9f0a44a56a72900a1cbce41e4698',
            sourceSha256: 'f4d1ef2a7ae619d2a27fbe53c993310a046f93a96cd7221fbdf9c3f7e30f8463',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
            assertionSha256: '69ccacabe4f18ad8b2f2cd7057de4449ee1c0c2341ac25445a703349f88b25cb',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: 'ec58f366eedbb4f516de3538ecb235208ff55f2a2a16cddde4bb988fe31e289d',
            callbackSha256: 'd5f0572084f5ea7fc0da65218f7bda55163a82a04c2c5c00120f4c5159f4fb05',
            orderedPrefixSha256: 'cc09b729505b8ecddde748d41b6f463c549e96982297b62d69159672b3845cf6',
            operationSha256: 'aae3d0266d4880c3196a61a653fc83ed6adc25bb43c064fdfb1c064c68d93644',
            sourceSha256: 'dfc05e99f9bfc2b6f40d25fbea7192308898b0fb08f03060d8ac75f829e8e2c6',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
          {
            kind: 'unchanged-memory-context-input',
            baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
            assertionSha256: 'ca73cc428fde6b5978a850fe6a7d0d9e2fb348b12095671bce1c1033e957d759',
            helperSha256: 'bf7e6ab28132f7cb810057cc8e4ac3044367329d9f1b74a25ca6dbef03b12b8c',
            constructionSha256: 'ec58f366eedbb4f516de3538ecb235208ff55f2a2a16cddde4bb988fe31e289d',
            callbackSha256: 'd5f0572084f5ea7fc0da65218f7bda55163a82a04c2c5c00120f4c5159f4fb05',
            orderedPrefixSha256: '753881c18948187a4538872cce576c6be206de26ede00011962024347b88adfe',
            operationSha256: '5def1c05b128f6a26b4a52f028a90a5ead7a9f693870821feac3051b57f4f6ff',
            sourceSha256: 'ece9f4a82fe38192fd17b83ebc524edd46dea17372336693c99c0d312fdf13ea',
            context: 'omitted',
            receiver: 'retained-engine',
            moduleIsolationRequired: true,
            rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
            nativeParityProven: false,
          },
        ],
        inputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
          },
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
          },
        ],
        additionalInputDependencies: [
          {
            path: 'mirage/test/fixtures/power-pages-historical-numeric-facts.json',
            sha256: '3ecc93e7d776634ef7420fbfc596c4dd0c961b056d9e36e04681fd2ed0849a8c',
            readAstSha256: '8045f5f3952b7a690a6638177f903cda6bdd699ce36f22699bd8878d74f7c8af',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-cases.json',
            sha256: 'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
            readAstSha256: 'c5fbb3664038ac43cbe100569043b09b61eed8fd63d8259f2f352e92b79029f7',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
          {
            path: 'mirage/test/fixtures/power-pages-contract-expected.json',
            sha256: '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
            readAstSha256: '7c1882d2d5e54e584efb0523253de8a9f14fa3289f7a7db0cc134f41fe7e4ea8',
            reviewedBy: '/root/frontend',
            reason: 'Pinned exact public evidence bytes used by unselected proof callback.',
          },
        ],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            {
              baselineId: 'mirage/test/liquid-observed-math.test.mjs:234:0',
              title: 'observed path_and_query includes fragments in a present query without changing other URL filters',
            },
          ],
          casesSha256: '2ce53be68232d77022c536c93f206a767ca3380551de0242229683ee4fa95762',
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
                id: 'native-original-liquid-038',
                pointer: '/captures/0/cases/37/facts',
                sha256: 'bb22f11ff98552d6517a3ab3cd735ab47b668af05895e55cc26582f4f129b2fa',
                replicatedPointers: ['/captures/0/cases/37/facts', '/captures/1/cases/37/facts'],
              },
              {
                id: 'native-original-liquid-039',
                pointer: '/captures/0/cases/38/facts',
                sha256: '3fabe9df97c53872a5d9883b5f10fa4bad38e3763e7aa9b9231fc09a43689924',
                replicatedPointers: ['/captures/0/cases/38/facts', '/captures/1/cases/38/facts'],
              },
              {
                id: 'native-original-liquid-040',
                pointer: '/captures/0/cases/39/facts',
                sha256: '96915a47e42860d2d7aa2170fa3670c99432dfaadbbfa617b88dc6581b0c03b5',
                replicatedPointers: ['/captures/0/cases/39/facts', '/captures/1/cases/39/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            '9975aff9cc4c52b3a31b288b2647d1b8013862a7be9907e3ba5aa2e6282ff5f8',
            '69ccacabe4f18ad8b2f2cd7057de4449ee1c0c2341ac25445a703349f88b25cb',
            'ca73cc428fde6b5978a850fe6a7d0d9e2fb348b12095671bce1c1033e957d759',
          ],
        ],
        regionFactIds: [
          [['native-original-liquid-038'], ['native-original-liquid-039'], ['native-original-liquid-040']],
        ],
      },
    ]);
    assert.equal(
      await engine.renderString("{{ '/path?existing=one#fragment#two' | path_and_query }}"),
      '/path?existing=one%23fragment%23two',
    );
    assert.equal(
      await engine.renderString("{{ 'https://example.test/path?existing=one%23fragment' | path_and_query }}"),
      '/path?existing=one%23fragment',
    );
    assert.equal(
      await engine.renderString(
        "{{ 'https://example.test/path#fragment' | path_and_query }}|{{ '#fragment' | path_and_query }}|{{ 'https://example.test/path?x=1#fragment' | path }}",
      ),
      '/path||/path',
    );
  }
});

// @test-kind parity: both native2026-11-08 pages65 captures reproduce the identical filter-path_and_query literal source and output; frontend-parity-evidence.json.
// @parity-evidence: this context-free literal URL expression has no request/object/block variables; default-mode and other URL shapes remain outside this region.
test('native literal URL query encodes its fragment delimiter', async () => {
  const engine = renderer({ liquidPathAndQueryFragment: 'query' });
  const source = "{{ 'https://example.test:8443/path?existing=one#fragment' | path_and_query }}";
  const cases = readFileSync(new URL('./fixtures/power-pages-contract-cases.json', import.meta.url));
  const expected = readFileSync(new URL('./fixtures/power-pages-contract-expected.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(cases).digest('hex'),
    'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
  );
  assert.equal(
    createHash('sha256').update(expected).digest('hex'),
    '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
  );
  assert.equal(JSON.parse(cases).find((row) => row.id === 'filter-path_and_query').source, source);
  assert.equal(
    JSON.parse(expected).find((row) => row.id === 'filter-path_and_query').output,
    '/path?existing=one%23fragment',
  );
  assert.equal(await engine.renderString(source), '/path?existing=one%23fragment');
});

// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.
test('parity source bindings 04a903c4e72b954d', () => {
  // @parity-evidence: Tooling-only exposure of the existing source/run/fact/case validator; the same helper and module URL execute once, with every protected binding unchanged.
  assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));
});
