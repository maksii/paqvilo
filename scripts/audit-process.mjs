import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { auditInventory, createAuditProgress } from './audit-progress.mjs';

export async function runNpmAudit(executable, [cli, ...args], settings, { launch = fork, progressOptions = {} } = {}) {
  const inventory = auditInventory(JSON.parse(fs.readFileSync(path.join(settings.cwd, 'package-lock.json'), 'utf8')));
  const nonce = randomBytes(32).toString('hex');
  const launched = (progressOptions.clock ?? performance).now();
  const child = launch(cli, args, {
    cwd: settings.cwd,
    execPath: executable,
    execArgv: ['--import', new URL('./audit-observer.mjs', import.meta.url).href],
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let failure;
  let stopping = false;
  let settled = false;
  let stopTimer;
  let rejectStop;
  const stopFailed = new Promise((resolve, reject) => {
    rejectStop = reject;
  });
  let stdout = '';
  let stderr = '';
  let ipcBytes = 0;
  const closed = new Promise((resolve) => child.once('close', (status, signal) => resolve({ status, signal })));
  const fail = (error) => {
    if (settled) return;
    failure ??= error;
    if (stopping) return;
    stopping = true;
    // The retained ChildProcess handle targets this owned child, never a rediscovered numeric PID.
    try {
      child.kill('SIGKILL');
    } catch (killError) {
      failure = killError;
    }
    stopTimer = setTimeout(() => {
      const stopError = new Error('Owned npm audit did not close its inherited streams after termination.');
      stopError.auditOwnershipFailure = true;
      rejectStop(stopError);
    }, settings.timeout);
  };
  let guard;
  child.once('error', fail);
  child.on('message', (packet) => {
    if (failure || settled) return;
    try {
      const size = Buffer.byteLength(JSON.stringify(packet));
      ipcBytes += size;
      if (size > 64 * 1024 || ipcBytes > settings.maxBuffer) throw new Error('Audit IPC output limit exceeded.');
      guard.accept(packet);
    } catch (error) {
      fail(error);
    }
  });
  const collect = (target, chunk) => {
    if (failure) return;
    const current = target === 'stdout' ? stdout : stderr;
    if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > settings.maxBuffer) {
      fail(new Error(`Audit ${target} output limit exceeded.`));
      return;
    }
    if (target === 'stdout') stdout += chunk;
    else stderr += chunk;
  };
  const abort = () => fail(new Error('Dependency audit cancelled.'));
  try {
    try {
      guard = createAuditProgress({ ...progressOptions, launched, inventory, nonce, timeout: settings.timeout, fail });
      child.stdout.setEncoding('utf8').on('data', (chunk) => collect('stdout', chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk) => collect('stderr', chunk));
      settings.signal?.addEventListener('abort', abort, { once: true });
      if (settings.signal?.aborted) abort();
      child.send({ v: 1, nonce }, (error) => {
        if (error) fail(error);
      });
    } catch (error) {
      fail(error);
    }
    const result = await Promise.race([closed, stopFailed]); // close follows exit AND inherited stream closure.
    try {
      if (!failure) guard.finish();
    } catch (error) {
      failure = error;
    }
    return { ...result, stdout, stderr, error: failure };
  } finally {
    settled = true;
    clearTimeout(stopTimer);
    settings.signal?.removeEventListener('abort', abort);
    guard?.stop();
  }
}
