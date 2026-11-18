// @test-kind contract: source refactors preserve null handling, response selection, and asynchronous UI ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { syntaxNodes } from './estree.mjs';
import { tsc } from './tsc.mjs';
import { windowsLaunchOptions } from '../mirage/lib/browser-launch.mjs';
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
  const found = syntaxNodes(text).find(predicate);
  assert.ok(found, `handler exists in ${file}`);
  return text.slice(found.start, found.end);
}
async function privateFunction(file, name, bindings) {
  const text = await sourceNode(file, (node) => node.type === 'FunctionDeclaration' && node.id?.name === name);
  // hang guard only: the evaluated handler is expected to return at once; this bound only stops a runaway evaluation.
  return vm.runInNewContext(`(${text})`, bindings, { timeout: 120_000 });
}

test('Windows launch forwarding retains invalid caller input and upstream defaults', () => {
  for (const invalid of [null, false, 3, 'invalid', [], { args: null }, { ignoreDefaultArgs: null }])
    assert.strictEqual(windowsLaunchOptions(invalid, 'win32'), invalid);
  const explicit = { args: ['--caller'], ignoreDefaultArgs: true };
  assert.strictEqual(windowsLaunchOptions(explicit, 'win32'), explicit);
  assert.strictEqual(windowsLaunchOptions(explicit, 'linux'), explicit);
  assert.deepEqual(windowsLaunchOptions(undefined, 'win32'), {});
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
    (node) => node.type === 'SwitchCase' && node.test?.type === 'Literal' && node.test.value === 'diff',
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
    (node) => node.type === 'SwitchCase' && node.test?.type === 'Literal' && node.test.value === 'diff',
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

test('the declared panel diff state accepts pending requests and the closed null state', async () => {
  const file = fileURLToPath(new URL('../lense/panel-ui.mjs', import.meta.url));
  const text = await fs.readFile(file, 'utf8');
  const stateDiff = (node) =>
    node.type === 'MemberExpression' && node.object.name === 'S' && !node.computed && node.property.name === 'diff';
  let state;
  let assignment;
  let comparison;
  for (const node of syntaxNodes(text)) {
    if (node.type === 'VariableDeclarator' && node.id.name === 'S') state = node;
    if (node.type === 'AssignmentExpression' && stateDiff(node.left) && node.right.name === 'pending')
      assignment = node;
    if (node.type === 'BinaryExpression' && stateDiff(node.left) && node.right.name === 'pending') comparison = node;
  }
  assert.ok(comparison);
  assert.ok(assignment);
  assert.ok(state);
  const declared = state.init.properties.find((property) => property.key?.name === 'diff');
  assert.ok(declared);
  // The compiler reports, at the line of each expression, a declared type that rejects its initializer or the pending
  // request assigned before the await, and an ownership comparison between types that cannot overlap.
  const lines = new Set([declared, assignment, comparison].map((node) => text.slice(0, node.start).split('\n').length));
  const checked = tsc([
    '--allowJs',
    '--checkJs',
    '--noEmit',
    '--strictNullChecks',
    '--target',
    'esnext',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    file,
  ]);
  // A line starting with "error TS" is a compiler option or input failure, not a finding in a source file.
  assert.doesNotMatch(checked.output, /^error TS/m, checked.output);
  // The compiler either accepted the file or reported positioned findings; anything else means it never checked it.
  assert.ok(checked.status === 0 || /\(\d+,\d+\): error TS\d+: /.test(checked.output), checked.output);
  const rejected = checked.output.split(/\r?\n/).filter((line) => {
    const position = /panel-ui\.mjs\((\d+),\d+\): error TS\d+/.exec(line);
    return position && lines.has(Number(position[1]));
  });
  assert.deepEqual(
    rejected,
    [],
    'the ownership comparison must be possible for the pending request assigned before await',
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
