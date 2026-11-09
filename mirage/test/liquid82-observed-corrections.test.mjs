// @test-kind parity: two source-frozen native include renders in power-pages-existing-liquid-evidence.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { observedConfig } from '../lib/project-config.mjs';

test('observed filters reproduce repeated native numeric, registration, HTML and URL results', async () => {
  const bytes = readFileSync(new URL('./fixtures/power-pages-existing-liquid-evidence.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
  );
  const evidence = JSON.parse(bytes);
  const engine = createPortalRenderer({
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
    observed: {
      liquidRuntimeCompatibility: 'observed',
      liquidFilterRegistration: 'observed',
      liquidTimesDispatch: 'observed',
      liquidFilterErrors: 'observed',
      liquidHtmlVoidSerialization: 'html',
      liquidHtmlSafeInput: 'observed',
      liquidRelativeQueryResolution: 'root',
    },
  });
  for (const id of [
    '004',
    '005',
    '012',
    '013',
    '015',
    '018',
    '019',
    '023',
    '027',
    '031',
    '032',
    '033',
    '035',
    '037',
    '043',
    '045',
    '056',
    '072',
    '079',
    '080',
  ].map((id) => `original-liquid-${id}`)) {
    const [first, second] = evidence.captures.map((capture) => capture.cases.find((item) => item.id === id).facts);
    assert.deepEqual(first, second, id);
    assert.equal(first.outcome, 'rendered-child', id);
    assert.equal(await engine.renderString(first.source), first.output, id);
  }
});

// @test-kind contract: relative-query observation is opt-in and leaves the absolute-URL path unchanged.
test('relative query resolution is explicitly selected', async () => {
  assert.throws(() => observedConfig({ liquidRelativeQueryResolution: 'root' }), /evidence/);
  assert.equal(
    observedConfig({ liquidRelativeQueryResolution: 'root', evidence: 'fixture' }).liquidRelativeQueryResolution,
    'root',
  );
  assert.throws(
    () => observedConfig({ liquidRelativeQueryResolution: 'invalid', evidence: 'fixture' }),
    /liquidRelativeQueryResolution/,
  );
  const portal = {
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
  };
  const source =
    "{{ '../next/?id=1#part' | add_query: 'tab', 'x' }}|{{ 'https://example.test/a#part' | add_query: 'tab', 'x' }}";
  assert.equal(
    await createPortalRenderer(portal).renderString(source),
    '../next/?id=1&tab=x#part|https://example.test/a?tab=x#part',
  );
  const observed = createPortalRenderer({ ...portal, observed: { liquidRelativeQueryResolution: 'root' } });
  assert.equal(await observed.renderString(source), '/next/?id=1&tab=x|https://example.test/a?tab=x#part');
});

test('observed runtime reproduces native child compilation and nil and symbol rendering', async () => {
  const bytes = readFileSync(new URL('./fixtures/power-pages-existing-liquid-evidence.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '241c77a32fa2fd08d6436a848114841f0dd6eb56d3548f1b0bcc07871c42b5a0',
  );
  const evidence = JSON.parse(bytes);
  for (const id of ['002', '044', '046', '047', '048', '050', '056', '080']) {
    const [first, second] = evidence.captures.map(
      (capture) => capture.cases.find((item) => item.id === `original-liquid-${id}`).facts,
    );
    assert.deepEqual(first, second, id);
    const engine = createPortalRenderer({
      templates: { proof: { id: 'proof', name: 'proof', source: first.source } },
      snippets: {},
      settings: {},
      pages: [],
      webFiles: [],
      records: [],
      weblinks: {},
      sitemarkers: {},
      website: {},
      pageTemplates: [],
      observed: { liquidRuntimeCompatibility: 'observed' },
    });
    assert.equal(await engine.renderString("{% include 'proof' %}"), first.output, id);
  }
});
