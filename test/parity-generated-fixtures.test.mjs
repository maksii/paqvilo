// @test-kind tooling: Source provenance recognizer checks invented generated files; it does not assert platform parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  analyzeGeneratedFixtures,
  analyzeUnselectedFixtureSlice,
  assertPureFixtureBootstrap,
  inferStaticObjectKeys,
} from '../scripts/parity-generated-fixtures.mjs';

const { parse: parseRaw } = createRequire(import.meta.url)('espree');
const parse = (text, options) => parseRaw(text, { ...options, range: true });
const source = `import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTemporaryDirectory } from './owned.mjs';
import { render } from './sut.mjs';
async function fixture(t, files) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}
const standard = { 'site.yml': 'invented', 'page/index.html': 'example' };
test('example', async (t) => { await render(await fixture(t, standard)); });
`;
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = fs.readFileSync(new URL('../mirage/testing/owned-fixture.mjs', import.meta.url));
  fs.writeFileSync(path.join(root, 'owned.mjs'), helper);
  return { root, helper };
}
function analyze(state, text = source, baseline = state.helper) {
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const registration = ast.body.find(
    (item) => item.type === 'ExpressionStatement' && item.expression.callee?.name === 'test',
  );
  return analyzeGeneratedFixtures({
    ast,
    selected: [{ old: { id: 'example:1:0', callback: registration.expression.arguments[1] } }],
    root: state.root,
    filePath: 'sample.test.mjs',
    readBaseline: () => baseline,
  });
}
const rejected = (state, text, baseline) =>
  assert.throws(() => analyze(state, text, baseline), /unsupported-generated-fixture/u);

test('binds a literal map and allocation-only helper while leaving SUT unpinned', (t) => {
  const state = setup(t),
    result = analyze(state);
  assert.deepEqual(
    result.fixtures[0].entries.map((entry) => entry.name),
    ['site.yml', 'page/index.html'],
  );
  assert.equal(result.fixtures[0].entries[0].sha256.length, 64);
  assert.deepEqual([...result.handledInputSources], ['./owned.mjs']);
  assert.deepEqual(
    result.dependencies.map((entry) => entry.path),
    ['owned.mjs'],
  );
  assert.equal(result.recognizedIdentifiers.size, 5);
  fs.writeFileSync(path.join(state.root, 'sut.mjs'), 'changed implementation');
  assert.deepEqual(analyze(state).fixtures, result.fixtures);
});

test('rejects unproven data producers, unsafe paths, and shadowed bindings', (t) => {
  const state = setup(t);
  for (const text of [
    source.replace("'invented'", 'process.env.SECRET'),
    source.replace('site.yml', '../outside'),
    source.replace('site.yml', 'C:/outside'),
    source.replace('site.yml', 'NUL.txt'),
    source.replace('site.yml', 'COM¹.txt'),
    source.replace('site.yml', 'page'),
    source.replace("'page/index.html'", "'SITE.YML'"),
    source.replace('await fs.writeFile(file, content);', "await fs.writeFile(file, await fs.readFile('/outside'));"),
    source.replace('await fs.writeFile(file, content);', 'await fs.symlink(content, file);'),
    source.replace("test('example', async (t)", "test('example', async (fs)"),
    source.replace("test('example'", "function other() { const { fs: os } = {}; return os; }\ntest('example'"),
    source.replace("test('example'", "Object.assign(path, { join: () => '/outside' });\ntest('example'"),
  ])
    rejected(state, text);
});

test('binds changes to the producer map independently of the SUT', (t) => {
  const state = setup(t),
    first = analyze(state),
    changed = analyze(state, source.replace("'invented'", "'different'"));
  assert.notEqual(first.fixtures[0].mapSha256, changed.fixtures[0].mapSha256);
  assert.notEqual(first.fixtures[0].entries[0].sha256, changed.fixtures[0].entries[0].sha256);
});

test('binds every selected original using the same fixture without duplicating the helper dependency', (t) => {
  const state = setup(t),
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const registration = ast.body.find((item) => item.type === 'ExpressionStatement');
  const callback = registration.expression.arguments[1];
  const result = analyzeGeneratedFixtures({
    ast,
    selected: [{ old: { id: 'first', callback } }, { old: { id: 'second', callback } }],
    root: state.root,
    filePath: 'sample.test.mjs',
    readBaseline: () => state.helper,
  });
  assert.deepEqual(
    result.fixtures.map((item) => item.baselineId),
    ['first', 'second'],
  );
  assert.equal(result.dependencies.length, 1);
});

test('pins helper bytes and rejects a changed allocator even with a matching baseline', (t) => {
  const state = setup(t),
    changed = Buffer.from(
      state.helper
        .toString()
        .replace('return fs.realpath(await fs.mkdtemp(prefix));', "return fs.readFile('/outside');"),
    );
  fs.writeFileSync(path.join(state.root, 'owned.mjs'), changed);
  rejected(state, source);
  rejected(state, source, changed);
});

test('marks only exact fixture identifiers and does not exempt unrelated reads', (t) => {
  const state = setup(t);
  const text = source.replace(
    "test('example'",
    "async function unrelated() { return fs.readFile('/outside'); }\ntest('example'",
  );
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const unrelated = ast.body.find((item) => item.id?.name === 'unrelated');
  const registration = ast.body.find((item) => item.type === 'ExpressionStatement');
  const result = analyzeGeneratedFixtures({
    ast,
    selected: [{ old: { id: 'example', callback: registration.expression.arguments[1] } }],
    root: state.root,
    filePath: 'sample.test.mjs',
    readBaseline: () => state.helper,
  });
  assert.equal(result.recognizedIdentifiers.has(unrelated.body.body[0].argument.callee.object), false);
});

test('recognizes only the context identifier passed to the proven fixture call', (t) => {
  const state = setup(t),
    text = source.replace('await render(', 't.skip(); await render(');
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const registration = ast.body.find((item) => item.type === 'ExpressionStatement');
  const callback = registration.expression.arguments[1];
  const skipContext = callback.body.body[0].expression.callee.object;
  const result = analyzeGeneratedFixtures({
    ast,
    selected: [{ old: { id: 'example', callback } }],
    root: state.root,
    filePath: 'sample.test.mjs',
    readBaseline: () => state.helper,
  });
  assert.equal(result.recognizedIdentifiers.has(skipContext), false);
});

test('does not classify unrelated async test helpers as generated fixtures', (t) => {
  const state = setup(t);
  const text = `import test from 'node:test'; async function unrelated(a, b) { return a + b; } test('other', async (t) => { const x = 1; await unrelated(t, x); });`;
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const registration = ast.body.find((item) => item.type === 'ExpressionStatement');
  const result = analyzeGeneratedFixtures({
    ast,
    selected: [{ old: { id: 'other', callback: registration.expression.arguments[1] } }],
    root: state.root,
    filePath: 'sample.test.mjs',
    readBaseline: () => state.helper,
  });
  assert.equal(result.fixtures.length, 0);
});

test('recognizes only a written fixture entry read before the owned root escapes', (t) => {
  const state = setup(t);
  const another = `test('other', async (t) => {
    const dir = await fixture(t, { ...standard, 'extra.txt': 'extra' });
    const before = await fs.readFile(path.join(dir, 'extra.txt'), 'utf8');
    await render(dir);
    const after = await fs.readFile(path.join(dir, 'extra.txt'), 'utf8');
  });`;
  const text = source + another,
    ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const registrations = ast.body.filter((item) => item.type === 'ExpressionStatement');
  const first = registrations[0].expression.arguments[1],
    other = registrations[1].expression.arguments[1];
  const beforeFs = other.body.body[1].declarations[0].init.argument.callee.object;
  const afterFs = other.body.body[3].declarations[0].init.argument.callee.object;
  const result = analyzeGeneratedFixtures({
    ast,
    selected: [{ old: { id: 'example', callback: first } }],
    root: state.root,
    filePath: 'sample.test.mjs',
    readBaseline: () => state.helper,
  });
  assert.equal(result.recognizedIdentifiers.has(beforeFs), true);
  assert.equal(result.recognizedIdentifiers.has(afterFs), false);
  assert.deepEqual(
    result.fixtures[0].ownedReads.map((item) => item.entry),
    ['extra.txt'],
  );
  const replaced = text.replace("path.join(dir, 'extra.txt')", "path.join(dir, '../outside')");
  assert.equal(analyze(state, replaced).fixtures[0].ownedReads.length, 0);
  const link = text.replace(
    'const before = await fs.readFile',
    "await fs.symlink('/outside', path.join(dir, 'extra.txt')); const before = await fs.readFile",
  );
  assert.equal(analyze(state, link).fixtures[0].ownedReads.length, 0);
  const escape = text.replace(
    'const before = await fs.readFile',
    'await render(dir); const before = await fs.readFile',
  );
  assert.equal(analyze(state, escape).fixtures[0].ownedReads.length, 0);
});

test('isolates unrelated fresh-root reads only with reviewed SUT and no shared test effects', (t) => {
  const state = setup(t);
  const other = `test('other', async (t) => {
    const dir = await fixture(t, { ...standard, 'extra.txt': 'extra' });
    const before = await fs.readFile(path.join(dir, 'extra.txt'), 'utf8');
    await render(dir);
    const after = await fs.readFile(path.join(dir, 'extra.txt'), 'utf8');
  });`;
  const probe = (text, implementationSources = ['./sut.mjs']) => {
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
    const row = ast.body.find((item) => item.type === 'ExpressionStatement').expression.arguments[1];
    return analyzeGeneratedFixtures({
      ast,
      selected: [{ old: { id: 'example', callback: row } }],
      root: state.root,
      filePath: 'sample.test.mjs',
      readBaseline: () => state.helper,
      implementationSources,
    });
  };
  const text = source + other;
  assert.equal(probe(text).isolatedIdentifiers.size, 2);
  assert.equal(probe(text, []).isolatedIdentifiers.size, 0);
  for (const changed of [
    text.replace("test('other', async", "test('other', { concurrency: true }, async"),
    text.replace("test('other'", "beforeEach(() => {}); test('other'"),
    text.replace('const before =', 't.skip(); const before ='),
    text.replace('await render(dir);', 'await unknown(dir);'),
    text.replace('await render(dir);', "await fetch('https://example.invalid'); await render(dir);"),
    text.replace('await render(dir);', 'const alias = dir; await render(alias);'),
    text
      .replace("test('other'", "let shared = 0; test('other'")
      .replace('await render(dir);', 'shared = 1; await render(dir);'),
    text.replace('await render(dir);', "await fs.symlink('/outside', path.join(dir, 'extra.txt'));"),
    text.replace("path.join(dir, 'extra.txt')", "path.join(dir, '../outside')"),
  ])
    assert.equal(probe(changed).isolatedIdentifiers.size, 0);
  assert.throws(
    () => probe(text.replace('await render(dir);', "standard['site.yml'] = 'changed'; await render(dir);")),
    /unsupported-generated-fixture/u,
  );
  assert.throws(
    () => probe(text.replace('await render(dir);', 'await render(standard); await render(dir);')),
    /unsupported-generated-fixture/u,
  );
});

test('enumerates source-derived map keys without executing value producers', () => {
  const inspect = (text) => {
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
    const expression = ast.body.at(-1).declarations[0].init;
    return inferStaticObjectKeys({ ast, expression });
  };
  assert.deepEqual(
    inspect(
      "const css = (id, name, unused = 1) => ({ [`assets/${name}`]: process.env.SECRET }); const base = { 'site.yml': 'x' }; const files = { ...base, ...css('1', 'demo.css') };",
    ),
    ['site.yml', 'assets/demo.css'],
  );
  for (const text of [
    'const make = (name) => ({ [name]: 1 }); const files = { ...make(process.env.UNKNOWN) };',
    "const make = (name) => ({ [name]: 1 }); const files = { ...make('../outside') };",
    "let shared = 'safe'; shared = '../outside'; const files = { [shared]: 1 };",
    "const files = { 'NUL.txt': 1 };",
    "const files = { 'A.txt': 1, 'a.txt': 2 };",
  ])
    assert.throws(() => inspect(text), /unsupported-generated-fixture/u);
});

test('module bootstrap accepts only pure static constructors and deterministic local arrows', () => {
  const check = (text) =>
    assertPureFixtureBootstrap({ ast: parse(text, { ecmaVersion: 'latest', sourceType: 'module' }) });
  const prefix = "import test from 'node:test'; ";
  const good =
    prefix +
    "const tpl = (name) => ({ [`x/${name}`]: name }); const files = { ...tpl('a'), text: ['a','b'].join('') }; const stamp = new Date(Date.UTC(2026, 0, 1)); test('x', () => {});";
  assert.equal(check(good).declarations.length, 3);
  for (const bad of [
    good.replace("tpl('a')", 'tpl(process.env.NAME)'),
    good.replace("['a','b'].join('')", "fetch('https://example.invalid')"),
    good.replace('Date.UTC(2026, 0, 1)', 'Date.now()'),
    good.replace("test('x'", "beforeEach(() => {}); test('x'"),
    good.replace('[`x/${name}`]: name', 'get x() { return name; }'),
  ])
    assert.throws(() => check(bad), /unsupported-generated-fixture/u);
});

test('isolates a source-only renderer from forwarded maps and independent generated roots', (t) => {
  const state = setup(t);
  const text = `import test from 'node:test'; import assert from 'node:assert/strict';
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
test('example', async () => { const view = plain(); assert.equal(await view('x'), 'y'); });
test('other', async (t) => {
  await setup(t, {}, { ...template('2', 'other.html', 'z') });
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'other-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const write = async (name, body) => { await fs.mkdir(path.join(dir, path.dirname(name)), { recursive: true }); await fs.writeFile(path.join(dir, name), body); };
  await write('a/file.txt', 'data');
  const contents = { 'a/file.txt': 'data' };
  for (const [name, content] of Object.entries(contents)) { const target = path.join(dir, 'more', name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); }
  const stateFile = path.join(dir, 'state', 'data.json'); await fs.mkdir(path.dirname(stateFile)); await fs.writeFile(stateFile, '{}');
  const before = await fs.readFile(stateFile, 'utf8'); await importer(dir); assert.equal(await fs.readFile(stateFile, 'utf8'), before);
});`;
  const probe = (sourceText, roles = ['./sut.mjs']) => {
    const ast = parse(sourceText, { ecmaVersion: 'latest', sourceType: 'module' });
    const callback = ast.body.find((item) => item.type === 'ExpressionStatement').expression.arguments[1];
    return analyzeUnselectedFixtureSlice({
      ast,
      selected: [{ old: { id: 'example', callback } }],
      root: state.root,
      filePath: 'sample.test.mjs',
      readBaseline: () => state.helper,
      implementationSources: roles,
    });
  };
  assert.ok(probe(text).isolatedIdentifiers.size >= 10);
  assert.ok(probe(text.replaceAll('plain', 'basic')).isolatedIdentifiers.size >= 10);
  assert.equal(probe(text, []).isolatedIdentifiers.size, 0);
  for (const changed of [
    text.replace('const view = plain();', "const view = plain(); await fs.readFile('/outside');"),
    text.replace('const files =', 'const ambient = os.tmpdir(); const files ='),
    text.replace("test('other'", "beforeEach(() => {}); test('other'"),
    text.replace("test('other', async", "test('other', { concurrency: true }, async"),
    text.replace('await importer(dir);', "const aliasTest = test; aliasTest('hidden', () => {}); await importer(dir);"),
    text.replace('await importer(dir);', 'await unknown(dir);'),
    text.replace('await importer(dir);', 'const importer = () => {}; await importer(dir);'),
    text.replace('path.dirname(stateFile)', 'path.dirname(dir)'),
    text.replace("await write('a/file.txt'", "await write('../outside'"),
    text.replace("'a/file.txt': 'data'", "'../outside': 'data'"),
    text.replace('await importer(dir);', "await fs.symlink('/outside', path.join(dir, 'a')); await importer(dir);"),
    text.replace('await importer(dir);', 't.skip(); await importer(dir);'),
    text.replace('await importer(dir);', "files['extra'] = 'changed'; await importer(dir);"),
    text.replace('await importer(dir);', 'Object.assign(Object.prototype, { poisoned: true }); await importer(dir);'),
    text.replace(
      'await importer(dir);',
      'const tmp = {}; tmp.constructor.prototype.poisoned = true; await importer(dir);',
    ),
    text.replace(
      'await importer(dir);',
      "const tmp = {}, a = 'constructor', b = 'prototype'; tmp[a][b].poisoned = true; await importer(dir);",
    ),
    text.replace(
      'await importer(dir);',
      "const tmp = {}, a = 'constructor', b = 'prototype', proto = tmp[a][b]; proto.poisoned = true; await importer(dir);",
    ),
    text.replace(
      'await importer(dir);',
      'const { constructor: ctor } = {}; const { prototype: proto } = ctor; proto.poisoned = true; await importer(dir);',
    ),
    text
      .replace('const files =', 'const shared = []; const files =')
      .replace("await view('x')", 'await view(shared)')
      .replace('await importer(dir);', "shared.push('changed'); await importer(dir);"),
    text
      .replace('const files =', 'const sharedDate = new Date(Date.UTC(2024, 0, 1)); const files =')
      .replace("await view('x')", 'await view(sharedDate)')
      .replace('await importer(dir);', 'sharedDate.setUTCFullYear(2030); await importer(dir);'),
    text
      .replace('const files =', 'const shared = []; const files =')
      .replace("await view('x')", 'await view(shared)')
      .replace('await importer(dir);', 'shared.push(await setup(t)); await importer(dir);'),
  ])
    assert.equal(probe(changed).isolatedIdentifiers.size, 0);
});
