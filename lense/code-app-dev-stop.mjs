import { spawn } from 'node:child_process';

// Grace period before each escalation step. It only decides when to escalate: a shutdown that is still progressing is not failed.
const GRACE_MS = 5000;
const defaultSchedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};
const defaultKill = (pid, signal) => process.kill(pid, signal);

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
 * platforms send SIGTERM to the process group, then SIGKILL only if the child has not closed after the grace period.
 */
export async function stopCodeAppDevServer(
  child,
  closed,
  { platform = process.platform, kill = defaultKill, schedule = defaultSchedule } = {},
) {
  if (child.pid && platform === 'win32' && child.exitCode === null && child.signalCode === null) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); // NOSONAR: fixed tool name resolved through PATH by developer tooling
    await new Promise((resolve) => {
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else if (child.pid && platform !== 'win32') {
    signalGroup(child.pid, 'SIGTERM', kill);
  }
  // Exit precedes stdio closure; descendants can still own inherited pipes.
  // Capture this promise at spawn so an early exit cannot lose the close event.
  if (await closedWithin(closed, GRACE_MS, schedule)) return;
  if (child.pid && platform !== 'win32') {
    signalGroup(child.pid, 'SIGKILL', kill);
    if (await closedWithin(closed, GRACE_MS, schedule)) return;
  }
  throw new Error(`Code app dev server pid ${child.pid} did not close its output streams.`);
}
