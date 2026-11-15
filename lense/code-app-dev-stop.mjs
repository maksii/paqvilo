import { spawn } from 'node:child_process';
import path from 'node:path';

// Grace period after SIGTERM before POSIX escalates to SIGKILL. It only decides when to escalate: a shutdown that is
// still progressing is not failed by it.
const GRACE_MS = 5000;
// A hang guard: a tree that has not released its output this long after a forced kill is reported.
const STOP_HANG_GUARD_MS = 60_000;
const defaultSchedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};
const defaultKill = (pid, signal) => process.kill(pid, signal);
// taskkill is addressed by its absolute path, so the stop does not depend on what PATH holds.
const defaultKillTree = (pid) =>
  new Promise((resolve) => {
    const taskkill = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', resolve);
    killer.once('close', resolve);
  });

// Signals the child's process group; a group that already ended is not an error.
function signalGroup(pid, signal, kill) {
  try {
    kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

// Resolves true when `closed` settles before the scheduled grace timer fires, else false.
function closedWithin(closed, ms, schedule) {
  return new Promise((resolve) => {
    const cancel = schedule(() => resolve(false), ms);
    closed.then(() => {
      cancel();
      resolve(true);
    });
  });
}

/**
 * Stop one owned process tree and require its inherited output streams to close. Windows uses taskkill /t /f; other
 * platforms send SIGTERM to the process group and wait GRACE_MS, then SIGKILL if the child has not closed. GRACE_MS
 * only decides that escalation. The final wait (after the forced kill, or the only wait when nothing was signalled) is
 * bounded by STOP_HANG_GUARD_MS, so only that wait can fail the stop by elapsed time.
 */
export async function stopCodeAppDevServer(
  child,
  closed,
  { platform = process.platform, kill = defaultKill, schedule = defaultSchedule, killTree = defaultKillTree } = {},
) {
  if (child.pid && platform === 'win32' && child.exitCode === null && child.signalCode === null) {
    await killTree(child.pid);
  } else if (child.pid && platform !== 'win32') {
    signalGroup(child.pid, 'SIGTERM', kill);
    if (await closedWithin(closed, GRACE_MS, schedule)) return;
    signalGroup(child.pid, 'SIGKILL', kill);
  }
  // Exit precedes stdio closure; descendants can still own inherited pipes.
  // Capture this promise at spawn so an early exit cannot lose the close event.
  if (await closedWithin(closed, STOP_HANG_GUARD_MS, schedule)) return;
  throw new Error(`Code app dev server pid ${child.pid} did not close its output streams.`);
}
