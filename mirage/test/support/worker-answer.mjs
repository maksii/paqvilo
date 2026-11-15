import { Worker } from 'node:worker_threads';

/**
 * Runs `source` (a module URL, or code with `{ eval: true }`) in a worker that posts ONE answer and then ends by
 * itself, and returns that answer once the worker has exited on its own.
 *
 * Teardown rule: a worker that answered is never terminated (terminate() racing a worker's own exit can end the
 * process in a V8 fatal error). Force is used only while no answer has arrived and the caller's `signal` aborts
 * (the test runner's timeout through `t.signal`). An answer or an error removes the abort listener before it settles,
 * so a later abort cannot reach a worker that is ending. There is no wall-clock deadline here: the test's own timeout
 * is the hang guard.
 */
export async function workerAnswer(source, { signal, ...options } = {}) {
  signal?.throwIfAborted();
  const worker = new Worker(source, options);
  const exited = new Promise((resolve) => worker.once('exit', resolve));
  let onAbort = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const settle = (done) => (value) => {
        signal?.removeEventListener('abort', onAbort);
        done(value);
      };
      onAbort = () => {
        worker.terminate().catch(() => {}); // no answer yet: the worker is still running, so force it and await its exit
        reject(signal.reason);
      };
      worker.once('message', settle(resolve));
      worker.once('error', settle(reject));
      exited.then((code) => reject(new Error(`The worker exited (${code}) before it answered.`)));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    await exited;
    signal?.removeEventListener('abort', onAbort);
  }
}
