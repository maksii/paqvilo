import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../lense/dataverse/connection.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, [cli, 'dataverse', ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
const commands = {
  register: ['--connection', '--name'],
  connect: ['--registration', '--secret-file', '--connection'],
  inspect: ['--connection'],
  verify: ['--connection'],
  plan: ['--manifest'],
  apply: ['--manifest', '--connection'],
  publish: ['--manifest', '--connection'],
  keys: ['--manifest', '--connection'],
  'audit-lookups': ['--manifest', '--connection'],
  'scope-solutions': ['--manifest', '--connection'],
  export: ['--connection', '--solution', '--out'],
  'data-plan': ['--catalogue'],
  'data-apply': ['--catalogue', '--connection'],
  'data-compare': ['--catalogue', '--connection'],
  'data-query': ['--catalogue', '--connection'],
};

test('all Dataverse commands validate arguments before connection, manifest or PAC access', () => {
  for (const [command, required] of Object.entries(commands)) {
    const help = run(command, '--help');
    assert.equal(help.status, 0, command);
    assert.match(help.stdout, /paqvilo dataverse/);
    assert.equal(help.stderr, '');
    const invalid = run(
      command,
      '--connection',
      'missing-connection.json',
      '--environment',
      'https://example.test',
      '--catalogue',
      'missing.json',
    );
    assert.equal(invalid.status, 1, command);
    assert.match(invalid.stderr, /not valid for dataverse/, command);
    assert.doesNotMatch(invalid.stderr, /ENOENT/, command);
    for (const omitted of required) {
      const supplied = required.filter((key) => key !== omitted).flatMap((key) => [key, 'missing-file']);
      const missing = run(command, ...supplied);
      assert.equal(missing.status, 1, `${command} ${omitted}`);
      assert.match(missing.stderr, new RegExp(omitted), command);
    }
  }
  for (const command of ['invented', 'constructor', '__proto__']) {
    const unknown = run(command, '--connection', 'missing.json');
    assert.match(unknown.stderr, /Unknown dataverse command/);
  }
  assert.equal(run('verify', '--connection', 'missing.json', '--', '--help').status, 1);
});

test('Dataverse diagnostics use the requested stream and retain the JSON error payload', () => {
  const human = run('verify');
  assert.equal(human.status, 1);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /^paqvilo dataverse: .*--connection/);
  const machine = run('plan', '--json');
  assert.equal(machine.status, 1);
  assert.equal(machine.stderr, '');
  assert.deepEqual(JSON.parse(machine.stdout), {
    ok: false,
    error: { code: 'DATAVERSE_COMMAND_FAILED', message: '--manifest required for dataverse plan' },
  });
  const commonJson = run('verify', '--json');
  assert.equal(commonJson.stderr, '');
  assert.match(JSON.parse(commonJson.stdout).error.message, /--connection/);
  const blank = run('export', '--connection', 'missing.json', '--solution', '', '--out', 'out.zip', '--json');
  assert.match(JSON.parse(blank.stdout).error.message, /--solution required/);
  const terminator = run('plan', '--', '--json');
  assert.equal(terminator.status, 1);
  assert.equal(terminator.stdout, '');
  assert.match(terminator.stderr, /^paqvilo dataverse:/);
});

test('malformed credential input does not expose file contents in diagnostics', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-dataverse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'connection.json');
  await fs.writeFile(file, '{"credential":"invented-private-value" INVALID');
  for (const command of ['inspect', 'verify']) {
    const result = run(command, '--connection', file, '--json');
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).error.message, 'Invalid JSON input.');
    assert.doesNotMatch(result.stdout, /invented-private-value/);
  }
});

test('PAC runner preserves Unicode and metacharacters as arguments and hides start errors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-process-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'OneDrive - Example', 'Проєкт & space');
  await fs.mkdir(folder, { recursive: true });
  const script = path.join(folder, 'invented runner.mjs');
  await fs.writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const args = ['path with spaces', 'Проєкт & $(not-a-command)', 'quote"value'];
  const result = await runProcess(process.execPath, [script, ...args]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(result.stderr, '');
  await assert.rejects(runProcess(path.join(folder, 'missing-executable'), []), /could not start.*permissions/);
});

test('offline data plan writes its complete report and --json prints that report', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-data-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalogue = path.join(root, 'catalogue.json');
  const report = path.join(root, 'report.json');
  await fs.writeFile(
    catalogue,
    JSON.stringify({
      schemaVersion: 1,
      datasetId: 'invented',
      version: 'v1',
      clock: '2026-01-01T00:00:00Z',
      tables: [],
      records: [],
      associations: [],
      queries: [],
    }),
  );
  const result = run('data-plan', '--catalogue', catalogue, '--out', report, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(await fs.readFile(report, 'utf8')));
  const summary = run('data-plan', '--catalogue', catalogue, '--out', report);
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(JSON.parse(summary.stdout).savedTo, report);
});
