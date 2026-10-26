import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSmokeNpm } from '../scripts/smoke-npm.mjs';

test('offline smoke npm child overrides an inherited enabled update notifier', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-smoke-npm-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'npm.mjs');
  fs.writeFileSync(
    cli,
    'process.stdout.write(JSON.stringify({notifier: process.env.npm_config_update_notifier, args: process.argv.slice(2)}));',
  );
  const previous = process.env.npm_config_update_notifier;
  t.after(() => {
    if (previous === undefined) delete process.env.npm_config_update_notifier;
    else process.env.npm_config_update_notifier = previous;
  });
  process.env.npm_config_update_notifier = 'true';
  const args = ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'];
  assert.deepEqual(JSON.parse(runSmokeNpm(cli, args, directory)), { notifier: 'false', args });
});
