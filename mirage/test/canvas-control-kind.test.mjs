import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { controlKind } from '../lib/canvas-controls.mjs';

test('control versions preserve supported kinds and reject multiline type names', () => {
  assert.equal(controlKind('Classic/Label@2.5.1'), 'label');
  assert.equal(controlKind('ModernTextInput@0.0.1'), 'textinput');
  assert.equal(controlKind('Label@' + '@'.repeat(20000)), 'label');
  for (const separator of ['\r', '\n', '\u2028', '\u2029'])
    assert.equal(controlKind('Label@2' + separator + 'invalid'), null);
});

test('malformed version markers cannot monopolize control classification', { timeout: 10000 }, async (t) => {
  const module = new URL('../lib/canvas-controls.mjs', import.meta.url).href;
  const source = `import { parentPort } from 'node:worker_threads';
import { controlKind } from ${JSON.stringify(module)};
parentPort.on('message', value => parentPort.postMessage(controlKind(value)));
parentPort.postMessage('ready');`;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)));
  t.after(() => worker.terminate());
  assert.equal((await once(worker, 'message'))[0], 'ready');
  // Start the bound after the module is loaded; terminate the isolated worker even on a regression.
  const result = once(worker, 'message', { signal: AbortSignal.timeout(3000) });
  worker.postMessage('@'.repeat(200000) + '\ninvalid');
  assert.equal((await result)[0], null);
});
