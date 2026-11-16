import { execFile } from 'node:child_process';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { withProcessSlot } from '../../mirage/test/process-slots.mjs';

// Bound each executing command, not the time a finite batch spends waiting for
// its process slots. A slot stays occupied until the owned process has closed.
export const COMMAND_HANG_GUARD_MS = 170_000;
export function boundedCommand(t, file, args, options = {}, { execute = execFile, slot = withProcessSlot } = {}) {
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
          timeout: COMMAND_HANG_GUARD_MS,
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
