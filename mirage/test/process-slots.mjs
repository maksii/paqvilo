// Caps the child processes one test file runs at once. The suites already run several files in parallel, so a
// 4-core CI runner gets one CLI process per file, as when tests spawned serially; larger machines run more.
// availableParallelism() follows the CPU affinity and cgroup quota of a container (verified on Node 24), so a
// self-hosted runner limited to 1-3 CPUs gets one slot per file, and a 64-core one 16.
// Full validation supplies each lane's share so parallel lanes cannot multiply that machine-wide budget.
import os from 'node:os';

const configured = process.env.PAQ_TEST_PROCESS_SLOTS;
if (configured !== undefined && !/^[1-9]\d*$/.test(configured))
  throw new Error('PAQ_TEST_PROCESS_SLOTS must be a positive integer.');
export const PROCESS_SLOTS =
  configured === undefined ? Math.max(1, Math.floor(os.availableParallelism() / 4)) : Number(configured);
// One pool per limit: a call never takes over a slot counted against another limit.
const pools = new Map();

/** Runs `start` (which spawns a process and resolves when it exits) once a slot is free. */
export async function withProcessSlot(start, limit = PROCESS_SLOTS, { signal } = {}) {
  signal?.throwIfAborted();
  let pool = pools.get(limit);
  if (!pool) pools.set(limit, (pool = { active: 0, waiting: [] }));
  if (pool.active < limit) pool.active++;
  else
    await new Promise((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const index = pool.waiting.indexOf(entry);
        if (index !== -1) pool.waiting.splice(index, 1);
        reject(signal.reason);
      };
      pool.waiting.push(entry);
      signal?.addEventListener('abort', abort, { once: true });
    });
  try {
    signal?.throwIfAborted();
    return await start();
  } finally {
    // A waiting call takes this slot over directly, so a new caller cannot slip in between.
    const next = pool.waiting.shift();
    if (next) next();
    else pool.active--;
  }
}
