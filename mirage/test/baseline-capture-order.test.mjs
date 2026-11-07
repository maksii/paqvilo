// @test-kind contract: captureMatrix reads injected capture results at its original callback await boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureMatrix } from '../baseline-suite.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

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
