// A forced schedule for CLR host start: in the worker it wraps, spawn throws as it does for a start the system refuses
// outright (the errors child_process raises synchronously), so no host process is ever created.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { workerData } from 'node:worker_threads';

childProcess.spawn = () => {
  throw Object.assign(new Error('spawn EINVAL (invented refusal)'), { code: 'EINVAL', syscall: 'spawn' });
};
syncBuiltinESMExports();
await import(workerData.workerUrl);
