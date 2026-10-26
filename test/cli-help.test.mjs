import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MIRAGE_COMMANDS, MIRAGE_TOOLS } from '../mirage/tool-registry.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { tempDirSync } from './fixture.mjs';

const bin = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
// Asynchronous so that the independent invocations of one test run concurrently.
const run = (args, options = {}) =>
  withProcessSlot(
    () =>
      new Promise((resolve) =>
        execFile(
          process.execPath,
          [bin, ...args],
          { env, encoding: 'utf8', windowsHide: true, timeout: 30000, ...options },
          (error, stdout, stderr) =>
            resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }),
        ),
      ),
  );

test('public tool registry routes each tool-specific help and prints the package version', async () => {
  const tools = Object.keys(MIRAGE_TOOLS);
  const [version, help, doctor, ...toolHelp] = await Promise.all([
    run(['--version']),
    run(['--help']),
    run(['doctor', '--help']),
    ...tools.map((name) => run(['mirage', name, '--help'])),
  ]);
  for (const [index, name] of tools.entries()) {
    assert.equal(toolHelp[index].status, 0, toolHelp[index].stderr);
    assert.ok(toolHelp[index].stdout.includes(`paqvilo mirage ${name}`), name);
  }
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(version.stdout.trim(), pkg.version);
  assert.equal(help.status, 0);
  for (const name of ['doctor', ...tools]) assert.ok(help.stdout.includes(name), name);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /Usage: paqvilo doctor --setup \[--json\] \[--config FILE\] \[--browser CHANNEL\]/);
});

test('unknown Mirage commands reject before project and source resolution in an empty directory', async (t) => {
  const root = tempDirSync('paqvilo-unknown-mirage-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unknown = [
    ['mirage', 'nosuchcommand'],
    ['mirage', 'xyz'],
    ['mirage', 'nosuchcommand', '--project', 'missing.json'],
    ['lense', 'mirage', 'nosuchcommand'],
  ];
  const [typo, help, ...results] = await Promise.all([
    run(['mirage', 'strat'], { cwd: root }),
    run(['mirage', '--help'], { cwd: root }),
    ...unknown.map((args) => run(args, { cwd: root })),
  ]);
  for (const [index, args] of unknown.entries()) {
    const result = results[index],
      label = args.join(' ');
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, /Unknown (?:command|mirage action)/, label);
    assert.match(result.stderr, /--help/, label);
    assert.doesNotMatch(result.stderr, /does not look like|ENOENT|portal-export/, label);
    assert.doesNotMatch(result.stderr, /Closest command:/, label);
  }
  assert.deepEqual(fs.readdirSync(root), [], 'unknown commands do not create local project state');
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /Closest command: start/);
  for (const command of MIRAGE_COMMANDS) {
    assert.ok(typo.stderr.includes(command), command);
    assert.ok(help.stdout.includes(command), command);
  }
});
