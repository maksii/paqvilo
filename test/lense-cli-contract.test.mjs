import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { FILES } from './fixture.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { cliArgs } from '../lense/commands/mirage.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const runWithEnv = (cwd, overrides, ...args) =>
  withProcessSlot(
    () =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [cli, 'lense', ...args],
          { cwd, env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true, timeout: 30000 },
          (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
        );
      }),
  );
const run = (cwd, ...args) => runWithEnv(cwd, {}, ...args);

test('invalid action arguments are rejected before configuration or discovery reads', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo cli \u00fc '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const missing = path.join(cwd, 'missing \u00fc.json');
  const cases = [
    ['resources', '--config', missing, '--limit', '0', '--json'],
    ['resources', '--config', missing, '--page', '//elsewhere', '--json'],
    ['agent', 'events', '--session', missing, '--limit', '0'],
    ['agent', 'viewport', '--session', missing, '--page-id', '1', '--width', '0'],
    ['model-driven', 'dev', '--project', missing, '--timeout', 'invalid', '--json'],
    ['mirage', 'start', '--project', missing, '--out', 'invalid.yml', '--json'],
    ['mirage', 'start', '--project', missing, '--port', '65536', '--json'],
    ['mirage', 'start', '--project', missing, '--startup-timeout', '0', '--json'],
  ];
  const messages = [/--limit/, /--page/, /--limit/, /--width/, /--timeout/, /--out/, /--port/, /--startup-timeout/];
  for (const [index, args] of cases.entries()) {
    const result = await run(cwd, ...args);
    assert.equal(result.status, 1, args.join(' '));
    const report = JSON.parse(result.stdout);
    assert.equal(report.error.code, 'invalid_argument', args.join(' '));
    assert.match(report.error.message, messages[index]);
    assert.equal(result.stderr, '');
    assert.deepEqual(report.writesFiles, []);
  }
});

test('action-specific options cannot be silently ignored', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo cli \u00fc '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const args of [
    ['mirage', 'status', '--port', '123', '--json'],
    ['mirage', 'inspect', '--port', '0', '--json'],
    ['model-driven', 'inspect', '--project', 'missing.json', '--headless', '--json'],
  ]) {
    const result = await run(cwd, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(JSON.parse(result.stdout).error.code, 'unsupported_option');
    assert.equal(result.stderr, '');
  }
});

test('empty options, conflicting use selectors and non-decimal deadlines fail before loading configuration', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo cli \u00fc '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const cases = [
    ['list', '--config=', '--json'],
    ['resources', '--source=', '--json'],
    ['resources', '--kind=', '--json'],
    ['use', 'one', 'dev', '--site', 'two'],
    ['use', 'one', 'dev', '--env', 'prod'],
    ['list', '--portals', 'invalid', '--json'],
    ['verify', '--sign-in-timeout', '1e3', '--json'],
    ['mirage', 'start', '--startup-timeout', '1e3', '--json'],
  ];
  for (const args of cases) {
    const result = await run(cwd, ...args);
    assert.equal(result.status, 1, args.join(' '));
    const output = args.includes('--json') ? JSON.parse(result.stdout).error.message : result.stderr;
    assert.match(output, /empty|not both|must be/, args.join(' '));
    assert.equal(fs.existsSync(path.join(cwd, '.env')), false);
  }
});

test('use selections and source paths with Unicode and special characters round-trip', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo cli \u00fc '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const repo = path.join(cwd, 'r\u00e9po & space');
  const source = path.join(repo, 'export #1');
  for (const [name, content] of Object.entries(FILES)) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const config = path.join(cwd, 'catalogue \u00fc.json');
  const site = 'sample';
  const environment = 'stage';
  fs.writeFileSync(
    config,
    JSON.stringify({
      sites: { [site]: { source: 'export #1', environments: { [environment]: 'http://127.0.0.1:8787' } } },
    }),
  );
  const selected = await run(cwd, 'use', site, environment, '--config', config, '--repo', repo);
  assert.equal(selected.status, 0, selected.stderr);
  const settings = parseEnv(fs.readFileSync(path.join(cwd, '.env'), 'utf8'));
  assert.equal(settings.PAQVILO_SITE, site);
  assert.equal(settings.PAQVILO_ENV, environment);
  const result = await run(cwd, 'resources', '--config', config, '--repo', repo, '--source', source, '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.site, site);
  assert.equal(report.environment, environment);
  assert.equal(path.resolve(report.sourceDir), source);
});

test('parse errors respect the option terminator when choosing output format', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo cli '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const text = await run(cwd, 'list', '--bogus', '--', '--json');
  assert.equal(text.status, 1);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /Unknown option/);
  const json = await run(cwd, 'list', '--json', '--bogus', '--', 'anything');
  assert.equal(json.status, 1);
  assert.equal(json.stderr, '');
  assert.equal(JSON.parse(json.stdout).error.code, 'unsupported_option');
});

test('list reports a successfully written optional Solution cache', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo cli cache '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(FILES)) {
    const file = path.join(cwd, 'portal', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const solution = path.join(cwd, 'solution', 'Other');
  fs.mkdirSync(solution, { recursive: true });
  fs.writeFileSync(
    path.join(solution, 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>Sample</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  fs.writeFileSync(path.join(solution, 'Customizations.xml'), '<ImportExportXml><Entities/></ImportExportXml>');
  const config = path.join(cwd, 'catalogue.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      sourceRoot: cwd,
      sites: {
        sample: {
          source: 'portal',
          environments: { dev: 'http://127.0.0.1:8787' },
          mirage: { solutionRoots: ['solution'] },
        },
      },
    }),
  );
  const result = await run(cwd, 'list', '--config', config, '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  const cache = path.join(cwd, '.paqvilo', 'simulator', 'cache', 'solution-discovery.json');
  assert.deepEqual(report.writesFiles, [cache]);
  assert.ok(fs.existsSync(cache));
});

test('use redacts environment URL queries and shell URL values', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo cli url '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const config = path.join(cwd, 'catalogue.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      sites: { sample: { source: '.', environments: { dev: 'https://example.test/?token=config-secret' } } },
    }),
  );
  const result = await runWithEnv(
    cwd,
    { PAQVILO_URL: 'https://other.test/?token=shell-secret' },
    'use',
    'sample',
    'dev',
    '--config',
    config,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAQVILO_URL.*wins over/);
  assert.match(result.stdout, /\?\[redacted\]/);
  assert.doesNotMatch(result.stdout, /config-secret|shell-secret/);
});

test('offline Mirage inspect forwards source selection and omits inherited runtime-only options', () => {
  const cfg = {
    siteName: 'sample',
    envName: 'dev',
    sourceDir: 'portal',
    origin: 'https://example.test',
    configFile: 'config.json',
    mirageConfig: {},
  };
  const args = {
    port: '1234',
    state: 'state.json',
    preset: 'sample',
    'preset-mode': 'always',
    'apply-configuration': true,
    'allow-live-writes': true,
    runtime: 'power-pages',
    simulation: 'simulation',
  };
  for (const [config, project] of [
    [cfg, null],
    [cfg, { configFile: 'project.json', runtime: { kind: 'power-pages' } }],
    [{ ...cfg, runtime: { kind: 'model-driven' } }, null],
  ]) {
    const values = cliArgs(config, 'inspect', args, project).values;
    for (const option of [
      '--state-dir',
      '--port',
      '--state',
      '--preset',
      '--preset-mode',
      '--apply-configuration',
      '--allow-live-writes',
      '--origin',
    ])
      assert.ok(!values.includes(option), `${option} must not reach inspect`);
    assert.ok(values.includes('--runtime'));
    assert.ok(values.includes('--simulation'));
  }
});

test('Mirage status finds its ownership directory without requiring the project or catalogue to remain present', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo cli status '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const option of ['--project', '--config']) {
    const missing = path.join(cwd, 'removed.json');
    const result = await run(cwd, 'mirage', 'status', option, missing, '--json');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.sessions, []);
  }
});

test('list redacts query and fragment values in configured and selected locations', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo cli list '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(FILES)) {
    const file = path.join(cwd, 'portal', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const config = path.join(cwd, 'catalogue.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      sourceRoot: cwd,
      sites: {
        sample: {
          source: 'portal',
          environments: {
            dev: {
              url: 'https://example.test/?token=config-secret#fragment-secret',
              startPath: '/page?key=path-secret',
            },
          },
        },
      },
    }),
  );
  for (const extra of [[], ['--json']]) {
    const result = await runWithEnv(
      cwd,
      { PAQVILO_URL: 'https://other.test/?token=shell-secret', PAQVILO_START_PATH: '/page?key=start-secret' },
      'list',
      '--config',
      config,
      ...extra,
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /config-secret|fragment-secret|path-secret|shell-secret|start-secret/);
    assert.match(result.stdout, /redacted/);
    if (extra.length) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.sites[0].environments[0].url, 'https://example.test/?[redacted]');
      assert.equal(report.settings.PAQVILO_URL, 'https://other.test/?[redacted]');
      assert.equal(report.coverage.targets[0].startPath, '/page?[redacted]');
    }
  }
});
