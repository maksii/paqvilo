import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateMatrix, scenarioDir, captureMatrix } from '../baseline-suite.mjs';
const scenario = (id) => ({ id, steps: [{ goto: '/invented/' }] }),
  matrix = (id) => ({ version: 1, scenarios: [scenario(id)] });
const BAD_ID = /scenario id must contain safe nonempty relative directory segments/;
const BAD_LABEL = /capture label must be one portable directory name/;

test('traversing, absolute, empty-segment and reserved scenario ids are refused by the matrix and the path builder', () => {
  for (const id of [
    'a/../../outside',
    'a/../outside',
    'a/./b',
    'a//b',
    'a/',
    '/absolute',
    'C:/absolute',
    'C:relative',
    'a\\..\\outside',
    '\\\\server\\share',
    'a/.../b',
    'a/.. /b',
    'a/CON/b',
  ]) {
    assert.throws(() => validateMatrix(matrix(id)), BAD_ID, id);
    assert.throws(() => scenarioDir('root', scenario(id), 'native'), BAD_ID, id);
  }
});
test('CLI labels that are not one portable directory name are refused', () => {
  for (const label of [
    '../outside',
    '..',
    '.',
    'a/b',
    'a\\b',
    '/absolute',
    'C:/absolute',
    'C:relative',
    '\\\\server\\share',
    '.. ',
    'trailing.',
    'NUL',
  ])
    assert.throws(() => scenarioDir('root', scenario('valid/nested'), label), BAD_LABEL, label);
});
test('genuine nested IDs and authored labels retain original paths', () => {
  assert.equal(
    scenarioDir('root', scenario('form/test_case.v2/render'), 'native current-2'),
    path.join('root', 'form', 'test_case.v2', 'render', 'native current-2'),
  );
});
test('whole matrix and label fail before capture callbacks or output writes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-case-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const side = {
    persona: async () => {
      calls++;
    },
    reset: async () => {
      calls++;
    },
    capture: async () => {
      calls++;
      return { status: 'captured' };
    },
  };
  await assert.rejects(
    captureMatrix({
      matrix: {
        version: 1,
        scenarios: [scenario('valid'), scenario('a/../../outside')],
      },
      side,
      outDir: path.join(root, 'out'),
      label: 'native',
    }),
    BAD_ID,
  );
  await assert.rejects(
    captureMatrix({
      matrix: matrix('valid'),
      side,
      outDir: path.join(root, 'out'),
      label: '../outside',
    }),
    BAD_LABEL,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await fs.readdir(root), []);
});
test('CLI label rejection precedes browser/runtime setup and any evidence write', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-label-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'matrix.json');
  await fs.writeFile(file, JSON.stringify(matrix('valid/nested')));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url)),
      'capture',
      '--matrix',
      file,
      '--out',
      path.join(root, 'out'),
      '--side',
      'mirage',
      '--label',
      '../outside',
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /capture label/);
  assert.deepEqual(await fs.readdir(root), ['matrix.json']);
});
