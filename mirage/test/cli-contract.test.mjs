// @test-kind contract: Paqvilo's own simulator administration, CLI, configuration and runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIRAGE_TOOLS } from '../tool-registry.mjs';
import { assertReportOutput } from '../lib/report-output.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

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
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-тест-'));
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
    'trace',
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
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-cli-empty-'));
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
      'trace',
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

test('explicit source selectors and data flags are validated before source reads', () => {
  for (const args of [
    ['inspect', '--source', fixture, '--portal', 'missing'],
    ['inspect', '--project', 'missing-project', '--source', fixture],
    ['data', 'scaffold', '--pack', 'ignored'],
    ['data', 'scaffold', 'unexpected'],
  ]) {
    const result = run('mirage/cli.mjs', ...args, '--json');
    assert.equal(result.status, 1, args.join(' '));
    const message = JSON.parse(result.stdout).error.message;
    assert.match(
      message,
      /--portal selects|either --project or --source|supported only by data generate|exactly one action/,
    );
    assert.doesNotMatch(message, /ENOENT|portal extract/);
    assert.equal(result.stderr, '');
  }
});

test('public tool option tables reject empty string values', () => {
  for (const [name, option] of [
    ['portal-matrix', '--only='],
    ['liquid-inventory', '--out='],
    ['webapi-inventory', '--portal='],
    ['render-sweep', '--path='],
  ]) {
    const result = run(`mirage/${name}.mjs`, option, '--json');
    assert.ok(result.status > 0, name);
    assert.match(JSON.parse(result.stdout).error.message, /requires a nonempty value/, name);
    assert.equal(result.stderr, '', name);
  }
});

test('data counts fail before resolving a missing catalogue', () => {
  for (const args of [
    ['scaffold', '--rows', 'invalid'],
    ['generate', '--materialize-persona-memberships', '--count', 'items=invalid'],
    ['generate', '--materialize-persona-memberships', '--count', 'items=1', '--count', 'items=2'],
  ]) {
    const result = run('mirage/cli.mjs', 'data', ...args, '--config', 'missing-catalogue.yml', '--json');
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error.message, /--rows|--count/);
    assert.equal(result.stderr, '');
  }
});

test('conformance output cannot replace suite or rules through direct or hard-linked paths', async () => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-conformance-'));
  try {
    const suite = path.join(dir, 'suite.json'),
      rules = path.join(dir, 'rules.json'),
      alias = path.join(dir, 'alias.json');
    const suiteData = JSON.stringify({ tests: [] }),
      rulesData = JSON.stringify({ rules: [] });
    await fs.writeFile(suite, suiteData);
    await fs.writeFile(rules, rulesData);
    await fs.link(suite, alias);
    for (const out of [suite, rules, alias]) {
      const result = run('mirage/liquid-conformance.mjs', '--suite', suite, '--rules', rules, '--out', out, '--json');
      assert.equal(result.status, 2);
      assert.match(JSON.parse(result.stdout).error.message, /--out must not refer to the suite or rules/);
      assert.equal(await fs.readFile(suite, 'utf8'), suiteData);
      assert.equal(await fs.readFile(rules, 'utf8'), rulesData);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('bootstrap and Liquid report outputs preserve portal sources and catalogue aliases', async () => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-report-boundary-'));
  try {
    const source = path.join(dir, 'portal');
    await fs.cp(fixture, source, { recursive: true });
    const sourceFile = path.join(source, 'website.yml');
    const sourceBytes = await fs.readFile(sourceFile);
    const sourceLink = path.join(dir, 'source-link.yml');
    await fs.link(sourceFile, sourceLink);
    const config = path.join(dir, 'catalogue.yml');
    await fs.writeFile(
      config,
      JSON.stringify({
        sourceRoot: dir,
        defaultSite: 'sample',
        sites: { sample: { source: 'portal', environments: { dev: 'https://invented.example.invalid' } } },
      }),
    );
    const configBytes = await fs.readFile(config);
    const configLink = path.join(dir, 'config-link.yml');
    await fs.link(config, configLink);
    for (const [tool, selector, outputFlag] of [
      ['bootstrap-report', ['--config', config, '--site', 'sample'], '--output'],
      ['liquid-inventory', ['--config', config, '--site', 'sample'], '--out'],
    ]) {
      for (const output of [sourceFile, sourceLink, config, configLink]) {
        const result = run(`mirage/${tool}.mjs`, ...selector, outputFlag, output, '--json');
        assert.ok(result.status > 0, `${tool}: ${output}`);
        assert.match(JSON.parse(result.stdout).error.message, /Report output must/);
        assert.equal(result.stderr, '');
        assert.deepEqual(await fs.readFile(sourceFile), sourceBytes);
        assert.deepEqual(await fs.readFile(config), configBytes);
      }
      const output = path.join(dir, `${tool}.json`);
      const good = run(`mirage/${tool}.mjs`, ...selector, outputFlag, output, '--json');
      assert.equal(good.status, 0, good.stderr || good.stdout);
      assert.doesNotThrow(() => JSON.parse(good.stdout));
      const written = await fs.readFile(output, 'utf8');
      assert.doesNotThrow(() => JSON.parse(written));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('render refuses to overwrite a portal source or linked workspace state before startup', async () => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-render-boundary-'));
  try {
    const source = path.join(dir, 'portal');
    await fs.cp(fixture, source, { recursive: true });
    const sourceFile = path.join(source, 'website.yml');
    const original = await fs.readFile(sourceFile);
    const linked = path.join(dir, 'linked.yml');
    await fs.link(sourceFile, linked);
    const state = path.join(dir, 'state.json');
    await fs.writeFile(state, '{"invented":true}');
    const stateLink = path.join(dir, 'state-link.json');
    await fs.link(state, stateLink);
    for (const output of [sourceFile, linked, stateLink]) {
      const result = run('mirage/cli.mjs', 'render', '--source', source, '--state', state, '--output', output);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Report output must/);
      assert.doesNotMatch(result.stderr, /runtime-startup/);
      assert.deepEqual(await fs.readFile(sourceFile), original);
      assert.equal(await fs.readFile(state, 'utf8'), '{"invented":true}');
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('missing optional source roots do not prevent external report output', async () => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-missing-root-'));
  try {
    const missing = path.join(dir, 'missing-solution');
    await assert.doesNotReject(assertReportOutput(path.join(dir, 'report.json'), { sourceRoots: [missing] }));
    await assert.rejects(
      assertReportOutput(path.join(missing, 'report.json'), { sourceRoots: [missing] }),
      /outside portal and solution sources/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('report output rejects dangling symbolic links instead of writing through them', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-dangling-output-'));
  try {
    const source = path.join(dir, 'portal');
    await fs.cp(fixture, source, { recursive: true });
    const link = path.join(dir, 'report-link');
    const target = path.join(source, process.platform === 'win32' ? 'new-dir' : 'new-report.json');
    const output = process.platform === 'win32' ? path.join(link, 'report.json') : link;
    try {
      await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symbolic links unavailable');
      throw error;
    }
    const result = run('mirage/liquid-inventory.mjs', '--portal', source, '--out', output, '--json');
    assert.notEqual(result.status, 0);
    assert.match(JSON.parse(result.stdout).error.message, /dangling symbolic link/);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
