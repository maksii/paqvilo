// @test-kind tooling: readiness follows observed child output and the owning test deadline, with exit/cancellation cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { waitForChildOutput } from '../test-browser/helpers/child-readiness.mjs';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output += chunk;
    });
  const controller = new AbortController();
  const wait = () =>
    waitForChildOutput(child, {
      signal: controller.signal,
      pattern: /^Opening model-driven app at /m,
      readOutput: () => output,
      label: 'owned browser and agent',
    });
  return { child, controller, wait };
}

// @test-kind contract: browser setup may cross the former sub-deadline without being mistaken for readiness or failure
test('browser setup may cross the former sub-deadline without being mistaken for readiness or failure', async (t) => {
  const { child, wait } = fixture();
  let now = 0,
    settled = false;
  t.mock.method(Date, 'now', () => now);
  const ready = wait().finally(() => {
    settled = true;
  });
  child.stderr.write('startup browser setup\n');
  now = 20000;
  child.stderr.write('startup browser setup (20.0s total)\n');
  await Promise.resolve();
  assert.equal(settled, false, 'progress is not browser/agent readiness');
  child.stdout.write('Opening model-driven app ');
  await Promise.resolve();
  assert.equal(settled, false);
  child.stdout.write('at http://127.0.0.1/\n');
  await ready;
  assert.equal(child.stdout.listenerCount('data'), 1);
  assert.equal(child.stderr.listenerCount('data'), 1);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

// @test-kind contract: a failed or cancelled child never reports successful readiness
test('a failed or cancelled child never reports successful readiness', async () => {
  for (const mode of ['exit', 'error', 'abort', 'already-exited', 'already-aborted']) {
    const { child, controller, wait } = fixture();
    if (mode === 'already-exited') child.exitCode = 7;
    if (mode === 'already-aborted') controller.abort(new Error('Cancelled'));
    const ready = wait();
    if (mode === 'exit') child.emit('close', 7, null);
    if (mode === 'error') child.emit('error', new Error('Launch failed'));
    if (mode === 'abort') controller.abort(new Error('Cancelled'));
    await assert.rejects(ready, /exited 7|owned CLI failed|Cancelled/);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.listenerCount('error'), 0);
  }
});
