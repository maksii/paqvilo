// A forced schedule for CLR host start: the worker it wraps never fires a timer of its own, so only the main thread's
// deadline can end a step whose host does not answer.
import { workerData } from 'node:worker_threads';

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
await import(workerData.workerUrl);
