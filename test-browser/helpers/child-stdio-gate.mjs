import assert from 'node:assert/strict';
import { once } from 'node:events';

/** Hold a real child pipe's destruction callback after process exit. */
export function childStdioGate(t, child) {
  const closed = once(child, 'close'),
    exited = once(child, 'exit');
  const release = Promise.withResolvers(),
    destroying = Promise.withResolvers();
  const destroy = child.stdout._destroy.bind(child.stdout);
  child.stdout._destroy = (error, callback) => {
    destroying.resolve();
    release.promise.then(() => destroy(error, callback));
  };
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    release.resolve();
    await closed;
  });
  return { child, closed, exited, release, destroying, output: () => output };
}

/** Exercise the same close contract for independent owned-child shutdown paths. */
export async function assertChildStdioDrain(gate, stop) {
  assert.deepEqual(await gate.exited, [0, null]);
  await gate.destroying.promise;
  let drained = false;
  const stopping = stop(gate.child, gate.closed).then((result) => {
    drained = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, 'exit alone cannot establish that stdio has closed');
  gate.release.resolve();
  const result = await stopping;
  assert.equal(gate.output(), 'owned-output');
  return result;
}
