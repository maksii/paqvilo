// The synchronous I/O bridge: network I/O for a caller that cannot await (the synchronous SDK drive of a plug-in's own SDK
// call, inside the store's plug-in pipeline). One worker thread (sync-io-worker.mjs) performs the I/O
// on its own event loop; the main thread posts the request and blocks with Atomics.wait until the answer or the deadline.
// No child process is started. The worker starts from sync-io-worker-entry.mjs, which loads the body and reports through
// the shared flag that it started (a call's deadline starts then) or that the body cannot load (the call fails at once).
//
// Operations (sync-io-worker.mjs): 'http-post' { url, headers, body, auth: { type, ref: 'env:NAME' } } answers the status of a
// loopback web hook POST (Learn's one retry on 502/503/504), the authentication applied by the worker from its env: reference;
// 'amqp-send' { provider: { id, connectionString: 'env:NAME', amqpPort }, entity, body, messageId,
// properties } sends one message to the Service Bus emulator and answers { messageId }. The worker shares the process
// environment (SHARE_ENV) and resolves the connection string and the web hook authentication itself: no key or authentication
// value crosses the thread boundary. A worker that crashes answers the call in flight (SyncIoWorkerFailed) and is replaced.
//
// A receiver that runs on Mirage's own main thread cannot answer while the main thread waits: such a call ends at its
// deadline. HTTP-driven writes therefore await I/O on the asynchronous pipeline instead (data.mjs createRecordAsync).
import { MessageChannel, SHARE_ENV, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { DataError } from './data-error.mjs';

let bridge = null;
/** The worker body the bridge loads (tests replace it to inject a crash; the next start uses the new value). */
export const syncIoWorker = { url: new URL('./sync-io-worker.mjs', import.meta.url) };
const ENTRY = new URL('./sync-io-worker-entry.mjs', import.meta.url);
// Hang guard for a worker that never reports that it started: the entry reports a body that cannot load at once, so
// only a failure inside Node's own worker start-up, before any module runs, reaches this.
const SYNC_IO_START_GUARD_MS = 120_000;

function start() {
  const { port1, port2 } = new MessageChannel();
  const flags = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(ENTRY, {
    workerData: { port: port2, signal: flags.buffer, body: syncIoWorker.url.href },
    transferList: [port2],
    env: SHARE_ENV,
  });
  // A worker that failed or exited is replaced by the next call. A crash during a call is answered by the worker itself
  // (crashed), because these listeners cannot run while the main thread waits.
  const reset = () => {
    if (bridge?.worker === worker) bridge = null;
  };
  worker.on('error', reset);
  worker.on('exit', reset);
  worker.unref();
  port1.unref();
  return { worker, port: port1, flags, next: 0, started: false };
}

/** Stops the worker (tests and host shutdown); the next call starts a new one. */
export function closeSyncIoBridge() {
  const current = bridge;
  bridge = null;
  if (!current) return Promise.resolve();
  // Terminate while idle on the port; closing the port first could let the worker start ending by itself.
  return current.worker.terminate().then(() => current.port.close());
}

/**
 * Runs one operation on the worker and blocks until it answers: returns its value, or throws its error (a DataError with the
 * worker's status, code and message). Past timeoutMs, counted from when the worker has started, it throws 504
 * SyncIoTimeout and stops the worker, so a late answer never reaches a later call.
 */
export function syncIo(operation, payload, { timeoutMs = 10_000 } = {}) {
  bridge ??= start();
  const current = bridge,
    id = ++current.next;
  let deadline = Date.now() + (current.started ? timeoutMs : SYNC_IO_START_GUARD_MS);
  Atomics.store(current.flags, 0, 0);
  current.port.postMessage({ id, operation, payload });
  for (;;) {
    const { started, answer } = takeAnswer(current, id);
    if (answer) return settle(current, answer);
    if (started) deadline = Date.now() + timeoutMs;
    const left = deadline - Date.now();
    if (left <= 0) {
      void closeSyncIoBridge();
      throw expired(current, operation, timeoutMs);
    }
    Atomics.wait(current.flags, 0, 0, left);
    Atomics.store(current.flags, 0, 0);
  }
}

// Reads every message waiting on the port: records the worker's start report (started) and returns the answer to call
// `id` when it is among them. Answers to earlier, timed-out calls are dropped.
function takeAnswer(current, id) {
  let started = false;
  for (let packet = receiveMessageOnPort(current.port); packet; packet = receiveMessageOnPort(current.port)) {
    const answer = packet.message;
    if (answer?.started) {
      current.started = true;
      started = true;
    } else if (answer?.id === id) return { started, answer };
  }
  return { started, answer: null };
}

// The call's value, or its error thrown as a DataError.
function settle(current, answer) {
  if (answer.crashed && bridge === current) void closeSyncIoBridge(); // stop the failed worker: the next call starts a new one
  if (!answer.error) return answer.value;
  const { message, status, code, details } = answer.error;
  throw new DataError(message, status ?? 502, code ?? 'SyncIoFailed', details ?? undefined);
}

function expired(current, operation, timeoutMs) {
  if (!current.started)
    return new DataError(
      `The synchronous I/O worker did not start within ${SYNC_IO_START_GUARD_MS} ms.`,
      502,
      'SyncIoWorkerFailed',
    );
  return new DataError(`Synchronous ${operation} did not finish within ${timeoutMs} ms.`, 504, 'SyncIoTimeout');
}
