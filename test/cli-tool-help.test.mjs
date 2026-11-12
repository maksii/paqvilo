// @test-kind tooling: standalone public help validates real schemas without resolving or executing operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MIRAGE_TOOLS, mirageToolHelp } from '../mirage/tool-registry.mjs';
import { parseToolArgs, parseToolHelp } from '../mirage/tool-options.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { tempDirSync } from './fixture.mjs';

const bin = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const guard = new URL('./cli-help-guard.mjs', import.meta.url).href;
// Derive argument types independently from public help, rather than importing private parser tables.
const documentedOptions = (name) => [
  ...new Map(
    [...MIRAGE_TOOLS[name].matchAll(/--([\w-]+)(?: ([^\s\]]+))?/g)].map((match) => [
      match[1],
      /^[\w/]/.test(match[2] ?? ''),
    ]),
  ).entries(),
];
const examples = {
  'bootstrap-report': ['--config', 'missing.yml', '--solution-root', 'one', '--solution-root', 'two', '--all-fields'],
  'render-sweep': ['--source', 'missing', '--solution-root', 'one', '--solution-root', 'two', '--strict'],
  'liquid-inventory': ['--portal', 'missing', '--include-inactive', '--sources'],
  'webapi-inventory': ['--config', 'missing.yml', '--client-wrapper', 'one', '--client-wrapper', 'two'],
  'portal-matrix': ['--project', 'missing.json', '--env', 'one=dev', '--env', 'two=dev', '--use-state'],
  'parity-suite': [
    '--config',
    'missing.yml',
    '--pack',
    'one',
    '--pack',
    'two',
    '--pack-module',
    'missing.mjs',
    '--local-owned',
  ],
  'baseline-suite': ['capture', '--matrix', 'missing.json', '--allow-writes'],
  'liquid-conformance': ['--suite', 'missing.json', '--rules', 'missing.json', '--markdown'],
  acceptance: ['--plan', 'missing.json', '--requires', 'one', '--requires', 'two', '--strict'],
  'enrich-reference': ['--state', 'missing.json', '--plan', 'missing.json'],
  'reference-parity': [
    '--plan',
    'missing.json',
    '--local-role',
    'one',
    '--local-role',
    'two',
    '--local-configured-persona',
  ],
  'query-inventory': ['--portal', 'missing'],
  verify: ['--local', 'http://127.0.0.1:1', '--origin', 'https://example.test', '--output', 'missing'],
  'verify-storage': ['--json'],
  'capture-shell': ['--config', 'missing.yml', '--no-rich-text', '--strict'],
  trace: ['show', 'invented-id', '--config', 'missing.yml'],
};

async function fixture(t) {
  const cwd = tempDirSync('paqvilo-tool-help-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const run = (name, args) =>
    withProcessSlot(
      () =>
        new Promise((resolve) =>
          execFile(
            process.execPath,
            ['--import', guard, bin, 'mirage', name, ...args],
            { cwd, encoding: 'utf8', windowsHide: true },
            (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
          ),
        ),
    );
  return { cwd, run };
}

async function completeAll(tasks) {
  const results = await Promise.allSettled(tasks);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

test('every advertised operational option is accepted by the execution schema', () => {
  for (const name of Object.keys(MIRAGE_TOOLS))
    for (const [key, string] of documentedOptions(name))
      assert.doesNotThrow(() => parseToolArgs(name, ['--' + key, ...(string ? ['missing'] : [])]), `${name}: ${key}`);
});

test('shared parsing preserves operational defaults, repeated values, empty-value policies and terminators', () => {
  assert.equal(parseToolArgs('acceptance', []).output, '.paqvilo/simulator/acceptance/evidence');
  assert.equal(parseToolArgs('acceptance', []).strict, false);
  assert.deepEqual(parseToolArgs('parity-suite', ['--pack', 'one', '--pack', 'two']).pack, ['one', 'two']);
  assert.equal(parseToolArgs('parity-suite', ['--label', '']).label, '');
  assert.throws(() => parseToolArgs('liquid-inventory', ['--portal=']), /nonempty/);
  assert.throws(() => parseToolArgs('capture-shell', ['--', '--help']), /Unexpected argument/);
  assert.throws(() => parseToolHelp('trace', ['--', '--help']), /Unexpected positional/);
  assert.throws(() => parseToolHelp('trace', ['list', 'extra', '--help']), /Unexpected positional/);
  assert.equal(parseToolHelp('capture-shell', ['--config=--help', '--help']).values.config, '--help');
});

test('every standalone tool accepts configured help in either order, -h and JSON without side effects', async (t) => {
  const { cwd, run } = await fixture(t);
  assert.deepEqual(Object.keys(examples).sort(), Object.keys(MIRAGE_TOOLS).sort());
  await completeAll(
    Object.entries(examples).map(async ([name, args]) => {
      for (const flags of [
        ['--help'],
        [...args, '--help'],
        ['--help', ...args],
        [...args, '-h'],
        [...args, '--help', '--json'],
        [
          '--help',
          ...documentedOptions(name).flatMap(([key, string]) =>
            string ? ['--' + key, 'missing-one', '--' + key, 'missing-two'] : ['--' + key],
          ),
        ],
      ]) {
        const result = await run(name, flags);
        assert.equal(result.status, 0, `${name} ${flags.join(' ')}: ${result.stderr}`);
        assert.equal(result.stdout, mirageToolHelp(name) + '\n');
        assert.equal(result.stderr, '');
      }
    }),
  );
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('standalone help rejects malformed arguments with clean JSON errors before side effects', async (t) => {
  const { cwd, run } = await fixture(t);
  await completeAll(
    Object.keys(MIRAGE_TOOLS).map(async (name) => {
      const malformed = [
        ['--invented-invalid-option', '--help'],
        ['unexpected', '--help'],
        ['--help', '--', '--help'],
      ];
      if (name !== 'verify-storage') {
        const option = examples[name].find(
          (arg) => arg.startsWith('--') && !['--json', '--allow-writes'].includes(arg),
        );
        malformed.push(['--help', option], [option, '--help']);
      }
      for (const flags of malformed) {
        const result = await run(name, ['--json', ...flags]);
        assert.equal(result.status, 1, `${name} ${flags.join(' ')}: ${result.stdout} ${result.stderr}`);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, false);
        assert.equal(output.error.code, 'INVALID_ARGUMENT');
        assert.match(output.error.message, /Unknown option|Unexpected|requires a value|argument .*missing|ambiguous/i);
        assert.equal(result.stderr, '');
      }
    }),
  );
  assert.deepEqual(fs.readdirSync(cwd), []);
});

// Built-ins that allow-listed modules import statically; the help guard refuses their side effects at run time.
const GUARD_PERMITTED_BUILTINS = new Set(['node:child_process', 'node:fs', 'node:url', 'node:util']);

function guardAllowedModules() {
  const source = fs.readFileSync(new URL('./cli-help-guard.mjs', import.meta.url), 'utf8');
  return [...source.matchAll(/'(\.\.\/[^']+\.mjs)'/g)].map((match) => new URL(match[1], guard).href);
}

function staticSpecifiers(source) {
  return [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'|^import\s+'([^']+)'/gm)].map(
    (match) => match[1] ?? match[2],
  );
}

test('every module in the help guard allow-list imports only allow-listed modules and permitted built-ins', () => {
  const allowed = guardAllowedModules();
  const allowedSet = new Set(allowed);
  assert.ok(
    allowedSet.has(new URL('../bin/paqvilo.mjs', import.meta.url).href),
    'guard list must name the entry point',
  );
  for (const href of allowed) {
    for (const specifier of staticSpecifiers(fs.readFileSync(new URL(href), 'utf8'))) {
      const permitted = specifier.startsWith('node:')
        ? GUARD_PERMITTED_BUILTINS.has(specifier)
        : allowedSet.has(new URL(specifier, href).href);
      assert.ok(permitted, `${href} statically imports ${specifier}`);
    }
  }
});
