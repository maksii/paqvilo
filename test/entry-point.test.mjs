// @test-kind contract: Paqvilo's scripts run their command when started through a linked folder (macOS /tmp and /var)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../lense/entry-point.mjs';

const checkoutFile = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url));
const helper = new URL('../lense/entry-point.mjs', import.meta.url).href;

function linkedFolder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-entry-point-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const physical = path.join(root, 'physical');
  const linked = path.join(root, 'linked');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, linked, process.platform === 'win32' ? 'junction' : 'dir');
  return { physical, linked };
}

test('a script started through a linked folder is the entry point; an imported one is not', (t) => {
  const { physical, linked } = linkedFolder(t);
  fs.writeFileSync(
    path.join(physical, 'script.mjs'),
    `import { isEntryPoint } from ${JSON.stringify(helper)};\nprocess.stdout.write(String(isEntryPoint(import.meta.url)));\n`,
  );
  fs.writeFileSync(path.join(physical, 'importer.mjs'), `import './script.mjs';\n`);
  for (const folder of [physical, linked]) {
    // Node reports the real path in import.meta.url whichever path it was started with.
    const started = execFileSync(process.execPath, [path.join(folder, 'script.mjs')], { encoding: 'utf8' });
    assert.equal(started.trim(), 'true', `started from ${folder}`);
    const imported = execFileSync(process.execPath, [path.join(folder, 'importer.mjs')], { encoding: 'utf8' });
    assert.equal(imported.trim(), 'false', `imported from ${folder}`);
  }
});

test('no started script, or one that cannot be resolved, is not this module', () => {
  assert.equal(isEntryPoint(import.meta.url, ''), false, 'node -e has no started script');
  assert.equal(isEntryPoint(import.meta.url, path.join(os.tmpdir(), 'paqvilo-missing-entry', 'x.mjs')), false);
});

test('a packaged contributor script answers --help when started through a linked checkout folder', (t) => {
  const { physical, linked } = linkedFolder(t);
  fs.mkdirSync(path.join(physical, 'scripts'));
  fs.mkdirSync(path.join(physical, 'lense'));
  fs.copyFileSync(
    checkoutFile('scripts/conventional-commit.mjs'),
    path.join(physical, 'scripts/conventional-commit.mjs'),
  );
  fs.copyFileSync(checkoutFile('scripts/script-help.mjs'), path.join(physical, 'scripts/script-help.mjs'));
  fs.copyFileSync(checkoutFile('lense/entry-point.mjs'), path.join(physical, 'lense/entry-point.mjs'));
  const output = execFileSync(process.execPath, [path.join(linked, 'scripts/conventional-commit.mjs'), '--help'], {
    encoding: 'utf8',
  });
  assert.match(output, /usage/i);
});
