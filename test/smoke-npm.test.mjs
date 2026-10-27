import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSmokeNpm, offlineSmokeEnv } from '../scripts/smoke-npm.mjs';

test('offline smoke children override inherited npm settings irrespective of casing', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-smoke-npm-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'npm.mjs');
  fs.writeFileSync(
    cli,
    `
    const names = ['offline', 'audit', 'fund', 'update_notifier'];
    process.stdout.write(JSON.stringify({ values: Object.fromEntries(names.map(name => [name, process.env['npm_config_' + name]])), args: process.argv.slice(2) }));
  `,
  );
  const names = ['OFFLINE', 'AUDIT', 'FUND', 'UPDATE_NOTIFIER'];
  const previous = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      names.some((name) => key.toLowerCase() === 'npm_config_' + name.toLowerCase()),
    ),
  );
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (names.some((name) => key.toLowerCase() === 'npm_config_' + name.toLowerCase())) delete process.env[key];
    Object.assign(process.env, previous);
  });
  for (const key of Object.keys(process.env))
    if (names.some((name) => key.toLowerCase() === 'npm_config_' + name.toLowerCase())) delete process.env[key];
  Object.assign(process.env, {
    NPM_CONFIG_OFFLINE: 'false',
    NPM_CONFIG_AUDIT: 'true',
    NPM_CONFIG_FUND: 'true',
    NPM_CONFIG_UPDATE_NOTIFIER: 'true',
  });
  const args = ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'];
  const expected = { values: { offline: 'true', audit: 'false', fund: 'false', update_notifier: 'false' }, args };
  assert.deepEqual(JSON.parse(runSmokeNpm(cli, args, directory)), expected);
  const child = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    env: offlineSmokeEnv(),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), expected);
});
