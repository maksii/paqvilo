// A forced schedule for CLR host start: this worker entry holds its thread for workerData.startDelayMs (as a slow
// worker boot, or a CreateProcess that an on-access scanner holds, would), then runs the CLR worker it wraps.
import { workerData } from 'node:worker_threads';

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.startDelayMs);
await import(workerData.workerUrl);
