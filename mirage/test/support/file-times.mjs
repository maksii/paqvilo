// Stat-keyed caches never reuse a file changed within the racy window (lense/file-cache.mjs): a same-size rewrite in
// one file-time tick keeps every stat field. These helpers control that window in tests.
import fs from 'node:fs';

// Well past the 2 s racy window of lense/file-cache.mjs (kept private there), with room for slow test hosts.
const SETTLED_OFFSET_MS = 60_000;

/** Fixtures written moments ago are judged as an unchanged tree is once the racy window has passed. */
export function settleFileTimes(t) {
  const now = Date.now;
  t.mock.method(Date, 'now', () => now() + SETTLED_OFFSET_MS);
}

/** The same for child Node processes, including ones they start: the environment with an --import of a shifted clock. */
export const settledClockEnv = (env = process.env) => ({
  ...env,
  // No spaces: NODE_OPTIONS separates options at spaces.
  NODE_OPTIONS:
    `${env.NODE_OPTIONS ?? ''} --import=data:text/javascript,Date.now=(n=>()=>n()+${SETTLED_OFFSET_MS})(Date.now);`.trim(),
});

/**
 * Every stat reports modification and change time `timeMs`, as if all writes landed in one tick: a regression for
 * same-tick rewrites then fails deterministically on any file system. `timeMs` older than the racy window instead
 * proves that settled files are still reused.
 */
export function freezeFileTimes(t, timeMs = Date.now()) {
  const freeze = (stat) => {
    if (stat && typeof stat.mtimeNs === 'bigint') {
      stat.mtimeMs = stat.ctimeMs = BigInt(timeMs);
      stat.mtimeNs = stat.ctimeNs = BigInt(timeMs) * 1_000_000n;
    } else if (stat) stat.mtimeMs = stat.ctimeMs = timeMs;
    return stat;
  };
  for (const name of ['statSync', 'lstatSync', 'fstatSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => freeze(original(...args)));
  }
  for (const name of ['stat', 'lstat']) {
    const original = fs.promises[name];
    t.mock.method(fs.promises, name, async (...args) => freeze(await original(...args)));
  }
}

/** freezeFileTimes at a time older than the racy window. */
export const freezeSettledFileTimes = (t) => freezeFileTimes(t, Date.now() - SETTLED_OFFSET_MS);
