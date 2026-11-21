// Test-only owner for the child processes a test file starts. A test the runner stops (its hang guard, a failed
// assertion beside a still-running command) leaves its commands running, and on Windows a folder cannot be removed
// while a process has it as working directory or holds a file in it. The file's cleanup therefore ends what is still
// running and waits for each observed exit before it removes anything, instead of retrying the removal.
import { endProcessTree } from './mirage-runtimes.mjs';

export function ownedChildren({ endTree = endProcessTree } = {}) {
  const running = new Map();
  return {
    /** Records `child` (from spawn or execFile) until its exit and the close of its streams are observed. */
    own(child) {
      const closed = new Promise((resolve) => {
        child.once('close', resolve);
        // A process that could not be started never closes.
        child.once('error', () => child.pid === undefined && resolve());
      });
      running.set(child, closed);
      closed.then(() => running.delete(child));
      return child;
    },
    /** Ends every recorded child that is still running, with the processes it started, and resolves once all have gone. */
    async end() {
      await Promise.all(
        [...running].map(async ([child, closed]) => {
          // A child whose exit Node has observed may have had its PID reused, and `/t` cannot follow an exited parent to
          // its orphans: only a running child is ended.
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            // A command may run its work in further processes (the generated test runner starts `node --test`),
            // which hold the same folders.
            if (process.platform === 'win32') await endTree(child.pid).catch(() => {});
            // Elsewhere the entry point forwards a termination signal to the process it started and waits for it
            // (lense/signal-forwarding.mjs); a kill it cannot handle would leave that process running.
            else child.kill('SIGTERM');
          }
          await closed;
        }),
      );
    },
  };
}
