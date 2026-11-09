// @test-kind unproven: portal imports, local adapters and native-facing rendering models; exact reproduced original guarantees receive per-test parity overrides.
import { parityAssertions as __paqParityAssertions } from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/import-render.test.mjs:473:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '94116b9f78c070017f920e44ce13b45ed28169ffff7872b0c7d83d208cf6440e',
    originalAssertions: [
      '3934850faefaa0635ac8ea6c81182d12f6f5a12b25ad7dfeb82d3346b256e380',
      '990f9b37945ccb6036eae0214be44dbc399e6829a199437db9d96a321aca5fa0',
      '6ee4b13facc397e5c6bea05bb78bee2a3934e2ed46b2346ca239473c4a42b3c0',
      '8bc62eb047907acbbf73263a2d2b64253cfc632cf02a63496a53c0ce17821b1c',
      'fceaf3b8619b509b475359679dcb127836507aae6e73b50c77140bf69b01d7d6',
      '572c5ff83a86c93f71d774dd61b57528c81d8579652dbe29aacd143b85ff4594',
      '81960565a815cb46657175e5e824ca8ebe0fd4690801040a88cb5aa3accfdf38',
    ],
    originalBodyAstSha256: '02125ca841529b83fbc810fe71a387ef360a6e66d1d224e735c81522b85320e8',
    originalGuardHashes: [],
    moduleContextAstSha256: 'b171657ac710fbed9b33468c2b25cf366e6dd54854e646005a85890522416ccc',
    isolationRegistrationsAstSha256: '6b5bab04f8e5cd104845c490ce1484f4097704a7c8d33047d155347cf7c80c60',
    importRoles: [
      {
        source: '../lib/importer.mjs',
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
        source: '../lib/header-notification-capture.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/extensions.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/observed-pagecopy-layout.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/observed-snippet-composition.mjs',
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
    generatedFixtures: [
      {
        baselineId: 'mirage/test/import-render.test.mjs:473:0',
        producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
        mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
        allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
        helperPath: 'mirage/testing/owned-fixture.mjs',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        entries: [
          { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
          {
            name: 'web-pages/home/Home.webpage.yml',
            sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
          },
          {
            name: 'web-pages/work/Work.webpage.yml',
            sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
            sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
            sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
            sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
            sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
          },
          {
            name: 'page-templates/Main.pagetemplate.yml',
            sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
          },
          {
            name: 'web-templates/header/Header.webtemplate.yml',
            sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
          },
          {
            name: 'web-templates/header/Header.webtemplate.source.html',
            sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.yml',
            sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.source.html',
            sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
          },
          {
            name: 'web-templates/content/Content.webtemplate.yml',
            sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
          },
          {
            name: 'web-templates/content/Content.webtemplate.source.html',
            sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
            sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            name: 'web-files/app.js.webfile.yml',
            sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
          },
          { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
          {
            name: 'table-permissions/contact.tablepermission.yml',
            sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
          },
        ],
        ownedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
        isolatedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
      },
      {
        baselineId: 'mirage/test/import-render.test.mjs:768:0',
        producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
        mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
        allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
        helperPath: 'mirage/testing/owned-fixture.mjs',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        entries: [
          { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
          {
            name: 'web-pages/home/Home.webpage.yml',
            sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
          },
          {
            name: 'web-pages/work/Work.webpage.yml',
            sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
            sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
            sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
            sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
            sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
          },
          {
            name: 'page-templates/Main.pagetemplate.yml',
            sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
          },
          {
            name: 'web-templates/header/Header.webtemplate.yml',
            sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
          },
          {
            name: 'web-templates/header/Header.webtemplate.source.html',
            sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.yml',
            sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.source.html',
            sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
          },
          {
            name: 'web-templates/content/Content.webtemplate.yml',
            sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
          },
          {
            name: 'web-templates/content/Content.webtemplate.source.html',
            sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
            sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            name: 'web-files/app.js.webfile.yml',
            sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
          },
          { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
          {
            name: 'table-permissions/contact.tablepermission.yml',
            sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
          },
        ],
        ownedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
        isolatedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
      },
      {
        baselineId: 'mirage/test/import-render.test.mjs:787:0',
        producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
        mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
        allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
        helperPath: 'mirage/testing/owned-fixture.mjs',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        entries: [
          { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
          {
            name: 'web-pages/home/Home.webpage.yml',
            sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
          },
          {
            name: 'web-pages/work/Work.webpage.yml',
            sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
            sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
            sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
            sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
            sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
          },
          {
            name: 'page-templates/Main.pagetemplate.yml',
            sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
          },
          {
            name: 'web-templates/header/Header.webtemplate.yml',
            sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
          },
          {
            name: 'web-templates/header/Header.webtemplate.source.html',
            sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.yml',
            sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.source.html',
            sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
          },
          {
            name: 'web-templates/content/Content.webtemplate.yml',
            sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
          },
          {
            name: 'web-templates/content/Content.webtemplate.source.html',
            sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
            sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            name: 'web-files/app.js.webfile.yml',
            sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
          },
          { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
          {
            name: 'table-permissions/contact.tablepermission.yml',
            sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
          },
        ],
        ownedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
        isolatedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
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
          baselineId: 'mirage/test/import-render.test.mjs:473:0',
          title: 'nested snippet Liquid, member assignments, null user, and Power Pages filter tolerance',
        },
      ],
      casesSha256: '4e5c569f22e638bc0de0c499f258f92873904f2b369f9b9608e3bdc8390e2846',
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
            id: 'native-original-liquid-001',
            pointer: '/captures/0/cases/0/facts',
            sha256: '7b257c555210b32ad165bb11e18521a3b562f0b7d2076f2741098dfcecfa8b10',
            replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
          },
        ],
      },
    ],
    regionHashes: [['fceaf3b8619b509b475359679dcb127836507aae6e73b50c77140bf69b01d7d6']],
    regionFactIds: [[['native-original-liquid-001']]],
  },
  {
    baselineId: 'mirage/test/import-render.test.mjs:768:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '3defb294e25df87446de5dcfe9296bff7db6db97f546ebaf08a13f7039d76ea3',
    originalAssertions: [
      '3c666697ad30993d40e9166026d4378e57a8198cf8c9de68098834599f4b0261',
      'c93da69d7225e033df17741a0e230406c732e4565728d3ab96e9e2ebca047479',
      '50e2c94a65214524832fce93358f23dd84be1c6e1d61736a3a715e303398b607',
    ],
    originalBodyAstSha256: '8ac7532d80961c754511addbe65c407a689b4a39b607b286d8fcc5b6cb59e576',
    originalGuardHashes: [],
    moduleContextAstSha256: 'b171657ac710fbed9b33468c2b25cf366e6dd54854e646005a85890522416ccc',
    isolationRegistrationsAstSha256: '6b5bab04f8e5cd104845c490ce1484f4097704a7c8d33047d155347cf7c80c60',
    importRoles: [
      {
        source: '../lib/importer.mjs',
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
        source: '../lib/header-notification-capture.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/extensions.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/observed-pagecopy-layout.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/observed-snippet-composition.mjs',
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
    generatedFixtures: [
      {
        baselineId: 'mirage/test/import-render.test.mjs:473:0',
        producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
        mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
        allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
        helperPath: 'mirage/testing/owned-fixture.mjs',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        entries: [
          { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
          {
            name: 'web-pages/home/Home.webpage.yml',
            sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
          },
          {
            name: 'web-pages/work/Work.webpage.yml',
            sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
            sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
            sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
            sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
            sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
          },
          {
            name: 'page-templates/Main.pagetemplate.yml',
            sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
          },
          {
            name: 'web-templates/header/Header.webtemplate.yml',
            sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
          },
          {
            name: 'web-templates/header/Header.webtemplate.source.html',
            sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.yml',
            sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.source.html',
            sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
          },
          {
            name: 'web-templates/content/Content.webtemplate.yml',
            sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
          },
          {
            name: 'web-templates/content/Content.webtemplate.source.html',
            sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
            sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            name: 'web-files/app.js.webfile.yml',
            sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
          },
          { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
          {
            name: 'table-permissions/contact.tablepermission.yml',
            sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
          },
        ],
        ownedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
        isolatedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
      },
      {
        baselineId: 'mirage/test/import-render.test.mjs:768:0',
        producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
        mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
        allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
        helperPath: 'mirage/testing/owned-fixture.mjs',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        entries: [
          { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
          {
            name: 'web-pages/home/Home.webpage.yml',
            sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
          },
          {
            name: 'web-pages/work/Work.webpage.yml',
            sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
            sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
            sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
            sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
            sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
          },
          {
            name: 'page-templates/Main.pagetemplate.yml',
            sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
          },
          {
            name: 'web-templates/header/Header.webtemplate.yml',
            sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
          },
          {
            name: 'web-templates/header/Header.webtemplate.source.html',
            sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.yml',
            sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.source.html',
            sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
          },
          {
            name: 'web-templates/content/Content.webtemplate.yml',
            sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
          },
          {
            name: 'web-templates/content/Content.webtemplate.source.html',
            sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
            sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            name: 'web-files/app.js.webfile.yml',
            sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
          },
          { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
          {
            name: 'table-permissions/contact.tablepermission.yml',
            sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
          },
        ],
        ownedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
        isolatedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
      },
      {
        baselineId: 'mirage/test/import-render.test.mjs:787:0',
        producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
        mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
        allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
        helperPath: 'mirage/testing/owned-fixture.mjs',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        entries: [
          { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
          {
            name: 'web-pages/home/Home.webpage.yml',
            sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
          },
          {
            name: 'web-pages/work/Work.webpage.yml',
            sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
            sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
            sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
            sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
            sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
          },
          {
            name: 'page-templates/Main.pagetemplate.yml',
            sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
          },
          {
            name: 'web-templates/header/Header.webtemplate.yml',
            sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
          },
          {
            name: 'web-templates/header/Header.webtemplate.source.html',
            sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.yml',
            sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.source.html',
            sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
          },
          {
            name: 'web-templates/content/Content.webtemplate.yml',
            sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
          },
          {
            name: 'web-templates/content/Content.webtemplate.source.html',
            sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
            sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            name: 'web-files/app.js.webfile.yml',
            sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
          },
          { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
          {
            name: 'table-permissions/contact.tablepermission.yml',
            sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
          },
        ],
        ownedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
        isolatedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
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
          baselineId: 'mirage/test/import-render.test.mjs:768:0',
          title: 'query filters preserve relative navigation paths and fragment spelling',
        },
      ],
      casesSha256: '90ab4c8b0e3965d7a92f247444a6c4cd2822cd47348e3f6b33ac87aeda0393d5',
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
            id: 'native-original-liquid-006',
            pointer: '/captures/0/cases/5/facts',
            sha256: 'e9e24f0423e7b9322930b782bb79969fd046c6bd84dda00d69b72971cf5ca0fe',
            replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
          },
        ],
      },
    ],
    regionHashes: [['50e2c94a65214524832fce93358f23dd84be1c6e1d61736a3a715e303398b607']],
    regionFactIds: [[['native-original-liquid-006']]],
  },
  {
    baselineId: 'mirage/test/import-render.test.mjs:787:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'fbb1aa456297661821e1441926dfb475b3a6a438e734f2a1af9182fe6ea58df0',
    originalAssertions: [
      '4ee36aa27abf2e26045cf9f560ef8801599407adea03f30770fb4f6979cb1973',
      '16e45c984a49ea827833d72cb16dc99050a5f45557c3e7c5b4a929420262e731',
      '52595e1aca3721729f3028a58ecad9bb13fdd64be80606aa2694614f1dda6b8d',
    ],
    originalBodyAstSha256: '2a4c5eb0d58a3da9268897ba1a6496567cabee69a23df03d2b076d8e7a1a665b',
    originalGuardHashes: [],
    moduleContextAstSha256: 'b171657ac710fbed9b33468c2b25cf366e6dd54854e646005a85890522416ccc',
    isolationRegistrationsAstSha256: '6b5bab04f8e5cd104845c490ce1484f4097704a7c8d33047d155347cf7c80c60',
    importRoles: [
      {
        source: '../lib/importer.mjs',
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
        source: '../lib/header-notification-capture.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/extensions.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/observed-pagecopy-layout.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/observed-snippet-composition.mjs',
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
    generatedFixtures: [
      {
        baselineId: 'mirage/test/import-render.test.mjs:473:0',
        producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
        mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
        allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
        helperPath: 'mirage/testing/owned-fixture.mjs',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        entries: [
          { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
          {
            name: 'web-pages/home/Home.webpage.yml',
            sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
          },
          {
            name: 'web-pages/work/Work.webpage.yml',
            sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
            sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
            sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
            sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
            sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
          },
          {
            name: 'page-templates/Main.pagetemplate.yml',
            sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
          },
          {
            name: 'web-templates/header/Header.webtemplate.yml',
            sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
          },
          {
            name: 'web-templates/header/Header.webtemplate.source.html',
            sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.yml',
            sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.source.html',
            sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
          },
          {
            name: 'web-templates/content/Content.webtemplate.yml',
            sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
          },
          {
            name: 'web-templates/content/Content.webtemplate.source.html',
            sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
            sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            name: 'web-files/app.js.webfile.yml',
            sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
          },
          { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
          {
            name: 'table-permissions/contact.tablepermission.yml',
            sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
          },
        ],
        ownedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
        isolatedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
      },
      {
        baselineId: 'mirage/test/import-render.test.mjs:768:0',
        producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
        mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
        allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
        helperPath: 'mirage/testing/owned-fixture.mjs',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        entries: [
          { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
          {
            name: 'web-pages/home/Home.webpage.yml',
            sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
          },
          {
            name: 'web-pages/work/Work.webpage.yml',
            sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
            sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
            sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
            sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
            sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
          },
          {
            name: 'page-templates/Main.pagetemplate.yml',
            sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
          },
          {
            name: 'web-templates/header/Header.webtemplate.yml',
            sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
          },
          {
            name: 'web-templates/header/Header.webtemplate.source.html',
            sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.yml',
            sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.source.html',
            sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
          },
          {
            name: 'web-templates/content/Content.webtemplate.yml',
            sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
          },
          {
            name: 'web-templates/content/Content.webtemplate.source.html',
            sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
            sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            name: 'web-files/app.js.webfile.yml',
            sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
          },
          { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
          {
            name: 'table-permissions/contact.tablepermission.yml',
            sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
          },
        ],
        ownedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
        isolatedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
      },
      {
        baselineId: 'mirage/test/import-render.test.mjs:787:0',
        producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
        mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
        allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
        helperPath: 'mirage/testing/owned-fixture.mjs',
        helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        entries: [
          { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
          {
            name: 'web-pages/home/Home.webpage.yml',
            sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
          },
          {
            name: 'web-pages/work/Work.webpage.yml',
            sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
            sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
            sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
            sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
          },
          {
            name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
            sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
          },
          {
            name: 'page-templates/Main.pagetemplate.yml',
            sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
          },
          {
            name: 'web-templates/header/Header.webtemplate.yml',
            sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
          },
          {
            name: 'web-templates/header/Header.webtemplate.source.html',
            sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.yml',
            sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
          },
          {
            name: 'web-templates/footer/Footer.webtemplate.source.html',
            sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
          },
          {
            name: 'web-templates/content/Content.webtemplate.yml',
            sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
          },
          {
            name: 'web-templates/content/Content.webtemplate.source.html',
            sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
            sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
          },
          {
            name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            name: 'web-files/app.js.webfile.yml',
            sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
          },
          { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
          {
            name: 'table-permissions/contact.tablepermission.yml',
            sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
          },
        ],
        ownedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
        ],
        isolatedReads: [
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
          {
            registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
            entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
            entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
          },
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
          baselineId: 'mirage/test/import-render.test.mjs:787:0',
          title: 'DotLiquid path split and include variable casing select the authored creation header',
        },
      ],
      casesSha256: '771b12cf654e128e51e2ef3f42167fb435d531f78c621efed42f1012742af04e',
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
            id: 'native-original-liquid-007',
            pointer: '/captures/0/cases/6/facts',
            sha256: '7539571566edbf3e73bb8c61adf7960b213cd845e68a21dda1571c4e1246a809',
            replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
          },
        ],
      },
    ],
    regionHashes: [['52595e1aca3721729f3028a58ecad9bb13fdd64be80606aa2694614f1dda6b8d']],
    regionFactIds: [[['native-original-liquid-007']]],
  },
]);
import {
  assertParityBindings as __paqParityBindings,
  assertParityBindingsFromSource as __paqParitySourceBindings,
} from '../../scripts/qualify-parity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importPortal } from '../lib/importer.mjs';
import { createPortalRenderer, renderShellResource } from '../lib/liquid.mjs';
import { observedHeaderNotifications } from '../lib/header-notification-capture.mjs';
import { registerShellConventions } from '../lib/extensions.mjs';
import { observedPageCopyLayout } from '../lib/observed-pagecopy-layout.mjs';
import { observedSnippetComposition } from '../lib/observed-snippet-composition.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function fixture(t, files) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-simulation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}
const standard = {
  'website.yml':
    'adx_websiteid: site\nadx_name: Test\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer\nadx_defaultlanguage: english',
  'web-pages/home/Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: main',
  'web-pages/work/Work.webpage.yml':
    'adx_webpageid: work\nadx_name: Work\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: work\nadx_pagetemplateid: main',
  'web-pages/work/content-pages/Work.en-US.webpage.yml':
    'adx_webpageid: translation\nadx_name: Work\nadx_title: Work title\nadx_isroot: false\nadx_rootwebpageid: work\nadx_webpagelanguageid: english\nadx_partialurl: work',
  'web-pages/work/content-pages/Work.en-US.webpage.copy.html': '<p>Page body {{request.params.item | escape}}</p>',
  'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css': '.work {color: red}',
  'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js': 'window.work = true;',
  'page-templates/Main.pagetemplate.yml':
    'adx_pagetemplateid: main\nadx_name: Main\nadx_usewebsiteheaderandfooter: true\nadx_webtemplateid: content',
  'web-templates/header/Header.webtemplate.yml': 'adx_webtemplateid: header\nadx_name: Header',
  'web-templates/header/Header.webtemplate.source.html': '<header>{{snippets["Greeting"]}}</header>',
  'web-templates/footer/Footer.webtemplate.yml': 'adx_webtemplateid: footer\nadx_name: Footer',
  'web-templates/footer/Footer.webtemplate.source.html': '<footer>{{ now | date: "yyyy" }}</footer>',
  'web-templates/content/Content.webtemplate.yml': 'adx_webtemplateid: content\nadx_name: Content',
  'web-templates/content/Content.webtemplate.source.html': "{% include 'Page Copy' %}",
  'content-snippets/greeting/Greeting.contentsnippet.yml': 'adx_contentsnippetid: greeting\nadx_name: Greeting',
  'content-snippets/greeting/Greeting.contentsnippet.value.html': 'Hello',
  'web-files/app.js.webfile.yml':
    'adx_webfileid: app\nadx_name: app.js\nadx_partialurl: renamed.js\nadx_parentpageid: home\nfilename: original.js\nmimetype: application/javascript',
  'web-files/app.js': 'window.asset = true;',
  'table-permissions/contact.tablepermission.yml':
    'adx_entitypermissionid: permission\nadx_entitylogicalname: contact\nadx_entityname: Contacts\nadx_read: true',
};
test('knowledge categories load lazily through the current data provider and follow paging without cross-render caching', async (t) => {
  const dir = await fixture(t, standard),
    portal = await importPortal(dir),
    reads = [];
  const renderer = createPortalRenderer(portal, {
    fetchXml: async (xml, user) => {
      reads.push({ xml, user });
      if (user.id === 'denied') return { entities: [], more_records: false };
      if (xml.includes('page="1"'))
        return {
          entities: [{ categoryid: 'first', categorynumber: 'CAT-01001', title: 'Forms' }],
          more_records: true,
          paging_cookie: '<cookie id="first" />',
        };
      assert.match(xml, /paging-cookie="&lt;cookie id=&quot;first&quot; \/&gt;"/);
      return {
        entities: [
          {
            categoryid: 'pms',
            categorynumber: 'CAT-01003',
            title: 'PMS guidance',
          },
        ],
        more_records: false,
      };
    },
  });
  portal.templates.content.source =
    "{% assign category=knowledge.categories | category_number:'CAT-01003' %}<h1>{{ category.title }}</h1>{% assign roots=knowledge.categories | top_level:9 %}{% for root in roots %}{{ root.categorynumber }} {% endfor %}";
  const allowed = await renderer.renderPage('/work/', {
    user: { id: 'allowed' },
  });
  assert.match(allowed.html, /<h1>PMS guidance<\/h1>/);
  assert.match(allowed.html, /CAT-01001 CAT-01003/);
  assert.equal(reads.length, 2);
  assert.ok(reads.every((read) => read.user.id === 'allowed'));
  const denied = await renderer.renderPage('/work/', {
    user: { id: 'denied' },
  });
  assert.doesNotMatch(denied.html, /PMS guidance|CAT-01003/);
  assert.equal(reads.length, 3);
  portal.templates.content.source = '<h1>Ordinary page</h1>';
  await renderer.renderPage('/work/', { user: { id: 'allowed' } });
  assert.equal(reads.length, 3);
});

test('observed static copy layout and snippet composition render through native tags and edited source wins', async (t) => {
  const copy = '<script src="/copy.js"></script>',
    parent = '<div class="empty">Use filters</div>',
    child = '<button id="create" style="display:none;">Create</button>';
  const dir = await fixture(t, {
    ...standard,
    'web-pages/work/content-pages/Work.en-US.webpage.copy.html': copy,
    'web-templates/content/Content.webtemplate.source.html': `{% include 'Page Copy' %}{{ snippets['Greeting'] }}`,
    'content-snippets/greeting/Greeting.contentsnippet.value.html': parent,
    'content-snippets/action/Action.contentsnippet.yml': 'adx_contentsnippetid: action\nadx_name: Action',
    'content-snippets/action/Action.contentsnippet.value.html': child,
  });
  const portal = await importPortal(dir),
    origin = 'https://example.invalid';
  const layout = observedPageCopyLayout(
    '<div class="page-copy"><div class="xrm-attribute-value">' +
      copy +
      '<div class="row sectionBlockLayout"><div class="container"></div></div></div></div>',
    { portal, path: '/work/', origin },
  );
  assert.ok(layout);
  const composition = observedSnippetComposition({
    snippets: portal.snippets,
    parentName: 'Greeting',
    childName: 'Action',
    observedMarkup: parent.replace('</div>', child + '</div>'),
    origin,
    pagePath: '/work/',
  });
  const renderer = createPortalRenderer(portal, {
    observationOrigin: origin,
    shellProfile: {
      pageCopyLayouts: [layout],
      snippetCompositions: [composition],
    },
  });
  const result = await renderer.renderPage('/work/');
  assert.equal(result.status, 200);
  assert.match(result.html, /xrm-editable-html/);
  assert.match(result.html, /sectionBlockLayout/);
  assert.match(result.html, /<button id="create" style="display:none;">/);
  portal.pages.find((p) => p.url === '/work/').html = 'Edited';
  portal.snippets.Greeting = 'Local parent edit';
  const changed = await renderer.renderPage('/work/');
  assert.doesNotMatch(changed.html, /sectionBlockLayout|id="create"/);
  assert.ok(changed.diagnostics.some((d) => d.code === 'PAGE_COPY_LAYOUT_SOURCE_CHANGED'));
  assert.ok(changed.diagnostics.some((d) => d.code === 'SNIPPET_COMPOSITION_SOURCE_CHANGED'));
});

test('observed header notification presentation uses exported Liquid query and current user without copying native data', async (t) => {
  // The data pack serving the portal names the query template (shell.headerNotificationQuery).
  assert.throws(() => registerShellConventions('test', { headerNotificationQuery: ' ' }), /must name a web template/);
  registerShellConventions('test', { headerNotificationQuery: 'Site notifications query' });
  const header = '<header><ul><li class="userProfileHolder">Profile</li></ul></header>';
  const dir = await fixture(t, {
    ...standard,
    'web-templates/header/Header.webtemplate.source.html': header,
    'web-templates/notifications/Notifications.webtemplate.yml':
      'adx_webtemplateid: notifications\nadx_name: Site notifications query',
    'web-templates/notifications/Notifications.webtemplate.source.html': `{% fetchxml notices %}<fetch><entity name="notification"/></fetch>{% endfetchxml %}{"notifications": [{% for notice in notices.results.entities %}{"visible":{% if notice.contact == user.id %}true{% else %}false{% endif %},"notificationText":"{{notice.message}}","severity":"info"}{% unless forloop.last %},{% endunless %}{% endfor %}]}`,
  });
  const profile = observedHeaderNotifications(
    '<li class="userProfileHolder"><a href="#"><svg><path d="M0 0"/></svg><span class="notificationsCount">99</span></a></li>',
    { headerSource: header, origin: 'https://example.invalid' },
  );
  let identity;
  const renderer = createPortalRenderer(await importPortal(dir), {
    fetchXml: async (_xml, user) => {
      identity = user;
      return {
        entities: [
          { contact: 'current', message: 'Local notice' },
          { contact: 'other', message: 'Hidden notice' },
        ],
      };
    },
    shellProfile: { headerNotifications: profile },
  });
  const result = await renderer.renderPage('/work/', {
    user: { id: 'current', roles: [] },
  });
  assert.equal(result.status, 200);
  assert.equal(identity.id, 'current');
  assert.match(result.html, /notificationsCount[^>]*>1</);
  assert.match(result.html, /Local notice/);
  assert.doesNotMatch(result.html, /Hidden notice/);
  assert.doesNotMatch(result.html, />99</);
});

test('header queries own custom audience rules and invalid presentation rows are diagnosed', async (t) => {
  registerShellConventions('presentation-fixture', { headerNotificationQuery: 'Authored notices' });
  const header = '<header><ul><li class="userProfileHolder">Profile</li></ul></header>';
  const dir = await fixture(t, {
    ...standard,
    'web-templates/header/Header.webtemplate.source.html': header,
    'web-templates/notices/Notices.webtemplate.yml': 'adx_webtemplateid: authored-notices\nadx_name: Authored notices',
    'web-templates/notices/Notices.webtemplate.source.html': JSON.stringify({
      notifications: [
        {
          notificationText: 'Authored visible',
          visible: true,
          severity: 'warning',
          audience: 99,
          webRoleName: 'Unassigned',
        },
        { notificationText: 'Authored hidden', visible: false, severity: 'info', audience: 1 },
        { notificationText: 'Numeric severity', visible: true, severity: 2 },
        { notificationText: 'String visibility', visible: 'false', severity: 'info' },
        null,
      ],
    }),
  });
  const profile = observedHeaderNotifications(
    '<li class="userProfileHolder"><a href="#"><svg><path d="M0 0"/></svg><span class="notificationsCount">99</span></a></li>',
    { headerSource: header, origin: 'https://example.invalid' },
  );
  const renderer = createPortalRenderer(await importPortal(dir), { shellProfile: { headerNotifications: profile } });
  const result = await renderer.renderPage('/work/', { user: { id: 'current', roles: [] } });
  assert.equal(result.status, 200);
  assert.match(result.html, /Authored visible/);
  assert.match(result.html, /alert-warning/);
  assert.match(result.html, /notificationsCount[^>]*>1</);
  assert.doesNotMatch(result.html, /Authored hidden|Numeric severity|String visibility/);
  assert.equal(result.diagnostics.find((entry) => entry.code === 'HEADER_NOTIFICATION_QUERY_INVALID')?.count, 3);
});

// @test-kind parity: Every unchanged original assertion is bound to repeated native source/input/result facts.
// @parity-evidence: Manifest guarantee liquid-combined-mirage-test-import-render-test-mjs-224-0; exact capsule/run/fact/source bindings are asserted below.
test('portal date formats support single numeric tokens and literal text', async (t) => {
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/import-render.test.mjs:224:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '3a39244c253cd12fb42d9f65925514cf993d56d88675c53ae076bb479f38c876',
      originalAssertions: [
        '8724ca307b578046c298b3b106f6f008c8d67a030c56242452e4a6606bf7044e',
        '0a9021536f3516d50f82538d6937485c16e3e9ebf8787aee87368707fc79f7b4',
        '38756d19337e65d2897c6008acb45d58a8d281d5b43aca3bf36884b9e6dcfa19',
        'e9c021452abed6dfa40612c94a955ba1802dacb29836b40dac74eda38af764fd',
      ],
      originalBodyAstSha256: 'a266f1fb2d2aa7b36c1b30e08be693e8fc35b6efe0418532b1510440c9102538',
      originalGuardHashes: [],
      moduleContextAstSha256: 'b171657ac710fbed9b33468c2b25cf366e6dd54854e646005a85890522416ccc',
      isolationRegistrationsAstSha256: '6b5bab04f8e5cd104845c490ce1484f4097704a7c8d33047d155347cf7c80c60',
      importRoles: [
        {
          source: '../lib/importer.mjs',
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
          source: '../lib/header-notification-capture.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/extensions.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/observed-pagecopy-layout.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/observed-snippet-composition.mjs',
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
      generatedFixtures: [
        {
          baselineId: 'mirage/test/import-render.test.mjs:224:0',
          producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
          mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
          allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
          helperPath: 'mirage/testing/owned-fixture.mjs',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          entries: [
            { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
            {
              name: 'web-pages/home/Home.webpage.yml',
              sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
            },
            {
              name: 'web-pages/work/Work.webpage.yml',
              sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
              sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
              sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
              sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
              sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
            },
            {
              name: 'page-templates/Main.pagetemplate.yml',
              sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
            },
            {
              name: 'web-templates/header/Header.webtemplate.yml',
              sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
            },
            {
              name: 'web-templates/header/Header.webtemplate.source.html',
              sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.yml',
              sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.source.html',
              sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
            },
            {
              name: 'web-templates/content/Content.webtemplate.yml',
              sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
            },
            {
              name: 'web-templates/content/Content.webtemplate.source.html',
              sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
              sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              name: 'web-files/app.js.webfile.yml',
              sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
            },
            { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
            {
              name: 'table-permissions/contact.tablepermission.yml',
              sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
            },
          ],
          ownedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
          isolatedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
        },
        {
          baselineId: 'mirage/test/import-render.test.mjs:624:0',
          producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
          mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
          allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
          helperPath: 'mirage/testing/owned-fixture.mjs',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          entries: [
            { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
            {
              name: 'web-pages/home/Home.webpage.yml',
              sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
            },
            {
              name: 'web-pages/work/Work.webpage.yml',
              sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
              sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
              sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
              sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
              sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
            },
            {
              name: 'page-templates/Main.pagetemplate.yml',
              sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
            },
            {
              name: 'web-templates/header/Header.webtemplate.yml',
              sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
            },
            {
              name: 'web-templates/header/Header.webtemplate.source.html',
              sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.yml',
              sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.source.html',
              sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
            },
            {
              name: 'web-templates/content/Content.webtemplate.yml',
              sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
            },
            {
              name: 'web-templates/content/Content.webtemplate.source.html',
              sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
              sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              name: 'web-files/app.js.webfile.yml',
              sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
            },
            { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
            {
              name: 'table-permissions/contact.tablepermission.yml',
              sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
            },
          ],
          ownedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
          isolatedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
        },
        {
          baselineId: 'mirage/test/import-render.test.mjs:830:0',
          producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
          mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
          allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
          helperPath: 'mirage/testing/owned-fixture.mjs',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          entries: [
            { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
            {
              name: 'web-pages/home/Home.webpage.yml',
              sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
            },
            {
              name: 'web-pages/work/Work.webpage.yml',
              sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
              sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
              sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
              sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
              sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
            },
            {
              name: 'page-templates/Main.pagetemplate.yml',
              sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
            },
            {
              name: 'web-templates/header/Header.webtemplate.yml',
              sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
            },
            {
              name: 'web-templates/header/Header.webtemplate.source.html',
              sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.yml',
              sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.source.html',
              sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
            },
            {
              name: 'web-templates/content/Content.webtemplate.yml',
              sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
            },
            {
              name: 'web-templates/content/Content.webtemplate.source.html',
              sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
              sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              name: 'web-files/app.js.webfile.yml',
              sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
            },
            { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
            {
              name: 'table-permissions/contact.tablepermission.yml',
              sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
            },
          ],
          ownedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
          isolatedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
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
            baselineId: 'mirage/test/import-render.test.mjs:224:0',
            title: 'portal date formats support single numeric tokens and literal text',
          },
        ],
        casesSha256: '9e4fddf81b681a4edc7649e98a3a1ce684109cb1268dfa673c4edc0b4e07318a',
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
              id: 'native-original-context-001',
              pointer: '/captures/0/cases/0/facts',
              sha256: 'ccfc03c9b206399314d19641918c3411a3b7babbaf9f01c1ca04f658ce2eec64',
              replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
            },
            {
              id: 'native-original-context-002',
              pointer: '/captures/0/cases/1/facts',
              sha256: 'e50657fab2defefd6ddc0bff5739169be102aed623e04214cbc7ea7029798433',
              replicatedPointers: ['/captures/0/cases/1/facts', '/captures/1/cases/1/facts'],
            },
            {
              id: 'native-original-context-003',
              pointer: '/captures/0/cases/2/facts',
              sha256: '3e443df71cf658cec9c07c9077bff673e0152fd48e38b4cc24d603c44dd422b1',
              replicatedPointers: ['/captures/0/cases/2/facts', '/captures/1/cases/2/facts'],
            },
            {
              id: 'native-original-context-004',
              pointer: '/captures/0/cases/3/facts',
              sha256: '0f2d2fcfc189daffc760bf5943d721a6398189b86b0689e7400cc46cbc2d78b6',
              replicatedPointers: ['/captures/0/cases/3/facts', '/captures/1/cases/3/facts'],
            },
          ],
        },
      ],
    },
  ]);
  const renderer = createPortalRenderer(await importPortal(await fixture(t, standard)));
  assert.equal(
    await renderer.renderString('{{ value | date: "dd/M/yyyy" }}', {
      value: '2026-01-02',
    }),
    '02/1/2026',
  );
  assert.equal(
    await renderer.renderString('{{ value | date: "d/M/yyyy" }}', {
      value: '2026-01-02',
    }),
    '2/1/2026',
  );
  assert.equal(
    await renderer.renderString(`{{ value | date: "yyyy 'year' MM 'month' dd" }}`, { value: '2026-01-02' }),
    '2026 year 01 month 02',
  );
  assert.equal(
    await renderer.renderString('{{ value | date: "g" }}', {
      value: '2026-01-02T00:00:00',
    }),
    '1/2/2026 12:00 AM',
  );
});

test('standard PAC names, language copy, URL, annotation attachment, and rendered shell', async (t) => {
  const dir = await fixture(t, standard);
  const portal = await importPortal(dir);
  assert.equal(portal.format, 'standard');
  assert.equal(portal.pages.length, 2);
  assert.equal(portal.snippets.Greeting, 'Hello');
  assert.equal(portal.templates.Content.source, "{% include 'Page Copy' %}");
  assert.equal(portal.webFiles[0].url, '/renamed.js');
  assert.equal(path.basename(portal.webFiles[0].file), 'app.js');
  assert.equal(portal.records.find((r) => r.kind === 'tablepermission').id, 'permission');
  const rendered = await createPortalRenderer(portal).renderPage('/work/?item=%3Cinput%3E', {
    now: new Date('2026-01-01'),
  });
  assert.equal(rendered.status, 200);
  // The platform layout's <html> also carries crm-lang, crm-lcid, data-lang and same-site-mode.
  assert.match(
    rendered.html,
    /<html lang="en-US" dir="ltr" crm-lang="en-US" crm-lcid="1033" data-lang="en-US" same-site-mode="None">/,
  );
  assert.match(rendered.html, /<header>Hello<\/header>/);
  assert.match(rendered.html, /<p>Page body &lt;input&gt;<\/p>/);
  // Authored footer markup is served unchanged; the local overlap repair
  // (lib/footer-spacing-compat.js) is part of the app bundle's local equivalent.
  assert.match(rendered.html, /<footer>2026<\/footer>/);
  assert.doesNotMatch(rendered.html, /data-sim-footer-spacing/);
  // The platform's after-footer bundles follow the footer; the page script comes last.
  assert.match(
    rendered.html,
    /<footer>2026<\/footer>(?:<script(?: onerror="[^"]*")? src="\/resource\/powerappsportal\/dist\/[^"]+"[^>]*><\/script>){4}<script>window\.work = true;[\s\S]*?<\/script><\/body>/,
  );
  assert.doesNotMatch(rendered.html, /\/__sim-static\//);
  assert.match(rendered.html, /\.work \{color: red\}/);
  assert.equal(rendered.page.title, 'Work title');
  // The minimal export has no "Page Copy" web template; the runtime template is used and reported.
  assert.deepEqual(
    rendered.diagnostics.map((d) => d.code),
    ['liquid-managed-template-source'],
  );
});

test('omitted basic form mode imports the documented Insert default', async (t) => {
  const dir = await fixture(t, {
    ...standard,
    'basic-forms/create/Create.basicform.yml':
      'adx_entityformid: create\nadx_name: Create\nadx_entityname: contact\nadx_formname: Main',
  });
  const portal = await importPortal(dir);
  assert.equal(portal.forms[0].mode, 100000000);
});

function component(id, type, name, content, extra = '') {
  const encode = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<powerpagecomponent powerpagecomponentid="${id}"><content>${encode(JSON.stringify(content))}</content><name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>0</statecode>${extra}</powerpagecomponent>`;
}
test('enhanced PAC components decode JSON/XML once and preserve sibling fields', async (t) => {
  const dir = await fixture(t, {
    'Assets/powerpagesites.xml':
      '<powerpagesites><powerpagesite powerpagesiteid="site"><content>{"headerwebtemplateid":"header"}</content><name>Enhanced</name></powerpagesite></powerpagesites>',
    'powerpagecomponents/home/powerpagecomponent.xml': component('home', 2, 'Home', {
      isroot: true,
      partialurl: '/',
      pagetemplateid: 'main',
    }),
    'powerpagecomponents/work/powerpagecomponent.xml': component('work', 2, 'Work', {
      isroot: true,
      parentpageid: 'home',
      partialurl: 'work',
      pagetemplateid: 'main',
    }),
    'powerpagecomponents/lang/powerpagecomponent.xml': component('lang', 2, 'Work', {
      isroot: false,
      rootwebpageid: 'work',
      copy: '<p>{{snippets["Greeting"]}}</p>',
      customcss: '.exact{color:blue}',
      customjavascript: 'window.enhanced = 1;',
    }),
    'powerpagecomponents/main/powerpagecomponent.xml': component('main', 6, 'Main', {
      webtemplateid: 'body',
      usewebsiteheaderandfooter: false,
    }),
    'powerpagecomponents/body/powerpagecomponent.xml': component('body', 8, 'Body', {
      source: "{% include 'Page Copy' %}",
    }),
    'powerpagecomponents/snippet/powerpagecomponent.xml': component('snippet', 7, 'Greeting', {
      value: 'A & B <span>ok</span>',
    }),
    'powerpagecomponents/file/powerpagecomponent.xml': component(
      'file',
      3,
      'app.js',
      { parentpageid: 'home', partialurl: 'app.js' },
      '<filecontent mimetype="application/javascript">app.js</filecontent>',
    ),
    'powerpagecomponents/file/filecontent/app.js': 'window.enhancedAsset = 1;',
    'powerpagecomponents/shortcut/powerpagecomponent.xml': component('shortcut', 32, 'Work shortcut', {
      parentpage_webpageid: 'home',
      webpageid: 'work',
      title: 'Shortcut title',
      displayorder: 2,
    }),
  });
  const portal = await importPortal(dir);
  assert.equal(portal.format, 'enhanced');
  assert.equal(portal.website.name, 'Enhanced');
  assert.equal(portal.webFiles[0].url, '/app.js');
  assert.deepEqual(
    portal.shortcuts.map((item) => ({ url: item.url, title: item.title })),
    [{ url: '/work/', title: 'Shortcut title' }],
  );
  const r = await createPortalRenderer(portal).renderPage('/work/');
  assert.equal(r.status, 200);
  assert.match(r.html, /<p>A & B <span>ok<\/span><\/p>/);
  assert.match(r.html, /window.enhanced = 1/);
  assert.match(r.html, /exact\{color:blue/);
  assert.equal(portal.records.find((x) => x.id === 'lang').customjavascript, 'window.enhanced = 1;');
});

test('sitemap shortcuts expose hidden targets in display order while retaining target page permissions', async (t) => {
  const dir = await fixture(t, {
    ...standard,
    'shortcut.yml':
      '- adx_shortcutid: home-link\n  adx_parentpage_webpageid: home\n  adx_webpageid: home\n  adx_name: Homepage\n  adx_displayorder: 2\n- adx_shortcutid: work-link\n  adx_parentpage_webpageid: home\n  adx_webpageid: work\n  adx_name: Hidden target\n  adx_title: Work shortcut\n  adx_displayorder: 1',
    'web-pages/work/content-pages/Work.en-US.webpage.yml':
      standard['web-pages/work/content-pages/Work.en-US.webpage.yml'] + '\nadx_hiddenfromsitemap: true',
    'webrole.yml': '- adx_webroleid: reader\n  adx_name: Reader',
    'webpageaccesscontrolrule.yml':
      '- adx_webpageaccesscontrolruleid: protect\n  adx_webpageid: work\n  adx_right: 2\n  adx_webpageaccesscontrolrule_webrole:\n  - reader',
  });
  const portal = await importPortal(dir),
    renderer = createPortalRenderer(portal);
  const root = portal.pages.find((p) => p.id === 'home');
  const denied = renderer.contextForPage(root, '/', {
    user: { id: 'user', roles: [] },
  });
  assert.deepEqual(
    denied.sitemap.root.children.map((p) => p.id),
    ['home-link'],
  );
  const allowed = renderer.contextForPage(root, '/', {
    user: { id: 'user', roles: ['Reader'] },
  });
  assert.deepEqual(
    allowed.sitemap.root.children.map((p) => p.id),
    ['work-link', 'home-link'],
  );
  assert.equal(allowed.sitemap.root.children[0].url, '/work/');
  assert.equal(allowed.sitemap.root.children[0].title, 'Work shortcut');
  assert.equal(allowed.sitemap.root.children[0].name, 'Work shortcut');
  assert.equal(allowed.sitemap.root.children[0].internalName, 'Hidden target');
  assert.equal(allowed.sitemap.root.children[1].title, root.title);
});

test('fetchxml variables, async entities, roles, include parameters, inheritance and elseif', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.templates.Layout = {
    source: '<article>{% block main %}default{% endblock %}</article>',
  };
  portal.templates.Child = {
    source: "{% extends 'Layout' %}{% block main %}{% include 'Row' label: 'Output' %}{% endblock %}",
  };
  portal.templates.Row = {
    source: '{{label}}:{{entities.contact[request.params.id].fullname}}',
  };
  let xmlReceived;
  const renderer = createPortalRenderer(portal, {
    fetchXml: async (xml, user) => {
      xmlReceived = xml;
      assert.equal(user.id, 'contact-user');
      return { entities: [{ name: 'Alpha' }], total_record_count: 1 };
    },
    entity: async (table, id) => {
      assert.equal(table, 'contact');
      assert.equal(id, '0c4f7a1e-5b6d-4e3f-9a8b-7c6d5e4f3a2b');
      return { fullname: 'Ada' };
    },
  });
  // entities[table][id] loads records only for GUID keys (EntitySetDrop).
  const context = renderer.contextForPage(portal.pages[1], '/work/?id=0c4f7a1e-5b6d-4e3f-9a8b-7c6d5e4f3a2b', {
    user: { id: 'contact-user', roles: ['Reader'] },
  });
  assert.equal(
    await renderer.renderString(
      "{% fetchxml found %}<fetch><entity name='contact'><filter><condition attribute='contactid' operator='eq' value='{{user.id}}' /></filter></entity></fetch>{% endfetchxml %}{% for item in found.results.entities %}{{item.name}}{% endfor %}|{{found.results.total_record_count}}",
      context,
    ),
    'Alpha|1',
  );
  assert.match(xmlReceived, /value='contact-user'/);
  assert.equal(await renderer.renderString("{% include 'Child' %}", context), '<article>Output:Ada</article>');
  assert.equal(
    await renderer.renderString(
      "{% assign reader=user | has_role:'Reader' %}{% if reader %}yes{% elseif false %}no{% endif %}",
      context,
    ),
    'yes',
  );
});

test('render diagnostics expose unsupported tags and filters instead of reporting coverage', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  // DotLiquid returns the input of an unknown filter unchanged; the admin still sees it.
  portal.templates.Content.source = '<p>{{ 1 | unsupported_filter }}</p>';
  let r = await createPortalRenderer(portal).renderPage('/work/');
  assert.equal(r.status, 200);
  assert.match(r.html, /<p>1<\/p>/);
  assert.equal(r.diagnostics[0].code, 'liquid-unknown-filter');
  assert.equal(r.diagnostics[0].filter, 'unsupported_filter');
  portal.templates.Content.source = '{% entityform name: "Unavailable" %}';
  r = await createPortalRenderer(portal).renderPage('/work/');
  assert.equal(r.diagnostics[0].code, 'unsupported-platform-component');
  // A template that fails to parse is replaced by the bare parser message.
  portal.templates.Content.source = 'before{% unknown_portal_tag %}after';
  r = await createPortalRenderer(portal).renderPage('/work/');
  assert.equal(r.status, 200);
  // Platform chrome (antiforgery holder, platform bundles, native controls root) surrounds the content.
  assert.match(
    r.html,
    /<header>Hello<\/header>(?:<div[^>]*><\/div>|<script(?: onerror="[^"]*"| defer="defer")? src="\/resource\/powerappsportal\/[^"]+"[^>]*><\/script>)*Unknown tag 'unknown_portal_tag'(?:<div[^>]*><\/div>|<script(?: onerror="[^"]*"| defer="defer")? src="\/resource\/powerappsportal\/[^"]+"[^>]*><\/script>)*<footer>/,
  );
  assert.equal(r.diagnostics[0].code, 'liquid-syntax-error');
  assert.match(r.diagnostics[0].message, /unknown_portal_tag/);
});

test('nested snippet Liquid, member assignments, null user, and Power Pages filter tolerance', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.snippets.Greeting = '{% if user %}Member{% else %}Visitor{% endif %} {{snippets["Second"]}}';
  portal.snippets.Second = '{{page.title}}';
  const renderer = createPortalRenderer(portal);
  const context = renderer.contextForPage(portal.pages[1], '/work/', {
    user: { id: null, roles: ['Anonymous Users'] },
  });
  assert.equal(context.user, null);
  assert.equal(context.page.adx_entityform, null);
  assert.equal(await renderer.renderString('{{ snippets["Greeting"] }}', context), 'Visitor Work title');
  // DotLiquid assign names a variable "page.title"; it does not change the page drop.
  assert.equal(
    await renderer.renderString('{% assign page.title = "Changed" %}{{page.title}}|{{ [\'page.title\'] }}', context),
    'Work title|Changed',
  );
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/import-render.test.mjs:473:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '94116b9f78c070017f920e44ce13b45ed28169ffff7872b0c7d83d208cf6440e',
        originalAssertions: [
          '3934850faefaa0635ac8ea6c81182d12f6f5a12b25ad7dfeb82d3346b256e380',
          '990f9b37945ccb6036eae0214be44dbc399e6829a199437db9d96a321aca5fa0',
          '6ee4b13facc397e5c6bea05bb78bee2a3934e2ed46b2346ca239473c4a42b3c0',
          '8bc62eb047907acbbf73263a2d2b64253cfc632cf02a63496a53c0ce17821b1c',
          'fceaf3b8619b509b475359679dcb127836507aae6e73b50c77140bf69b01d7d6',
          '572c5ff83a86c93f71d774dd61b57528c81d8579652dbe29aacd143b85ff4594',
          '81960565a815cb46657175e5e824ca8ebe0fd4690801040a88cb5aa3accfdf38',
        ],
        originalBodyAstSha256: '02125ca841529b83fbc810fe71a387ef360a6e66d1d224e735c81522b85320e8',
        originalGuardHashes: [],
        moduleContextAstSha256: 'b171657ac710fbed9b33468c2b25cf366e6dd54854e646005a85890522416ccc',
        isolationRegistrationsAstSha256: '6b5bab04f8e5cd104845c490ce1484f4097704a7c8d33047d155347cf7c80c60',
        importRoles: [
          {
            source: '../lib/importer.mjs',
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
            source: '../lib/header-notification-capture.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/extensions.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/observed-pagecopy-layout.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/observed-snippet-composition.mjs',
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
        generatedFixtures: [
          {
            baselineId: 'mirage/test/import-render.test.mjs:473:0',
            producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
            mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
            allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
            helperPath: 'mirage/testing/owned-fixture.mjs',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            entries: [
              { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
              {
                name: 'web-pages/home/Home.webpage.yml',
                sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
              },
              {
                name: 'web-pages/work/Work.webpage.yml',
                sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
                sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
                sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
                sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
                sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
              },
              {
                name: 'page-templates/Main.pagetemplate.yml',
                sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
              },
              {
                name: 'web-templates/header/Header.webtemplate.yml',
                sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
              },
              {
                name: 'web-templates/header/Header.webtemplate.source.html',
                sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.yml',
                sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.source.html',
                sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
              },
              {
                name: 'web-templates/content/Content.webtemplate.yml',
                sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
              },
              {
                name: 'web-templates/content/Content.webtemplate.source.html',
                sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
                sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                name: 'web-files/app.js.webfile.yml',
                sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
              },
              { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
              {
                name: 'table-permissions/contact.tablepermission.yml',
                sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
              },
            ],
            ownedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
            isolatedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
          },
          {
            baselineId: 'mirage/test/import-render.test.mjs:768:0',
            producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
            mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
            allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
            helperPath: 'mirage/testing/owned-fixture.mjs',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            entries: [
              { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
              {
                name: 'web-pages/home/Home.webpage.yml',
                sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
              },
              {
                name: 'web-pages/work/Work.webpage.yml',
                sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
                sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
                sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
                sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
                sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
              },
              {
                name: 'page-templates/Main.pagetemplate.yml',
                sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
              },
              {
                name: 'web-templates/header/Header.webtemplate.yml',
                sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
              },
              {
                name: 'web-templates/header/Header.webtemplate.source.html',
                sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.yml',
                sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.source.html',
                sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
              },
              {
                name: 'web-templates/content/Content.webtemplate.yml',
                sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
              },
              {
                name: 'web-templates/content/Content.webtemplate.source.html',
                sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
                sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                name: 'web-files/app.js.webfile.yml',
                sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
              },
              { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
              {
                name: 'table-permissions/contact.tablepermission.yml',
                sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
              },
            ],
            ownedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
            isolatedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
          },
          {
            baselineId: 'mirage/test/import-render.test.mjs:787:0',
            producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
            mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
            allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
            helperPath: 'mirage/testing/owned-fixture.mjs',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            entries: [
              { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
              {
                name: 'web-pages/home/Home.webpage.yml',
                sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
              },
              {
                name: 'web-pages/work/Work.webpage.yml',
                sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
                sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
                sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
                sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
                sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
              },
              {
                name: 'page-templates/Main.pagetemplate.yml',
                sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
              },
              {
                name: 'web-templates/header/Header.webtemplate.yml',
                sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
              },
              {
                name: 'web-templates/header/Header.webtemplate.source.html',
                sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.yml',
                sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.source.html',
                sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
              },
              {
                name: 'web-templates/content/Content.webtemplate.yml',
                sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
              },
              {
                name: 'web-templates/content/Content.webtemplate.source.html',
                sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
                sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                name: 'web-files/app.js.webfile.yml',
                sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
              },
              { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
              {
                name: 'table-permissions/contact.tablepermission.yml',
                sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
              },
            ],
            ownedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
            isolatedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
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
              baselineId: 'mirage/test/import-render.test.mjs:473:0',
              title: 'nested snippet Liquid, member assignments, null user, and Power Pages filter tolerance',
            },
          ],
          casesSha256: '4e5c569f22e638bc0de0c499f258f92873904f2b369f9b9608e3bdc8390e2846',
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
                id: 'native-original-liquid-001',
                pointer: '/captures/0/cases/0/facts',
                sha256: '7b257c555210b32ad165bb11e18521a3b562f0b7d2076f2741098dfcecfa8b10',
                replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
              },
            ],
          },
        ],
        regionHashes: [['fceaf3b8619b509b475359679dcb127836507aae6e73b50c77140bf69b01d7d6']],
        regionFactIds: [[['native-original-liquid-001']]],
      },
    ]);
    assert.equal(
      await renderer.renderString(
        '{% capture value %}a\nb{% endcapture %}{% assign value = value | | strip_newlines %}{{value}}',
        context,
      ),
      'ab',
    );
  }
  // DotLiquid tags cannot span lines, even inside a quoted string.
  assert.equal(
    await renderer.renderString('{% assign value = "a\nb" %}{{value}}', context),
    'Tag \'{% assign value = "a\nb" %}\' was not properly terminated with regexp: (?-mix:\\%\\})',
  );
  assert.equal(
    await renderer.renderString('{% raw %}{% assign x = {{y}} %}{% endraw %}', context),
    '{% assign x = {{y}} %}',
  );
});

test('shell profile preserves captured dependency phases around source content and footer', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  const renderer = createPortalRenderer(portal, {
    shellProfile: {
      stylesheets: ['/resource/font-awesome.css', '/bootstrap.min.css'],
      headScripts: ['/scripts/jquery.min.js'],
      beforeContentScripts: ['/resource/jquery-ui.min.js'],
      bodyScripts: ['/resource/legacy-before-footer.js'],
      afterFooterScripts: ['/resource/bootstrap.bundle.js'],
    },
  });
  const result = await renderer.renderPage('/work/');
  assert.equal(result.status, 200);
  // Each marker is present (indexOf -1 would pass a bare comparison) and the phases keep their order.
  const at = (marker) => {
    const index = result.html.indexOf(marker);
    assert.notEqual(index, -1, `${marker} is rendered`);
    return index;
  };
  assert.ok(at('/resource/font-awesome.css') < at('/bootstrap.min.css'));
  assert.ok(at('/scripts/jquery.min.js') < at('<body '));
  assert.ok(at('<body ') < at('/resource/jquery-ui.min.js'));
  assert.ok(at('/resource/jquery-ui.min.js') < at('/resource/legacy-before-footer.js'));
  assert.ok(at('/resource/legacy-before-footer.js') < at('<footer>'));
  assert.ok(at('</footer>') < at('/resource/bootstrap.bundle.js'));
  // The authored footer is not annotated; the local footer-spacing repair is part of the
  // platform app bundle's local equivalent, which follows the captured after-footer phase.
  assert.match(result.html, /<footer>2026<\/footer>/);
  assert.doesNotMatch(result.html, /\/__sim-static\//);
  assert.equal(result.html.split('/resource/powerappsportal/dist/app.bundle-').length, 2);
  assert.ok(at('/resource/bootstrap.bundle.js') < at('/resource/powerappsportal/dist/app.bundle-'));
  assert.equal(renderer.inspectCapabilities().diagnostics.length, 0);
  const invalid = await createPortalRenderer(portal, {
    shellProfile: { headScripts: ['javascript:alert(1)'] },
  }).renderPage('/work/');
  assert.equal(invalid.status, 500);
});

test('deployment profile changes values in memory and preserves source and navigation child flags', async (t) => {
  const dir = await fixture(t, {
    ...standard,
    'deployment-profiles/sandbox.deployment.yml':
      'adx_contentsnippet:\n- adx_contentsnippetid: greeting\n  adx_name: RenamedGreeting\n  adx_value: true\nadx_webtemplate:\n- adx_webtemplateid: content\n  adx_source: "{{snippets[\'Greeting\']}}"',
    'weblink-sets/nav/Nav.weblinkset.yml': 'adx_weblinksetid: nav\nadx_name: Primary Navigation',
    'weblink-sets/nav/Nav.weblinkset.weblink.yml':
      '- adx_weblinkid: home-link\n  adx_name: Home\n  adx_pageid: home\n  adx_weblinksetid: nav\n  adx_displaypagechildlinks: true\n  adx_openinnewwindow: true',
  });
  const original = await fs.readFile(
    path.join(dir, 'content-snippets/greeting/Greeting.contentsnippet.value.html'),
    'utf8',
  );
  const portal = await importPortal(dir, { deploymentProfile: 'sandbox' });
  assert.equal(portal.snippets.Greeting, 'true');
  assert.equal(portal.snippets.RenamedGreeting, 'true');
  assert.ok(portal.diagnostics.some((d) => d.code === 'DEPLOYMENT_PROFILE_SNIPPET_NAME_ALIAS'));
  assert.equal(portal.profileChanges.length, 2);
  assert.equal(portal.templates.Content.source, "{{snippets['Greeting']}}");
  assert.equal(
    await fs.readFile(path.join(dir, 'content-snippets/greeting/Greeting.contentsnippet.value.html'), 'utf8'),
    original,
  );
  const link = portal.weblinks['Primary Navigation'].weblinks[0];
  assert.equal(link.display_page_child_links, true);
  assert.equal(link.Open_In_New_Window, true);
  const renderer = createPortalRenderer(portal);
  const ctx = renderer.contextForPage(portal.pages[1]);
  assert.equal(ctx.sitemap['/'].children[0].url, '/work/');
  await assert.rejects(() => importPortal(dir, { deploymentProfile: 'missing' }), /absent/);
});

test('Power Pages numeric request equality and no-header template MIME preserve AJAX semantics', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  const renderer = createPortalRenderer(portal);
  assert.equal(
    await renderer.renderString(
      "{% case item.order %}{% when '1' %}pill{% when '2', '3' %}package{% else %}other{% endcase %}",
      { item: { order: 1 } },
    ),
    'pill',
  );
  assert.equal(
    await renderer.renderString(
      "{% case item.order %}{% when '1' %}pill{% when '2', '3' %}package{% else %}other{% endcase %}",
      { item: { order: 3 } },
    ),
    'package',
  );
  assert.equal(
    await renderer.renderString(
      "{% case item.order %}{% when 1 %}first{% when 'unrelated' %}second{% else %}other{% endcase %}",
      { item: { order: 'unrelated' } },
    ),
    'second',
  );
  assert.equal(
    await renderer.renderString(
      '{% assign count = request.params.count | liquid %}{% if count == 0 %}total{% else %}rows{% endif %}',
      { request: { params: { count: '0' } } },
    ),
    'total',
  );
  assert.equal(
    await renderer.renderString('{% if request.params.count != 0 %}rows{% endif %}', {
      request: { params: { count: '10' } },
    }),
    'rows',
  );
  portal.pageTemplates[0].useHeaderFooter = false;
  portal.templates.Content.source = '{"totalCount":1}';
  let result = await renderer.renderPage('/work/');
  assert.equal(result.contentType, 'text/html; charset=utf-8');
  assert.equal(result.isDocument, false);
  portal.templates.Content.metadata.adx_mimetype = 'application/json;';
  result = await renderer.renderPage('/work/');
  assert.equal(result.contentType, 'application/json; charset=utf-8');
});

// @test-kind parity: Both fresh native source-bound include rounds reproduce every unchanged original literal result/error assertion in this registration; automatic actual-context replay matches exactly.
// @parity-evidence: Manifest guarantee existing-liquid-import-render-test-mjs-624-0; exact capsule/run/fact/source bindings are asserted below.
test('Liquid syntax repairs preserve quoted filter-like string values', async (t) => {
  // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/import-render.test.mjs:624:0',
      repositoryRoot: '../..',
      titleExpressionSha256: 'e1fe97739a4e7a575d525731c06a74201d103560ad7f44343bd4b0d3565be7da',
      originalAssertions: ['5be8fc2e343a13ce4cf908d569e7221c525ecb043542ca962d10288f823bf8ae'],
      originalBodyAstSha256: '493e7e8fbd824dd3c574e956d379428db0e6e1e3f02ca4b76c33a0469301bb98',
      originalGuardHashes: [],
      moduleContextAstSha256: 'b171657ac710fbed9b33468c2b25cf366e6dd54854e646005a85890522416ccc',
      isolationRegistrationsAstSha256: '6b5bab04f8e5cd104845c490ce1484f4097704a7c8d33047d155347cf7c80c60',
      importRoles: [
        {
          source: '../lib/importer.mjs',
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
          source: '../lib/header-notification-capture.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/extensions.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/observed-pagecopy-layout.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/observed-snippet-composition.mjs',
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
      generatedFixtures: [
        {
          baselineId: 'mirage/test/import-render.test.mjs:224:0',
          producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
          mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
          allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
          helperPath: 'mirage/testing/owned-fixture.mjs',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          entries: [
            { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
            {
              name: 'web-pages/home/Home.webpage.yml',
              sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
            },
            {
              name: 'web-pages/work/Work.webpage.yml',
              sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
              sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
              sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
              sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
              sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
            },
            {
              name: 'page-templates/Main.pagetemplate.yml',
              sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
            },
            {
              name: 'web-templates/header/Header.webtemplate.yml',
              sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
            },
            {
              name: 'web-templates/header/Header.webtemplate.source.html',
              sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.yml',
              sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.source.html',
              sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
            },
            {
              name: 'web-templates/content/Content.webtemplate.yml',
              sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
            },
            {
              name: 'web-templates/content/Content.webtemplate.source.html',
              sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
              sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              name: 'web-files/app.js.webfile.yml',
              sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
            },
            { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
            {
              name: 'table-permissions/contact.tablepermission.yml',
              sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
            },
          ],
          ownedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
          isolatedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
        },
        {
          baselineId: 'mirage/test/import-render.test.mjs:624:0',
          producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
          mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
          allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
          helperPath: 'mirage/testing/owned-fixture.mjs',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          entries: [
            { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
            {
              name: 'web-pages/home/Home.webpage.yml',
              sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
            },
            {
              name: 'web-pages/work/Work.webpage.yml',
              sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
              sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
              sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
              sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
              sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
            },
            {
              name: 'page-templates/Main.pagetemplate.yml',
              sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
            },
            {
              name: 'web-templates/header/Header.webtemplate.yml',
              sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
            },
            {
              name: 'web-templates/header/Header.webtemplate.source.html',
              sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.yml',
              sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.source.html',
              sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
            },
            {
              name: 'web-templates/content/Content.webtemplate.yml',
              sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
            },
            {
              name: 'web-templates/content/Content.webtemplate.source.html',
              sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
              sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              name: 'web-files/app.js.webfile.yml',
              sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
            },
            { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
            {
              name: 'table-permissions/contact.tablepermission.yml',
              sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
            },
          ],
          ownedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
          isolatedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
        },
        {
          baselineId: 'mirage/test/import-render.test.mjs:830:0',
          producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
          mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
          allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
          helperPath: 'mirage/testing/owned-fixture.mjs',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          entries: [
            { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
            {
              name: 'web-pages/home/Home.webpage.yml',
              sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
            },
            {
              name: 'web-pages/work/Work.webpage.yml',
              sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
              sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
              sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
              sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
              sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
            },
            {
              name: 'page-templates/Main.pagetemplate.yml',
              sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
            },
            {
              name: 'web-templates/header/Header.webtemplate.yml',
              sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
            },
            {
              name: 'web-templates/header/Header.webtemplate.source.html',
              sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.yml',
              sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.source.html',
              sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
            },
            {
              name: 'web-templates/content/Content.webtemplate.yml',
              sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
            },
            {
              name: 'web-templates/content/Content.webtemplate.source.html',
              sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
              sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              name: 'web-files/app.js.webfile.yml',
              sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
            },
            { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
            {
              name: 'table-permissions/contact.tablepermission.yml',
              sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
            },
          ],
          ownedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
          isolatedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
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
            baselineId: 'mirage/test/import-render.test.mjs:624:0',
            title: 'Liquid syntax repairs preserve quoted filter-like string values',
          },
        ],
        casesSha256: '9bbdc73b92f8c8cd0a2ff9134852804f89868d375e62938f9da215188ccd20df',
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
              id: 'native-original-liquid-003',
              pointer: '/captures/0/cases/2/facts',
              sha256: '3526195f64eb814c90f39ac2acc78de9a5e2a2fe9eeb59999ba1428bb92fac8a',
              replicatedPointers: ['/captures/0/cases/2/facts', '/captures/1/cases/2/facts'],
            },
          ],
        },
      ],
    },
  ]);
  const portal = await importPortal(await fixture(t, standard));
  const renderer = createPortalRenderer(portal);
  const result = await renderer.renderString(
    '{% assign literal = "| | date:%Y, (value) | thing=abc" %}{{ literal }}',
    {},
  );
  assert.equal(result, '| | date:%Y, (value) | thing=abc');
});

test('platform poll placements render the embedded placeholder and the poll service selects by state and dates', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.records.push(
    {
      kind: 'pollplacement',
      id: 'sidebar',
      name: 'Sidebar',
      adx_pollplacement_poll: ['poll'],
    },
    {
      kind: 'poll',
      id: 'poll',
      name: 'Question',
      adx_active: false,
      adx_question: 'Which option?',
    },
    { kind: 'polloption', id: 'yes', name: 'Yes', adx_pollid: 'poll' },
  );
  const renderer = createPortalRenderer(portal);
  const ctx = renderer.contextForPage(portal.pages[1]);
  // The embedded poll template (random_poll) renders the placeholder the poll service fills.
  assert.match(
    await renderer.renderString('{% include "poll" poll_placement_name:"Sidebar" %}', ctx),
    /<div class="poll" data-url="\/_services\/polls\/[^/]*\/placements\/sidebar\/random" data-submit-url="\/_services\/polls\/[^/]*\/SubmitPoll\?id=sidebar"><\/div>/,
  );
  assert.deepEqual(ctx.__diagnostics, []);
  const service = '{% assign poll_placement_name = "Sidebar" %}{% mirage_poll %}';
  const served = await renderer.renderString(service, renderer.contextForPage(portal.pages[1]));
  assert.match(served, /<div class="poll-questionpanel" data-id="poll" data-name="Question">/);
  assert.match(served, /Which option\?/);
  portal.records.find((r) => r.kind === 'poll').statecode = 1;
  assert.equal((await renderer.renderString(service, renderer.contextForPage(portal.pages[1]))).trim(), '');
  // side_navigation is the embedded runtime template (EmbeddedResourceFileSystem).
  const navigation = await renderer.renderString(
    '{% include "side_navigation" %}',
    renderer.contextForPage(portal.pages[0]),
  );
  assert.match(navigation, /<ul class="side-nav" role="navigation">/);
  assert.match(navigation, /<li class="active">\s*<a href="\/" title="Home">/);
  assert.match(navigation, /<a href="\/work\/" title="Work title">/);
});

test('include names resolve web templates case-insensitively before embedded runtime templates', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.templates['Side Navigation'] = {
    name: 'Side Navigation',
    source:
      '<nav data-exported>{{ page.parent.title }}:{% for item in page.parent.children %}{{item.title}}{% endfor %}</nav>',
  };
  const renderer = createPortalRenderer(portal),
    ctx = renderer.contextForPage(portal.pages[1]);
  // adx_name lookup is a Dataverse string comparison (case-insensitive).
  assert.equal(
    await renderer.renderString('{% include "side navigation" %}', ctx),
    '<nav data-exported>Home:Work title</nav>',
  );
  // The snake_case runtime name does not match the display name of the web template.
  assert.match(
    await renderer.renderString('{% include "side_navigation" %}', ctx),
    /<ul class="side-nav" role="navigation">/,
  );
});

test('observed shell profile retains resource loading attributes safely', () => {
  assert.equal(
    renderShellResource({ href: '/print.css', media: 'print' }, 'css'),
    '<link rel="stylesheet" href="/print.css" media="print">',
  );
  assert.equal(
    renderShellResource({ src: '/module.js', defer: true, async: true, type: 'module' }, 'js'),
    '<script src="/module.js" defer async type="module"></script>',
  );
  assert.throws(() => renderShellResource({ src: '/data.js', type: 'application/json' }, 'js'), /Unsupported/);
  assert.throws(() => renderShellResource('//other/script.js', 'js'), /paths/);
  assert.throws(
    () =>
      renderShellResource('https://example.com/script.js', 'js', {
        localOnly: true,
      }),
    /paths/,
  );
});

test('browser title suffix renders exported Liquid and retains entities without allowing markup', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.snippets['Browser Title Suffix'] = '&nbsp;· {{ website.name }} </title><script>alert(1)</script>';
  const result = await createPortalRenderer(portal).renderPage('/work/');
  assert.match(
    result.html,
    /<title>Work title &nbsp;· Test &lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/,
  );
});

test('metadata-only managed Page Copy renders source scripts and custom templates own landmarks', async (t) => {
  const files = {
    ...standard,
    'web-templates/page-copy/Page-Copy.webtemplate.yml': 'adx_webtemplateid: managed-copy\nadx_name: Page Copy',
    'web-templates/content/Content.webtemplate.source.html':
      "<div class='page-header'>Header</div><main id='mainContent'>{% include 'Page Copy' %}</main>",
  };
  const portal = await importPortal(await fixture(t, files));
  portal.pages.find((p) => p.url === '/work/').html =
    '<script defer src="/scripts/master.js"></script><p>Source copy</p>';
  const result = await createPortalRenderer(portal).renderPage('/work/');
  assert.match(result.html, /<script defer src="\/scripts\/master.js"><\/script>/);
  assert.equal((result.html.match(/id=['"]mainContent['"]/g) ?? []).length, 1);
  // The platform layout's <body> carries data-sitemap-state and the DateTime/* attributes.
  assert.match(
    result.html,
    /<body data-sitemap-state="\/work\/:\/"[^>]*>[\s\S]*?<header>Hello<\/header>(?:<div id="antiforgerytoken"[^>]*><\/div>)?(?:<script(?: onerror="[^"]*")? src="\/resource\/powerappsportal\/dist\/[^"]+"[^>]*><\/script>){6}<div class='page-header'>/,
  );
});

test('inherited DataTable layout treats missing components as nil and preserves blank/empty comparisons', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.templates['DataTable Tabs'] = {
    source:
      '{% block variables %}{% endblock %}{% for name in panels %}{% if entityForm != null and entityForm != "" %}{% entityform name: entityForm %}{% else %}<table id="{{name}}"></table>{% endif %}{% endfor %}',
  };
  const renderer = createPortalRenderer(portal);
  const html = await renderer.renderString(
    '{% extends "DataTable Tabs" %}{% block variables %}{% assign panels="draft,all"|split:"," %}{% endblock %}',
    {},
  );
  assert.equal(html, '<table id="draft"></table><table id="all"></table>');
  assert.equal(
    await renderer.renderString(
      '{% if missing == nil %}nil{% endif %}{% if values == empty %}empty{% endif %}{% if whitespace == blank %}blank{% endif %}',
      { values: [], whitespace: '  ' },
    ),
    'nilemptyblank',
  );
});

test('query filters preserve relative navigation paths and fragment spelling', async (t) => {
  const renderer = createPortalRenderer(await importPortal(await fixture(t, standard)));
  assert.equal(
    await renderer.renderString(
      '{{ "itemselection/#step" | add_query: "id", "record" | add_query: "orderId", 1 }}',
      {},
    ),
    'itemselection/?id=record&orderId=1#step',
  );
  assert.equal(
    await renderer.renderString('{{ "../details/?id=record&keep=x#section" | remove_query: "id" }}', {}),
    '../details/?keep=x#section',
  );
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/import-render.test.mjs:768:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '3defb294e25df87446de5dcfe9296bff7db6db97f546ebaf08a13f7039d76ea3',
        originalAssertions: [
          '3c666697ad30993d40e9166026d4378e57a8198cf8c9de68098834599f4b0261',
          'c93da69d7225e033df17741a0e230406c732e4565728d3ab96e9e2ebca047479',
          '50e2c94a65214524832fce93358f23dd84be1c6e1d61736a3a715e303398b607',
        ],
        originalBodyAstSha256: '8ac7532d80961c754511addbe65c407a689b4a39b607b286d8fcc5b6cb59e576',
        originalGuardHashes: [],
        moduleContextAstSha256: 'b171657ac710fbed9b33468c2b25cf366e6dd54854e646005a85890522416ccc',
        isolationRegistrationsAstSha256: '6b5bab04f8e5cd104845c490ce1484f4097704a7c8d33047d155347cf7c80c60',
        importRoles: [
          {
            source: '../lib/importer.mjs',
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
            source: '../lib/header-notification-capture.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/extensions.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/observed-pagecopy-layout.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/observed-snippet-composition.mjs',
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
        generatedFixtures: [
          {
            baselineId: 'mirage/test/import-render.test.mjs:473:0',
            producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
            mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
            allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
            helperPath: 'mirage/testing/owned-fixture.mjs',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            entries: [
              { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
              {
                name: 'web-pages/home/Home.webpage.yml',
                sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
              },
              {
                name: 'web-pages/work/Work.webpage.yml',
                sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
                sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
                sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
                sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
                sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
              },
              {
                name: 'page-templates/Main.pagetemplate.yml',
                sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
              },
              {
                name: 'web-templates/header/Header.webtemplate.yml',
                sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
              },
              {
                name: 'web-templates/header/Header.webtemplate.source.html',
                sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.yml',
                sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.source.html',
                sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
              },
              {
                name: 'web-templates/content/Content.webtemplate.yml',
                sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
              },
              {
                name: 'web-templates/content/Content.webtemplate.source.html',
                sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
                sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                name: 'web-files/app.js.webfile.yml',
                sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
              },
              { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
              {
                name: 'table-permissions/contact.tablepermission.yml',
                sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
              },
            ],
            ownedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
            isolatedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
          },
          {
            baselineId: 'mirage/test/import-render.test.mjs:768:0',
            producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
            mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
            allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
            helperPath: 'mirage/testing/owned-fixture.mjs',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            entries: [
              { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
              {
                name: 'web-pages/home/Home.webpage.yml',
                sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
              },
              {
                name: 'web-pages/work/Work.webpage.yml',
                sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
                sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
                sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
                sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
                sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
              },
              {
                name: 'page-templates/Main.pagetemplate.yml',
                sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
              },
              {
                name: 'web-templates/header/Header.webtemplate.yml',
                sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
              },
              {
                name: 'web-templates/header/Header.webtemplate.source.html',
                sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.yml',
                sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.source.html',
                sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
              },
              {
                name: 'web-templates/content/Content.webtemplate.yml',
                sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
              },
              {
                name: 'web-templates/content/Content.webtemplate.source.html',
                sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
                sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                name: 'web-files/app.js.webfile.yml',
                sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
              },
              { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
              {
                name: 'table-permissions/contact.tablepermission.yml',
                sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
              },
            ],
            ownedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
            isolatedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
          },
          {
            baselineId: 'mirage/test/import-render.test.mjs:787:0',
            producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
            mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
            allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
            helperPath: 'mirage/testing/owned-fixture.mjs',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            entries: [
              { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
              {
                name: 'web-pages/home/Home.webpage.yml',
                sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
              },
              {
                name: 'web-pages/work/Work.webpage.yml',
                sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
                sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
                sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
                sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
                sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
              },
              {
                name: 'page-templates/Main.pagetemplate.yml',
                sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
              },
              {
                name: 'web-templates/header/Header.webtemplate.yml',
                sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
              },
              {
                name: 'web-templates/header/Header.webtemplate.source.html',
                sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.yml',
                sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.source.html',
                sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
              },
              {
                name: 'web-templates/content/Content.webtemplate.yml',
                sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
              },
              {
                name: 'web-templates/content/Content.webtemplate.source.html',
                sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
                sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                name: 'web-files/app.js.webfile.yml',
                sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
              },
              { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
              {
                name: 'table-permissions/contact.tablepermission.yml',
                sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
              },
            ],
            ownedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
            isolatedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
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
              baselineId: 'mirage/test/import-render.test.mjs:768:0',
              title: 'query filters preserve relative navigation paths and fragment spelling',
            },
          ],
          casesSha256: '90ab4c8b0e3965d7a92f247444a6c4cd2822cd47348e3f6b33ac87aeda0393d5',
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
                id: 'native-original-liquid-006',
                pointer: '/captures/0/cases/5/facts',
                sha256: 'e9e24f0423e7b9322930b782bb79969fd046c6bd84dda00d69b72971cf5ca0fe',
                replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
              },
            ],
          },
        ],
        regionHashes: [['50e2c94a65214524832fce93358f23dd84be1c6e1d61736a3a715e303398b607']],
        regionFactIds: [[['native-original-liquid-006']]],
      },
    ]);
    assert.equal(
      await renderer.renderString('{{ "https://example.com/path/?id=old" | add_query: "id", "new" }}', {}),
      'https://example.com/path/?id=new',
    );
  }
});

test('DotLiquid path split and include variable casing select the authored creation header', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.templates.HeaderFlags = {
    source:
      '{% assign parts=request.path | split:"/" %}{% assign itemSelection=itemSelection %}{% if parts.size == 2 and parts[0] == "requests" and parts[1] == "new" %}<h1>Create new request</h1>{% endif %}<button style="display:{{itemSelection}}">Save</button>',
  };
  const renderer = createPortalRenderer(portal);
  assert.equal(
    await renderer.renderString('{% include "HeaderFlags" itemselection:"none" %}', {
      request: { path: '/requests/new/' },
    }),
    '<h1>Create new request</h1><button style="display:none">Save</button>',
  );
  assert.equal(
    await renderer.renderString(
      '{% assign Label="first" %}{% assign label="second" %}{{LABEL}} {{ dictionary.NAME }}',
      { dictionary: { Name: 'Source name' } },
    ),
    'second Source name',
  );
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/import-render.test.mjs:787:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'fbb1aa456297661821e1441926dfb475b3a6a438e734f2a1af9182fe6ea58df0',
        originalAssertions: [
          '4ee36aa27abf2e26045cf9f560ef8801599407adea03f30770fb4f6979cb1973',
          '16e45c984a49ea827833d72cb16dc99050a5f45557c3e7c5b4a929420262e731',
          '52595e1aca3721729f3028a58ecad9bb13fdd64be80606aa2694614f1dda6b8d',
        ],
        originalBodyAstSha256: '2a4c5eb0d58a3da9268897ba1a6496567cabee69a23df03d2b076d8e7a1a665b',
        originalGuardHashes: [],
        moduleContextAstSha256: 'b171657ac710fbed9b33468c2b25cf366e6dd54854e646005a85890522416ccc',
        isolationRegistrationsAstSha256: '6b5bab04f8e5cd104845c490ce1484f4097704a7c8d33047d155347cf7c80c60',
        importRoles: [
          {
            source: '../lib/importer.mjs',
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
            source: '../lib/header-notification-capture.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/extensions.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/observed-pagecopy-layout.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/observed-snippet-composition.mjs',
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
        generatedFixtures: [
          {
            baselineId: 'mirage/test/import-render.test.mjs:473:0',
            producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
            mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
            allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
            helperPath: 'mirage/testing/owned-fixture.mjs',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            entries: [
              { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
              {
                name: 'web-pages/home/Home.webpage.yml',
                sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
              },
              {
                name: 'web-pages/work/Work.webpage.yml',
                sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
                sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
                sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
                sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
                sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
              },
              {
                name: 'page-templates/Main.pagetemplate.yml',
                sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
              },
              {
                name: 'web-templates/header/Header.webtemplate.yml',
                sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
              },
              {
                name: 'web-templates/header/Header.webtemplate.source.html',
                sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.yml',
                sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.source.html',
                sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
              },
              {
                name: 'web-templates/content/Content.webtemplate.yml',
                sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
              },
              {
                name: 'web-templates/content/Content.webtemplate.source.html',
                sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
                sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                name: 'web-files/app.js.webfile.yml',
                sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
              },
              { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
              {
                name: 'table-permissions/contact.tablepermission.yml',
                sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
              },
            ],
            ownedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
            isolatedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
          },
          {
            baselineId: 'mirage/test/import-render.test.mjs:768:0',
            producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
            mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
            allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
            helperPath: 'mirage/testing/owned-fixture.mjs',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            entries: [
              { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
              {
                name: 'web-pages/home/Home.webpage.yml',
                sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
              },
              {
                name: 'web-pages/work/Work.webpage.yml',
                sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
                sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
                sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
                sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
                sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
              },
              {
                name: 'page-templates/Main.pagetemplate.yml',
                sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
              },
              {
                name: 'web-templates/header/Header.webtemplate.yml',
                sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
              },
              {
                name: 'web-templates/header/Header.webtemplate.source.html',
                sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.yml',
                sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.source.html',
                sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
              },
              {
                name: 'web-templates/content/Content.webtemplate.yml',
                sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
              },
              {
                name: 'web-templates/content/Content.webtemplate.source.html',
                sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
                sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                name: 'web-files/app.js.webfile.yml',
                sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
              },
              { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
              {
                name: 'table-permissions/contact.tablepermission.yml',
                sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
              },
            ],
            ownedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
            isolatedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
          },
          {
            baselineId: 'mirage/test/import-render.test.mjs:787:0',
            producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
            mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
            allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
            helperPath: 'mirage/testing/owned-fixture.mjs',
            helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
            entries: [
              { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
              {
                name: 'web-pages/home/Home.webpage.yml',
                sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
              },
              {
                name: 'web-pages/work/Work.webpage.yml',
                sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
                sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
                sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
                sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
              },
              {
                name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
                sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
              },
              {
                name: 'page-templates/Main.pagetemplate.yml',
                sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
              },
              {
                name: 'web-templates/header/Header.webtemplate.yml',
                sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
              },
              {
                name: 'web-templates/header/Header.webtemplate.source.html',
                sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.yml',
                sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
              },
              {
                name: 'web-templates/footer/Footer.webtemplate.source.html',
                sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
              },
              {
                name: 'web-templates/content/Content.webtemplate.yml',
                sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
              },
              {
                name: 'web-templates/content/Content.webtemplate.source.html',
                sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
                sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
              },
              {
                name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                name: 'web-files/app.js.webfile.yml',
                sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
              },
              { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
              {
                name: 'table-permissions/contact.tablepermission.yml',
                sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
              },
            ],
            ownedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
            ],
            isolatedReads: [
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
              {
                registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
                entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
                entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
              },
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
              baselineId: 'mirage/test/import-render.test.mjs:787:0',
              title: 'DotLiquid path split and include variable casing select the authored creation header',
            },
          ],
          casesSha256: '771b12cf654e128e51e2ef3f42167fb435d531f78c621efed42f1012742af04e',
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
                id: 'native-original-liquid-007',
                pointer: '/captures/0/cases/6/facts',
                sha256: '7539571566edbf3e73bb8c61adf7960b213cd845e68a21dda1571c4e1246a809',
                replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
              },
            ],
          },
        ],
        regionHashes: [['52595e1aca3721729f3028a58ecad9bb13fdd64be80606aa2694614f1dda6b8d']],
        regionFactIds: [[['native-original-liquid-007']]],
      },
    ]);
    assert.equal(
      await renderer.renderString('{{ "" | split:"," | size }} {{ "a,,b," | split:"," | join:"|" }}', {}),
      '1 a|b',
    );
  }
});

test('portal params alias includes URL and request-body overrides', async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  const renderer = createPortalRenderer(portal);
  const context = renderer.contextForPage(
    portal.pages.find((p) => p.url === '/work/'),
    '/work/?dynamicfilter=nickname',
  );
  assert.equal(
    await renderer.renderString('{{ params.dynamicfilter }}|{{ request.params.dynamicfilter }}', context),
    'nickname|nickname',
  );
  const posted = renderer.contextForPage(portal.pages[0], '/', {
    request: { params: { dynamicfilter: 'POST value' } },
  });
  assert.equal(await renderer.renderString('{{ params.dynamicfilter }}', posted), 'POST value');
});

// @test-kind parity: Both fresh native source-bound include rounds reproduce every unchanged original literal result/error assertion in this registration; automatic actual-context replay matches exactly.
// @parity-evidence: Manifest guarantee existing-liquid-import-render-test-mjs-830-0; exact capsule/run/fact/source bindings are asserted below.
test('URL decoding treats form plus as spaces while preserving encoded plus signs', async (t) => {
  // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/import-render.test.mjs:830:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '3462908627926c936afbaab8e5fdacf29c8905c861515cf2ce642a2979276e8c',
      originalAssertions: ['bba2540e409309a0f6c7dd2201bf4c5ec791086ad0a740c30e8d5f892535e239'],
      originalBodyAstSha256: '30799e8cdf5f8314e98135d010c15eeb587d1507ad5af4611ad07e1f38214671',
      originalGuardHashes: [],
      moduleContextAstSha256: 'b171657ac710fbed9b33468c2b25cf366e6dd54854e646005a85890522416ccc',
      isolationRegistrationsAstSha256: '6b5bab04f8e5cd104845c490ce1484f4097704a7c8d33047d155347cf7c80c60',
      importRoles: [
        {
          source: '../lib/importer.mjs',
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
          source: '../lib/header-notification-capture.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/extensions.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/observed-pagecopy-layout.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/frontend',
          reason:
            'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
        },
        {
          source: '../lib/observed-snippet-composition.mjs',
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
      generatedFixtures: [
        {
          baselineId: 'mirage/test/import-render.test.mjs:224:0',
          producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
          mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
          allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
          helperPath: 'mirage/testing/owned-fixture.mjs',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          entries: [
            { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
            {
              name: 'web-pages/home/Home.webpage.yml',
              sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
            },
            {
              name: 'web-pages/work/Work.webpage.yml',
              sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
              sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
              sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
              sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
              sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
            },
            {
              name: 'page-templates/Main.pagetemplate.yml',
              sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
            },
            {
              name: 'web-templates/header/Header.webtemplate.yml',
              sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
            },
            {
              name: 'web-templates/header/Header.webtemplate.source.html',
              sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.yml',
              sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.source.html',
              sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
            },
            {
              name: 'web-templates/content/Content.webtemplate.yml',
              sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
            },
            {
              name: 'web-templates/content/Content.webtemplate.source.html',
              sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
              sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              name: 'web-files/app.js.webfile.yml',
              sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
            },
            { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
            {
              name: 'table-permissions/contact.tablepermission.yml',
              sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
            },
          ],
          ownedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
          isolatedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
        },
        {
          baselineId: 'mirage/test/import-render.test.mjs:624:0',
          producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
          mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
          allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
          helperPath: 'mirage/testing/owned-fixture.mjs',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          entries: [
            { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
            {
              name: 'web-pages/home/Home.webpage.yml',
              sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
            },
            {
              name: 'web-pages/work/Work.webpage.yml',
              sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
              sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
              sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
              sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
              sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
            },
            {
              name: 'page-templates/Main.pagetemplate.yml',
              sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
            },
            {
              name: 'web-templates/header/Header.webtemplate.yml',
              sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
            },
            {
              name: 'web-templates/header/Header.webtemplate.source.html',
              sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.yml',
              sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.source.html',
              sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
            },
            {
              name: 'web-templates/content/Content.webtemplate.yml',
              sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
            },
            {
              name: 'web-templates/content/Content.webtemplate.source.html',
              sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
              sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              name: 'web-files/app.js.webfile.yml',
              sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
            },
            { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
            {
              name: 'table-permissions/contact.tablepermission.yml',
              sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
            },
          ],
          ownedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
          isolatedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
        },
        {
          baselineId: 'mirage/test/import-render.test.mjs:830:0',
          producerSha256: '7dfc1d3df9ea022732386246419bded67252384353fbd364f0e2bc21b96622be',
          mapSha256: 'd368fb1efc7227f2e52c806743a5187b68d8893ab0831126feaa683e901aa4c9',
          allocatorSha256: '85f915211cad8ac647fa6a1b546813f4b519f3602bea03062a95fdbafa6cdb52',
          helperPath: 'mirage/testing/owned-fixture.mjs',
          helperSha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
          entries: [
            { name: 'website.yml', sha256: '09daa85247a4c34014689892485c6426ccb47c22246755fad9c587a84a463537' },
            {
              name: 'web-pages/home/Home.webpage.yml',
              sha256: '673420cc98f0a53e8bb7484f0f5550d16d37ec38843346b8cd7880f435fbe016',
            },
            {
              name: 'web-pages/work/Work.webpage.yml',
              sha256: 'c5f3d9a25dded6b28c20116ad62ffbc118dd486933b0e44e18cc955ab4ca0d3f',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.yml',
              sha256: 'a2609e549492c78607ca2f9be8cb27df8e1fb5d82ece7e3b111d333d6deb1f46',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.copy.html',
              sha256: '1c04a2dbbfba2167cc2909f871116f67aacdffcdda647344b59b96b9510ffdce',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_css.css',
              sha256: '183956a357237907d105b35c5c0428e8ffbae5c2f629035919b416cdf002b227',
            },
            {
              name: 'web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js',
              sha256: 'a2a2a481e18742d64346185feee8334b0b63c52acb80a587f0f345d28645b234',
            },
            {
              name: 'page-templates/Main.pagetemplate.yml',
              sha256: 'f175f0f52676fac2e4359f98e9484065b69268a5d1c4c18e19891bd575f3034d',
            },
            {
              name: 'web-templates/header/Header.webtemplate.yml',
              sha256: 'e19b14f5aaeabbafb37b2b886bbb6c9fd89065409f70cbf8f2cf84e895b185c3',
            },
            {
              name: 'web-templates/header/Header.webtemplate.source.html',
              sha256: 'd0053616975af7ed005205df3c2897971aa7874c5447a31cdfb15db0c0e85e5b',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.yml',
              sha256: '20a375a2945a4ed26856b48b362a647bceb9ca5f1a452ecd5679853f91f20fc5',
            },
            {
              name: 'web-templates/footer/Footer.webtemplate.source.html',
              sha256: '1541de4a384edb0373ac18afe8649add4c43f83b90a6b39f30a25ec5715b578e',
            },
            {
              name: 'web-templates/content/Content.webtemplate.yml',
              sha256: '8ef866e97ccd6e951bce670cd487e07ae2c0041a5b29167064b1389ba64a7b0f',
            },
            {
              name: 'web-templates/content/Content.webtemplate.source.html',
              sha256: '0a767003f9ba7f12e0c305304e26150ce5be6943b9264b9e9a70b5d716e6ca20',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.yml',
              sha256: '82e83d4381677781cc5117a97cbfd198669d5046dd3479ac1db19f6afcc3c9d2',
            },
            {
              name: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              name: 'web-files/app.js.webfile.yml',
              sha256: 'c6209955aaace564a6111fb559ed3aee5117099142e8c15b4c7b51123b711fca',
            },
            { name: 'web-files/app.js', sha256: '86e298374ea61d4c5009f06f3e05e3cf5d151974a3b94bfae6ebf3431088254c' },
            {
              name: 'table-permissions/contact.tablepermission.yml',
              sha256: '8b18a87863bb3eefbb0c0ce3c725b2829230625c2d4c897420ede06dd9c093e6',
            },
          ],
          ownedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
          ],
          isolatedReads: [
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
            {
              registrationSha256: '960a01f092fcf3d74554c93529d98fe804c4810a9c429cea56b8629eef7dfdb7',
              entry: 'content-snippets/greeting/Greeting.contentsnippet.value.html',
              entrySha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
            },
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
            baselineId: 'mirage/test/import-render.test.mjs:830:0',
            title: 'URL decoding treats form plus as spaces while preserving encoded plus signs',
          },
        ],
        casesSha256: '6a27c0d521b99870fa75a0b7fd15982fd51e8770557540f08481d1a58992faf7',
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
              id: 'native-original-liquid-008',
              pointer: '/captures/0/cases/7/facts',
              sha256: 'ed4c0c273fe17d476fd38471f824a41e5da8f5add25849769cfe69c59d96529a',
              replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
            },
          ],
        },
      ],
    },
  ]);
  const renderer = createPortalRenderer(await importPortal(await fixture(t, standard)));
  assert.equal(
    await renderer.renderString('{{ "%3Csvg+width%3D%2715%27%3E%2B%3C%2Fsvg%3E" | url_decode }}'),
    "<svg width='15'>+</svg>",
  );
});

// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.
test('parity source bindings 900a48ea97f5dbdc', () => {
  // @parity-evidence: Tooling-only exposure of the existing source/run/fact/case validator; the same helper and module URL execute once, with every protected binding unchanged.
  assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));
});
