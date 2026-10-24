// Caps the child processes one test file runs at once. The suites already run several files in parallel, so a
// 4-core CI runner gets one CLI process per file, as when tests spawned serially; larger machines run more.
import os from 'node:os';

export const PROCESS_SLOTS = Math.max(1, Math.floor(os.availableParallelism() / 4));
let active = 0;
const waiting = [];

/** Runs `start` (which spawns a process and resolves when it exits) once a slot is free. */
export async function withProcessSlot(start, limit = PROCESS_SLOTS) {
  if (active < limit) active++;
  else await new Promise(resolve => waiting.push(resolve));
  try {
    return await start();
  } finally {
    // A waiting call takes this slot over directly, so a new caller cannot slip in between.
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}
