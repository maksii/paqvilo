// The watch thread of project-code-watch.mjs: it runs while the main thread may be blocked, so it reads the marks of
// the main thread from shared memory, and it writes and ends the process without the main thread's help.
import fs from 'node:fs';
import { workerData } from 'node:worker_threads';
import { stalledMessage } from './project-code-watch.mjs';

const { flags, started, label, limitMs, intervalMs, pid } = workerData;
const ACTIVE = 0;
const WAITING = 1;
const LENGTH = 2;

setInterval(() => {
  if (!Atomics.load(flags, ACTIVE) || Atomics.load(flags, WAITING)) return;
  if (Date.now() - started[0] < limitMs) return;
  const name = new TextDecoder().decode(label.slice(0, Atomics.load(flags, LENGTH)));
  try {
    fs.writeSync(2, stalledMessage(name, limitMs));
  } catch {
    /* Standard error may be closed; the process still ends. */
  }
  process.kill(pid);
}, intervalMs);
