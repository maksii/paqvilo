// Liveness and start identity of a process ID. Only Node built-ins are imported, so scripts/ci.mjs can use these
// without loading the lense command module.
//
// No read here ends on elapsed time: a loaded host answers late, not never, and a read given up early reports a
// running process as unread. An awaited read ends with its caller's signal; a synchronous one with its helper process.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { execFile, spawnSync } from 'node:child_process';

/**
 * The host a process number belongs to: its operating system and machine name. Records of locks and runtimes carry it,
 * since a PID means nothing in another process namespace (Windows and WSL, or hosts sharing one folder).
 */
export const lockHost = () => `${process.platform}/${os.hostname()}`;

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

const WINDOWS_SHELL = 'powershell.exe';
const WINDOWS_SHELL_ARGUMENTS = ['-NoProfile', '-NonInteractive', '-Command'];
const PS = 'ps';

const validPid = (pid) => Number.isInteger(pid) && pid > 0;
// Our own PID cannot be reused while this module is running. Cache only a
// successful self read; foreign PIDs and failed reads always need a fresh probe.
let ownIdentity;
const rememberIdentity = (pid, identity) => {
  if (pid === process.pid && identity) ownIdentity = identity;
  return identity;
};
const windowsArguments = (pid) => [
  ...WINDOWS_SHELL_ARGUMENTS,
  `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`,
];
const psArguments = (pid) => ['-o', 'lstart=', '-p', String(pid)];

/** The start time a finished helper printed, or null: a helper that did not run or failed read nothing. */
const printedIdentity = (result) => (result.status === 0 ? result.stdout.trim() || null : null);

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

/**
 * The process start time as the operating system reports it: a recorded PID only names the recorded process while
 * this value is unchanged. Windows starts PowerShell for it (about a second, more on a loaded host), so on Windows
 * Mirage start, stop and status do not read it for the runtimes they record now (see `newStartIdentity`).
 */
export function processIdentity(pid) {
  if (!validPid(pid)) return null;
  if (pid === process.pid && ownIdentity !== undefined) return ownIdentity;
  if (process.platform === 'win32')
    return rememberIdentity(
      pid,
      printedIdentity(
        spawnSync(
          WINDOWS_SHELL, // NOSONAR: fixed tool name resolved through PATH by developer tooling
          windowsArguments(pid),
          { encoding: 'utf8', windowsHide: true },
        ),
      ),
    );
  const proc = procIdentity(pid);
  if (proc !== undefined) return rememberIdentity(pid, proc);
  return rememberIdentity(
    pid,
    printedIdentity(
      spawnSync(
        PS, // NOSONAR: fixed tool name resolved through PATH by developer tooling
        psArguments(pid),
        { encoding: 'utf8', windowsHide: true },
      ),
    ),
  );
}

/**
 * processIdentity without blocking the event loop: the same reads, awaited. An aborted signal ends the read at once:
 * null.
 */
export async function processIdentityAsync(pid, { signal } = {}) {
  if (signal?.aborted || !validPid(pid)) return null;
  if (pid === process.pid && ownIdentity !== undefined) return ownIdentity;
  if (process.platform === 'win32') {
    const result = await runAsync(WINDOWS_SHELL, windowsArguments(pid), signal);
    return signal?.aborted ? null : rememberIdentity(pid, printedIdentity(result));
  }
  const proc = await procIdentityAsync(pid, signal);
  if (signal?.aborted) return null;
  if (proc !== undefined) return rememberIdentity(pid, proc);
  const result = await runAsync(PS, psArguments(pid), signal);
  return signal?.aborted ? null : rememberIdentity(pid, printedIdentity(result));
}

/** The exit status of a failed execFile: its numeric code, else null; 0 when it succeeded. */
function exitStatusOf(error) {
  if (!error) return 0;
  return typeof error.code === 'number' ? error.code : null;
}

/** execFile as a promise, with the fields of a spawnSync result that the identity reads use. */
function runAsync(file, args, signal, env) {
  return new Promise((resolve) => {
    const options = { encoding: 'utf8', windowsHide: true, signal, ...(env ? { env } : {}) };
    execFile(file, args, options, (error, stdout) => {
      resolve({ status: exitStatusOf(error), stdout: stdout ?? '' });
    });
  });
}

// ---- start tokens (Windows)
//
// Windows has no cheap way to read another process's start time, so a runtime started there is not identified by it.
// The launcher gives the runtime a random start token on its command line and records `token:<hex>` as its identity.
// - While the runtime lives it holds a named pipe named after the token (`holdStartToken`). The pipe is a kernel
//   object of that process alone (children do not inherit it) and goes with the process, so its name in the pipe
//   listing shows the recorded runtime running, within a millisecond and also while its event loop is busy.
// - Any local program can create a pipe of a name it has seen, so the listing never justifies a signal. A process is
//   ended only after the operating system showed the token on the command line of the process whose handle is held
//   (`endRecordedWindowsProcess`).
const START_TOKEN = /^token:([0-9a-f]{32})$/;
const PIPE_ROOT = '\\\\.\\pipe\\';
/** The runtime option that carries the start token, so the token is on the runtime's command line. */
export const START_TOKEN_OPTION = '--start-token';
const pipeName = (token) => `paqvilo-mirage-${token}`;

/** The identity a launcher records for the runtime it is about to start: a token here, null where the OS is read. */
export const newStartIdentity = (platform = process.platform) =>
  platform === 'win32' ? `token:${crypto.randomBytes(16).toString('hex')}` : null;
/** The token of a recorded token identity, or null for an operating-system start time. */
export const startTokenOf = (identity) =>
  typeof identity === 'string' ? (START_TOKEN.exec(identity)?.[1] ?? null) : null;

/**
 * Runtime side: holds the pipe that shows this process running with start token `token` until the process ends.
 * A value that is not a token, or a pipe that cannot be held, holds nothing: the launcher then asks the OS.
 */
export function holdStartToken(token, platform = process.platform) {
  if (platform !== 'win32' || !START_TOKEN.test(`token:${token}`)) return null;
  const server = net.createServer((socket) => socket.destroy());
  server.on('error', () => {});
  server.listen(PIPE_ROOT + pipeName(token), () => server.unref());
  return server;
}

/** Whether a process holds the pipe of `token` now. */
async function startTokenHeld(token) {
  try {
    return (await fs.readdir(PIPE_ROOT)).includes(pipeName(token));
  } catch {
    return false;
  }
}

/**
 * PowerShell: `$ours` says whether the process behind the held handle `$p` (PID `pid`) has identity `recorded`. The
 * token is passed in the environment of the helper, not in its script: the helper's own command line would otherwise
 * contain the token it searches the command lines for, and match itself.
 */
export function windowsOwnershipScript(pid, recorded) {
  const token = startTokenOf(recorded);
  if (token)
    return {
      body:
        `$line = (Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine; ` +
        `$ours = [bool]($line -and $line.Contains($env:PAQVILO_START_TOKEN_MATCH))`,
      env: { ...process.env, PAQVILO_START_TOKEN_MATCH: `${START_TOKEN_OPTION} ${token}` },
    };
  return { body: `$ours = $p.StartTime.ToUniversalTime().Ticks -eq ${recorded}`, env: undefined };
}
/** The words a Windows script below prints as its last line. */
const WINDOWS_ANSWERS = new Set(['ours', 'ended', 'other', 'gone', 'refused']);
const windowsRecordable = (pid, recorded) =>
  validPid(pid) && (startTokenOf(recorded) !== null || (typeof recorded === 'string' && /^\d+$/.test(recorded)));
/** Runs a script that holds the handle of `pid` as `$p` and prints one of WINDOWS_ANSWERS; 'unread' otherwise. */
async function windowsAnswer(pid, body, signal, env) {
  if (signal?.aborted) return 'unread';
  // The handle is held from here to the end of the script: Windows cannot give the PID to another process meanwhile.
  const script =
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { 'gone'; exit }; ` +
    `try { $null = $p.Handle } catch { 'unread'; exit }; if ($p.HasExited) { $p.WaitForExit(); 'gone'; exit }; ${body}`;
  const { stdout } = await runAsync(WINDOWS_SHELL, [...WINDOWS_SHELL_ARGUMENTS, script], signal, env);
  const answer = stdout.trim().split(/\r?\n/).at(-1);
  return WINDOWS_ANSWERS.has(answer) ? answer : 'unread';
}

/**
 * The identity of the process that holds `pid` now, for comparison with the identity `recorded` for that PID: equal
 * to `recorded` while the recorded process runs, another value when the PID belongs to another program, null when the
 * process is gone or could not be read. An operating-system start time is read as `processIdentityAsync` reads it.
 * A start token is looked up in the pipe listing; only a live process without its pipe (a runtime that has not
 * created it yet, or another program with the reused PID) is read from its command line, which starts PowerShell.
 * A token recorded on Windows cannot be read elsewhere (a state folder shared with another system): null.
 */
export async function recordedIdentityNow(
  pid,
  recorded,
  { signal, alive = isAlive, platform = process.platform } = {},
) {
  const token = startTokenOf(recorded);
  if (!token) return processIdentityAsync(pid, { signal });
  if (signal?.aborted || !validPid(pid) || platform !== 'win32') return null;
  if (await startTokenHeld(token)) return alive(pid) ? recorded : null;
  if (!alive(pid)) return null;
  const ownership = windowsOwnershipScript(pid, recorded);
  const answer = await windowsAnswer(
    pid,
    `${ownership.body}; if ($ours) { 'ours' } else { 'other' }`,
    signal,
    ownership.env,
  );
  if (answer === 'ours') return recorded;
  return answer === 'other' ? 'another process' : null;
}

/**
 * Windows only: ends process `pid` (with `tree`, as `taskkill /t /f`, also every process it started) when it has the
 * identity `recorded` (a start token or an operating-system start time; null with `tree` ends it unconditionally: the
 * caller vouches for the PID, its own child or a process it has just identified), and resolves once it has exited.
 * The identity is checked and the process ended through one held handle, so the PID cannot change hands in between.
 *
 * Windows marks a terminated process as exited, so `isAlive(pid)` is false, before it closes the handles the process
 * held (a listening port, open files); the held process handle is signalled only when they are closed, so 'ended' and
 * 'gone' mean released. The wait has no time limit: a terminated process always ends; `signal` abandons it.
 * @returns {Promise<'ended'|'gone'|'other'|'refused'|'unread'>} 'other': another program holds the PID and was left
 *   alone; 'refused': the process is the recorded one and could not be ended; 'unread': nothing is known (PowerShell
 *   did not run, the process could not be opened, the wait was abandoned, or the arguments name no process).
 */
export async function endRecordedWindowsProcess(pid, recorded, { tree = false, signal } = {}) {
  if (recorded === null ? !(tree && validPid(pid)) : !windowsRecordable(pid, recorded)) return 'unread';
  const ownership =
    recorded === null ? { body: '$ours = $true', env: undefined } : windowsOwnershipScript(pid, recorded);
  const kill = tree ? `taskkill /pid ${pid} /t /f 2>&1 | Out-Null; if ($LASTEXITCODE) { throw }` : '$p.Kill()';
  return windowsAnswer(
    pid,
    `${ownership.body}; if (-not $ours) { 'other'; exit }; $ended = $false; try { ${kill}; $ended = $true } catch {}; ` +
      `if ($ended -or $p.HasExited) { $p.WaitForExit(); 'ended' } else { 'refused' }`,
    signal,
    ownership.env,
  );
}
