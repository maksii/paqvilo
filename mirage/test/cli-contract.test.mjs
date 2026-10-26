import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIRAGE_TOOLS } from '../tool-registry.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = (program, ...args) =>
  spawnSync(process.execPath, [path.join(root, program), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });
const fixture = path.join(root, 'mirage/test/fixtures/wet-boew-bilingual');

test('core commands reject extra positionals and retain preflight invocation exit code', () => {
  for (const [command, code] of [
    ['inspect', 1],
    ['preflight', 2],
  ]) {
    const result = run('mirage/cli.mjs', command, 'unexpected', '--source', fixture, '--json');
    assert.equal(result.status, code, result.stderr);
    assert.match(JSON.parse(result.stdout).error.message, /Unexpected positional argument: unexpected/);
    assert.equal(result.stderr, '');
  }
  const help = run('mirage/cli.mjs', '-h');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Commands:/);
});

test('render and matrix limits reject invalid values before running', () => {
  for (const value of ['nope', '0', '1.5', '1e3', '9007199254740992']) {
    for (const tool of ['render-sweep', 'portal-matrix']) {
      const result = run(`mirage/${tool}.mjs`, '--limit', value);
      assert.equal(result.status, 2, `${tool}: ${result.stderr}`);
      assert.match(result.stderr, /--limit must be a positive integer/);
      assert.equal(result.stdout, '');
    }
  }
});

test('manual tool parsers reject missing option values and invalid timeouts', async () => {
  const query = run('mirage/query-inventory.mjs', '--portal', '--json');
  assert.equal(query.status, 1);
  assert.match(JSON.parse(query.stdout).error.message, /--portal/);
  const missing = run('mirage/liquid-conformance.mjs', '--suite', '--json');
  assert.equal(missing.status, 2);
  assert.match(JSON.parse(missing.stdout).error.message, /--suite/);
  for (const value of ['nope', '0', '-1', '2147483648']) {
    const result = run('mirage/liquid-conformance.mjs', '--suite', 'unused', `--timeout=${value}`);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--timeout must be an integer/);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-тест-'));
  try {
    const suite = path.join(dir, 'suite.json');
    await fs.writeFile(suite, JSON.stringify({ tests: [] }));
    const result = run('mirage/liquid-conformance.mjs', '--suite', suite, '--json', '--timeout', '100');
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('baseline suite rejects extra actions before reading or writing files', () => {
  const result = run('mirage/baseline-suite.mjs', 'capture', 'unexpected', '--matrix', 'absent', '--out', 'absent');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('parity-suite rejects invalid delays before reading a plan or connecting', () => {
  for (const value of ['nope', '-1', '1.5', '2147483648']) {
    const result = run('mirage/parity-suite.mjs', `--delay-ms=${value}`);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--delay-ms must be an integer/);
  }
});

test('verify-storage rejects unexpected arguments before starting the large check', () => {
  for (const args of [['--bogus'], ['unexpected']]) {
    const result = run('mirage/verify-storage.mjs', ...args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--bogus|unexpected/);
    assert.equal(result.stdout, '');
  }
});

test('every public Mirage tool rejects an unknown flag before execution', () => {
  for (const name of Object.keys(MIRAGE_TOOLS)) {
    const result = run(`mirage/${name}.mjs`, '--bogus');
    assert.ok(result.status > 0, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /--bogus/, name);
    assert.equal(result.stdout, '', name);
  }
});

test('core commands reject options belonging to another command with JSON errors when requested', () => {
  for (const [command, flag] of [
    ['inspect', '--rows=2'],
    ['preflight', '--port=42'],
    ['serve', '--scenario=file'],
    ['data', '--no-watch'],
  ]) {
    const result = run('mirage/cli.mjs', command, flag, '--json');
    assert.equal(result.status, command === 'preflight' ? 2 : 1);
    assert.match(JSON.parse(result.stdout).error.message, /not supported/);
    assert.equal(result.stderr, '');
  }
  const result = run('mirage/cli.mjs', 'preflight', '--unknown', '--json');
  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stdout).error.message, /--unknown/);
  assert.equal(result.stderr, '');
});

test('JSON-capable tools return one structured error for invalid flags', () => {
  for (const name of [
    'bootstrap-report',
    'render-sweep',
    'liquid-inventory',
    'webapi-inventory',
    'portal-matrix',
    'liquid-conformance',
    'query-inventory',
    'capture-shell',
    'verify-storage',
  ]) {
    const result = run(`mirage/${name}.mjs`, '--bogus', '--json');
    assert.ok(result.status > 0, name);
    assert.match(JSON.parse(result.stdout).error.message, /--bogus/, name);
    assert.equal(result.stderr, '', name);
  }
});

test('unknown core command does not become successful help', () => {
  const result = run('mirage/cli.mjs', 'inspekt', '--help');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: inspekt/);
  assert.equal(result.stdout, '');
});

test('JSON and preflight detection respect option values and the terminator', () => {
  const positional = run('mirage/cli.mjs', 'inspect', '--', '--json');
  assert.equal(positional.status, 1);
  assert.equal(positional.stdout, '');
  assert.match(positional.stderr, /Unexpected positional/);
  const value = run('mirage/cli.mjs', 'render', '--path', 'preflight', '--bogus');
  assert.equal(value.status, 1);
  const tool = run('mirage/query-inventory.mjs', '--', '--json');
  assert.equal(tool.status, 1);
  assert.equal(tool.stdout, '');
});

test('JSON tools report missing inputs without reading a configured site', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-cli-empty-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
    for (const name of [
      'bootstrap-report',
      'render-sweep',
      'liquid-inventory',
      'webapi-inventory',
      'portal-matrix',
      'liquid-conformance',
      'query-inventory',
      'capture-shell',
    ]) {
      const result = spawnSync(process.execPath, [path.join(root, `mirage/${name}.mjs`), '--json'], {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
      });
      assert.ok(result.status > 0, `${name}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).ok, false, name);
      assert.equal(result.stderr, '', name);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('core rejects explicitly empty option values before source resolution', () => {
  for (const option of ['--source=', '--project=', '--site=', '--port=']) {
    const result = run('mirage/cli.mjs', 'inspect', option, '--json');
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error.message, /requires a nonempty value|not supported/);
    assert.equal(result.stderr, '');
  }
});

test('missing selectors write usage to stderr while help succeeds on stdout', () => {
  for (const name of ['render-sweep', 'liquid-inventory', 'portal-matrix']) {
    const missing = run(`mirage/${name}.mjs`);
    assert.equal(missing.status, 2, name);
    assert.match(missing.stderr, /Usage:/, name);
    assert.equal(missing.stdout, '', name);
    const help = run(`mirage/${name}.mjs`, '--help');
    assert.equal(help.status, 0, name);
    assert.match(help.stdout, /Usage:/, name);
    assert.equal(help.stderr, '', name);
  }
});
