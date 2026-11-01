import { spawn } from 'node:child_process';

/** Stop one owned process tree and require its inherited output streams to close. */
export async function stopCodeAppDevServer(child, closed) {
  if (child.pid && process.platform === 'win32' && child.exitCode === null && child.signalCode === null) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve) => {
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  // Exit precedes stdio closure; descendants can still own inherited pipes.
  // Capture this promise at spawn so an early exit cannot lose the close event.
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Code app dev server pid ${child.pid} did not close its output streams.`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
