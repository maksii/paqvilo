// @test-kind unproven: paging, fetch and include models retain unmatched assertions; only explicitly reproduced source-local regions carry parity.
import {
  parityAssertions as __paqParityAssertions,
  assertParityBindings as __paqParityBindings,
} from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/liquid-paging.test.mjs:15:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'a68da104ff17bdb8092bc870b661e8b6a019f10c85f7adb050f2226062d95ffa',
    originalAssertions: [
      '56b9af8159c2b6e8915ddb85a95c564cbf48de6163329492a11b61f9b91bb925',
      'cd6ca717e7f230f97c07ff44bcde8d0d61b270da5b36411907618a14f5f30bc2',
      '0a07b42461e3ed0abdda33984037f7a6e818f3164df4db47514a42b170f9e103',
      '0b1825fc46eac2333b2c60e2dd9349d095b9ba02619ab383d1507e0f86c24842',
    ],
    originalBodyAstSha256: '20a108d272fb31f1342e067c1541e2c51f47d46a4cc7cfb41da0574df0b8a3c9',
    originalGuardHashes: [],
    moduleContextAstSha256: '28c4010bad6f2990251ff2332a222534d4f0faf161a2fd4127907ffba473f30d',
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/data.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
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
          baselineId: 'mirage/test/liquid-paging.test.mjs:15:0',
          title: 'Quoted nested Liquid used by the exported paging-cookie assignment remains executable',
        },
      ],
      casesSha256: '818e069b54ce7f8c5944a2c588472133cf49c329754db4d319557d57645839e7',
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
            id: 'native-original-context-005',
            pointer: '/captures/0/cases/4/facts',
            sha256: 'c817b400b824ceba45a045629875971f778495e342e923fad83c027d504e3dc1',
            replicatedPointers: ['/captures/0/cases/4/facts', '/captures/1/cases/4/facts'],
          },
        ],
      },
    ],
    regionHashes: [['0b1825fc46eac2333b2c60e2dd9349d095b9ba02619ab383d1507e0f86c24842']],
    regionFactIds: [[['native-original-context-005']]],
  },
]);
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { DataStore } from '../lib/data.mjs';
const portal = {
  templates: {},
  snippets: {},
  settings: {},
  pages: [],
  webFiles: [],
  lists: [],
  entityForms: [],
  advancedForms: [],
};
test('Quoted nested Liquid used by the exported paging-cookie assignment remains executable', async () => {
  const source = `{% assign pagingCookie = ' paging-cookie = "{{ pagingCookie | replace: "amp;","" }}"' | liquid %}{% fetchxml rows %}<fetch {{pagingCookie}} count="2" page="2"><entity name="item" /></fetch>{% endfetchxml %}{{rows.results.entities[0].name}}`;
  const store = await new DataStore({
    state: {
      mappings: { item: { entitySet: 'items', idColumn: 'itemid' } },
      tables: {
        item: [1, 2, 3, 4].map((n) => ({
          itemid: String(n),
          name: `Item ${n}`,
        })),
      },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  let xml;
  const renderer = createPortalRenderer(portal, {
    fetchXml: (value) => {
      xml = value;
      return store.fetchXml(value);
    },
  });
  assert.equal(
    await renderer.renderString(source, {
      pagingCookie: '&lt;cookie page=&quot;1&quot; /&gt;',
    }),
    'Item 3',
  );
  assert.match(xml, /paging-cookie = "&lt;cookie page=&quot;1&quot; \/&gt;"/);
  // DotLiquid reads tag attribute values with its variable parser, so the braces
  // around an attribute expression are ignored: value resolves user.fullname.
  portal.templates.Template = { name: 'Template', source: '[{{ value }}]' };
  assert.equal(
    await renderer.renderString('{% include "Template" value: {{user.fullname}} %}', {
      user: { fullname: 'Ada Lovelace' },
    }),
    '[Ada Lovelace]',
  );
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-paging.test.mjs:15:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'a68da104ff17bdb8092bc870b661e8b6a019f10c85f7adb050f2226062d95ffa',
        originalAssertions: [
          '56b9af8159c2b6e8915ddb85a95c564cbf48de6163329492a11b61f9b91bb925',
          'cd6ca717e7f230f97c07ff44bcde8d0d61b270da5b36411907618a14f5f30bc2',
          '0a07b42461e3ed0abdda33984037f7a6e818f3164df4db47514a42b170f9e103',
          '0b1825fc46eac2333b2c60e2dd9349d095b9ba02619ab383d1507e0f86c24842',
        ],
        originalBodyAstSha256: '20a108d272fb31f1342e067c1541e2c51f47d46a4cc7cfb41da0574df0b8a3c9',
        originalGuardHashes: [],
        moduleContextAstSha256: '28c4010bad6f2990251ff2332a222534d4f0faf161a2fd4127907ffba473f30d',
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
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
              baselineId: 'mirage/test/liquid-paging.test.mjs:15:0',
              title: 'Quoted nested Liquid used by the exported paging-cookie assignment remains executable',
            },
          ],
          casesSha256: '818e069b54ce7f8c5944a2c588472133cf49c329754db4d319557d57645839e7',
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
                id: 'native-original-context-005',
                pointer: '/captures/0/cases/4/facts',
                sha256: 'c817b400b824ceba45a045629875971f778495e342e923fad83c027d504e3dc1',
                replicatedPointers: ['/captures/0/cases/4/facts', '/captures/1/cases/4/facts'],
              },
            ],
          },
        ],
        regionHashes: [['0b1825fc46eac2333b2c60e2dd9349d095b9ba02619ab383d1507e0f86c24842']],
        regionFactIds: [[['native-original-context-005']]],
      },
    ]);
    assert.equal(await renderer.renderString('{{name}}', { name: 'Alex' }), 'Alex');
  }
});
