// Test-only causal boundary: directory discovery completed, native metadata has not started.
import fs from 'node:fs';
import workerThreads from 'node:worker_threads';
import assert from 'node:assert/strict';

export function removeAtMetadataStat(t, file) {
  const Original = workerThreads.Worker;
  let removed = false;
  const Gated = class extends Original {
    constructor(url, options) {
      if (!removed && options?.workerData?.files?.includes(file)) {
        removed = true;
        fs.unlinkSync(file);
      }
      super(url, options);
    }
  };
  workerThreads.Worker = Gated;
  const restore = () => {
    if (workerThreads.Worker === Gated) workerThreads.Worker = Original;
  };
  t.after(() => {
    restore();
    assert.equal(removed, true, 'the owned file reached the native metadata gate');
  });
  return restore;
}
