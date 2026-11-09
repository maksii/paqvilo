// @test-kind tooling: In-memory renderer source isolation is a qualification mechanism, not platform evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyzeMemoryRendererSlice } from '../scripts/parity-memory-renderer-slice.mjs';

const { parse } = createRequire(import.meta.url)('espree');
const source = `import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './sut.mjs';
function renderer(observed, options = {}) {
  return createRenderer({ templates: {}, settings: { 'invented/key': '2' }, pages: [], observed }, options);
}
test('one', async () => { const engine = renderer({ mode: 'observed' }); assert.equal(await engine.renderString('one'), 'result'); });
test('two', async () => { const engine = renderer({ other: 'observed' }); assert.equal(await engine.renderString('two'), 'result'); });
`;
function analyzeSource(text = source, implementationSources = ['./sut.mjs']) {
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', range: true });
  const selected = ast.body
    .filter((item) => item.type === 'ExpressionStatement')
    .map((item, index) => ({ old: { id: `test:${index}`, callback: item.expression.arguments[1] } }));
  return analyzeMemoryRendererSlice({ ast, selected, implementationSources });
}
test('binds each fresh renderer input and the shared literal producer', () => {
  const result = analyzeSource();
  assert.equal(result.fixtures.length, 2);
  assert.equal(result.fixtures[0].helperSha256, result.fixtures[1].helperSha256);
  assert.notEqual(result.fixtures[0].inputSha256, result.fixtures[1].inputSha256);
  assert.equal(result.recognizedIdentifiers.size, 0);
  assert.equal(result.recognizedBuiltinImports.size, 0);
  assert.equal(result.isolatedIdentifiers.size, 0);
  assert.equal(result.requiresAllRegistrations, true);
  assert.equal(analyzeSource(source, []).fixtures.length, 0);
});
test('fails closed for shared state, hooks, ambient inputs and escaped renderer', () => {
  for (const text of [
    source.replace("test('one'", "const shared = []; test('one'"),
    source.replace("import test from 'node:test';", "import test from 'node:test'; import './unreviewed.mjs';"),
    source.replace("test('one'", "beforeEach(() => {}); test('one'"),
    source.replace("test('one', async", "test('one', { concurrency: true }, async"),
    source.replace("test('one', async ()", "test('one', async (t)"),
    source.replace("test('one'", "test.beforeEach(() => {}); test('one'"),
    source.replace("{ mode: 'observed' }", '{ mode: process.env.MODE }'),
    source.replace("await engine.renderString('one')", 'await engine.renderString(shared)'),
    source.replace("await engine.renderString('one')", "await engine.renderString('one', process.env.SECRET)"),
    source.replace(
      "const engine = renderer({ mode: 'observed' });",
      "const engine = renderer({ mode: 'observed' }); const leaked = engine;",
    ),
    source.replace(
      "const engine = renderer({ other: 'observed' });",
      "const engine = renderer({ other: 'observed' }); const o = {}; o.constructor.prototype.x = true;",
    ),
    source.replace(
      "const engine = renderer({ other: 'observed' });",
      "const engine = renderer({ other: 'observed' }); const x = await import('./unknown.mjs');",
    ),
  ])
    assert.equal(analyzeSource(text).fixtures.length, 0);
});
