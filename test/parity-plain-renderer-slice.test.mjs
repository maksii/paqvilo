// @test-kind tooling: composed source isolation certificates use invented fixtures and do not establish native parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeParitySource } from '../scripts/qualify-parity.mjs';
import { analyzePlainRendererSlice } from '../scripts/parity-plain-renderer-slice.mjs';

const source = `import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { makeTemporaryDirectory } from './owned.mjs'; import { render, importer } from './sut.mjs';
const template = (id, name, value) => ({ [\`data/\${id}/\${name}\`]: value });
const files = { 'site.yml': 'x', ...template('1', 'template.html', 'x') };
async function fixturePortal(t, extra = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ ...files, ...extra })) {
    const file = path.join(dir, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  return importer(dir);
}
async function setup(t, options = {}, extraFiles = {}) { return fixturePortal(t, extraFiles); }
function plain() { const renderer = render({ templates: {} }); return (source, data = {}) => renderer.renderString(source, data); }
test('first', async () => { const view = plain(); assert.equal(await view('x'), 'y'); });
test('second', async () => { const view = plain(); assert.equal(await view('z', { x: 1 }), 'q'); });
test('other', async (t) => { await setup(t, {}, { ...template('2', 'other.html', 'z') }); });`;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-slice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = fs.readFileSync(new URL('../mirage/testing/owned-fixture.mjs', import.meta.url));
  fs.writeFileSync(path.join(root, 'owned.mjs'), helper);
  return { root, helper };
}
function classify(state, text = source, names = ['first', 'second'], roles = ['./sut.mjs']) {
  const model = describeParitySource(text, 'sample.test.mjs');
  return analyzePlainRendererSlice({
    ast: model.ast,
    selected: names.map((name) => ({ old: model.registrations.find((row) => row.title === name) })),
    root: state.root,
    filePath: 'sample.test.mjs',
    readBaseline: () => state.helper,
    implementationSources: roles,
  });
}
test('composes independent singleton proofs over the same isolation boundary', (t) => {
  const state = setup(t),
    both = classify(state),
    first = classify(state, source, ['first']);
  assert.equal(both.fixtures.length, 2);
  assert.equal(both.requiresAllRegistrations, true);
  assert.equal(both.requiresModuleIsolationProof, true);
  assert.deepEqual(both.dependencies, first.dependencies);
  assert.equal(both.isolatedIdentifiers.size, first.isolatedIdentifiers.size);
  assert.equal(classify(state, source, ['first', 'first']).fixtures.length, 0);
  assert.equal(classify(state, source, ['first', 'missing']).fixtures.length, 0);
  assert.equal(classify(state, source, ['first', 'second'], []).fixtures.length, 0);
});
test('rejects any cohort containing an unsafe selected parent or unsafe shared fixture', (t) => {
  const state = setup(t);
  for (const changed of [
    source.replace(
      "const view = plain(); assert.equal(await view('z'",
      "const view = plain(); await fs.readFile('/outside'); assert.equal(await view('z'",
    ),
    source.replace('await setup(t, {},', 'globalThis.outside = 1; await setup(t, {},'),
    source.replace('const files =', 'const ambient = os.tmpdir(); const files ='),
    source.replace("test('second', async ()", "test('second', async (t)"),
    source.replace("test('other', async", "test('other', { concurrency: true }, async"),
  ]) {
    assert.notEqual(changed, source);
    assert.equal(classify(state, changed).fixtures.length, 0);
  }
});
