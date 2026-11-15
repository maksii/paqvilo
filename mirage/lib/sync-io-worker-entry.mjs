// The entry of the synchronous I/O worker (sync-io-bridge.mjs). It imports nothing but node:worker_threads and then loads
// the worker body (sync-io-worker.mjs). The main thread waits in Atomics.wait and cannot see the worker's error or exit
// events, so both outcomes of the load reach it through the shared flag: a body that loaded is announced as started (the
// call's deadline starts then), and a body that cannot load (a missing dependency, a syntax error) answers every request
// as crashed, so the waiting call ends at once instead of at its deadline.
import { workerData } from 'node:worker_threads';

const { port, signal, body } = workerData,
  flags = new Int32Array(signal);
const send = (message) => {
  port.postMessage(message);
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
};
let failure = null;
try {
  await import(body);
} catch (error) {
  failure = { message: `The synchronous I/O worker failed: ${String(error?.message ?? error)}` };
}
if (failure)
  port.on('message', ({ id }) =>
    send({
      id,
      crashed: true,
      error: { message: failure.message, status: 502, code: 'SyncIoWorkerFailed', details: null },
    }),
  );
else send({ started: true });
