// @test-kind contract: canvas control versions keep their supported kinds, reject multiline type names and bound malformed markers in a worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { controlKind } from '../lib/canvas-controls.mjs';
import { workerAnswer } from './support/worker-answer.mjs';

test('control versions preserve supported kinds and reject multiline type names', () => {
  assert.equal(controlKind('Classic/Label@2.5.1'), 'label');
  assert.equal(controlKind('ModernTextInput@0.0.1'), 'textinput');
  assert.equal(controlKind('Label@' + '@'.repeat(20000)), 'label');
  for (const separator of ['\r', '\n', '\u2028', '\u2029'])
    assert.equal(controlKind('Label@2' + separator + 'invalid'), null);
});

test('malformed version markers cannot monopolize control classification', async (t) => {
  const module = new URL('../lib/canvas-controls.mjs', import.meta.url).href;
  const source = `import { parentPort, workerData } from 'node:worker_threads';
import { controlKind } from ${JSON.stringify(module)};
parentPort.postMessage(controlKind(workerData));`;
  // A one-shot worker answers once and exits by itself; a regression that never answers is ended by the test's
  // own timeout through t.signal.
  const answer = await workerAnswer(new URL('data:text/javascript,' + encodeURIComponent(source)), {
    workerData: '@'.repeat(200000) + '\ninvalid',
    signal: t.signal,
  });
  assert.equal(answer, null);
});
