// Ownership of agent discovery files. A discovery file holds the bearer token of one agent API, so it must not
// outlive the process that serves that API: the owner removes it on every exit it can observe, and a file whose
// owner was ended without notice is recognised as stale by readers and removed by the next agent start.
import fs from 'node:fs';
import path from 'node:path';
import { isAlive, processIdentity } from './process-identity.mjs';
import { stopOwners, TERMINATION_FALLBACK } from './signal-forwarding.mjs';

/** Discovery files of the agent servers that are live in this process (absolute paths). */
const live = new Set();
// Signals whose default action ends the process without an 'exit' event.
const END_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const handlers = new Map();
let earliestOwnProcessStart = performance.timeOrigin;

// Wall time can step backwards after Node records timeOrigin. Sample wall time first, then subtract monotonic
// elapsed time: a delayed second read only makes this start bound earlier. Keep every observed lower bound so a
// later forward correction cannot reject owner metadata written during an observed backward correction.
function observeOwnProcessStart() {
  const now = Date.now();
  earliestOwnProcessStart = Math.min(earliestOwnProcessStart, now - performance.now());
  return Math.floor(earliestOwnProcessStart);
}

function removeLiveFiles() {
  for (const file of live) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // A file that cannot be removed while the process ends is left for the next agent start to sweep.
    }
  }
}

function endedBy(signal) {
  // Another listener owns the stop of this process: it closes the agents, which removes their files, or it exits,
  // which runs the 'exit' listener. Alone, this listener stands in for the default action of the signal.
  if (stopOwners(process, signal) > 0) return;
  removeLiveFiles();
  unwatchProcess();
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(1); // a signal this platform cannot send to itself (SIGHUP on Windows)
  }
}

function watchProcess() {
  if (handlers.size) return;
  // 'exit' covers a normal end, process.exit() and an uncaught exception.
  handlers.set('exit', removeLiveFiles);
  for (const signal of END_SIGNALS) {
    const handler = () => endedBy(signal);
    handler[TERMINATION_FALLBACK] = true;
    handlers.set(signal, handler);
  }
  for (const [name, handler] of handlers) process.on(name, handler);
}

function unwatchProcess() {
  for (const [name, handler] of handlers) process.off(name, handler);
  handlers.clear();
}

/** The start identity of this process where reading it starts no other process (/proc), else null. */
function ownProcessStart() {
  return process.platform === 'linux' ? processIdentity(process.pid) : null;
}

function ownProcessStartDiffers(recorded) {
  if (process.platform !== 'linux' || typeof recorded !== 'string' || !recorded) return false;
  const current = ownProcessStart();
  return current !== null && current !== recorded;
}

/** The fields that bind a discovery file to the process that writes it. */
export function discoveryOwner() {
  observeOwnProcessStart();
  return { pid: process.pid, processStart: ownProcessStart() };
}

/**
 * Writes a discovery file that this process owns: it is removed when the process exits, when it is ended by
 * SIGINT, SIGTERM or SIGHUP, and by `release`. A process ended without notice (SIGKILL, TerminateProcess, a
 * kill-on-close job, power loss) leaves the file behind; discoveryOwnerGone() recognises it.
 * @returns {() => void} release: removes the file and gives up its ownership; a removal failure throws
 */
export function writeOwnedDiscovery(file, discovery) {
  file = path.resolve(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Owned before it exists, so an exit between the write and the next statement still removes it.
  live.add(file);
  watchProcess();
  const release = () => {
    if (!live.has(file)) return;
    // Still owned until the file is gone, so the exit listener retries a removal that failed here.
    fs.rmSync(file, { force: true });
    live.delete(file);
    if (!live.size) unwatchProcess();
  };
  try {
    observeOwnProcessStart();
    fs.writeFileSync(file, JSON.stringify(discovery, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    live.delete(file);
    if (!live.size) unwatchProcess();
    throw error;
  }
  return release;
}

/**
 * Whether the process that wrote a discovery file is gone, as far as that can be told without starting a process:
 * its PID names no process; or the PID is this process but the file is not one it owns and predates every observed
 * start bound; or (Linux)
 * the process under that PID has another start identity. A file whose owner is gone is stale: its token
 * authenticates nothing, because the agent API that knew it ended with the process. False means "not known to be
 * gone": on Windows and macOS a PID reused by another live process is not detected here, since reading a start
 * time there takes a process start.
 */
export function discoveryOwnerGone(discovery, file) {
  const { pid, processStart, startedAt } = discovery ?? {};
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) {
    const startedBefore = observeOwnProcessStart();
    if (file && live.has(path.resolve(file))) return false;
    if (ownProcessStartDiffers(processStart)) return true;
    const written = Date.parse(startedAt);
    return Number.isFinite(written) && written < startedBefore;
  }
  if (!isAlive(pid)) return true;
  if (process.platform !== 'linux' || typeof processStart !== 'string' || !processStart) return false;
  const current = processIdentity(pid);
  // An identity that cannot be read is not a different one.
  return current !== null && current !== processStart;
}

/** A discovery file read through one handle: size and contents come from the same file; null when over 64 KiB. */
function readDiscoveryFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.fstatSync(fd).size > 64 * 1024) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Removes the discovery files of a state folder's `agents` directory whose owner is gone. Files this process owns,
 * files of live owners and anything that is not a discovery file are left alone.
 */
export function sweepStaleDiscovery(directory) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.endsWith('.json')).slice(0, 256)) {
    const file = path.resolve(directory, name);
    if (live.has(file)) continue;
    try {
      const discovery = readDiscoveryFile(file);
      if (discovery?.schemaVersion === 1 && typeof discovery.token === 'string' && discoveryOwnerGone(discovery, file))
        fs.rmSync(file, { force: true });
    } catch {
      // Unreadable, or not a discovery file: `agent sessions` reports it.
    }
  }
}
