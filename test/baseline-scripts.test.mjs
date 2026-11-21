// @test-kind tooling: the baseline generator scripts answer --help and unknown options without writing, and --check guards the committed inventories
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = (name) => path.join(root, 'scripts', `${name}.mjs`);
const run = (name, args) =>
  spawnSync(process.execPath, [script(name), ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
const inventories = ['dataverse-inventory.md', 'power-pages-inventory.md'].map((name) =>
  path.join(root, 'mirage', 'docs', 'baseline', name),
);
const snapshot = () =>
  Promise.all(inventories.map(async (file) => [await fs.readFile(file, 'utf8'), (await fs.stat(file)).mtimeMs]));

test('baseline-inventory --help and an unknown option print one answer and leave the inventories untouched', async () => {
  const before = await snapshot();
  const help = run('baseline-inventory', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: node scripts\/baseline-inventory\.mjs \[--check\]/);
  const unknown = run('baseline-inventory', ['--bogus']);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr.trim(), "Unknown option '--bogus'. Run with --help to see supported options.");
  assert.deepEqual(await snapshot(), before);
});

test('baseline-inventory --check passes on the committed inventories and writes nothing', async () => {
  const before = await snapshot();
  const check = run('baseline-inventory', ['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(await snapshot(), before);
});

// @test-kind tooling: an exported whole-number rollup (SourceType 2) is classified as the rollup column, not as an integer.
test('baseline-inventory classifies the exported whole-number rollup as dv.column.rollup', async () => {
  const [[inventory]] = await snapshot();
  const row = inventory.split('\n').find((line) => line.startsWith('| `dv.column.rollup`'));
  assert.match(row, /pqvd_baselineparent\.pqvd_rollup \(int\/none/);
  assert.doesNotMatch(row, /manual maker-portal step pending/);
});

for (const name of ['baseline-matrix', 'baseline-reference'])
  test(`${name} --help prints its usage and exits 0; an unknown option is named`, () => {
    const help = run(name, ['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`^Usage: node scripts/${name}\\.mjs --`));
    const unknown = run(name, ['--bogus']);
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stderr.trim(), "Unknown option '--bogus'. Run with --help to see supported options.");
  });

test('baseline-matrix creates the missing parent folder of --out', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-baseline-matrix-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const out = path.join(directory, 'missing', 'nested', 'matrix.json');
  const result = run('baseline-matrix', ['--out', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(await fs.readFile(out, 'utf8')).scenarios.length > 0);
});
