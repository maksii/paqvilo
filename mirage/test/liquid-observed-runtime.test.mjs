// @test-kind unproven: observed and diagnostic Liquid runtime models; only explicitly reproduced assertion regions carry parity.
import {
  parityAssertions as __paqParityAssertions,
  assertParityBindings as __paqParityBindings,
} from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/liquid-observed-runtime.test.mjs:21:0',
    repositoryRoot: '../..',
    titleExpressionSha256: '6a7d932f2a9a8fb9b3877dc548793a3b5a97a0b2db44d0ddc657b5b35baae4e8',
    originalAssertions: [
      'bfa64cfc64ef483802fbc5263f8d6076faf3aa9cc8c6cfae13b204fc9793ebd6',
      '177bbce973b207b1fa18a323794416ef7f2998661975655b81131fb893358212',
      'cb2c9ccbe20026b7784a2f182d9ad8d453eecb8f52d1fa1fc14ce92d0a9494bc',
    ],
    originalBodyAstSha256: '62a388ff7d5572eba3556aecc52dc72894e398bd798e70500eac761881e4eacb',
    originalGuardHashes: [],
    moduleContextAstSha256: 'cc0b6b9760ae63e2dd3746f83bb52877c038364b9b06cf2799709eab3f967f32',
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-engine.mjs',
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
          baselineId: 'mirage/test/liquid-observed-runtime.test.mjs:21:0',
          title: 'observed runtime uses the verified blank predicate and string-array index errors',
        },
      ],
      casesSha256: '53d26eab8375c97376d95c8485b7e38abd4802514ee2d5d49a44bbd417f756c4',
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
            id: 'native-original-liquid-041',
            pointer: '/captures/0/cases/40/facts',
            sha256: '35bbc50f0f2495f109815e174ed07d800113112a27ee49afb1c7389ad5fb2a36',
            replicatedPointers: ['/captures/0/cases/40/facts', '/captures/1/cases/40/facts'],
          },
          {
            id: 'native-original-liquid-042',
            pointer: '/captures/0/cases/41/facts',
            sha256: 'af58e58f76e8b20d30e15b6a2c0930170a8923703405e94334c74c0c9da9ff86',
            replicatedPointers: ['/captures/0/cases/41/facts', '/captures/1/cases/41/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        'bfa64cfc64ef483802fbc5263f8d6076faf3aa9cc8c6cfae13b204fc9793ebd6',
        '177bbce973b207b1fa18a323794416ef7f2998661975655b81131fb893358212',
      ],
    ],
    regionFactIds: [[['native-original-liquid-041'], ['native-original-liquid-042']]],
  },
  {
    baselineId: 'mirage/test/liquid-observed-runtime.test.mjs:43:0',
    repositoryRoot: '../..',
    titleExpressionSha256: 'c0c76bbe28bac3d3c8f8c7dfeebbde7797b9f8b1f27a49faab58c20fdd59710b',
    originalAssertions: [
      '86476af1cf34b9115698f3e9b436ae199e1a8eae009b4fd56d9cdfad0ef95c42',
      'c5e3cf7c3dc287b068f193103e2e9ce63a4c8036a8817b377b2bbdf46b1187a6',
      '0d8e2e49b8558ffa936ed961b1020ce12db9fe07d41c4d88c9df39f3df4ca691',
      'bf9adda8a7af4f3da9f2a885d7c59a0907bd3fd3f2c31b290c641a0ec9e1ec24',
      'a869346c7fa0123203e37b7f84823d419acbd9d34a62e93f59171c8edbc457f6',
      '209124b670c38648782b0113e3b668574d996af93b67924847733a14da156ed1',
      'fdca2dc2115f35f0daa20e12c4e8cb458647ea54b864a241818e885d61135691',
      '5c9507cf9778e3505d2c5e3500fb3d68707340046c875457b8aec8d6506a8df8',
    ],
    originalBodyAstSha256: '8777d868c921e7e531929c8945abcdedc073941c01bcfc476d11e0fc0c69e1c5',
    originalGuardHashes: [],
    moduleContextAstSha256: 'cc0b6b9760ae63e2dd3746f83bb52877c038364b9b06cf2799709eab3f967f32',
    importRoles: [
      {
        source: '../lib/liquid.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/frontend',
        reason:
          'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
      },
      {
        source: '../lib/liquid-engine.mjs',
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
          baselineId: 'mirage/test/liquid-observed-runtime.test.mjs:43:0',
          title: 'observed runtime preserves hosted parse and parenthesized-condition behavior',
        },
      ],
      casesSha256: 'a666d822ca425b00f357e5587dfb36f322d7b28db9896db4e372463ab6bc8ff7',
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
            id: 'native-original-liquid-045',
            pointer: '/captures/0/cases/44/facts',
            sha256: '667f312f261fb4f8fcb6225a3aaff0598340acf4f3ee063ba4d242b59d3ccf2c',
            replicatedPointers: ['/captures/0/cases/44/facts', '/captures/1/cases/44/facts'],
          },
        ],
      },
    ],
    regionHashes: [['0d8e2e49b8558ffa936ed961b1020ce12db9fe07d41c4d88c9df39f3df4ca691']],
    regionFactIds: [[['native-original-liquid-045']]],
  },
]);
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { LiquidHash } from '../lib/liquid-engine.mjs';

const renderer = (mode) =>
  createPortalRenderer({
    templates: {},
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    records: [],
    website: {},
    weblinks: {},
    sitemarkers: {},
    pageTemplates: [],
    observed: { liquidRuntimeCompatibility: mode },
  });

test('observed runtime uses the verified blank predicate and string-array index errors', async () => {
  const engine = renderer('observed');
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-runtime.test.mjs:21:0',
        repositoryRoot: '../..',
        titleExpressionSha256: '6a7d932f2a9a8fb9b3877dc548793a3b5a97a0b2db44d0ddc657b5b35baae4e8',
        originalAssertions: [
          'bfa64cfc64ef483802fbc5263f8d6076faf3aa9cc8c6cfae13b204fc9793ebd6',
          '177bbce973b207b1fa18a323794416ef7f2998661975655b81131fb893358212',
          'cb2c9ccbe20026b7784a2f182d9ad8d453eecb8f52d1fa1fc14ce92d0a9494bc',
        ],
        originalBodyAstSha256: '62a388ff7d5572eba3556aecc52dc72894e398bd798e70500eac761881e4eacb',
        originalGuardHashes: [],
        moduleContextAstSha256: 'cc0b6b9760ae63e2dd3746f83bb52877c038364b9b06cf2799709eab3f967f32',
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-engine.mjs',
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
              baselineId: 'mirage/test/liquid-observed-runtime.test.mjs:21:0',
              title: 'observed runtime uses the verified blank predicate and string-array index errors',
            },
          ],
          casesSha256: '53d26eab8375c97376d95c8485b7e38abd4802514ee2d5d49a44bbd417f756c4',
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
                id: 'native-original-liquid-041',
                pointer: '/captures/0/cases/40/facts',
                sha256: '35bbc50f0f2495f109815e174ed07d800113112a27ee49afb1c7389ad5fb2a36',
                replicatedPointers: ['/captures/0/cases/40/facts', '/captures/1/cases/40/facts'],
              },
              {
                id: 'native-original-liquid-042',
                pointer: '/captures/0/cases/41/facts',
                sha256: 'af58e58f76e8b20d30e15b6a2c0930170a8923703405e94334c74c0c9da9ff86',
                replicatedPointers: ['/captures/0/cases/41/facts', '/captures/1/cases/41/facts'],
              },
            ],
          },
        ],
        regionHashes: [
          [
            'bfa64cfc64ef483802fbc5263f8d6076faf3aa9cc8c6cfae13b204fc9793ebd6',
            '177bbce973b207b1fa18a323794416ef7f2998661975655b81131fb893358212',
          ],
        ],
        regionFactIds: [[['native-original-liquid-041'], ['native-original-liquid-042']]],
      },
    ]);
    assert.equal(
      await engine.renderString(
        "{% if '' == blank %}T{% endif %}|{% if ' ' == blank %}T{% endif %}|{% if nil == blank %}T{% endif %}|{% if false == blank %}T{% endif %}",
      ),
      'T|||',
    );
    assert.equal(
      await engine.renderString(
        "{% assign a = 'zero,one' | split: ',' %}[{{ a[0] }}]|[{{ a[-1] }}]|[{{ a[99] }}]|[{{ a['1'] }}]|[{{ a[1.5] }}]",
      ),
      '[zero]|[Liquid error: Index was outside the bounds of the array.]|[Liquid error: Index was outside the bounds of the array.]|[]|[]',
    );
  }
  assert.equal(
    await renderer('dotliquid').renderString(
      "{% assign a = 'zero,one' | split: ',' %}[{{ a[-1] }}]|[{{ a[99] }}]|{% if nil == blank %}T{% endif %}",
    ),
    '[one]|[]|T',
  );
});

test('observed runtime preserves hosted parse and parenthesized-condition behavior', async () => {
  const source = '{% for i in (3..1) %}{{ i }}{% else %}empty{% endfor %}';
  assert.equal(await renderer('observed').renderString(source), 'for tag does not expect else tag');
  assert.equal(await renderer('dotliquid').renderString(source), 'empty');
  {
    __paqParityAssertions(import.meta.url, [
      {
        baselineId: 'mirage/test/liquid-observed-runtime.test.mjs:43:0',
        repositoryRoot: '../..',
        titleExpressionSha256: 'c0c76bbe28bac3d3c8f8c7dfeebbde7797b9f8b1f27a49faab58c20fdd59710b',
        originalAssertions: [
          '86476af1cf34b9115698f3e9b436ae199e1a8eae009b4fd56d9cdfad0ef95c42',
          'c5e3cf7c3dc287b068f193103e2e9ce63a4c8036a8817b377b2bbdf46b1187a6',
          '0d8e2e49b8558ffa936ed961b1020ce12db9fe07d41c4d88c9df39f3df4ca691',
          'bf9adda8a7af4f3da9f2a885d7c59a0907bd3fd3f2c31b290c641a0ec9e1ec24',
          'a869346c7fa0123203e37b7f84823d419acbd9d34a62e93f59171c8edbc457f6',
          '209124b670c38648782b0113e3b668574d996af93b67924847733a14da156ed1',
          'fdca2dc2115f35f0daa20e12c4e8cb458647ea54b864a241818e885d61135691',
          '5c9507cf9778e3505d2c5e3500fb3d68707340046c875457b8aec8d6506a8df8',
        ],
        originalBodyAstSha256: '8777d868c921e7e531929c8945abcdedc073941c01bcfc476d11e0fc0c69e1c5',
        originalGuardHashes: [],
        moduleContextAstSha256: 'cc0b6b9760ae63e2dd3746f83bb52877c038364b9b06cf2799709eab3f967f32',
        importRoles: [
          {
            source: '../lib/liquid.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/frontend',
            reason:
              'Production renderer, import, filter, parser or sweep implementation exercised by this file. Selected source-local assertions bind explicit literal/input/output facts; production implementations remain mutable for remediation.',
          },
          {
            source: '../lib/liquid-engine.mjs',
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
              baselineId: 'mirage/test/liquid-observed-runtime.test.mjs:43:0',
              title: 'observed runtime preserves hosted parse and parenthesized-condition behavior',
            },
          ],
          casesSha256: 'a666d822ca425b00f357e5587dfb36f322d7b28db9896db4e372463ab6bc8ff7',
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
                id: 'native-original-liquid-045',
                pointer: '/captures/0/cases/44/facts',
                sha256: '667f312f261fb4f8fcb6225a3aaff0598340acf4f3ee063ba4d242b59d3ccf2c',
                replicatedPointers: ['/captures/0/cases/44/facts', '/captures/1/cases/44/facts'],
              },
            ],
          },
        ],
        regionHashes: [['0d8e2e49b8558ffa936ed961b1020ce12db9fe07d41c4d88c9df39f3df4ca691']],
        regionFactIds: [[['native-original-liquid-045']]],
      },
    ]);
    assert.equal(await renderer('observed').renderString('{% if (true or false) %}marker{% endif %}'), '');
  }
  assert.equal(await renderer('dotliquid').renderString('{% if (true or false) %}marker{% endif %}'), 'marker');
  assert.equal(await renderer('observed').renderString('{% increment probe %}'), "Unknown tag 'increment'");
  assert.equal(await renderer('observed').renderString('{% decrement probe %}'), "Unknown tag 'decrement'");
  assert.equal(
    await renderer('observed').renderString("{% liquid\nassign probe = 'value'\n%}"),
    "Tag '{%' was not properly terminated with regexp: (?-mix:\\%\\})",
  );
  assert.equal(
    await renderer('observed').renderString("{{ 'first\nsecond' }}"),
    "Variable '{{' was not properly terminated with regexp: (?-mix:\\}\\})",
  );
});

test('observed request encoding follows direct aliases and resets after literal assignment and capture', async () => {
  const engine = renderer('observed');
  const context = engine.contextForPage(
    { id: '00000000-0000-4000-8000-000000000001', url: '/', metadata: {} },
    '/?probe=a%26b%22c',
  );
  const source =
    "{{ params.probe }}|{{ request.params.probe }}|{% assign alias = request.params.probe %}{{ alias }}|{{ alias | escape }}|{% assign alias = 'literal & text' %}{{ alias }}|{% capture alias %}{{ params.probe }}{% endcapture %}{{ alias }}";
  assert.equal(
    await engine.renderString(source, context),
    'a&amp;b&quot;c|a&amp;b&quot;c|a&amp;b&quot;c|a&amp;b&quot;c|literal & text|a&amp;b&quot;c',
  );
});

test('current-page editable rendering derives distinct root and content metadata while keeping defaults', async () => {
  const websiteId = '10000000-0000-4000-8000-000000000001',
    rootId = '20000000-0000-4000-8000-000000000001',
    contentId = '30000000-0000-4000-8000-000000000001';
  const portal = {
    templates: {},
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    records: [],
    website: { id: websiteId },
    weblinks: {},
    sitemarkers: {},
    pageTemplates: [],
  };
  const page = { id: rootId, title: 'Fixture', url: '/fixture/', metadata: { adx_webpageid: contentId } };
  const engine = createPortalRenderer(portal, { observed: { liquidEditableMetadata: 'observed' } });
  const source = "{% editable page 'adx_title' type:'text' %}";
  const html = await engine.renderString(source, engine.contextForPage(page, '/fixture/'));
  assert.ok(html.includes('/adx_webpage/' + contentId + '/adx_title'));
  assert.ok(html.includes('working=' + Buffer.from('adx_webpage:' + rootId + ':False').toString('base64')));
  assert.ok(html.endsWith('<div class="xrm-attribute-value">Fixture</div></div>'));
  const defaults = createPortalRenderer(portal);
  assert.equal(
    await defaults.renderString(source, defaults.contextForPage(page, '/fixture/')),
    '<div class="xrm-editable-text&#32;xrm-attribute"><div class="xrm-attribute-value">Fixture</div></div>',
  );
});

test('observed request pairs keep known parameters but reject numeric entry indexing', async () => {
  const source =
    '[{{ request.params.size }}]|{% for pair in request.params %}[{{ pair[0] | escape }}:{{ pair | size }}]{% endfor %}|{{ params.probe }}';
  const page = { id: '00000000-0000-4000-8000-000000000001', url: '/', metadata: {} };
  const observed = renderer('observed'),
    defaults = renderer('dotliquid');
  assert.equal(
    await observed.renderString(source, observed.contextForPage(page, '/?probe=synthetic')),
    '[1]|[:0]|synthetic',
  );
  assert.equal(
    await defaults.renderString(source, defaults.contextForPage(page, '/?probe=synthetic')),
    '[1]|[probe:0]|synthetic',
  );
  assert.equal(
    await observed.renderString('{% for pair in fixture %}{{ pair[0] }}{% endfor %}', {
      fixture: new LiquidHash({ probe: 'synthetic' }),
    }),
    'probe',
  );
});

test('observed parameter loops hide the verified pair accessors while direct lookup and aliases work', async () => {
  const engine = renderer('observed');
  const page = { id: '00000000-0000-4000-8000-000000000001', url: '/', metadata: {} };
  const context = engine.contextForPage(page, '/?probe=synthetic&0=numeric-key');
  const comparisons =
    "{% if pair[0] == 'probe' %}I0;{% endif %}{% if pair[1] == 'synthetic' %}I1;{% endif %}{% if pair.Value == 'synthetic' %}UV;{% endif %}{% if pair.value == 'synthetic' %}LV;{% endif %}{% if pair == 'probe' %}BK;{% endif %}{% if pair.Key == 'probe' %}UK;{% endif %}{% if pair.key == 'probe' %}LK;{% endif %}{% if pair.Name == 'probe' %}UN;{% endif %}{% if pair.name == 'probe' %}LN;{% endif %}";
  for (const target of ['request.params', 'params', 'alias']) {
    const source = `{% assign alias = request.params %}{{ ${target}.size }}|{% for pair in ${target} %}${comparisons}{% endfor %}|{{ ${target}.probe }}|{{ ${target}['0'] }}`;
    assert.equal(await engine.renderString(source, context), '2||synthetic|numeric-key');
  }
});

test('parameter capabilities leave ordinary dictionary pairs and their formatting intact', async () => {
  const hash = new LiquidHash({ probe: 'synthetic' });
  const source =
    '{% for pair in fixture %}{{ pair[0] }}|{{ pair[1] }}|{{ pair.Key }}|{{ pair.Value }}|{{ pair }}{% endfor %}';
  for (const mode of ['observed', 'dotliquid'])
    assert.equal(
      await renderer(mode).renderString(source, { fixture: hash }),
      'probe|synthetic|probe|synthetic|[probe, synthetic]',
    );
  const engine = renderer('observed');
  assert.equal(
    await engine.renderString(
      '{% for pair in params %}{{ pair.Key }}:{{ pair.Value }}{% endfor %}|{{ params.probe }}|{% for pair in fixture %}{{ pair.Key }}:{{ pair.Value }}{% endfor %}',
      { params: hash, request: { params: hash }, fixture: hash },
    ),
    ':|synthetic|probe:synthetic',
  );
  assert.equal(hash.numericPairLookup, true);
  assert.equal(hash.namedPairLookup, true);
});

test('parameter observation leaves general loop assignment and direct default parameter pairs unchanged', async () => {
  const control =
    "{% assign flag = false %}{% for item in (1..1) %}RANGE;{% assign flag = true %}{% endfor %}|{{ flag }}|{% assign items = 'synthetic' | split: ',' %}{% for item in items %}{% if item == 'synthetic' %}BARE;{% endif %}{% endfor %}";
  for (const mode of ['observed', 'dotliquid'])
    assert.equal(await renderer(mode).renderString(control), 'RANGE;|true|BARE;');
  assert.equal(
    await renderer('dotliquid').renderString(
      '{% for pair in params %}{{ pair[0] }}|{{ pair.Key }}|{{ pair[1] }}|{{ pair.Value }}{% endfor %}',
      { params: { probe: 'synthetic' } },
    ),
    'probe|probe|synthetic|synthetic',
  );
});
