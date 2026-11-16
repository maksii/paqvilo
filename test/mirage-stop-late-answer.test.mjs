// Stop answers a runtime that is slow to answer its shutdown request, under load, by waiting for it, not by signalling it.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { workspace } from './helpers/mirage-in-process.mjs';

// @test-kind contract: a runtime that answers its shutdown request late is still stopped gracefully and never signalled
test('a runtime that answers its shutdown request late is still stopped gracefully and never signalled', async (t) => {
  const work = await workspace(t);
  const config = path.join(work.directory, 'catalogue controls', 'late.json');
  await work.writeCatalogue(config);
  const started = await work.start(['--config', config, '--port', '0']);
  // The runtime holds its state answer, which the stop asks before it shuts the runtime down.
  const held = work.host.runtime(started.pid).hold('/_sim/api/state');
  t.mock.timers.enable({ apis: ['AbortSignal.timeout'] });
  const stopping = work.run(['mirage', 'stop', '--config', config, '--json']);
  await held.asked;
  // Elapsed time passes while the runtime has not answered; the stop must not give up on it.
  t.mock.timers.tick(5000);
  held.release();
  const result = await stopping;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [stoppedRuntime] = JSON.parse(result.stdout).stopped;
  assert.equal(stoppedRuntime.graceful, true);
  assert.deepEqual(work.host.kills, []);
});
