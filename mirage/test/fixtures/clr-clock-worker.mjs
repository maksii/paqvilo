// An owned clock for a CLR worker: the worker it wraps arms its timers here, and they fire only when the test posts a
// message on workerData.clock, so a step's deadline runs at a point the test chooses and never races host start.
import { workerData } from 'node:worker_threads';

const pending = new Map();
let next = 0;
globalThis.setTimeout = (callback) => {
  next += 1;
  pending.set(next, callback);
  return next;
};
globalThis.clearTimeout = (id) => pending.delete(id);
workerData.clock.on('message', () => {
  const due = [...pending.values()];
  pending.clear();
  for (const fire of due) fire();
});
// The clock never keeps the worker alive: it ends by itself once its host exits.
workerData.clock.unref();
await import(workerData.workerUrl);
