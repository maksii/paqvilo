// Liveness and start identity of a process ID. Only Node built-ins are imported, so scripts/ci.mjs can use these
// without loading the lense command module.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';

/** True when the process exists (EPERM: it exists but belongs to another account). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// PowerShell can start slowly on a busy machine: a Windows read that timed out is tried again, because an unread
// identity must not be mistaken for a reused process ID. A missing program or a non-zero exit is an answer.
const WINDOWS_ATTEMPTS = 3;
const WINDOWS_TIMEOUT_MS = 15_000;
const POSIX_TIMEOUT_MS = 3000;
const WINDOWS_SHELL = 'powershell.exe';
const PS = 'ps';
const RETRY = Symbol('retry');

const validPid = (pid) => Number.isInteger(pid) && pid > 0;
// Our own PID cannot be reused while this module is running. Cache only a
// successful self read; foreign PIDs and failed reads always need a fresh probe.
let ownIdentity;
const rememberIdentity = (pid, identity) => {
  if (pid === process.pid && identity) ownIdentity = identity;
  return identity;
};
const windowsArguments = (pid) => [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`,
];
const psArguments = (pid) => ['-o', 'lstart=', '-p', String(pid)];
// A synchronous read is tried again after any failure to run or a signal; an awaited read after a timeout, which
// execFile reports as error.killed.
const unreadSync = (result) => Boolean(result.error) || result.signal != null;
const unreadAsync = (result) => result.error?.killed === true;

/** RETRY for a Windows read that has to be tried again; otherwise the start time, or null. */
function windowsIdentity(result, unread) {
  if (unread(result)) return RETRY;
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function psIdentity(result) {
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/** Field 22 of a /proc/<pid>/stat line (the start time since boot). */
const procStartField = (stat) => stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;

/** Field 22 of /proc/<pid>/stat, or undefined where /proc cannot be read. */
function procIdentity(pid) {
  try {
    return procStartField(fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    /* macOS and other proc-less systems */
    return undefined;
  }
}

async function procIdentityAsync(pid, signal) {
  try {
    return procStartField(await fs.readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal }));
  } catch {
    /* macOS and other proc-less systems, or a read that was aborted */
    return undefined;
  }
}

/** The process start time: a recorded PID only names our Mirage while this value is unchanged. */
export function processIdentity(pid) {
  if (!validPid(pid)) return null;
  if (pid === process.pid && ownIdentity !== undefined) return ownIdentity;
  if (process.platform === 'win32') {
    for (let attempt = 0; attempt < WINDOWS_ATTEMPTS; attempt++) {
      const identity = windowsIdentity(
        spawnSync(
          WINDOWS_SHELL, // NOSONAR: fixed tool name resolved through PATH by developer tooling
          windowsArguments(pid),
          { encoding: 'utf8', windowsHide: true, timeout: WINDOWS_TIMEOUT_MS },
        ),
        unreadSync,
      );
      if (identity !== RETRY) return rememberIdentity(pid, identity);
    }
    return null;
  }
  const proc = procIdentity(pid);
  if (proc !== undefined) return rememberIdentity(pid, proc);
  return rememberIdentity(
    pid,
    psIdentity(
      spawnSync(
        PS, // NOSONAR: fixed tool name resolved through PATH by developer tooling
        psArguments(pid),
        { encoding: 'utf8', windowsHide: true, timeout: POSIX_TIMEOUT_MS },
      ),
    ),
  );
}

/**
 * processIdentity without blocking the event loop: the same reads, awaited. Startup uses it while it keeps its
 * heartbeat and cancellation responsive. An aborted signal ends the read at once: null, with no further attempt.
 */
export async function processIdentityAsync(pid, { signal } = {}) {
  if (signal?.aborted || !validPid(pid)) return null;
  if (pid === process.pid && ownIdentity !== undefined) return ownIdentity;
  if (process.platform === 'win32') {
    for (let attempt = 0; attempt < WINDOWS_ATTEMPTS; attempt++) {
      const result = await runAsync(WINDOWS_SHELL, windowsArguments(pid), WINDOWS_TIMEOUT_MS, signal);
      if (signal?.aborted) return null;
      const identity = windowsIdentity(result, unreadAsync);
      if (identity !== RETRY) return rememberIdentity(pid, identity);
    }
    return null;
  }
  const proc = await procIdentityAsync(pid, signal);
  if (signal?.aborted) return null;
  if (proc !== undefined) return rememberIdentity(pid, proc);
  return rememberIdentity(pid, psIdentity(await runAsync(PS, psArguments(pid), POSIX_TIMEOUT_MS, signal)));
}

/** execFile as a promise, with the fields of a spawnSync result that processIdentity reads. */
function runAsync(file, args, timeout, signal) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout, signal }, (error, stdout) => {
      resolve(spawnShaped(error, stdout ?? ''));
    });
  });
}

/** An execFile outcome as spawnSync reports it: a numeric error code is the exit status; any other error (a missing
 * program, a timeout, an abort) is the error itself. */
function spawnShaped(error, stdout) {
  if (!error) return { status: 0, signal: null, error: undefined, stdout };
  const exited = typeof error.code === 'number';
  return {
    status: exited ? error.code : null,
    signal: error.signal ?? null,
    error: exited ? undefined : error,
    stdout,
  };
}
