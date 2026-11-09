// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.
// @test-kind unproven: invented form and collection models require reproduced native proof for each qualified assertion.
import {
  parityAssertions as __paqParityAssertions,
  assertParityBindings as __paqParityBindings,
} from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/model-driven-collections.test.mjs:22:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '4c6bbd62b4c4433cee8957f3b0ef694cb6dad2ce4308aec94002306b8c00fe7f',
    originalAssertions: [
      '6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51',
      '380b585438d198366baf1ed43c933d06d9e4c4a8caf2f93958c32b1638ed30c4',
      'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
      '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
      'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
      '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
      'b52eac841d90a281a3944aaf1e857f0486cf7d098ecde0a9c460669068fe3b31',
      'ca00200da7e9896cea4a55d61a734e0b26a06d68865508d8fbefb37d2a6ba991',
      'c661d6f94eec42e6a4c9214b02ad2676e2cec13ee1a280728e479aeb5414ada4',
      '01c74616f427e0b97162f34d6d6b9dbc74e27d3c9411e0d5be988c3faa881fe9',
      '02b60046174e22d4253ec925360850120e291d80244b8305f3c57df3f56c4bef',
      'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
      '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
      'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
      '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
      'cd2a1734927c93c5cd737068d49cd7252bf6025981cd2a601d47f23e9a19a77a',
      '55db03756ff2a2a3829c3eba779ea47ddc589d3bb9b4bfb6f606d2fd718f7e8c',
    ],
    baselineOriginalAssertions: [
      '6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51',
      '380b585438d198366baf1ed43c933d06d9e4c4a8caf2f93958c32b1638ed30c4',
      'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
      'cefc0015b9af5800a84a22fd57d0519b1650373164f3f8fc2d726e6611b0ad28',
      '98161de53dc8d2f0ea31ea79f517a28f8821dfd57ae86f09733ea3fa0fe5af5a',
      '7161253441a0d6c5862dcb00f10e13aff322f765a4b1fceed932ff57e6ef35f8',
      'b52eac841d90a281a3944aaf1e857f0486cf7d098ecde0a9c460669068fe3b31',
      'ca00200da7e9896cea4a55d61a734e0b26a06d68865508d8fbefb37d2a6ba991',
      'c661d6f94eec42e6a4c9214b02ad2676e2cec13ee1a280728e479aeb5414ada4',
      '01c74616f427e0b97162f34d6d6b9dbc74e27d3c9411e0d5be988c3faa881fe9',
      '02b60046174e22d4253ec925360850120e291d80244b8305f3c57df3f56c4bef',
      'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
      '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
      'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
      '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
      'cd2a1734927c93c5cd737068d49cd7252bf6025981cd2a601d47f23e9a19a77a',
      '55db03756ff2a2a3829c3eba779ea47ddc589d3bb9b4bfb6f606d2fd718f7e8c',
    ],
    originalBodyAstSha256: 'f081f490427db5dfdd02e27b15b8eeb38a5e20ab8861953a78478d7a222d2ad7',
    baselineBodyAstSha256: 'd99e6ab26f66991a5ba450b88234aa9fffede5258f80054e630bcd3219ca59c4',
    originalGuardHashes: [],
    moduleContextAstSha256: '2b3f2c15a3c3a6f5299ad4c98b7a2b2fcade30e8de66af5818cfbe8e74738a8b',
    moduleReview: {
      reviewedBy: '/root/frontend',
      reason:
        'Only three native-backed selector expected values change; exact producer/input and all unrelated assertions and protected original proof objects are retained.',
      addedTests: [],
      corrections: [
        {
          sameGuarantee: true,
          reviewedBy: '/root/frontend',
          reason:
            'Source-relative upper-braced input returns typed null; original expects current. Authored literal separately returns null. Two fresh source-bound typed null results license only this expected-value correction.',
          oldAstSha256: 'cefc0015b9af5800a84a22fd57d0519b1650373164f3f8fc2d726e6611b0ad28',
          currentAstSha256: '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
          guaranteeId: 'model-driven-current-form-id-selector-identity',
          factIds: ['native-lookup-original-32-exact-literal', 'native-lookup-original-32'],
        },
        {
          sameGuarantee: true,
          reviewedBy: '/root/frontend',
          reason:
            'Native current.getLabel equals actual source name; its exact lookup returns null. Authored Invented form literal also returns null but is not the native source label. Two fresh source-bound typed null results license only this expected-value correction.',
          oldAstSha256: '98161de53dc8d2f0ea31ea79f517a28f8821dfd57ae86f09733ea3fa0fe5af5a',
          currentAstSha256: 'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
          guaranteeId: 'model-driven-current-form-id-selector-identity',
          factIds: ['native-lookup-original-33-exact-literal', 'native-lookup-original-33'],
        },
        {
          sameGuarantee: true,
          reviewedBy: '/root/frontend',
          reason:
            'Exact authored unknown GUID returns typed null; original expects undefined. Two fresh source-bound typed null results license only this expected-value correction.',
          oldAstSha256: '7161253441a0d6c5862dcb00f10e13aff322f765a4b1fceed932ff57e6ef35f8',
          currentAstSha256: '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
          guaranteeId: 'model-driven-current-form-id-selector-identity',
          factIds: ['native-lookup-original-34'],
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/model-driven/client-runtime.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/model_driven_remediation',
        reason:
          'The production client runtime implements the selector and collection APIs exercised by the original assertions.',
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
          baselineId: 'mirage/test/model-driven-collections.test.mjs:22:0',
          title: 'form items resolve by form identity while attribute and control collections retain their own names',
        },
      ],
      casesSha256: '74fed432d9be3b9f9563b19eac285eb02b6971a9bb6a56d8389f84fe075cad99',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/model-driven-single-form-native-facts.json',
        sha256: 'a8fb304427b03cf01a08798123956d8f9d28091baa55240f536d7e6a7b2b56b1',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-one-form-first-expression',
            pointer: '/captures/0/cases/0/facts',
            sha256: '2d451927e2827951ae4748c63549d3d50754dc9d2e603a8c2beece85e8afa10c',
            replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
          },
          {
            id: 'native-one-form-source-context',
            pointer: '/captures/0/source',
            sha256: '861fa0a6ac3d232a77ce98e2206d2b4d7869933143210f862a03cc723f9fc4c3',
            replicatedPointers: ['/captures/0/source', '/captures/1/source'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/model-driven-single-form-lookup-native-facts.json',
        sha256: '399620eaebfa933d1d851b29feb4050618a61884ad7ede46b9a77dd4a7ee4eff',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'native-lookup-original-31',
            pointer: '/captures/0/cases/3/facts',
            sha256: '6aa203b50028e75016b891864c3184416f23efeb102429182ebf1558e15df717',
            replicatedPointers: ['/captures/0/cases/3/facts', '/captures/1/cases/3/facts'],
          },
          {
            id: 'native-lookup-original-32',
            pointer: '/captures/0/cases/5/facts',
            sha256: '230077ba6dfcbb3a0fbaaf4f26bffb3b155b2d71cf8550302767a701fd81dded',
            replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
          },
          {
            id: 'native-lookup-original-33',
            pointer: '/captures/0/cases/8/facts',
            sha256: '4015448f180ccabde980d321d5facefaf553530a9c28e970fd6a44abf5dddf55',
            replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
          },
          {
            id: 'native-lookup-original-34',
            pointer: '/captures/0/cases/9/facts',
            sha256: '51b03d3cb1972436902cb08ce1275e044a97df244c3b40fe42c65622145d1c44',
            replicatedPointers: ['/captures/0/cases/9/facts', '/captures/1/cases/9/facts'],
          },
          {
            id: 'native-lookup-original-40',
            pointer: '/captures/0/cases/10/facts',
            sha256: '7aa511d8a4c9f5420cafbd6eb95c2d21f9ba6c94891e0b1c693baf084c819f68',
            replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
          },
          {
            id: 'native-lookup-original-41',
            pointer: '/captures/0/cases/11/facts',
            sha256: '8f7c8c4b3ed3d08fd960f41a5b18297e4018faa151e292d67559724c62983e53',
            replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
          },
          {
            id: 'native-lookup-original-42',
            pointer: '/captures/0/cases/13/facts',
            sha256: 'c318f1b59b6aeaad187eb57184bba78a032ea36a540842f42f515161102eea40',
            replicatedPointers: ['/captures/0/cases/13/facts', '/captures/1/cases/13/facts'],
          },
          {
            id: 'native-lookup-original-46',
            pointer: '/captures/0/cases/14/facts',
            sha256: 'fa5833f95ecce1918ddf09b6eaae418cc754da74a680dde7faf7dd7ed252a6e7',
            replicatedPointers: ['/captures/0/cases/14/facts', '/captures/1/cases/14/facts'],
          },
          {
            id: 'native-lookup-original-32-exact-literal',
            pointer: '/captures/0/cases/6/facts',
            sha256: '6f3df1e00bcd78abf2465c709cfd353ab721e8d17202d6abb29a586130377d8b',
            replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
          },
          {
            id: 'native-lookup-original-33-exact-literal',
            pointer: '/captures/0/cases/7/facts',
            sha256: 'dfa724b75b4ec9bcd401492afdc1365a9b6995a4bc5249ef9b2e2408154ca49d',
            replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      ['6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51'],
      [
        'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
        '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
        'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
        '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
      ],
      [
        'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
        '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
        'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
        '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
      ],
    ],
    regionFactIds: [
      [['native-one-form-first-expression', 'native-one-form-source-context']],
      [
        ['native-lookup-original-31'],
        ['native-lookup-original-32-exact-literal', 'native-lookup-original-32'],
        ['native-lookup-original-33-exact-literal', 'native-lookup-original-33'],
        ['native-lookup-original-34'],
      ],
      [
        ['native-lookup-original-40'],
        ['native-lookup-original-41'],
        ['native-lookup-original-42'],
        ['native-lookup-original-46'],
      ],
    ],
  },
]);

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';

const formId = 'aabbccdd-1234-4abc-8def-123456abcdef';

function fixture() {
  const fields = {
    x_title: { name: 'x_title', type: 'text' },
    x_count: { name: 'x_count', type: 'number' },
  };
  const bindings = { title_editor: 'x_title', count_editor: 'x_count' };
  return createFormClientRuntime({
    table: { entity: 'x_item', fields, idColumn: 'x_itemid', nameColumn: 'x_title' },
    form: { id: formId, name: 'Invented form', attributes: Object.keys(fields) },
    record: { x_title: 'Invented', x_count: 2 },
    controlNames: (name) => Object.keys(bindings).filter((key) => !name || bindings[key] === name),
    controlField: (name) => bindings[name],
  });
}

test('form items resolve by form identity while attribute and control collections retain their own names', () => {
  const runtime = fixture(),
    form = runtime.formContext,
    attributes = form.data.entity.attributes,
    controls = form.ui.controls,
    forms = form.ui.formSelector.items,
    current = form.ui.formSelector.getCurrentItem();

  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/model-driven-collections.test.mjs:22:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '4c6bbd62b4c4433cee8957f3b0ef694cb6dad2ce4308aec94002306b8c00fe7f',
        originalAssertions: [
          '6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51',
          '380b585438d198366baf1ed43c933d06d9e4c4a8caf2f93958c32b1638ed30c4',
          'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
          '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
          'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
          '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
          'b52eac841d90a281a3944aaf1e857f0486cf7d098ecde0a9c460669068fe3b31',
          'ca00200da7e9896cea4a55d61a734e0b26a06d68865508d8fbefb37d2a6ba991',
          'c661d6f94eec42e6a4c9214b02ad2676e2cec13ee1a280728e479aeb5414ada4',
          '01c74616f427e0b97162f34d6d6b9dbc74e27d3c9411e0d5be988c3faa881fe9',
          '02b60046174e22d4253ec925360850120e291d80244b8305f3c57df3f56c4bef',
          'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
          '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
          'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
          '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
          'cd2a1734927c93c5cd737068d49cd7252bf6025981cd2a601d47f23e9a19a77a',
          '55db03756ff2a2a3829c3eba779ea47ddc589d3bb9b4bfb6f606d2fd718f7e8c',
        ],
        baselineOriginalAssertions: [
          '6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51',
          '380b585438d198366baf1ed43c933d06d9e4c4a8caf2f93958c32b1638ed30c4',
          'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
          'cefc0015b9af5800a84a22fd57d0519b1650373164f3f8fc2d726e6611b0ad28',
          '98161de53dc8d2f0ea31ea79f517a28f8821dfd57ae86f09733ea3fa0fe5af5a',
          '7161253441a0d6c5862dcb00f10e13aff322f765a4b1fceed932ff57e6ef35f8',
          'b52eac841d90a281a3944aaf1e857f0486cf7d098ecde0a9c460669068fe3b31',
          'ca00200da7e9896cea4a55d61a734e0b26a06d68865508d8fbefb37d2a6ba991',
          'c661d6f94eec42e6a4c9214b02ad2676e2cec13ee1a280728e479aeb5414ada4',
          '01c74616f427e0b97162f34d6d6b9dbc74e27d3c9411e0d5be988c3faa881fe9',
          '02b60046174e22d4253ec925360850120e291d80244b8305f3c57df3f56c4bef',
          'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
          '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
          'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
          '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
          'cd2a1734927c93c5cd737068d49cd7252bf6025981cd2a601d47f23e9a19a77a',
          '55db03756ff2a2a3829c3eba779ea47ddc589d3bb9b4bfb6f606d2fd718f7e8c',
        ],
        originalBodyAstSha256: 'f081f490427db5dfdd02e27b15b8eeb38a5e20ab8861953a78478d7a222d2ad7',
        baselineBodyAstSha256: 'd99e6ab26f66991a5ba450b88234aa9fffede5258f80054e630bcd3219ca59c4',
        originalGuardHashes: [],
        moduleContextAstSha256: '2b3f2c15a3c3a6f5299ad4c98b7a2b2fcade30e8de66af5818cfbe8e74738a8b',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason:
            'Only three native-backed selector expected values change; exact producer/input and all unrelated assertions and protected original proof objects are retained.',
          addedTests: [],
          corrections: [
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Source-relative upper-braced input returns typed null; original expects current. Authored literal separately returns null. Two fresh source-bound typed null results license only this expected-value correction.',
              oldAstSha256: 'cefc0015b9af5800a84a22fd57d0519b1650373164f3f8fc2d726e6611b0ad28',
              currentAstSha256: '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
              guaranteeId: 'model-driven-current-form-id-selector-identity',
              factIds: ['native-lookup-original-32-exact-literal', 'native-lookup-original-32'],
            },
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Native current.getLabel equals actual source name; its exact lookup returns null. Authored Invented form literal also returns null but is not the native source label. Two fresh source-bound typed null results license only this expected-value correction.',
              oldAstSha256: '98161de53dc8d2f0ea31ea79f517a28f8821dfd57ae86f09733ea3fa0fe5af5a',
              currentAstSha256: 'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
              guaranteeId: 'model-driven-current-form-id-selector-identity',
              factIds: ['native-lookup-original-33-exact-literal', 'native-lookup-original-33'],
            },
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Exact authored unknown GUID returns typed null; original expects undefined. Two fresh source-bound typed null results license only this expected-value correction.',
              oldAstSha256: '7161253441a0d6c5862dcb00f10e13aff322f765a4b1fceed932ff57e6ef35f8',
              currentAstSha256: '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
              guaranteeId: 'model-driven-current-form-id-selector-identity',
              factIds: ['native-lookup-original-34'],
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/model-driven/client-runtime.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/model_driven_remediation',
            reason:
              'The production client runtime implements the selector and collection APIs exercised by the original assertions.',
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
              baselineId: 'mirage/test/model-driven-collections.test.mjs:22:0',
              title:
                'form items resolve by form identity while attribute and control collections retain their own names',
            },
          ],
          casesSha256: '74fed432d9be3b9f9563b19eac285eb02b6971a9bb6a56d8389f84fe075cad99',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/model-driven-single-form-native-facts.json',
            sha256: 'a8fb304427b03cf01a08798123956d8f9d28091baa55240f536d7e6a7b2b56b1',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-one-form-first-expression',
                pointer: '/captures/0/cases/0/facts',
                sha256: '2d451927e2827951ae4748c63549d3d50754dc9d2e603a8c2beece85e8afa10c',
                replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
              },
              {
                id: 'native-one-form-source-context',
                pointer: '/captures/0/source',
                sha256: '861fa0a6ac3d232a77ce98e2206d2b4d7869933143210f862a03cc723f9fc4c3',
                replicatedPointers: ['/captures/0/source', '/captures/1/source'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/model-driven-single-form-lookup-native-facts.json',
            sha256: '399620eaebfa933d1d851b29feb4050618a61884ad7ede46b9a77dd4a7ee4eff',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-lookup-original-31',
                pointer: '/captures/0/cases/3/facts',
                sha256: '6aa203b50028e75016b891864c3184416f23efeb102429182ebf1558e15df717',
                replicatedPointers: ['/captures/0/cases/3/facts', '/captures/1/cases/3/facts'],
              },
              {
                id: 'native-lookup-original-32',
                pointer: '/captures/0/cases/5/facts',
                sha256: '230077ba6dfcbb3a0fbaaf4f26bffb3b155b2d71cf8550302767a701fd81dded',
                replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
              },
              {
                id: 'native-lookup-original-33',
                pointer: '/captures/0/cases/8/facts',
                sha256: '4015448f180ccabde980d321d5facefaf553530a9c28e970fd6a44abf5dddf55',
                replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
              },
              {
                id: 'native-lookup-original-34',
                pointer: '/captures/0/cases/9/facts',
                sha256: '51b03d3cb1972436902cb08ce1275e044a97df244c3b40fe42c65622145d1c44',
                replicatedPointers: ['/captures/0/cases/9/facts', '/captures/1/cases/9/facts'],
              },
              {
                id: 'native-lookup-original-40',
                pointer: '/captures/0/cases/10/facts',
                sha256: '7aa511d8a4c9f5420cafbd6eb95c2d21f9ba6c94891e0b1c693baf084c819f68',
                replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
              },
              {
                id: 'native-lookup-original-41',
                pointer: '/captures/0/cases/11/facts',
                sha256: '8f7c8c4b3ed3d08fd960f41a5b18297e4018faa151e292d67559724c62983e53',
                replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
              },
              {
                id: 'native-lookup-original-42',
                pointer: '/captures/0/cases/13/facts',
                sha256: 'c318f1b59b6aeaad187eb57184bba78a032ea36a540842f42f515161102eea40',
                replicatedPointers: ['/captures/0/cases/13/facts', '/captures/1/cases/13/facts'],
              },
              {
                id: 'native-lookup-original-46',
                pointer: '/captures/0/cases/14/facts',
                sha256: 'fa5833f95ecce1918ddf09b6eaae418cc754da74a680dde7faf7dd7ed252a6e7',
                replicatedPointers: ['/captures/0/cases/14/facts', '/captures/1/cases/14/facts'],
              },
              {
                id: 'native-lookup-original-32-exact-literal',
                pointer: '/captures/0/cases/6/facts',
                sha256: '6f3df1e00bcd78abf2465c709cfd353ab721e8d17202d6abb29a586130377d8b',
                replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
              },
              {
                id: 'native-lookup-original-33-exact-literal',
                pointer: '/captures/0/cases/7/facts',
                sha256: 'dfa724b75b4ec9bcd401492afdc1365a9b6995a4bc5249ef9b2e2408154ca49d',
                replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          ['6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51'],
          [
            'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
            '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
            'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
            '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
          ],
          [
            'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
            '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
            'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
            '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
          ],
        ],
        regionFactIds: [
          [['native-one-form-first-expression', 'native-one-form-source-context']],
          [
            ['native-lookup-original-31'],
            ['native-lookup-original-32-exact-literal', 'native-lookup-original-32'],
            ['native-lookup-original-33-exact-literal', 'native-lookup-original-33'],
            ['native-lookup-original-34'],
          ],
          [
            ['native-lookup-original-40'],
            ['native-lookup-original-41'],
            ['native-lookup-original-42'],
            ['native-lookup-original-46'],
          ],
        ],
      },
    ]);
    assert.equal(forms.get(current.getId()), current);
  }

  assert.throws(() => current.navigate(), /does not support formSelector item.navigate/);
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/model-driven-collections.test.mjs:22:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '4c6bbd62b4c4433cee8957f3b0ef694cb6dad2ce4308aec94002306b8c00fe7f',
        originalAssertions: [
          '6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51',
          '380b585438d198366baf1ed43c933d06d9e4c4a8caf2f93958c32b1638ed30c4',
          'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
          '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
          'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
          '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
          'b52eac841d90a281a3944aaf1e857f0486cf7d098ecde0a9c460669068fe3b31',
          'ca00200da7e9896cea4a55d61a734e0b26a06d68865508d8fbefb37d2a6ba991',
          'c661d6f94eec42e6a4c9214b02ad2676e2cec13ee1a280728e479aeb5414ada4',
          '01c74616f427e0b97162f34d6d6b9dbc74e27d3c9411e0d5be988c3faa881fe9',
          '02b60046174e22d4253ec925360850120e291d80244b8305f3c57df3f56c4bef',
          'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
          '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
          'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
          '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
          'cd2a1734927c93c5cd737068d49cd7252bf6025981cd2a601d47f23e9a19a77a',
          '55db03756ff2a2a3829c3eba779ea47ddc589d3bb9b4bfb6f606d2fd718f7e8c',
        ],
        baselineOriginalAssertions: [
          '6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51',
          '380b585438d198366baf1ed43c933d06d9e4c4a8caf2f93958c32b1638ed30c4',
          'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
          'cefc0015b9af5800a84a22fd57d0519b1650373164f3f8fc2d726e6611b0ad28',
          '98161de53dc8d2f0ea31ea79f517a28f8821dfd57ae86f09733ea3fa0fe5af5a',
          '7161253441a0d6c5862dcb00f10e13aff322f765a4b1fceed932ff57e6ef35f8',
          'b52eac841d90a281a3944aaf1e857f0486cf7d098ecde0a9c460669068fe3b31',
          'ca00200da7e9896cea4a55d61a734e0b26a06d68865508d8fbefb37d2a6ba991',
          'c661d6f94eec42e6a4c9214b02ad2676e2cec13ee1a280728e479aeb5414ada4',
          '01c74616f427e0b97162f34d6d6b9dbc74e27d3c9411e0d5be988c3faa881fe9',
          '02b60046174e22d4253ec925360850120e291d80244b8305f3c57df3f56c4bef',
          'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
          '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
          'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
          '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
          'cd2a1734927c93c5cd737068d49cd7252bf6025981cd2a601d47f23e9a19a77a',
          '55db03756ff2a2a3829c3eba779ea47ddc589d3bb9b4bfb6f606d2fd718f7e8c',
        ],
        originalBodyAstSha256: 'f081f490427db5dfdd02e27b15b8eeb38a5e20ab8861953a78478d7a222d2ad7',
        baselineBodyAstSha256: 'd99e6ab26f66991a5ba450b88234aa9fffede5258f80054e630bcd3219ca59c4',
        originalGuardHashes: [],
        moduleContextAstSha256: '2b3f2c15a3c3a6f5299ad4c98b7a2b2fcade30e8de66af5818cfbe8e74738a8b',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason:
            'Only three native-backed selector expected values change; exact producer/input and all unrelated assertions and protected original proof objects are retained.',
          addedTests: [],
          corrections: [
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Source-relative upper-braced input returns typed null; original expects current. Authored literal separately returns null. Two fresh source-bound typed null results license only this expected-value correction.',
              oldAstSha256: 'cefc0015b9af5800a84a22fd57d0519b1650373164f3f8fc2d726e6611b0ad28',
              currentAstSha256: '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
              guaranteeId: 'model-driven-current-form-id-selector-identity',
              factIds: ['native-lookup-original-32-exact-literal', 'native-lookup-original-32'],
            },
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Native current.getLabel equals actual source name; its exact lookup returns null. Authored Invented form literal also returns null but is not the native source label. Two fresh source-bound typed null results license only this expected-value correction.',
              oldAstSha256: '98161de53dc8d2f0ea31ea79f517a28f8821dfd57ae86f09733ea3fa0fe5af5a',
              currentAstSha256: 'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
              guaranteeId: 'model-driven-current-form-id-selector-identity',
              factIds: ['native-lookup-original-33-exact-literal', 'native-lookup-original-33'],
            },
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Exact authored unknown GUID returns typed null; original expects undefined. Two fresh source-bound typed null results license only this expected-value correction.',
              oldAstSha256: '7161253441a0d6c5862dcb00f10e13aff322f765a4b1fceed932ff57e6ef35f8',
              currentAstSha256: '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
              guaranteeId: 'model-driven-current-form-id-selector-identity',
              factIds: ['native-lookup-original-34'],
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/model-driven/client-runtime.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/model_driven_remediation',
            reason:
              'The production client runtime implements the selector and collection APIs exercised by the original assertions.',
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
              baselineId: 'mirage/test/model-driven-collections.test.mjs:22:0',
              title:
                'form items resolve by form identity while attribute and control collections retain their own names',
            },
          ],
          casesSha256: '74fed432d9be3b9f9563b19eac285eb02b6971a9bb6a56d8389f84fe075cad99',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/model-driven-single-form-native-facts.json',
            sha256: 'a8fb304427b03cf01a08798123956d8f9d28091baa55240f536d7e6a7b2b56b1',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-one-form-first-expression',
                pointer: '/captures/0/cases/0/facts',
                sha256: '2d451927e2827951ae4748c63549d3d50754dc9d2e603a8c2beece85e8afa10c',
                replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
              },
              {
                id: 'native-one-form-source-context',
                pointer: '/captures/0/source',
                sha256: '861fa0a6ac3d232a77ce98e2206d2b4d7869933143210f862a03cc723f9fc4c3',
                replicatedPointers: ['/captures/0/source', '/captures/1/source'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/model-driven-single-form-lookup-native-facts.json',
            sha256: '399620eaebfa933d1d851b29feb4050618a61884ad7ede46b9a77dd4a7ee4eff',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-lookup-original-31',
                pointer: '/captures/0/cases/3/facts',
                sha256: '6aa203b50028e75016b891864c3184416f23efeb102429182ebf1558e15df717',
                replicatedPointers: ['/captures/0/cases/3/facts', '/captures/1/cases/3/facts'],
              },
              {
                id: 'native-lookup-original-32',
                pointer: '/captures/0/cases/5/facts',
                sha256: '230077ba6dfcbb3a0fbaaf4f26bffb3b155b2d71cf8550302767a701fd81dded',
                replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
              },
              {
                id: 'native-lookup-original-33',
                pointer: '/captures/0/cases/8/facts',
                sha256: '4015448f180ccabde980d321d5facefaf553530a9c28e970fd6a44abf5dddf55',
                replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
              },
              {
                id: 'native-lookup-original-34',
                pointer: '/captures/0/cases/9/facts',
                sha256: '51b03d3cb1972436902cb08ce1275e044a97df244c3b40fe42c65622145d1c44',
                replicatedPointers: ['/captures/0/cases/9/facts', '/captures/1/cases/9/facts'],
              },
              {
                id: 'native-lookup-original-40',
                pointer: '/captures/0/cases/10/facts',
                sha256: '7aa511d8a4c9f5420cafbd6eb95c2d21f9ba6c94891e0b1c693baf084c819f68',
                replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
              },
              {
                id: 'native-lookup-original-41',
                pointer: '/captures/0/cases/11/facts',
                sha256: '8f7c8c4b3ed3d08fd960f41a5b18297e4018faa151e292d67559724c62983e53',
                replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
              },
              {
                id: 'native-lookup-original-42',
                pointer: '/captures/0/cases/13/facts',
                sha256: 'c318f1b59b6aeaad187eb57184bba78a032ea36a540842f42f515161102eea40',
                replicatedPointers: ['/captures/0/cases/13/facts', '/captures/1/cases/13/facts'],
              },
              {
                id: 'native-lookup-original-46',
                pointer: '/captures/0/cases/14/facts',
                sha256: 'fa5833f95ecce1918ddf09b6eaae418cc754da74a680dde7faf7dd7ed252a6e7',
                replicatedPointers: ['/captures/0/cases/14/facts', '/captures/1/cases/14/facts'],
              },
              {
                id: 'native-lookup-original-32-exact-literal',
                pointer: '/captures/0/cases/6/facts',
                sha256: '6f3df1e00bcd78abf2465c709cfd353ab721e8d17202d6abb29a586130377d8b',
                replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
              },
              {
                id: 'native-lookup-original-33-exact-literal',
                pointer: '/captures/0/cases/7/facts',
                sha256: 'dfa724b75b4ec9bcd401492afdc1365a9b6995a4bc5249ef9b2e2408154ca49d',
                replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          ['6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51'],
          [
            'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
            '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
            'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
            '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
          ],
          [
            'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
            '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
            'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
            '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
          ],
        ],
        regionFactIds: [
          [['native-one-form-first-expression', 'native-one-form-source-context']],
          [
            ['native-lookup-original-31'],
            ['native-lookup-original-32-exact-literal', 'native-lookup-original-32'],
            ['native-lookup-original-33-exact-literal', 'native-lookup-original-33'],
            ['native-lookup-original-34'],
          ],
          [
            ['native-lookup-original-40'],
            ['native-lookup-original-41'],
            ['native-lookup-original-42'],
            ['native-lookup-original-46'],
          ],
        ],
      },
    ]);
    assert.equal(forms.get(formId), current);
    assert.equal(forms.get(`{${formId.toUpperCase()}}`), null);
    assert.equal(forms.get('Invented form'), null, 'the form label is not its identity');
    assert.equal(forms.get('ffffffff-ffff-4fff-8fff-ffffffffffff'), null);
  }
  assert.equal(attributes.get('x_title').getName(), 'x_title');
  assert.equal(attributes.get('title_editor'), undefined);
  assert.equal(controls.get('title_editor').getAttribute().getName(), 'x_title');
  assert.equal(controls.get('x_title'), undefined);
  assert.equal(attributes.get('x_title').controls.get('title_editor').getName(), 'title_editor');
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/model-driven-collections.test.mjs:22:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '4c6bbd62b4c4433cee8957f3b0ef694cb6dad2ce4308aec94002306b8c00fe7f',
        originalAssertions: [
          '6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51',
          '380b585438d198366baf1ed43c933d06d9e4c4a8caf2f93958c32b1638ed30c4',
          'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
          '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
          'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
          '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
          'b52eac841d90a281a3944aaf1e857f0486cf7d098ecde0a9c460669068fe3b31',
          'ca00200da7e9896cea4a55d61a734e0b26a06d68865508d8fbefb37d2a6ba991',
          'c661d6f94eec42e6a4c9214b02ad2676e2cec13ee1a280728e479aeb5414ada4',
          '01c74616f427e0b97162f34d6d6b9dbc74e27d3c9411e0d5be988c3faa881fe9',
          '02b60046174e22d4253ec925360850120e291d80244b8305f3c57df3f56c4bef',
          'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
          '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
          'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
          '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
          'cd2a1734927c93c5cd737068d49cd7252bf6025981cd2a601d47f23e9a19a77a',
          '55db03756ff2a2a3829c3eba779ea47ddc589d3bb9b4bfb6f606d2fd718f7e8c',
        ],
        baselineOriginalAssertions: [
          '6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51',
          '380b585438d198366baf1ed43c933d06d9e4c4a8caf2f93958c32b1638ed30c4',
          'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
          'cefc0015b9af5800a84a22fd57d0519b1650373164f3f8fc2d726e6611b0ad28',
          '98161de53dc8d2f0ea31ea79f517a28f8821dfd57ae86f09733ea3fa0fe5af5a',
          '7161253441a0d6c5862dcb00f10e13aff322f765a4b1fceed932ff57e6ef35f8',
          'b52eac841d90a281a3944aaf1e857f0486cf7d098ecde0a9c460669068fe3b31',
          'ca00200da7e9896cea4a55d61a734e0b26a06d68865508d8fbefb37d2a6ba991',
          'c661d6f94eec42e6a4c9214b02ad2676e2cec13ee1a280728e479aeb5414ada4',
          '01c74616f427e0b97162f34d6d6b9dbc74e27d3c9411e0d5be988c3faa881fe9',
          '02b60046174e22d4253ec925360850120e291d80244b8305f3c57df3f56c4bef',
          'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
          '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
          'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
          '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
          'cd2a1734927c93c5cd737068d49cd7252bf6025981cd2a601d47f23e9a19a77a',
          '55db03756ff2a2a3829c3eba779ea47ddc589d3bb9b4bfb6f606d2fd718f7e8c',
        ],
        originalBodyAstSha256: 'f081f490427db5dfdd02e27b15b8eeb38a5e20ab8861953a78478d7a222d2ad7',
        baselineBodyAstSha256: 'd99e6ab26f66991a5ba450b88234aa9fffede5258f80054e630bcd3219ca59c4',
        originalGuardHashes: [],
        moduleContextAstSha256: '2b3f2c15a3c3a6f5299ad4c98b7a2b2fcade30e8de66af5818cfbe8e74738a8b',
        moduleReview: {
          reviewedBy: '/root/frontend',
          reason:
            'Only three native-backed selector expected values change; exact producer/input and all unrelated assertions and protected original proof objects are retained.',
          addedTests: [],
          corrections: [
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Source-relative upper-braced input returns typed null; original expects current. Authored literal separately returns null. Two fresh source-bound typed null results license only this expected-value correction.',
              oldAstSha256: 'cefc0015b9af5800a84a22fd57d0519b1650373164f3f8fc2d726e6611b0ad28',
              currentAstSha256: '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
              guaranteeId: 'model-driven-current-form-id-selector-identity',
              factIds: ['native-lookup-original-32-exact-literal', 'native-lookup-original-32'],
            },
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Native current.getLabel equals actual source name; its exact lookup returns null. Authored Invented form literal also returns null but is not the native source label. Two fresh source-bound typed null results license only this expected-value correction.',
              oldAstSha256: '98161de53dc8d2f0ea31ea79f517a28f8821dfd57ae86f09733ea3fa0fe5af5a',
              currentAstSha256: 'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
              guaranteeId: 'model-driven-current-form-id-selector-identity',
              factIds: ['native-lookup-original-33-exact-literal', 'native-lookup-original-33'],
            },
            {
              sameGuarantee: true,
              reviewedBy: '/root/frontend',
              reason:
                'Exact authored unknown GUID returns typed null; original expects undefined. Two fresh source-bound typed null results license only this expected-value correction.',
              oldAstSha256: '7161253441a0d6c5862dcb00f10e13aff322f765a4b1fceed932ff57e6ef35f8',
              currentAstSha256: '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
              guaranteeId: 'model-driven-current-form-id-selector-identity',
              factIds: ['native-lookup-original-34'],
            },
          ],
        },
        importRoles: [
          {
            source: '../lib/model-driven/client-runtime.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/model_driven_remediation',
            reason:
              'The production client runtime implements the selector and collection APIs exercised by the original assertions.',
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
              baselineId: 'mirage/test/model-driven-collections.test.mjs:22:0',
              title:
                'form items resolve by form identity while attribute and control collections retain their own names',
            },
          ],
          casesSha256: '74fed432d9be3b9f9563b19eac285eb02b6971a9bb6a56d8389f84fe075cad99',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/model-driven-single-form-native-facts.json',
            sha256: 'a8fb304427b03cf01a08798123956d8f9d28091baa55240f536d7e6a7b2b56b1',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-one-form-first-expression',
                pointer: '/captures/0/cases/0/facts',
                sha256: '2d451927e2827951ae4748c63549d3d50754dc9d2e603a8c2beece85e8afa10c',
                replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
              },
              {
                id: 'native-one-form-source-context',
                pointer: '/captures/0/source',
                sha256: '861fa0a6ac3d232a77ce98e2206d2b4d7869933143210f862a03cc723f9fc4c3',
                replicatedPointers: ['/captures/0/source', '/captures/1/source'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/model-driven-single-form-lookup-native-facts.json',
            sha256: '399620eaebfa933d1d851b29feb4050618a61884ad7ede46b9a77dd4a7ee4eff',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'native-lookup-original-31',
                pointer: '/captures/0/cases/3/facts',
                sha256: '6aa203b50028e75016b891864c3184416f23efeb102429182ebf1558e15df717',
                replicatedPointers: ['/captures/0/cases/3/facts', '/captures/1/cases/3/facts'],
              },
              {
                id: 'native-lookup-original-32',
                pointer: '/captures/0/cases/5/facts',
                sha256: '230077ba6dfcbb3a0fbaaf4f26bffb3b155b2d71cf8550302767a701fd81dded',
                replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
              },
              {
                id: 'native-lookup-original-33',
                pointer: '/captures/0/cases/8/facts',
                sha256: '4015448f180ccabde980d321d5facefaf553530a9c28e970fd6a44abf5dddf55',
                replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
              },
              {
                id: 'native-lookup-original-34',
                pointer: '/captures/0/cases/9/facts',
                sha256: '51b03d3cb1972436902cb08ce1275e044a97df244c3b40fe42c65622145d1c44',
                replicatedPointers: ['/captures/0/cases/9/facts', '/captures/1/cases/9/facts'],
              },
              {
                id: 'native-lookup-original-40',
                pointer: '/captures/0/cases/10/facts',
                sha256: '7aa511d8a4c9f5420cafbd6eb95c2d21f9ba6c94891e0b1c693baf084c819f68',
                replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
              },
              {
                id: 'native-lookup-original-41',
                pointer: '/captures/0/cases/11/facts',
                sha256: '8f7c8c4b3ed3d08fd960f41a5b18297e4018faa151e292d67559724c62983e53',
                replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
              },
              {
                id: 'native-lookup-original-42',
                pointer: '/captures/0/cases/13/facts',
                sha256: 'c318f1b59b6aeaad187eb57184bba78a032ea36a540842f42f515161102eea40',
                replicatedPointers: ['/captures/0/cases/13/facts', '/captures/1/cases/13/facts'],
              },
              {
                id: 'native-lookup-original-46',
                pointer: '/captures/0/cases/14/facts',
                sha256: 'fa5833f95ecce1918ddf09b6eaae418cc754da74a680dde7faf7dd7ed252a6e7',
                replicatedPointers: ['/captures/0/cases/14/facts', '/captures/1/cases/14/facts'],
              },
              {
                id: 'native-lookup-original-32-exact-literal',
                pointer: '/captures/0/cases/6/facts',
                sha256: '6f3df1e00bcd78abf2465c709cfd353ab721e8d17202d6abb29a586130377d8b',
                replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
              },
              {
                id: 'native-lookup-original-33-exact-literal',
                pointer: '/captures/0/cases/7/facts',
                sha256: 'dfa724b75b4ec9bcd401492afdc1365a9b6995a4bc5249ef9b2e2408154ca49d',
                replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          ['6a788e0950d9393a833bbf5551741b70bdcc01df9166a5524e256bd20530af51'],
          [
            'b48f11776179f025af4530d491622d08cf9dcf0ab609e7231933087951234ef6',
            '6c7c0e08df8411aca00e3fcf5b5f68fced266442580207e60acd66461bb1714a',
            'd22270b1bbda4c128f530b49589eb98ed90da62adb4c1bde731c9e36b4bc5cd6',
            '45135c08ec7a79659cf69185471ad34c1302a63ca30e39dc08cb6443dbbbe18e',
          ],
          [
            'e272f1ff3cb5b57e6cc5f0bbb77a75e1610d5df99d18eab16a0408c0c01e106c',
            '0a28bf0d244e300ce82049dfa80f6b29a2d6fbd3e45e907e36a8b0ce04e6f3a1',
            'e6d5cad2190f21b56696a8b9274e96610c113b2fea9c7d32da0d2e3e1467f08d',
            '16097c27b75fbc60748d3d3a981131047a6efac1e2d76120cde42b33f955231d',
          ],
        ],
        regionFactIds: [
          [['native-one-form-first-expression', 'native-one-form-source-context']],
          [
            ['native-lookup-original-31'],
            ['native-lookup-original-32-exact-literal', 'native-lookup-original-32'],
            ['native-lookup-original-33-exact-literal', 'native-lookup-original-33'],
            ['native-lookup-original-34'],
          ],
          [
            ['native-lookup-original-40'],
            ['native-lookup-original-41'],
            ['native-lookup-original-42'],
            ['native-lookup-original-46'],
          ],
        ],
      },
    ]);
    assert.equal(forms.get(0), current);
    assert.deepEqual(forms.get(), [current]);
    assert.deepEqual(
      forms.get((item, index) => index === 0 && item.getId() === current.getId()),
      [current],
    );
    assert.deepEqual(
      forms.get(() => false),
      [],
    );
  }
  assert.equal(controls.get(1).getName(), 'count_editor');
  assert.deepEqual(
    attributes.get((attribute, index) => index === 1).map((attribute) => attribute.getName()),
    ['x_count'],
  );
});

test('form collection identity lookups preserve disposed-context checks', () => {
  const runtime = fixture(),
    form = runtime.formContext,
    items = form.ui.formSelector.items,
    attributes = form.data.entity.attributes,
    controls = form.ui.controls,
    retained = items.get(formId);
  runtime.destroy();
  assert.throws(() => items.get(formId), /disposed/);
  assert.throws(() => retained.getId(), /disposed/);
  assert.throws(() => attributes.get('x_title'), /disposed/);
  assert.throws(() => controls.get('title_editor'), /disposed/);
  assert.throws(() => items.get(0).getId(), /disposed/);
});
