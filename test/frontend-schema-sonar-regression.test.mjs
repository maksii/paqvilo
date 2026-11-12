// @test-kind contract: source refactors preserve null handling, response selection, and asynchronous UI ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { windowsLaunchOptions, BACKPORTED_DISABLED_FEATURES } from '../mirage/lib/browser-launch.mjs';
import { observedConfig } from '../mirage/lib/project-config.mjs';
import { staffFormatting } from '../mirage/lib/model-driven/pcf-runtime.mjs';
import { createOfflineSessions } from '../mirage/lib/model-driven/offline.mjs';
import { LiquidContext } from '../mirage/lib/liquid-engine.mjs';
import { redactEmbeddedQueryValues } from '../mirage/baseline-capture.mjs';
import { stringifyExactJson } from '../mirage/lib/exact-numeric.mjs';

// Execute the real private handlers with controlled dependencies rather than
// introducing production exports or asserting an implementation's source text.
async function sourceNode(file, predicate) {
  const text = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found;
  const visit = (node) => {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found, `handler exists in ${file}`);
  return found.getText(source);
}
async function privateFunction(file, name, bindings) {
  const text = await sourceNode(file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  // hang guard only: the evaluated handler is expected to return at once; this bound only stops a runaway evaluation.
  return vm.runInNewContext(`(${text})`, bindings, { timeout: 120_000 });
}

test('Windows launch forwarding retains invalid caller input and the default backport', () => {
  for (const invalid of [null, false, 3, 'invalid', [], { args: null }, { ignoreDefaultArgs: null }])
    assert.strictEqual(windowsLaunchOptions(invalid, 'win32'), invalid);
  const explicit = { args: ['--caller'], ignoreDefaultArgs: true };
  assert.strictEqual(windowsLaunchOptions(explicit, 'win32'), explicit);
  assert.strictEqual(windowsLaunchOptions(explicit, 'linux'), explicit);
  assert.equal(windowsLaunchOptions(undefined, 'win32').args[0], BACKPORTED_DISABLED_FEATURES);
});

test('observed configuration rejects an accessor without invoking it', () => {
  let calls = 0;
  const config = Object.defineProperty({}, 'dataverseAttributeErrorContexts', {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  assert.throws(() => observedConfig(config), {
    name: 'Error',
    message: 'observed.dataverseAttributeErrorContexts requires explicit data',
  });
  assert.equal(calls, 0);
});

test('JSON response selection preserves empty 204, literal wire JSON and chunk precedence', async () => {
  const chunks = [];
  const json = await privateFunction('mirage/server.mjs', 'json', {
    auditResponse: Symbol('audit'),
    stringifyExactJson,
    writeJsonChunks: (_res, value) => chunks.push(value),
  });
  const response = () => ({
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(value) {
      this.body = value;
    },
  });
  const empty = response();
  json(empty, 204, { toJSON: () => assert.fail('204 must not serialize') }, {}, { wireText: 'ignored', chunks: [] });
  assert.equal(empty.body, undefined);
  assert.equal(chunks.length, 0);
  const wire = response();
  json(wire, 200, { fallback: true }, {}, { wireText: '', omitContentType: true });
  assert.equal(wire.body, '');
  assert.equal(wire.headers['content-type'], undefined);
  const encoded = response();
  json(encoded, 200, { amount: 17 });
  assert.equal(encoded.body, '{"amount":17}');
  const streamed = response();
  const pieces = ['literal', 'chunks'];
  json(streamed, 200, {}, {}, { chunks: pieces, wireText: 'ignored' });
  assert.strictEqual(chunks[0], pieces);
});

test('Dataverse options distinguish explicit true, object overrides and disabled inputs', async () => {
  const settings = await privateFunction('mirage/server.mjs', 'dataverseInputSettings', {});
  assert.equal(Object.keys(settings(true)).length, 0);
  for (const input of [undefined, null, false, 0, '', [], 'invalid']) assert.equal(settings(input).enabled, false);
  const custom = { enabled: true, localeId: 1058, host: '127.0.0.1' };
  assert.strictEqual(settings(custom), custom);
});

test('a closed or superseded panel diff cannot be overwritten by its late response', async () => {
  const clause = await sourceNode(
    'lense/panel-ui.mjs',
    (node) => ts.isCaseClause(node) && node.expression.text === 'diff',
  );
  const coercible = {
    [Symbol.toPrimitive]() {
      assert.fail('diff ownership must not coerce a replacement');
    },
  };
  for (const replacement of [
    null,
    { loading: true, rel: 'newer' },
    undefined,
    false,
    0,
    '',
    'original',
    { loading: true, rel: 'original' },
    coercible,
  ]) {
    const pending = Promise.withResolvers();
    const S = { diff: null };
    let draws = 0;
    const run = vm.runInNewContext(`(async () => { switch (action) { ${clause} } })`, {
      S,
      action: 'diff',
      rel: 'original',
      url: '/original',
      fresh: () => draws++,
      api: () => pending.promise,
    });
    const finished = run();
    assert.equal(S.diff.loading, true);
    S.diff = replacement;
    pending.resolve({ ok: true, text: 'late original result' });
    await finished;
    assert.strictEqual(S.diff, replacement);
    assert.equal(draws, 2);
  }
});

test('panel diff ownership accepts only the current request, including requests for the same path', async () => {
  const clause = await sourceNode(
    'lense/panel-ui.mjs',
    (node) => ts.isCaseClause(node) && node.expression.text === 'diff',
  );
  const firstResponse = Promise.withResolvers();
  const secondResponse = Promise.withResolvers();
  const responses = [firstResponse, secondResponse];
  const S = { diff: null };
  let draws = 0;
  const run = vm.runInNewContext(`(async () => { switch (action) { ${clause} } })`, {
    S,
    action: 'diff',
    rel: 'original',
    url: '/original',
    fresh: () => draws++,
    api: () => responses.shift().promise,
  });
  const first = run();
  const firstPending = S.diff;
  const second = run();
  const secondPending = S.diff;
  assert.notStrictEqual(firstPending, secondPending);
  secondResponse.resolve({ ok: true, text: 'current result', rel: 'response cannot change the requested path' });
  await second;
  const current = S.diff;
  assert.equal(current.ok, true);
  assert.equal(current.text, 'current result');
  assert.equal(current.rel, 'original');
  firstResponse.resolve({ ok: true, text: 'late original result' });
  await first;
  assert.strictEqual(S.diff, current);
  assert.equal(draws, 4);
});

test('the declared panel diff state accepts pending requests and the closed null state', () => {
  const file = fileURLToPath(new URL('../lense/panel-ui.mjs', import.meta.url));
  const program = ts.createProgram([file], {
    allowJs: true,
    noEmit: true,
    strictNullChecks: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  });
  const source = program.getSourceFile(file);
  const checker = program.getTypeChecker();
  let comparison;
  let state;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'S') state = node;
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.getText(source) === 'S' &&
      node.left.name.text === 'diff' &&
      ts.isIdentifier(node.right) &&
      node.right.text === 'pending'
    )
      comparison = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(comparison);
  assert.ok(state);
  assert.equal(
    checker.isTypeAssignableTo(checker.getTypeAtLocation(comparison.right), checker.getTypeAtLocation(comparison.left)),
    true,
    'the ownership comparison must be possible for the pending request assigned before await',
  );
  const diff = state.initializer.properties.find((property) => property.name?.getText(source) === 'diff');
  assert.equal(
    checker.isTypeAssignableTo(checker.getTypeAtLocation(diff.initializer), checker.getTypeAtLocation(diff)),
    true,
  );
});

test('folder response becomes the picker data and website selection retains its custom-folder path', async () => {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { close() {}, className: '', textContent: '', value: '' });
    return elements.get(selector);
  };
  const data = {
    kind: { type: 'website' },
    path: '/invented',
    files: [],
    folders: [],
    value: 'invented',
    shown: './invented',
  };
  const picker = { kind: 'website', data: null };
  const PICK = { website: { noun: 'website export' } };
  const open = await privateFunction('lense/setup/app.mjs', 'openFolder', {
    $: element,
    picker,
    PICK,
    URLSearchParams,
    request: async () => data,
    kindText: () => 'Website export',
    esc: String,
  });
  await open('');
  assert.strictEqual(picker.data, data);
  assert.equal(element('#folder-picker-input').value, '/invented');
  assert.match(element('#folder-picker-here').textContent, /Choose “Use this folder”/);
  let changed = false;
  picker.form = {
    isConnected: true,
    querySelectorAll: () => [],
    querySelector: element,
    classList: { add: () => (changed = true) },
  };
  const use = await privateFunction('lense/setup/app.mjs', 'useFolder', {
    $: element,
    picker,
    PICK,
    document: {},
    quickUi: { normalPath: (value) => value },
    confirm: () => assert.fail('matching website needs no confirmation'),
    esc: String,
  });
  use();
  assert.equal(element('[name="website-other"]').value, 'invented');
  assert.equal(element('[data-picked="website"]').innerHTML, '<code>./invented</code>');
  assert.equal(element('input[name="website"][value=""]').checked, true);
  assert.equal(changed, true);
});

test('folder detection handles omitted entries, supplied entries and a read failure', async () => {
  let reads = 0;
  const entries = [{ name: 'invented.deployment.yml', isFile: () => true }];
  const folderKind = await privateFunction('lense/setup/preview.mjs', 'folderKind', {
    fs: { readdir: async () => (reads++, entries) },
    PROFILE_FILE: /^(.+)\.deployment\.ya?ml$/i,
  });
  const omitted = await folderKind('/invented');
  assert.equal(omitted.type, 'profiles');
  assert.equal(omitted.files[0].name, 'invented');
  assert.equal(reads, 1);
  const supplied = await folderKind('/invented', entries);
  assert.equal(supplied.files[0].file, 'invented.deployment.yml');
  assert.equal(reads, 1);
  const absent = await privateFunction('lense/setup/preview.mjs', 'folderKind', {
    fs: {
      readdir: async () => {
        throw new Error('invented read error');
      },
    },
  });
  assert.equal(await absent('/missing'), null);
});

test('query redaction preserves fragments and identical output with or without a fragment', () => {
  assert.equal(redactEmbeddedQueryValues('/item?secret=invented'), '/item?secret=…');
  assert.equal(redactEmbeddedQueryValues('/item?secret=invented#keep'), '/item?secret=…#keep');
});

test('offline session restoration is optional and loads persisted sessions once', () => {
  assert.deepEqual(createOfflineSessions({}).list(), []);
  assert.deepEqual(createOfflineSessions({ state: null }).list(), []);
  let loads = 0;
  const sessions = createOfflineSessions({ state: { load: () => (loads++, null) } });
  assert.deepEqual(sessions.list(), []);
  assert.deepEqual(sessions.list(), []);
  assert.equal(loads, 1);
});

test('PCF currency formatting preserves anonymous fallback, invalid ISO fallback and explicit currency', () => {
  assert.equal(staffFormatting().formatCurrency(17), '17.00');
  assert.equal(
    staffFormatting({ transactionCurrency: { isoCode: 'invalid', symbol: '¤', precision: 1 } }).formatCurrency(17),
    '¤17.0',
  );
  assert.equal(
    staffFormatting({ transactionCurrency: { isoCode: 'USD', symbol: '$', precision: 2 } }).formatCurrency(17),
    '$17.00',
  );
  const currency = { isoCode: 'USD', symbol: '$', precision: 2 };
  const formatter = staffFormatting({ transactionCurrency: currency });
  currency.isoCode = 'JPY';
  currency.symbol = '¥';
  currency.precision = 0;
  assert.equal(formatter.formatCurrency(17), '¥17');
});

test('an empty Liquid variable remains nil while a valid variable resolves', async () => {
  const context = new LiquidContext({}, { environment: { invented: 'retained' } });
  assert.equal(await context.variable(''), null);
  assert.equal(await context.variable('!'), null);
  assert.equal(await context.variable('invented'), 'retained');
});
