// @test-kind tooling: standalone public help validates real schemas without resolving or executing operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIRAGE_TOOLS, MIRAGE_TOOL_USAGE_EXIT, mirageToolHelp } from '../mirage/tool-registry.mjs';
import { parseToolArgs, parseToolHelp } from '../mirage/tool-options.mjs';
import { boundedCommand, COMMAND_HANG_GUARD_MS } from './helpers/bounded-command.mjs';
import { operationBudget, countOperations } from './helpers/operation-budget.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { tempDirSync } from './fixture.mjs';

const bin = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const guard = new URL('./cli-help-guard.mjs', import.meta.url).href;
// Derive argument types independently from public help, rather than importing private parser tables: [name, takes a
// value, repeatable (help marks it `...`)].
const documentedOptions = (name) =>
  [
    ...new Map(
      [...MIRAGE_TOOLS[name].matchAll(/--([\w-]+)(?: ([^\s\]]+))?( \.\.\.|\]\.\.\.)?/g)].map((match) => [
        match[1],
        [/^[\w/]/.test(match[2] ?? ''), Boolean(match[3])],
      ]),
    ).entries(),
  ].map(([key, [string, repeatable]]) => [key, string, repeatable]);
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

const helpFlags = (name, args) => [
  ['--help'],
  [...args, '--help'],
  ['--help', ...args],
  [...args, '-h'],
  [...args, '--help', '--json'],
  [
    '--help',
    // Every documented option: a repeatable one twice, a single-value one once (a repeat is refused).
    ...documentedOptions(name).flatMap(([key, string, repeatable]) => {
      if (!string) return ['--' + key];
      return repeatable ? ['--' + key, 'missing-one', '--' + key, 'missing-two'] : ['--' + key, 'missing-one'];
    }),
  ],
];
const malformedFlags = (name) => {
  const malformed = [
    ['--invented-invalid-option', '--help'],
    ['unexpected', '--help'],
    ['--help', '--', '--help'],
  ];
  if (name !== 'verify-storage') {
    const option = examples[name].find((arg) => arg.startsWith('--') && !['--json', '--allow-writes'].includes(arg));
    malformed.push(['--help', option], [option, '--help']);
  }
  return malformed;
};
const helpCount = Object.entries(examples).reduce((count, [name, args]) => count + helpFlags(name, args).length, 0);
const malformedCount = Object.keys(MIRAGE_TOOLS).reduce((count, name) => count + malformedFlags(name).length, 0);

async function fixture(t, commands) {
  const cwd = tempDirSync('paqvilo-tool-help-');
  ownedFixture(t).remove(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const run = countOperations(t, commands, (name, args) =>
    boundedCommand(t, process.execPath, ['--import', guard, bin, 'mirage', name, ...args], { cwd }),
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

// These finite batches retain every tool/flag case. The execution guard belongs
// to each command, after it acquires a slot, rather than to the whole queue.
test(
  'every standalone tool accepts configured help in either order, -h and JSON without side effects',
  { timeout: operationBudget(helpCount, COMMAND_HANG_GUARD_MS) },
  async (t) => {
    const { cwd, run } = await fixture(t, helpCount);
    assert.deepEqual(Object.keys(examples).sort(), Object.keys(MIRAGE_TOOLS).sort());
    await completeAll(
      Object.entries(examples).map(async ([name, args]) => {
        for (const flags of helpFlags(name, args)) {
          const result = await run(name, flags);
          assert.equal(result.status, 0, `${name} ${flags.join(' ')}: ${result.stderr}`);
          assert.equal(result.stdout, mirageToolHelp(name) + '\n');
          assert.equal(result.stderr, '');
        }
      }),
    );
    assert.deepEqual(fs.readdirSync(cwd), []);
  },
);

test(
  'standalone help rejects malformed arguments with clean JSON errors before side effects',
  { timeout: operationBudget(malformedCount, COMMAND_HANG_GUARD_MS) },
  async (t) => {
    const { cwd, run } = await fixture(t, malformedCount);
    await completeAll(
      Object.keys(MIRAGE_TOOLS).map(async (name) => {
        for (const flags of malformedFlags(name)) {
          const result = await run(name, ['--json', ...flags]);
          // With --help as without it, the tool's own argument-error exit code.
          assert.equal(
            result.status,
            MIRAGE_TOOL_USAGE_EXIT[name] ?? 1,
            `${name} ${flags.join(' ')}: ${result.stdout} ${result.stderr}`,
          );
          const output = JSON.parse(result.stdout);
          assert.equal(output.ok, false);
          // An unknown option is unsupported_option in every command; other help-time refusals INVALID_ARGUMENT.
          assert.equal(
            output.error.code,
            flags[0] === '--invented-invalid-option' ? 'unsupported_option' : 'INVALID_ARGUMENT',
          );
          assert.match(
            output.error.message,
            /Unknown option|Unexpected|requires a value|argument .*missing|ambiguous/i,
          );
          assert.equal(result.stderr, '');
        }
      }),
    );
    assert.deepEqual(fs.readdirSync(cwd), []);
  },
);

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
