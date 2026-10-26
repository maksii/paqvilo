// Test-only cleanup for Mirage runtimes that toolkit CLIs start detached in a temporary workspace.
// stopRecordedRuntimes stops every runtime recorded in the workspace's ownership stores. When run as
// a script, this module is a reaper: it outlives an abruptly terminated test process and then
// waits for that process's CLIs, stops what they recorded and removes the workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { miragePaths, stopOwnedSessions, isAlive } from '../lense/commands/mirage.mjs';

const OWNERSHIP = path.join('.paqvilo', 'mirage', 'sessions.json');
// A CLI ends within its own deadline (the test's execFile timeout); the reaper waits slightly longer.
const CLI_WAIT_MS = 180_000;
const CLI_POLL_MS = 250;
const execute = promisify(execFile);

/** Stops the runtimes recorded under `directory`; returns those still running (expected: none). */
export async function stopRecordedRuntimes(directory) {
  const left = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { recursive: true });
  } catch (error) {
    if (error.code === 'ENOENT') return left;
    throw error;
  }
  for (const relative of entries.filter((entry) => entry.endsWith(OWNERSHIP))) {
    const file = path.join(directory, relative);
    const paths = miragePaths({ stateDir: path.dirname(path.dirname(file)) });
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sessions = [] } = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!sessions.length) break;
      // An identity that could not be read now (a slow PowerShell) is retried once.
      const result = await stopOwnedSessions({ paths, pids: sessions.map((entry) => entry.pid) });
      if (!result.unverified.length || attempt) {
        left.push(...result.remaining, ...result.unverified);
        break;
      }
    }
  }
  return left;
}

/**
 * Starts the reaper for `directory`. Call track(child) for every CLI process the test starts, and
 * finish() once the test has cleaned up itself. If the test process ends without finish(), the
 * reaper cleans up instead and writes the runtimes it stopped to the inherited stdout.
 */
export function startReaper(directory) {
  const reaper = spawn(process.execPath, [fileURLToPath(import.meta.url), directory], {
    detached: true,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => reaper.once('exit', resolve));
  // A reaper that already ended (it never exits early by itself) must not crash the test with EPIPE.
  reaper.stdin.on('error', () => {});
  const send = (line) =>
    new Promise((resolve) =>
      reaper.stdin.writableEnded ? resolve() : reaper.stdin.write(line + '\n', () => resolve()),
    );
  return {
    pid: reaper.pid,
    track: (child) => {
      const sent = send('+' + child.pid);
      child.once('exit', () => void send('-' + child.pid));
      return sent;
    },
    finish: async () => {
      reaper.stdin.end('done\n');
      await exited;
    },
  };
}

async function reap(directory) {
  const live = new Set();
  let finished = false,
    buffer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line === 'done') finished = true;
      else if (line[0] === '+') live.add(Number(line.slice(1)));
      else if (line[0] === '-') live.delete(Number(line.slice(1)));
    }
  }
  if (finished) return;
  // The test process ended without its own cleanup. Its CLIs may still be starting a runtime;
  // waiting (never signalling a PID that may have been reused) lets each record or abandon it.
  const deadline = Date.now() + CLI_WAIT_MS;
  while ([...live].some(isAlive) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, CLI_POLL_MS));
  const reaped = await recordedPids(directory);
  const left = (await stopRecordedRuntimes(directory)).map((entry) => entry.pid);
  // A CLI that died between launching and recording its runtime leaves no record. Only processes
  // naming this unique temporary workspace on their command line can be such strays.
  const strays = await processesNaming(directory);
  for (const pid of strays) await endProcessTree(pid);
  left.push(...(await processesNaming(directory)));
  if (!left.length) await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  process.stdout.write(JSON.stringify({ reaped, strays, left }) + '\n');
}

/** PIDs (other than this process) whose command line contains `text`. */
export async function processesNaming(text) {
  const listing =
    process.platform === 'win32'
      ? await execute(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:PAQ_REAP_TEXT) } | ForEach-Object { $_.ProcessId }',
          ],
          { env: { ...process.env, PAQ_REAP_TEXT: text }, windowsHide: true, timeout: 60_000 },
        )
      : await execute('ps', ['-axww', '-o', 'pid=,args='], { timeout: 60_000 });
  return listing.stdout
    .split(/\r?\n/)
    .filter((line) => process.platform === 'win32' || line.includes(text))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

async function endProcessTree(pid) {
  try {
    if (process.platform === 'win32')
      await execute('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already ended */
  }
}

async function recordedPids(directory) {
  const pids = [];
  for (const relative of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter((entry) =>
    entry.endsWith(OWNERSHIP),
  ))
    pids.push(
      ...(JSON.parse(await fs.readFile(path.join(directory, relative), 'utf8')).sessions ?? []).map((s) => s.pid),
    );
  return pids;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await reap(process.argv[2]);
