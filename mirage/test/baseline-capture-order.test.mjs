// @test-kind contract: captureMatrix reads injected capture results at its original callback await boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureMatrix } from '../baseline-suite.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const suite = fileURLToPath(new URL('../baseline-suite.mjs', import.meta.url));
const runSuite = (args) => spawnSync(process.execPath, [suite, ...args], { encoding: 'utf8' });
// A live bridge that only records its own start: a refused capture must never run it.
const liveMatrix = (marker) => ({
  version: 1,
  origin: 'https://fixture.invalid',
  live: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] },
  scenarios: [{ id: 'fixture/read', steps: [{ goto: '/' }] }],
});
async function fixtureDirectory(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-baseline-selection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

test('capture result is read before a queued side-state change', async (t) => {
  const outDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-baseline-order-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const events = [];
  let flipped = false;
  const capture = {
    get status() {
      events.push(flipped ? 'status-after' : 'status-before');
      return flipped ? 'after' : 'before';
    },
    problems: [],
    requests: [],
    elements: [],
  };
  const side = {
    persona: () => null,
    diagnostics: () => [],
    capture() {
      return {
        then(resolve) {
          resolve(capture);
          queueMicrotask(() =>
            queueMicrotask(() => {
              flipped = true;
              events.push('flip');
            }),
          );
        },
      };
    },
  };
  const matrix = { version: 1, delayMs: 0, scenarios: [{ id: 'one', reset: false, steps: [{}] }] };
  const results = await captureMatrix({ matrix, side, outDir, label: 'mirage' });
  assert.equal(results[0].status, 'before');
  assert.deepEqual(events, ['status-before', 'flip']);
});

test('live capture without --only or --all-scenarios is refused before the bridge starts', async (t) => {
  const directory = await fixtureDirectory(t);
  const marker = path.join(directory, 'bridge-started.txt');
  const matrix = path.join(directory, 'matrix.json');
  await fs.writeFile(matrix, JSON.stringify(liveMatrix(marker)));
  const result = runSuite(['capture', '--matrix', matrix, '--out', path.join(directory, 'out'), '--side', 'live']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--only/);
  assert.match(result.stderr, /--all-scenarios/);
  assert.equal(await exists(marker), false);
});

test('unknown --only ids are refused by capture and compare and keep the previous report', async (t) => {
  const directory = await fixtureDirectory(t);
  const marker = path.join(directory, 'bridge-started.txt');
  const matrix = path.join(directory, 'matrix.json');
  await fs.writeFile(matrix, JSON.stringify(liveMatrix(marker)));
  const out = path.join(directory, 'out');
  await fs.mkdir(out);
  await fs.writeFile(path.join(out, 'report.json'), 'previous');
  const capture = runSuite(['capture', '--matrix', matrix, '--out', out, '--side', 'live', '--only', 'typo']);
  assert.equal(capture.status, 1, capture.stderr);
  assert.match(capture.stderr, /Unknown scenario ids: typo/);
  assert.equal(await exists(marker), false);
  const compare = runSuite(['compare', '--matrix', matrix, '--out', out, '--only', 'typo']);
  assert.equal(compare.status, 1, compare.stdout);
  assert.match(compare.stderr, /Unknown scenario ids: typo/);
  assert.equal(await fs.readFile(path.join(out, 'report.json'), 'utf8'), 'previous');
});
