import { execFile } from 'node:child_process';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { withProcessSlot } from '../../mirage/test/process-slots.mjs';

// Bound each executing command, not the time a finite batch spends waiting for
// its process slots. A slot stays occupied until the owned process has closed.
export const COMMAND_HANG_GUARD_MS = 170_000;
// Hang guard of a command that starts or stops a Mirage runtime. `mirage start` ends a silent start-up itself and
// allows a progressing one its 600 s cap (lense/commands/mirage.mjs): a shorter guard here ends, on a loaded host, a
// start that the product would have completed. The guard only catches a command that would never return.
export const RUNTIME_COMMAND_HANG_GUARD_MS = 1_200_000;
// Hang guard only, of one test that runs a long scenario (several runtime starts, reloads or large fixtures). On a
// loaded slow host such a test is slow, not hung, and overran the lane's --test-timeout while still progressing. An
// explicit node:test `{ timeout }` outlives --test-timeout; subtests and hooks need their own.
export const SCENARIO_HANG_GUARD_MS = 1_200_000;
export function boundedCommand(
  t,
  file,
  args,
  options = {},
  { execute = execFile, slot = withProcessSlot, guardMs = COMMAND_HANG_GUARD_MS } = {},
) {
  const owner = ownedFixture(t);
  return slot(
    async () => {
      const completed = Promise.withResolvers();
      const closed = Promise.withResolvers();
      const child = execute(
        file,
        args,
        {
          encoding: 'utf8',
          windowsHide: true,
          ...options,
          timeout: guardMs,
          signal: t.signal,
        },
        (error, stdout, stderr) =>
          completed.resolve({
            status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
            error,
            stdout,
            stderr,
          }),
      );
      child.once('close', closed.resolve);
      owner.add(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed.promise;
      });
      const result = await completed.promise;
      await closed.promise;
      return result;
    },
    undefined,
    { signal: t.signal },
  );
}
