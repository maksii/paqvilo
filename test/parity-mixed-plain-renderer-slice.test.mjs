// @test-kind tooling: invented date-diagnostic fixtures exercise source isolation only, never native parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeParitySource, parityAstHash } from '../scripts/qualify-parity.mjs';
import { analyzeMixedPlainRendererSlice } from '../scripts/parity-mixed-plain-renderer-slice.mjs';
const source = `import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { makeTemporaryDirectory } from './owned.mjs'; import { render, importer } from './sut.mjs';
const NOW = new Date(Date.UTC(2026, 0, 2));
const template = (id, name, value) => ({ [\`data/\${id}/\${name}\`]: value });
const files = { 'site.yml': 'x', ...template('1', 'template.html', 'x') };
async function fixturePortal(t, extra = {}) { const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); for (const [name, content] of Object.entries({ ...files, ...extra })) { const file = path.join(dir, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); } return importer(dir); }
async function setup(t, options = {}, extraFiles = {}) { return fixturePortal(t, extraFiles); }
function plain() { const renderer = render({ templates: {} }); return (source, data = {}) => renderer.renderString(source, data); }
test('anchor', async () => { const view = plain(); assert.equal(await view('anchor'), 'a'); });
test('mixed', async () => { const view = plain(); assert.equal(await view('first'), 'a'); assert.equal(await view('date', { now: NOW }), 'b'); const d = new Date(Date.UTC(2024, 0, 31)); assert.equal(await view('local-date', { d }), 'c'); assert.equal(await view('last', { s: 'value' }), 'd'); });
test('other', async (t) => { await setup(t, {}, { ...template('2', 'other.html', 'z') }); });`;
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-slice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = fs.readFileSync(new URL('../mirage/testing/owned-fixture.mjs', import.meta.url));
  fs.writeFileSync(path.join(root, 'owned.mjs'), helper);
  return { root, helper };
}
function probe(state, text = source, indices = [0, 3]) {
  const model = describeParitySource(text, 'sample.test.mjs'),
    row = model.registrations.find((r) => r.title === 'mixed'),
    anchor = model.registrations.find((r) => r.title === 'anchor'),
    before = parityAstHash(row.callback.body),
    result = analyzeMixedPlainRendererSlice({
      ast: model.ast,
      selected: [{ old: row, assertionHashes: indices.map((i) => row.assertions[i].sha256) }],
      anchor,
      root: state.root,
      filePath: 'sample.test.mjs',
      readBaseline: () => state.helper,
      implementationSources: ['./sut.mjs'],
    });
  assert.equal(parityAstHash(row.callback.body), before, 'analyzer must restore AST');
  return result;
}
test('certifies selected literals around deterministic date diagnostics without dropping them from full-body binding', (t) => {
  const r = probe(setup(t));
  assert.equal(r.fixtures.length, 1);
  assert.equal(r.fixtures[0].selectedAssertionHashes.length, 2);
  assert.equal(r.fixtures[0].surroundingStatementHashes.length, 3);
  assert.equal(r.requiresModuleIsolationProof, true);
});
test('rejects stateful, ambient, escaping, and selected nonliteral inputs', (t) => {
  const state = setup(t);
  for (const bad of [
    source.replace('Date.UTC(2024, 0, 31)', 'Date.now()'),
    source.replace("await view('first')", 'await view(process.env.OUTSIDE)'),
    source.replace(
      "assert.equal(await view('date', { now: NOW }), 'b');",
      "const escaped = view; assert.equal(await escaped('date'), 'b');",
    ),
    source.replace('const d = new Date(Date.UTC(2024, 0, 31));', 'globalThis.changed = 1;'),
    source.replace("{ s: 'value' }", '{ s: NOW }'),
    source.replace("test('other', async", "test('other', { concurrency: true }, async"),
  ]) {
    assert.notEqual(bad, source);
    assert.equal(probe(state, bad).fixtures.length, 0);
  }
});

test('accepts a proven owned-fixture tail only after all selected scalar assertions', (t) => {
  const state = setup(t),
    suffix = `const { render: pageRender } = await setup(t); const user = { fullname: 'Invented', roles: ['Editors'] }; assert.equal((await pageRender('page', { user })).html, 'result');`,
    withTail = source
      .replace("test('mixed', async () => {", "test('mixed', async (t) => {")
      .replace(
        "assert.equal(await view('date', { now: NOW }), 'b'); const d = new Date(Date.UTC(2024, 0, 31)); assert.equal(await view('local-date', { d }), 'c'); ",
        '',
      )
      .replace(
        "assert.equal(await view('last', { s: 'value' }), 'd');",
        `assert.equal(await view('last', { s: 'value' }), 'd'); ${suffix}`,
      );
  assert.equal(probe(state, withTail, [0, 1]).fixtures.length, 1);
  const moved = withTail
    .replace(` ${suffix}`, '')
    .replace(
      "const view = plain(); assert.equal(await view('first'), 'a');",
      `const view = plain(); ${suffix} assert.equal(await view('first'), 'a');`,
    );
  assert.equal(probe(state, moved, [0, 1]).fixtures.length, 0);
  const interleaved = withTail.replace(
    "assert.equal(await view('last', { s: 'value' }), 'd');",
    "assert.equal(await view('unselected'), 'x'); assert.equal(await view('last', { s: 'value' }), 'd');",
  );
  assert.equal(probe(state, interleaved, [0, 2]).fixtures.length, 0);
  const afterFixture = withTail.replace('const user = {', "assert.equal(await view('after'), 'x'); const user = {");
  assert.equal(probe(state, afterFixture, [0, 1]).fixtures.length, 0);
  const escaped = withTail.replace('const user = {', 'const escaped = view; const user = {');
  assert.equal(probe(state, escaped, [0, 1]).fixtures.length, 0);
  const ambient = withTail.replace(
    "await pageRender('page', { user })",
    'await pageRender(process.env.OUTSIDE, { user })',
  );
  assert.equal(probe(state, ambient, [0, 1]).fixtures.length, 0);
});
