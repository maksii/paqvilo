// @test-kind tooling: bounded included-renderer isolation is a source guard, not native parity proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeParitySource } from '../scripts/qualify-parity.mjs';
import { analyzeIncludedRendererSlice } from '../scripts/parity-included-renderer-slice.mjs';
const helpers =
  "function plain() {\n  const renderer = createPortalRenderer({\n    templates: {},\n    snippets: {},\n    settings: {},\n    pages: [],\n    webFiles: [],\n    records: [],\n    weblinks: {},\n    sitemarkers: {},\n    website: {},\n    pageTemplates: [],\n  });\n  return (source, data = {}) => renderer.renderString(source, data);\n}\nfunction nativeInclude() {\n  return (source, data = {}) =>\n    createPortalRenderer(\n      {\n        templates: { proof: { id: 'proof', name: 'proof', source } },\n        snippets: {},\n        settings: {},\n        pages: [],\n        webFiles: [],\n        records: [],\n        weblinks: {},\n        sitemarkers: {},\n        website: {},\n        pageTemplates: [],\n      },\n      {\n        observed: {\n          liquidRuntimeCompatibility: 'observed',\n          liquidFilterErrors: 'observed',\n          liquidHtmlVoidSerialization: 'html',\n          liquidPathAndQueryFragment: 'query',\n          evidence: 'Repeated native 2026-11-08 language include captures; frontend-parity-evidence.json.',\n        },\n      },\n    ).renderString(\"{% include 'proof' %}\", data);\n}";
const calls = (count) =>
  Array.from({ length: count }, (_, i) => `assert.equal(await render('case-${i}'), 'result');`).join('\n');
const base = `import test from 'node:test'; import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
${helpers}
test('plain', async () => { const render = plain(); ${calls(4)} });
test('loop', async () => { const render = nativeInclude(); ${calls(5)} });
test('cycle', async () => { const render = nativeInclude(); ${calls(3)} });
test('math', async () => { const render = nativeInclude(); ${calls(8)} });`;
const names = ['plain', 'loop', 'cycle', 'math'];
function classify(text = base, selectedNames = names, implementations = ['../lib/liquid.mjs']) {
  const model = describeParitySource(text, 'mirage/test/invented.test.mjs');
  return analyzeIncludedRendererSlice({
    ast: model.ast,
    selected: selectedNames.map((title) => ({ old: model.registrations.find((r) => r.title === title) })),
    implementationSources: implementations,
  });
}
test('certifies distinct plain and fresh include producers with ordered literal inputs', () => {
  const r = classify();
  assert.deepEqual(
    r.fixtures.map((x) => x.producerKind),
    ['plain-renderer', 'fresh-included-renderer', 'fresh-included-renderer', 'fresh-included-renderer'],
  );
  assert.deepEqual(
    r.fixtures.map((x) => x.calls.length),
    [4, 5, 3, 8],
  );
  assert.equal(r.requiresAllRegistrations, true);
  assert.equal(r.requiresModuleIsolationProof, true);
  assert.notEqual(r.fixtures[1].calls[0].inputSha256, r.fixtures[1].calls[1].inputSha256);
  assert.equal(classify(base, names, []).fixtures.length, 0);
  assert.equal(classify(base, names.slice(0, 2)).fixtures.length, 0);
  const old = base.replaceAll('const render = nativeInclude();', 'const render = plain();');
  const baseline = classify(old);
  assert.deepEqual(
    baseline.fixtures.map((x) => x.producerKind),
    Array(4).fill('plain-renderer'),
  );
  for (let i = 0; i < 4; i++)
    assert.deepEqual(
      baseline.fixtures[i].calls.map((x) => x.inputSha256),
      r.fixtures[i].calls.map((x) => x.inputSha256),
    );
});
test('rejects helper settings, source and template changes', () => {
  for (const changed of [
    base.replace("liquidRuntimeCompatibility: 'observed'", "liquidRuntimeCompatibility: 'dotliquid'"),
    base.replace("id: 'proof', name: 'proof', source", "id: 'other', name: 'proof', source"),
    base.replace("id: 'proof', name: 'proof', source", "id: 'proof', name: 'proof', source: 'fixed'"),
    base.replace('.renderString("{% include \'proof\' %}", data)', '.renderString("{% include \'other\' %}", data)'),
    base.replace('function nativeInclude()', 'function* nativeInclude()'),
  ]) {
    assert.notEqual(changed, base);
    assert.equal(classify(changed).fixtures.length, 0);
  }
});
test('rejects mutation, escaped renderers, ambient inputs and asynchronous reorderings', () => {
  const d = 'const render = nativeInclude();';
  for (const changed of [
    base.replace(d, d + ' globalThis.shared = render;'),
    base.replace(d, d + ' const escaped = render;'),
    base.replace(d, d + " render('unawaited');"),
    base.replace("await render('case-0')", "render('case-0')"),
    base.replace("await render('case-0')", 'await render(process.env.VALUE)'),
    base.replace(d, 'let render = nativeInclude(); render = nativeInclude();'),
    base + "\ntest('unreviewed', () => { globalThis.x = nativeInclude(); });\n",
    base.replace("test('loop', async ()", "test('loop', { concurrency: true }, async ()"),
    base.replace("test('loop', async ()", "for (const v of [1]) test('loop', async ()"),
  ]) {
    assert.notEqual(changed, base);
    assert.equal(classify(changed).fixtures.length, 0);
  }
});
