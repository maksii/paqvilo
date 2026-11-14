// Toolkit wrapper around the bundled Mirage runtime: project bootstrap, lifecycle and readiness.
// It only stops loopback Mirage processes it started itself (recorded with their process start
// identity), and it never contacts a portal environment.
import fs from 'node:fs/promises';
import { adminServes, appsPath } from '../../mirage/lib/admin-origin.mjs';
import { renderSettings } from '../../mirage/lib/render-settings.mjs';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';
import { loadCatalogue, loadConfig, loadDevTargets, mirageOnlySite } from '../config.mjs';
import { runtimePort } from '../../mirage/lib/runtime-port.mjs';
import { readStartupPhases } from '../startup-progress.mjs';
import { CODE_APP_STARTUP_CANCELLED } from '../code-app-dev-servers.mjs';
import { readLocalFile } from '../local-file.mjs';
import { mirageStopCommand, mirageCommandHint, listenerPort } from '../stop-command.mjs';
import { persistCommandPayload, pruneCommandPayloads } from '../command-payload.mjs';
import { withMirageDebugOutput } from '../mirage-debug-output-scope.mjs';
import { guardShutdownSignals } from '../signal-forwarding.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIRAGE_ROOT = path.join(TOOL_ROOT, 'mirage');
const TOOLKIT_CLI = path.join(TOOL_ROOT, 'bin/paqvilo.mjs');
/** Where Mirage processes announce themselves and where the toolkit records the ones it started. */
export function miragePaths(cfg = null, args = {}) {
  let directory;
  if (args.config) directory = path.dirname(path.resolve(args.config));
  else if (args.project) directory = path.dirname(path.resolve(args.project));
  else directory = process.cwd();
  const stateDir = cfg?.stateDir ?? path.join(directory, '.paqvilo');
  return {
    discoveryRoot: path.join(stateDir, 'simulator'),
    ownershipFile: path.join(stateDir, 'mirage', 'sessions.json'),
    logRoot: path.join(stateDir, 'mirage', 'logs'),
  };
}
export const DEFAULT_PATHS = Object.freeze(miragePaths());
export const DEFAULT_PORT = 8787;
const DEFAULT_STARTUP_TIMEOUT = 120_000;
// Start-up progress extends the silence bound, but never past this absolute cap.
const STARTUP_ABSOLUTE_CAP = 600_000;
const STOP_DEADLINE = 5000;
const ACTIONS = ['init', 'start', 'dev', 'status', 'inspect', 'stop'];
export function validateMirageAction(action) {
  if (!ACTIONS.includes(action))
    throw new Error(
      `Unknown mirage action "${action}"; use ${ACTIONS.slice(0, -1).join(', ')} or ${ACTIONS.at(-1)}. Run paqvilo lense --help for options.`,
    );
}
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const abortable = (promise, signal) => {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
};

const resolved = (value) => (value ? path.resolve(value) : null);
export const samePath = (a, b) => {
  if (!a || !b) return false;
  // Node and Windows temp directories may spell the same source through a
  // short path or junction. Compare existing filesystem identities first.
  const canonical = (value) => {
    try {
      return fsSync.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const left = canonical(a),
    right = canonical(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
const isDirectory = (dir) => {
  try {
    return fsSync.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (file) => {
  try {
    return fsSync.statSync(file).isFile();
  } catch {
    return false;
  }
};
const realpath = (target) => {
  try {
    return fsSync.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
};
/** Shared with Solution discovery, so repeated orderings reuse parsed Solution files. */
const SOLUTION_ORDER_CACHE = path.join(process.cwd(), '.paqvilo', 'simulator', 'cache', 'solution-discovery.json');
const solutionOrderOf = (cfg) => (cfg?.mirageConfig?.solutionOrder === 'explicit' ? 'explicit' : 'derived');
const sameOrder = (a, b) => a.length === b.length && a.every((item, index) => samePath(item, b[index]));
const rootNames = (roots) => roots.map((root) => path.basename(root)).join(' → ');

/**
 * Solution roots in their dependency order, the order Solution discovery, bootstrap and the
 * data scaffold apply: a root exporting a table's full definition precedes roots that only
 * extend it; independent roots keep name order. Cycles are added to `diagnostics`.
 */
export async function derivedSolutionOrder(roots, { diagnostics = [], cacheFile = SOLUTION_ORDER_CACHE } = {}) {
  const resolved = [...new Set(roots.map((root) => path.resolve(root)))];
  if (resolved.length < 2 || resolved.some((root) => !isDirectory(root))) return resolved;
  const { scanSolutionSources } = await import('../../mirage/lib/solution-schema.mjs');
  const scan = await scanSolutionSources(resolved, { cacheFile, order: 'derived' });
  try {
    await scan.cache?.save({ prune: false });
  } catch {
    /* the cache only saves parsing time */
  }
  diagnostics.push(...(scan.diagnostics ?? []).filter((item) => item.code === 'SOLUTION_ORDER_CYCLE'));
  const ordered = [];
  for (const layer of scan.layers) {
    const input = resolved.find((root) => samePath(root, layer.input));
    if (input && !ordered.includes(input)) ordered.push(input);
  }
  return [...ordered, ...resolved.filter((root) => !ordered.includes(root))];
}
// The app link of a runtime session: its apps origin when the runtime reports one, else the portal origin.
function appLinkOf(session, kind) {
  if (kind !== 'model-driven') return session.adminUrl ?? adminUrlOf(session.url);
  return `${(session.appsUrl ?? session.url).replace(/\/$/, '')}/main.aspx`;
}
/** The address a Mirage development start opens: app and administration paths use the origin the runtime reports. */
export function mirageStartUrl(session, startPath = '/') {
  return reportedOriginOf(session, startPath) + startPath;
}
/** The address a Code App's dev server is given: the one that serves the Code Apps surface and the Dataverse Web API. */
export function codeAppRuntimeOrigin(session) {
  return new URL(session.appsUrl ?? session.url).origin;
}
// The origin that serves a start path when the runtime reports one for it; the portal origin otherwise.
function reportedOriginOf(session, startPath) {
  const pathname = startPath.split(/[?#]/, 1)[0];
  if (appsPath(pathname) && session.appsUrl) return new URL(session.appsUrl).origin;
  if (adminServes(pathname) && session.adminUrl) return new URL(session.adminUrl).origin;
  return session.url;
}
// Fallback only: a record without the runtime-reported admin URL (the runtime itself reports `adminUrl`).
const adminUrlOf = (url) => {
  try {
    return new URL('/_sim/', url).href;
  } catch {
    return null;
  }
};
/** Mirage binds only to loopback; never send runtime probes or shutdowns anywhere else. */
const loopbackUrl = (url) => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
};

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

/** The process start time: a recorded PID only names our Mirage while this value is unchanged. */
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    // PowerShell can start slowly on a busy machine: give it time and retry a read that timed
    // out, because an unread identity must not be mistaken for a reused process ID.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = spawnSync(
        'powershell.exe', // NOSONAR: fixed tool name resolved through PATH by developer tooling
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      );
      if (!result.error && result.signal == null) return result.status === 0 ? result.stdout.trim() || null : null;
    }
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null; // field 22: process start time since boot
  } catch {
    /* macOS and other proc-less systems */
  }
  /* NOSONAR */ const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/**
 * processIdentity() for several PIDs. On Windows one PowerShell start (about half a second) reads
 * them all instead of one start per PID; a PID it does not answer falls back to processIdentity().
 * @returns {Map<number, string|null>}
 */
export function processIdentities(pids) {
  const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const identities = new Map();
  if (process.platform === 'win32' && unique.length > 1) readWindowsProcessIdentities(unique, identities);
  for (const pid of unique) if (!identities.has(pid)) identities.set(pid, processIdentity(pid));
  return identities;
}

function readWindowsProcessIdentities(unique, identities) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = spawnSync(
      'powershell.exe', // NOSONAR: fixed tool name resolved through PATH by developer tooling
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Each PID is read on its own: a missing or inaccessible process yields an empty identity.
        `$ErrorActionPreference = 'Stop'; foreach ($id in ${unique.join(',')}) { try { "$id=$((Get-Process -Id $id).StartTime.ToUniversalTime().Ticks)" } catch { "$id=" } }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
    if (result.error || result.signal != null) {
      // Three timed-out reads leave every identity unread, as processIdentity() does.
      if (attempt === 2) for (const pid of unique) identities.set(pid, null);
      continue;
    }
    storeWindowsProcessIdentities(result.stdout, unique, identities);
    break;
  }
}

function storeWindowsProcessIdentities(stdout, unique, identities) {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)=(\d*)$/.exec(line.trim());
    if (match && unique.includes(Number(match[1]))) identities.set(Number(match[1]), match[2] || null);
  }
}

// Startup must keep its heartbeat and cancellation responsive while Windows
// resolves process ownership. The synchronous public helper remains for callers.
const executeFile = promisify(execFile);
/* NOSONAR */ export async function processIdentityAsync(pid, { signal } = {}) {
  if (signal?.aborted) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'win32') {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal });
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    } catch {
      if (signal?.aborted) return null;
    }
    try {
      const { stdout } = await executeFile('ps', ['-o', 'lstart=', '-p', String(pid)], {
        windowsHide: true,
        timeout: 3000,
        encoding: 'utf8',
        signal,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await executeFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`,
        ],
        { windowsHide: true, timeout: 15000, encoding: 'utf8', signal },
      );
      return stdout.trim() || null;
    } catch (error) {
      if (!error.killed) return null;
    }
  }
  return null;
}

const UNIX_EPOCH_TICKS = 621_355_968_000_000_000n; // .NET ticks (100 ns since 0001-01-01) at 1970-01-01
// Candidate kernel clock tick rates (USER_HZ); the one used is confirmed against this process's own start time.
const CLOCK_TICK_RATES = [100, 1000, 250, 300];
const START_TIME_AGREEMENT_MS = 2000;
const LSTART_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const localFields = (ms) => {
  const date = new Date(ms);
  return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
};
const sameFields = (left, right) => left.every((value, index) => value === right[index]);

/** `ps -o lstart=` in the C locale ("Thu Nov 13 18:03:05 2026", local time), or null when it is not unambiguous. */
function lstartMs(text) {
  const match = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
    text,
  );
  const month = match ? LSTART_MONTHS.indexOf(match[1]) : -1;
  if (month < 0) return null;
  const fields = [Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])];
  const ms = new Date(fields[0], month, fields[2], fields[3], fields[4], fields[5]).getTime();
  // A time that does not exist (a skipped hour) or exists twice (a repeated hour) is ambiguous.
  if (!sameFields(localFields(ms), fields)) return null;
  if (sameFields(localFields(ms - 3_600_000), fields) || sameFields(localFields(ms + 3_600_000), fields)) return null;
  return ms;
}

/**
 * The start time of process `pid` in milliseconds since the Unix epoch, derived from what processIdentityAsync()
 * reads, or null when it cannot be read or converted. Windows: StartTime ticks. Linux: field 22 of /proc/<pid>/stat
 * (clock ticks since boot) with `btime` from /proc/stat, at the tick rate that gives this process's own start time.
 * Elsewhere: `ps -o lstart=`, read only in the C locale's form.
 */
export async function processStartTimeMs(
  pid,
  {
    identityOf = processIdentityAsync,
    readText = (file) => fs.readFile(file, 'utf8'),
    platform = process.platform,
    now = Date.now,
    uptimeMs = () => process.uptime() * 1000,
    signal,
  } = {},
) {
  const identity = await identityOf(pid, { signal });
  if (typeof identity !== 'string') return null;
  if (platform === 'win32')
    return /^\d+$/.test(identity) ? Number((BigInt(identity) - UNIX_EPOCH_TICKS) / 10_000n) : null;
  if (!/^\d+$/.test(identity)) return lstartMs(identity);
  try {
    const bootSeconds = /^btime (\d+)$/m.exec(await readText('/proc/stat'))?.[1];
    const self = await readText('/proc/self/stat');
    const selfTicks = Number(self.slice(self.lastIndexOf(')') + 2).split(' ')[19]);
    if (!bootSeconds || !Number.isFinite(selfTicks)) return null;
    const boot = Number(bootSeconds) * 1000;
    const selfStart = now() - uptimeMs();
    const rate = CLOCK_TICK_RATES.find(
      (hz) => Math.abs(boot + (selfTicks * 1000) / hz - selfStart) <= START_TIME_AGREEMENT_MS,
    );
    return rate ? boot + (Number(identity) * 1000) / rate : null;
  } catch {
    return null;
  }
}

// ---- ownership records
/**
 * Only a missing records file means "no sessions"; any other read failure is surfaced, never taken as empty, and
 * says what the user can do about it.
 */
export async function ownedSessions(paths = DEFAULT_PATHS) {
  const sessionFolder = paths.discoveryRoot ? ' in ' + paths.discoveryRoot : '';
  const remedy = () =>
    ` Inspect or remove ${paths.ownershipFile} and run the command again. Without that file Paqvilo no longer` +
    ` recognises the Mirages it listed, so "paqvilo mirage stop" cannot stop them; end them by` +
    ` their process IDs, which the session-<pid>.json files${sessionFolder} name.`;
  let text;
  try {
    text = await fs.readFile(paths.ownershipFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(
      `Could not read the Mirage ownership records ${paths.ownershipFile}: ${error.message}.${remedy()}`,
      {
        cause: error,
      },
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The Mirage ownership records ${paths.ownershipFile} are not valid JSON: ${error.message}.${remedy()}`,
      { cause: error },
    );
  }
  return Array.isArray(value?.sessions) ? value.sessions.filter((item) => item && Number.isInteger(item.pid)) : [];
}

/** Windows refuses to replace a file while another process has it open; such a refusal lasts only as long as the read. */
const REPLACE_REFUSED = new Set(['EPERM', 'EBUSY', 'EACCES']);
/**
 * Hang guard for the records and their lock: a read-modify-write takes milliseconds and a reader holds the file for
 * as long as one read, so a refusal or a held lock that lasts this long is not going to end by itself.
 */
const OWNERSHIP_LOCK_HANG_GUARD = 30_000;

/**
 * The records file is only ever replaced whole by a rename, so a reader sees the previous or the next complete
 * content. A refused rename is retried until it succeeds, `signal` aborts, or the hang guard ends it with the refusal.
 */
async function saveOwnedSessions(paths, sessions, { signal } = {}) {
  await fs.mkdir(path.dirname(paths.ownershipFile), { recursive: true });
  const temporary = `${paths.ownershipFile}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`; // NOSONAR: pseudo-random value for simulation, not a secret
  await fs.writeFile(temporary, JSON.stringify({ version: 1, sessions }, null, 2));
  const deadline = performance.now() + OWNERSHIP_LOCK_HANG_GUARD;
  try {
    for (;;) {
      try {
        await fs.rename(temporary, paths.ownershipFile);
        return;
      } catch (error) {
        if (!REPLACE_REFUSED.has(error.code)) throw error;
        if (performance.now() > deadline)
          throw new Error(
            `Could not replace the Mirage ownership records ${paths.ownershipFile} (${error.code}): the file is read-only or another program keeps it open. Make it writable or close that program, then run the command again.`,
            { cause: error },
          );
      }
      await delay(10, undefined, { signal });
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// ---- lock files (the ownership lock here and the setup save lock in lense/setup/store.mjs)
/**
 * A lock records its holder as JSON `{pid, at, ticks}`, and a waiter decides from it whether the live process with
 * that number is still the holder:
 * - Linux: `ticks` is the holder's start in clock ticks since boot (field 22 of /proc/<pid>/stat), read by the holder
 *   itself. A waiter reads the same field of the live process and compares for equality: equal is the holder, a
 *   different value is another program with the reused number. No clock is compared, so no clock step can make a live
 *   holder look reused.
 * - Windows and `ps` platforms report a start time fixed at process creation. `at` is the wall clock as it stood at
 *   the holder's own start, advanced monotonically (`lockStamp`), so no clock step after the holder started can put
 *   `at` before that start: a process that started more than this margin after `at` is another program. The margin
 *   covers the granularity of the start times read (one second for `ps`).
 * - A lock without `ticks` (an older toolkit's lock: the PID alone, its file time standing for `at`, or `{pid, at}`
 *   with the wall clock at the take; or a Linux holder that could not read its own ticks) is judged by the time rule
 *   above. For it, a clock stepped back by more than the margin between the holder's start and its take (Windows,
 *   `ps`), or forward by more than the margin after the take (Linux, whose start times follow the current clock),
 *   could make a live holder look reused.
 * - `host` names the operating system and machine the lock was taken on (`lockHost`). Process numbers mean nothing in
 *   another process namespace (Windows and WSL, or a host and a container, sharing one workspace), so a lock from
 *   another host is held: its holder is never judged here. A lock without `host` (an older toolkit's) counts as local.
 */
const REUSED_AFTER_MS = 2000;

const lockStamp = (platform) => (platform === 'linux' ? Date.now() : performance.timeOrigin + performance.now());
/** Where this process takes its locks: its operating system and machine name. */
const lockHost = () => `${process.platform}/${os.hostname()}`;

/** Field 22 of /proc/<pid>/stat (`self`: this process): the start in clock ticks since boot, or null when unread. */
async function procStartTicks(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
  } catch {
    return null;
  }
}
/** This process's own start ticks per reader: read once, at its first lock (once per process for the default reader). */
const ownStartTicks = new WeakMap();
/** The record of each lock this process holds, and of each it released but could not remove (its leftovers). */
const heldLocks = new Map();
const leftLocks = new Map();

/** The holder a lock text records, or null: the PID alone (an older Mirage lock) or JSON `{pid, at, ticks, host}`. */
function lockRecord(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (Number.isInteger(value) && value > 0) return { pid: value, at: null, ticks: null, host: null };
  if (!Number.isInteger(value?.pid) || value.pid <= 0) return null;
  const ticks = typeof value.ticks === 'string' && /^\d+$/.test(value.ticks) ? value.ticks : null;
  const host = typeof value.host === 'string' ? value.host : null;
  return { pid: value.pid, at: Number.isFinite(value.at) ? value.at : null, ticks, host };
}

/**
 * Who holds a lock file. `missing`: it is gone. `unreadable`: it cannot be read, and counts as held. Otherwise `pid`,
 * `at`, `ticks` and `host` from its record (`pid` null when it records none: its creator may still be writing it, or
 * ended before it did; `at` the file time when the record has none), `foreign` when it was taken on another `host`
 * than this one, `stale` when it is local and the recorded process has exited, `ageMs` since the file was last
 * written, measured from the file system's time, and `key`, which changes whenever the lock is replaced or rewritten.
 */
export async function lockHolder(file, { host = lockHost() } = {}) {
  let text, stat;
  try {
    [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true, key: 'missing' };
    return { unreadable: true, pid: null, stale: false, ageMs: 0, key: 'unreadable' };
  }
  const record = lockRecord(text) ?? { pid: null, at: null, ticks: null, host: null };
  const foreign = record.host !== null && record.host !== host;
  return {
    ...record,
    at: record.at ?? stat.mtimeMs,
    foreign,
    stale: record.pid !== null && !foreign && !isAlive(record.pid),
    ageMs: Date.now() - stat.mtimeMs,
    key: JSON.stringify([stat.ino, stat.birthtimeMs, stat.mtimeMs, text]),
  };
}

/**
 * `reused` when the live process with a lock's PID is not its holder (the holder has gone), `held` when it is, `unread`
 * when its start could not be read (the lock is kept). Reading another process's start may start a helper process.
 */
async function lockOwnership(
  holder,
  { startTimeOf = processStartTimeMs, readTicks = procStartTicks, platform = process.platform, signal } = {},
) {
  if (holder.ticks && platform === 'linux') {
    const ticks = await readTicks(holder.pid);
    if (ticks == null) return 'unread';
    return ticks === holder.ticks ? 'held' : 'reused';
  }
  const started = await startTimeOf(holder.pid, { signal });
  if (!Number.isFinite(started) || !Number.isFinite(holder.at)) return 'unread';
  return started > holder.at + REUSED_AFTER_MS ? 'reused' : 'held';
}

/**
 * Whether a lock's holder is `gone` (it has exited, its live number now names another program, or the lock records no
 * holder), `held`, or `unread` (alive, its start unreadable: kept). The start of a live holder is read, and a lock
 * that records no holder is given up, only when `longHeld`: the caller has seen this lock unchanged for its guard. A
 * lock taken on another host is held: its holder can only be judged there.
 */
export async function lockVerdict(holder, longHeld, options = {}) {
  if (holder.missing || holder.stale) return 'gone';
  if (!longHeld || holder.unreadable || holder.foreign) return 'held';
  if (!holder.pid) return 'gone';
  const ownership = await lockOwnership(holder, options);
  return ownership === 'reused' ? 'gone' : ownership;
}

/** What a busy lock message adds for a holder on another host, or one whose start time was asked. */
export const lockOwnershipNote = (verdict, holder = {}) => {
  if (holder.foreign)
    return ` It was taken on ${holder.host} and can only be judged there: if no Paqvilo command is running there, remove the lock file.`;
  return verdict === 'unread' ? ' Its start time could not be read, so the lock is kept.' : '';
};

/** Takes this process's own leftover lock again when it still holds exactly the record this process wrote. */
async function retakeLeftover(file) {
  const text = leftLocks.get(file);
  if (text === undefined) return false;
  let current;
  try {
    current = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && leftLocks.get(file) === text) leftLocks.delete(file);
    return false;
  }
  // Another call in this process may have taken it while this one read it.
  if (leftLocks.get(file) !== text) return false;
  leftLocks.delete(file);
  if (current !== text) return false;
  heldLocks.set(file, text);
  return true;
}

/**
 * Creates the lock `file` exclusively, holding this process's record; false when it exists (or Windows refuses it:
 * `refused` receives that error). A lock this process left behind because its removal failed is its own and nobody is
 * inside it, so it is taken again as it stands. A file whose record cannot be written is removed before the error is
 * thrown, so it cannot block anyone.
 */
export async function createHeld(
  file,
  { platform = process.platform, readTicks = procStartTicks, host = lockHost(), refused } = {},
) {
  const key = path.resolve(file);
  const record = { pid: process.pid, at: lockStamp(platform) };
  if (platform === 'linux') {
    if (!ownStartTicks.has(readTicks)) ownStartTicks.set(readTicks, readTicks('self'));
    const ticks = await ownStartTicks.get(readTicks);
    if (ticks) record.ticks = ticks;
  }
  record.host = host;
  const text = JSON.stringify(record);
  let handle;
  try {
    handle = await fs.open(file, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    refused?.(error);
    return retakeLeftover(key);
  }
  try {
    await handle.writeFile(text).finally(() => handle.close());
  } catch (error) {
    await fs.rm(file, { force: true }).catch(() => {});
    throw error;
  }
  // A leftover removed by someone else is no longer this process's: only the record it holds now is.
  leftLocks.delete(key);
  heldLocks.set(key, text);
  return true;
}

/** Removals of a lock that Windows refuses while another program has the file open, tried before giving up. */
const RELEASE_ATTEMPTS = 10;

/**
 * Removes a lock this process holds. A removal refused while another program has the file open is retried a bounded
 * number of times. One that still fails is reported once through `warn`, never thrown, so it cannot replace the result
 * or the error of the locked work; the lock is then this process's leftover, which its next `createHeld` takes again.
 */
export async function releaseHeld(file, warn) {
  const key = path.resolve(file);
  const text = heldLocks.get(key);
  heldLocks.delete(key);
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rm(file, { force: true });
      return;
    } catch (error) {
      if (REPLACE_REFUSED.has(error.code) && attempt < RELEASE_ATTEMPTS) {
        await delay(20 * attempt);
        continue;
      }
      if (text !== undefined) leftLocks.set(key, text);
      warn(
        `Could not remove the lock file ${file} (${error.code ?? error.message}). This process takes it again for its next update; if no Paqvilo command is running, remove that file by hand.`,
      );
      return;
    }
  }
}

/**
 * Removes `lock` if it is still the lock judged gone (the same `key`). One breaker at a time holds `<lock>.breaking`,
 * created like a lock, so a lock another waiter has taken in the meantime is never removed and nothing is ever put
 * back. Returns `{removed: true}` when this call removed it (the caller then competes for the lock as usual), `{}` when
 * the lock has changed, `{refused}` when Windows refused its removal, or `{busy, verdict, refused}` for a breaker
 * another call holds: `breakerVerdict(busy)` judges it, and a breaker judged gone is removed when it is still
 * unchanged (`refused` when Windows refused that). A refusal is returned, not thrown: the caller tries again under its
 * guard.
 */
export async function breakStaleLock(lock, key, { breakerVerdict, warn, ...options } = {}) {
  const breaker = `${lock}.breaking`;
  if (!(await createHeld(breaker, options))) {
    const busy = await lockHolder(breaker, options);
    const verdict = await breakerVerdict(busy);
    const remove = verdict === 'gone' && !busy.missing && (await lockHolder(breaker, options)).key === busy.key;
    return { busy, verdict, refused: remove ? await refusedRemoval(breaker) : null };
  }
  try {
    if ((await lockHolder(lock, options)).key !== key) return {};
    const refused = await refusedRemoval(lock);
    return refused ? { refused } : { removed: true };
  } finally {
    await releaseHeld(breaker, warn);
  }
}

/** Removes `file`; null when it is gone, or the error when Windows refused it while another program has it open. */
async function refusedRemoval(file) {
  try {
    await fs.rm(file, { force: true });
    return null;
  } catch (error) {
    if (!REPLACE_REFUSED.has(error.code)) throw error;
    return error;
  }
}

/** Why a waiter gives up on `<lock>.breaking` at its guard, from what `breakStaleLock` returned. */
function breakerStuck(lock, { busy, verdict, refused }) {
  const breaker = `${lock}.breaking`;
  if (busy.missing)
    return `Could not create ${breaker}, which is needed to remove the abandoned Mirage ownership lock ${lock}: the folder refuses new files. Make the folder writable, or remove ${lock} if no Paqvilo command is running, and run the command again.`;
  if (refused)
    return `Could not remove ${breaker}, left by process ${busy.pid ?? 'unknown'}, which has ended (${refused.code}): another program keeps it open. Close that program, or remove both files if no Paqvilo command is running, and run the command again.`;
  return `The Mirage ownership lock ${lock} is being removed by process ${busy.pid ?? 'unknown'}, which has not finished for ${OWNERSHIP_LOCK_HANG_GUARD / 1000} s: ${breaker}.${lockOwnershipNote(verdict, busy)} If no Paqvilo command is running, remove both files and run the command again.`;
}

/** True once this waiter has seen the same lock (`key`) for the hang guard on its own monotonic `clock`. */
function lockWatch(clock) {
  let watched, since;
  return (key) => {
    if (key !== watched) [watched, since] = [key, clock()];
    return clock() - since > OWNERSHIP_LOCK_HANG_GUARD;
  };
}

const reportLockWarning = (message) => console.error(`mirage   ${message}`);

/**
 * Runs `action` holding the ownership lock (`<sessions file>.lock`, created exclusively), so toolkit commands in other
 * processes cannot interleave their read-modify-write with this one. A lock whose holder has exited is taken over at
 * once; a live holder's lock never is. The hang guard is this waiter's own: once it has seen the same lock unchanged
 * for the guard on its monotonic `clock`, it takes the lock if it is free at that moment, takes it over when its live
 * number now names another program or it records no holder, and otherwise ends with an error naming the holder. A
 * lock taken by another waiter restarts the guard, so the wait ends when this waiter takes the lock or one lock has
 * stayed for the whole guard. While another waiter removes a lock, this one waits for that under the same guard for
 * `<lock>.breaking`; that guard also ends a breaker the folder refuses to create, or an ended breaker's file Windows
 * refuses to remove. A lock whose removal Windows refuses is tried again until the lock's own guard ends.
 */
/* NOSONAR */ async function withOwnershipLock(
  paths,
  action,
  { signal, clock = () => performance.now(), warn = reportLockWarning, ...options } = {},
) {
  const lock = `${paths.ownershipFile}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const lockOptions = { ...options, signal, warn };
  const lockWatched = lockWatch(clock),
    breakerWatched = lockWatch(clock);
  const breakerVerdict = (busy) => lockVerdict(busy, breakerWatched(busy.key), lockOptions);
  let judged = {};
  for (;;) {
    signal?.throwIfAborted();
    if (await createHeld(lock, lockOptions)) break;
    const holder = await lockHolder(lock, lockOptions);
    const longHeld = lockWatched(holder.key);
    // A lock that is free at the moment the guard ends is taken, not reported.
    if (longHeld && (await createHeld(lock, lockOptions))) break;
    if (judged.key !== holder.key || judged.longHeld !== longHeld)
      judged = { key: holder.key, longHeld, verdict: await lockVerdict(holder, longHeld, lockOptions) };
    if (holder.missing) {
      if (longHeld)
        throw new Error(
          `Could not create the Mirage ownership lock in ${path.dirname(lock)}: the folder refuses new files. Make it writable and run the command again.`,
        );
    } else if (judged.verdict === 'gone') {
      const broken = await breakStaleLock(lock, holder.key, { ...lockOptions, breakerVerdict });
      if (broken.removed) continue;
      // A breaker that is not removing the lock (held, missing although its create was refused, or ended but not
      // removable) counts against the breaker guard; a refused removal of the lock itself against the lock's guard.
      const stuck = broken.busy && (broken.verdict !== 'gone' || broken.busy.missing || broken.refused);
      if (stuck && breakerWatched(broken.busy.key)) throw new Error(breakerStuck(lock, broken));
      if (!broken.busy && broken.refused && longHeld)
        throw new Error(
          `Could not remove the abandoned Mirage ownership lock ${lock} (${broken.refused.code}): another program keeps it open. Close that program, or remove that lock file, and run the command again.`,
          { cause: broken.refused },
        );
    } else if (longHeld)
      throw new Error(
        `The Mirage ownership records stayed locked by process ${holder.pid ?? 'unknown'} for ${OWNERSHIP_LOCK_HANG_GUARD / 1000} s: ${lock}.${lockOwnershipNote(judged.verdict, holder)} If no Paqvilo command is running, remove that lock file and run the command again.`,
      );
    await delay(20 + Math.floor(Math.random() * 40), undefined, { signal }); // NOSONAR: pseudo-random value for simulation, not a secret
  }
  try {
    signal?.throwIfAborted();
    return await action();
  } finally {
    await releaseHeld(lock, warn);
  }
}

/**
 * Read-modify-write, so entries added meanwhile by another toolkit command are retained. Updates
 * are queued within this process and locked across processes: Mirages starting at once, from
 * one command or several, must not lose a record. The remaining options reach the lock: `clock` (monotonic, for its
 * guard), `warn` (a lock that could not be removed), `startTimeOf`, `readTicks` and `platform` (whose lock it is).
 */
const ownershipUpdates = new Map();
export async function updateOwnedSessions(paths, change, { signal, ...lockOptions } = {}) {
  const key = path.resolve(paths.ownershipFile);
  const previous = ownershipUpdates.get(key) ?? Promise.resolve();
  const run = abortable(previous, signal).then(() =>
    withOwnershipLock(
      paths,
      async () => {
        const next = await change(await ownedSessions(paths));
        await saveOwnedSessions(paths, next, { signal });
        return next;
      },
      { signal, ...lockOptions },
    ),
  );
  // A cancelled queued caller returns promptly, but later updates must still
  // wait for its predecessor rather than overtaking an active publication.
  ownershipUpdates.set(
    key,
    Promise.allSettled([previous, run]).then(() => {}),
  );
  return run;
}

// ---- discovery records
async function discoveryRecords(paths, { signal } = {}) {
  signal?.throwIfAborted();
  let names;
  try {
    names = await fs.readdir(paths.discoveryRoot);
  } catch {
    signal?.throwIfAborted();
    return [];
  }
  signal?.throwIfAborted();
  const records = [];
  for (const name of names.filter((item) => /^session-\d+\.json$/.test(item)).sort()) {
    signal?.throwIfAborted();
    const file = path.join(paths.discoveryRoot, name);
    try {
      const record = JSON.parse(await fs.readFile(file, { encoding: 'utf8', signal }));
      if (!Number.isInteger(record.pid) || (!record.url && !Array.isArray(record.portals))) continue;
      records.push({ record, file });
    } catch {
      signal?.throwIfAborted(); /* incomplete discovery file */
    }
  }
  return records;
}

async function readRuntime(url, fallbackSite = null, { signal, timeout = 2500 } = {}) {
  signal?.throwIfAborted();
  if (!url || !loopbackUrl(url)) return null;
  // The light status endpoint first; older runtimes answer 404 there and expose the state summary.
  for (const pathname of ['/_sim/api/status', '/_sim/api/state?summary=1', '/__sim/api/state?summary=1']) {
    let response;
    try {
      response = await fetch(new URL(pathname, url), {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
    } catch {
      signal?.throwIfAborted();
      return null;
    }
    if (response.status === 404) continue;
    if (!response.ok) return null;
    try {
      const data = await response.json();
      const status = data?.status ?? data ?? {};
      return {
        site: status.site ?? fallbackSite,
        pageCount: status.pageCount ?? 0,
        sourceFingerprint: status.sourceFingerprint ?? null,
        revision: status.revision ?? null,
        // "disabled" unless the runtime was started with --allow-live-writes; then "off" or "enabled".
        liveWrites: typeof status.liveWrites === 'string' ? status.liveWrites : null,
        platformStyles: status.platformStyles ?? { mode: 'placeholder' },
        startupPreset: status.startupPreset ?? null,
        observed: status.observed ?? null,
        runtime: status.runtime ?? { kind: 'power-pages' },
        capabilities: status.capabilities ?? null,
        links: status.links ?? null,
        simulation: status.simulation ?? null,
      };
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }
  return null;
}

/** Discovered Mirage portals; `probe` asks each live process whether its runtime answers. */
export async function discoveries(paths = DEFAULT_PATHS, { probe = true, signal } = {}) {
  const sessions = [];
  for (const { record, file } of await discoveryRecords(paths, { signal })) {
    signal?.throwIfAborted();
    const processAlive = isAlive(record.pid);
    if (!processAlive && !isAlive(record.pid)) {
      await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }
    const { portals, ...base } = record;
    const entries = Array.isArray(portals) ? portals.map((portal) => ({ ...base, ...portal, id: portal.id })) : [base];
    for (const entry of entries) {
      signal?.throwIfAborted();
      const runtime = processAlive && probe ? await readRuntime(entry.url, entry.id ?? null, { signal }) : null;
      sessions.push({ ...entry, discovery: file, processAlive, ready: Boolean(runtime), runtime });
    }
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

async function requestShutdown(url) {
  if (!loopbackUrl(url)) return false;
  try {
    let prefix = '/_sim/api';
    let response = await fetch(new URL(`${prefix}/state?summary=1`, url), { signal: AbortSignal.timeout(5000) });
    if (response.status === 404) {
      prefix = '/__sim/api';
      response = await fetch(new URL(`${prefix}/state?summary=1`, url), { signal: AbortSignal.timeout(5000) });
    }
    if (!response.ok) return false;
    const state = await response.json();
    if (typeof state.csrf !== 'string' || !state.csrf) return false;
    const stopped = await fetch(new URL(`${prefix}/shutdown`, url), {
      method: 'POST',
      headers: { 'x-sim-csrf': state.csrf },
      signal: AbortSignal.timeout(2500),
    });
    return stopped.status === 202;
  } catch {
    return false;
  }
}

/**
 * Stops toolkit-owned Mirage processes selected by portal source folder or PID. An entry is only
 * acted on while its PID still has the recorded start identity; entries of exited processes (or of a
 * reused PID) are pruned, and discovery files of exited processes are removed.
 */
/* NOSONAR: single-pass routine, splitting it would change shared state */ export async function stopOwnedSessions({
  paths = DEFAULT_PATHS,
  sourceDir = null,
  sourceDirs = null,
  pids = null,
  deadline = STOP_DEADLINE,
  identityOf = processIdentity,
  alive = isAlive,
} = {}) {
  const folders = sourceDirs ?? (sourceDir ? [sourceDir] : []);
  const owned = await ownedSessions(paths);
  const records = await discoveryRecords(paths);
  const stale = [],
    targets = [],
    unverified = [];
  const known =
    identityOf === processIdentity
      ? processIdentities(owned.filter((entry) => alive(entry.pid)).map((entry) => entry.pid))
      : null;
  classifyOwnedTargets(owned, { alive, identityOf, known, folders, pids, stale, targets, unverified });
  const results = [];
  for (const entry of targets) {
    const record = records.find((item) => item.record.pid === entry.pid)?.record;
    // The recorded URL is ours; a discovery URL is only used while ours is not known yet (starting).
    const urls = [
      ...new Set(
        entry.url ? [entry.url] : [record?.url, ...(record?.portals ?? []).map((portal) => portal.url)].filter(Boolean),
      ),
    ];
    let graceful = false;
    for (const url of urls) if (!graceful) graceful = await requestShutdown(url);
    if (!graceful && identityOf(entry.pid) === entry.processIdentity) {
      try {
        process.kill(entry.pid, 'SIGTERM');
      } catch {
        /* already stopped */
      }
    }
    results.push({ entry, graceful });
  }
  const waitForExit = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end && targets.some((entry) => alive(entry.pid))) await sleep(100);
  };
  await waitForExit(deadline);
  for (const entry of targets) {
    // POSIX signals can be handled; force only the process that still has the recorded identity.
    if (alive(entry.pid) && identityOf(entry.pid) === entry.processIdentity) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
  }
  if (targets.some((entry) => alive(entry.pid))) await waitForExit(2000);
  const remaining = targets.filter((entry) => {
    if (!alive(entry.pid)) return false;
    const current = identityOf(entry.pid);
    return current == null || current === entry.processIdentity;
  });
  const removedDiscoveries = [];
  for (const { record, file } of await discoveryRecords(paths)) {
    if (alive(record.pid)) continue;
    await fs.rm(file, { force: true });
    removedDiscoveries.push(file);
  }
  const forget = [...targets.filter((item) => !remaining.includes(item)), ...stale.map((item) => item.entry)];
  for (const entry of forget) {
    if (!entry.discovery || removedDiscoveries.includes(entry.discovery) || alive(entry.pid)) continue;
    const relative = path.relative(paths.discoveryRoot, entry.discovery);
    if (/^session-\d+\.json$/.test(relative) && fsSync.existsSync(entry.discovery)) {
      await fs.rm(entry.discovery, { force: true });
      removedDiscoveries.push(entry.discovery);
    }
  }
  await updateOwnedSessions(paths, (current) => {
    const retained = current.filter(
      (item) => !forget.some((entry) => entry.pid === item.pid && entry.processIdentity === item.processIdentity),
    );
    pruneCommandPayloads(
      path.join(path.dirname(paths.ownershipFile), 'commands'),
      current.filter((item) => !retained.includes(item)).flatMap((item) => item.hintFiles ?? []),
      retained.flatMap((item) => item.hintFiles ?? []),
    );
    return retained;
  });
  // A runtime that acknowledged its shutdown and was ready has no start-up diagnosis left to keep.
  const cleanLogs = results
    .filter(({ entry, graceful }) => graceful && entry.ready !== false && !remaining.includes(entry))
    .map(({ entry }) => entry.log)
    .filter((file) => file && isStartupLogIn(paths, file));
  for (const file of cleanLogs) await removeStartupLog(file);
  const describe = (entry) => ({
    pid: entry.pid,
    url: entry.url ?? null,
    sourceDir: entry.sourceDir ?? null,
    stateFile: entry.stateFile ?? null,
    project: entry.project ?? null,
    portal: entry.portal ?? null,
  });
  return {
    stopped: results
      .filter(({ entry }) => !remaining.includes(entry))
      .map(({ entry, graceful }) => ({ ...describe(entry), graceful, wasReady: entry.ready !== false })),
    remaining: remaining.map(describe),
    pruned: stale.map(({ entry, reason }) => ({ ...describe(entry), reason })),
    unverified: unverified.map(({ entry, reason }) => ({ ...describe(entry), reason })),
    removedDiscoveries,
    writesFiles: [paths.ownershipFile],
  };
}

function classifyOwnedTargets(owned, { alive, identityOf, known, folders, pids, stale, targets, unverified }) {
  for (const entry of owned) {
    const status = inspectOwnedTarget(entry, { alive, identityOf, known });
    if (status.kind === 'unverified') {
      unverified.push({ entry, reason: status.reason });
      continue;
    }
    if (status.kind === 'stale') {
      stale.push({ entry, reason: status.reason });
      continue;
    }
    if (isSelectedOwnedTarget(entry, pids, folders)) targets.push(entry);
  }
}

function inspectOwnedTarget(entry, { alive, identityOf, known }) {
  const running = alive(entry.pid);
  let current = null;
  if (running) {
    if (known?.has(entry.pid)) current = known.get(entry.pid);
    else current = identityOf(entry.pid);
  }
  // A live process whose start identity was never recorded or cannot be read now is neither
  // proof of a reused process ID nor safe to signal: its record stays for a later stop.
  if (running && (!entry.processIdentity || current == null))
    return {
      kind: 'unverified',
      reason: entry.processIdentity
        ? 'its start identity could not be read now; run stop again'
        : 'no start identity was recorded when it started, so it is never signalled',
    };
  if (!running || current !== entry.processIdentity)
    return { kind: 'stale', reason: !running ? 'process exited' : 'process ID now belongs to another program' };
  return { kind: 'target' };
}

function isSelectedOwnedTarget(entry, pids, folders) {
  return Boolean(pids?.includes(entry.pid)) || folders.some((folder) => samePath(entry.sourceDir, folder));
}

/** The batch reads the real identities, so an injected reader is asked for each PID instead. */
function batchedIdentities(pids, identityOf) {
  return identityOf === processIdentity ? processIdentities(pids) : new Map();
}

/** Sessions with ownership, project and portal information merged from both record kinds. */
export async function mirageStatus(paths = DEFAULT_PATHS, { identityOf = processIdentity } = {}) {
  const owned = await ownedSessions(paths);
  const found = await discoveries(paths);
  // Read every identity this status can compare in one batch, not one PowerShell start per PID.
  const pids = [
    ...found
      .filter(
        (session) =>
          session.processAlive &&
          owned.some(
            (item) => item.pid === session.pid && item.discovery === session.discovery && item.processIdentity,
          ),
      )
      .map((session) => session.pid),
    ...owned
      .filter((entry) => !found.some((session) => session.pid === entry.pid) && isAlive(entry.pid))
      .map((entry) => entry.pid),
  ];
  const identities = batchedIdentities(pids, identityOf);
  const identity = (pid) => {
    if (!identities.has(pid)) identities.set(pid, identityOf(pid));
    return identities.get(pid);
  };
  const sessions = found.map((session) => {
    const owner = owned.find((item) => item.pid === session.pid && item.discovery === session.discovery);
    const isOwned = Boolean(
      owner && session.processAlive && owner.processIdentity && owner.processIdentity === identity(session.pid),
    );
    return {
      ...session,
      adminUrl: session.adminUrl ?? (session.url ? adminUrlOf(session.url) : null),
      owned: isOwned,
      project: session.project ?? owner?.project ?? null,
      portal: session.id ?? owner?.portal ?? null,
    };
  });
  for (const entry of owned) {
    if (
      found.some((session) => session.pid === entry.pid) ||
      !isAlive(entry.pid) ||
      entry.processIdentity !== identity(entry.pid)
    )
      continue;
    sessions.push({
      pid: entry.pid,
      url: entry.url ?? null,
      adminUrl: entry.adminUrl ?? (entry.url ? adminUrlOf(entry.url) : null),
      appsUrl: entry.appsUrl,
      sourceDir: entry.sourceDir ?? null,
      stateFile: entry.stateFile ?? null,
      project: entry.project ?? null,
      portal: entry.portal ?? null,
      discovery: entry.discovery ?? null,
      processAlive: true,
      ready: false,
      starting: true,
      owned: true,
      runtime: null,
    });
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

// ---- configuration
async function loadProject(file) {
  const { loadProjectConfig } = await import('../../mirage/lib/project-config.mjs');
  return loadProjectConfig(path.resolve(file));
}

/** A Ctrl+C during Code App start-up is an interrupt: it prints one line and returns true. Other errors return false. */
export function codeAppStartupInterrupted(error, write = (line) => console.log(line)) {
  if (error?.code !== CODE_APP_STARTUP_CANCELLED) return false;
  write('mirage   Code App start-up was interrupted.');
  return true;
}

/**
 * The abort controller of a Code App dev session. Only the reason its own interrupt aborts with counts as an interrupt.
 */
export function codeAppInterrupt() {
  const controller = new AbortController();
  const reason = new Error('Code App development stopped.');
  return {
    controller,
    interrupt: () => controller.abort(reason),
    interrupted: (error = controller.signal.reason) => error === reason,
  };
}

async function startProjectCodeApps(cfg, launch, session, controller) {
  const project = launch.project ? await loadProject(launch.project) : null;
  const entries = project?.codeApps ?? cfg.mirageConfig?.codeApps ?? [];
  const root = project ? path.dirname(project.configFile) : cfg.configDir;
  const { loadCodeApps } = await import('../../mirage/lib/code-apps-config.mjs');
  const apps = loadCodeApps(entries, root);
  const { startCodeAppDevServers } = await import('../code-app-dev-servers.mjs');
  const servers = await startCodeAppDevServers(apps, {
    signal: controller.signal,
    mirageUrl: codeAppRuntimeOrigin(session),
    onFailure: (error) => controller.abort(error),
  });
  return { apps, servers };
}

/**
 * Applies catalogue Mirage settings (`cfg.mirageConfig`) to the command-line options: a
 * catalogued project, then catalogued Solution roots, port and preset. Explicit options always win.
 */
export function catalogueArgs(cfg, args = {}, { requireProject = true } = {}) {
  const configured = cfg?.mirageConfig ?? {};
  const effective = { ...args };
  if (effective.runtime === undefined && configured.runtime?.kind !== undefined)
    effective.runtime = configured.runtime.kind;
  if (effective.simulation === undefined && configured.simulation?.level !== undefined)
    effective.simulation = configured.simulation.level;
  applyConfiguredProject(effective, configured, cfg, args, requireProject);
  if (!effective.project && !effective['solution-root']?.length && configured.solutionRoots?.length)
    effective['solution-root'] = [...configured.solutionRoots];
  if (effective.port === undefined && Number.isInteger(configured.port)) effective.port = String(configured.port);
  if (effective.preset === undefined && configured.preset) effective.preset = configured.preset;
  if (effective['apply-configuration'] === undefined && configured.presetConfiguration === 'apply')
    effective['apply-configuration'] = true;
  if (effective['preset-mode'] === undefined && configured.presetMode) effective['preset-mode'] = configured.presetMode;
  return effective;
}

function applyConfiguredProject(effective, configured, cfg, args, requireProject) {
  if (effective.project !== undefined || !configured.project) return;
  if (isFile(configured.project)) {
    effective.project = configured.project;
    return;
  }
  if (!requireProject) return;
  throw new Error(
    `Site "${cfg.siteName}" selects the Mirage project ${configured.project}, which does not exist. Create it with: ${mirageCommandHint([['mirage', 'init', ...configurationHintScope(cfg, args)]], { cli: TOOLKIT_CLI })}, or remove mirage.project for this site.`,
  );
}

export function cliArgs(cfg, action, args, project = null) {
  const cli = path.join(MIRAGE_ROOT, 'cli.mjs');
  const common = commonCliArguments(cfg, action, args);
  if (project) return projectCliArgs(cli, cfg, action, args, project, common);
  if (cfg.runtime?.kind && cfg.runtime.kind !== 'power-pages')
    return standaloneCatalogueCliArgs(cli, cfg, action, args, common);
  return portalSourceCliArgs(cli, cfg, action, args, common);
}

function commonCliArguments(cfg, action, args) {
  return [
    ...(action === 'inspect'
      ? []
      : [
          '--state-dir',
          path.dirname(miragePaths(cfg, args).discoveryRoot),
          ...(args.port !== undefined ? ['--port', String(runtimePort(args.port, DEFAULT_PORT))] : []),
          ...(args.state ? ['--state', path.resolve(args.state)] : []),
          ...(args.preset ? ['--preset', args.preset] : []),
          ...(args['apply-configuration'] === true ? ['--apply-configuration'] : []),
          ...(args['preset-mode'] ? ['--preset-mode', args['preset-mode']] : []),
          ...(args['allow-live-writes'] === true ? ['--allow-live-writes'] : []),
        ]),
    ...(args.runtime ? ['--runtime', args.runtime] : []),
    ...(args.simulation ? ['--simulation', args.simulation] : []),
  ];
}

function portalSourceCliArgs(cli, cfg, action, args, common) {
  const origin = httpsOrigin(cfg.origin);
  const values = [
    action,
    '--site',
    cfg.siteName,
    '--env',
    cfg.envName,
    '--source',
    cfg.sourceDir,
    ...(origin && action !== 'inspect' ? ['--origin', origin] : []),
    ...common,
  ];
  // The Mirage reads the site's mirage settings (such as observed behaviour) from the
  // catalogue: the same catalogue file and portal checkout the toolkit resolved.
  if (cfg.configFile || args.config) values.push('--config', cfg.configFile ?? path.resolve(args.config));
  if (args.repo) values.push('--repo', path.resolve(args.repo));
  for (const root of args['solution-root'] ?? []) values.push('--solution-root', path.resolve(root));
  // The Mirage layers --solution-root values in their dependency order unless told otherwise.
  if (args['solution-root']?.length) values.push('--solution-order', solutionOrderOf(cfg));
  return { cli, values };
}

function projectCliArgs(cli, cfg, action, args, project, common) {
  const powerPages = (args.runtime ?? project.runtime?.kind ?? 'power-pages') === 'power-pages';
  if (!powerPages && args.portal) throw new Error('A standalone runtime does not select a portal.');
  let portal = null;
  if (powerPages) portal = args.portal ?? (action === 'serve' ? project.defaultPortal : null);
  return {
    cli,
    values: [
      action,
      '--project',
      project.configFile,
      ...(portal ? ['--portal', portal] : []),
      ...(cfg?.mirageConfig?.deploymentProfiles && samePath(cfg.mirageConfig.project, project.configFile)
        ? ['--site', cfg.catalogueSite ?? cfg.siteName, '--env', cfg.envName]
        : []),
      ...((args.config || !args.project) && cfg?.configFile ? ['--config', cfg.configFile] : []),
      ...common,
    ],
  };
}

function standaloneCatalogueCliArgs(cli, cfg, action, args, common) {
  return {
    cli,
    values: [
      action,
      ...(args.runtime ? [] : ['--runtime', cfg.runtime.kind]),
      ...common,
      ...(cfg.configFile ? ['--config', cfg.configFile, '--site', cfg.siteName] : []),
      ...(args['solution-root'] ?? []).flatMap((root) => ['--solution-root', path.resolve(root)]),
    ],
  };
}

/** Whether create, update and delete requests can reach the live environment from this runtime. */
function liveWritesText(value) {
  if (value === 'enabled') return 'enabled: create, update and delete requests reach the live environment';
  if (value === 'off') return 'allowed by --allow-live-writes; off until switched on in _sim';
  if (value === 'disabled') return 'disabled (start with --allow-live-writes to allow them)';
  return 'not reported by this Mirage';
}

const catalogueOwnedState = (cfg) =>
  cfg.configFile && samePath(cfg.stateDir, path.join(path.dirname(cfg.configFile), '.paqvilo'));
const catalogueIdentity = (cfg) =>
  cfg.configFile ? { configFile: cfg.configFile, siteName: cfg.catalogueSite ?? cfg.siteName } : cfg.catalogueScope;

function sessionSelectors(entry, selection) {
  const roots = selection['solution-root']?.map((root) => path.resolve(root));
  const actualPort = listenerPort(entry.url);
  return (
    (!selection.state || samePath(entry.stateFile ?? entry.identity?.stateFile, path.resolve(selection.state))) &&
    selectedPortMatches(entry, selection.port, actualPort) &&
    selectedRootsMatch(entry, roots)
  );
}

function selectedPortMatches(entry, selectedPort, actualPort) {
  if (selectedPort === undefined) return true;
  if (String(selectedPort) === '0') return entry.identity?.requestedPort === '0';
  return actualPort === String(selectedPort) || (!actualPort && entry.identity?.requestedPort === String(selectedPort));
}

function selectedRootsMatch(entry, roots) {
  return (
    !roots ||
    (entry.identity?.solutionRoots?.length === roots.length &&
      roots.every((root) => entry.identity.solutionRoots.some((candidate) => samePath(root, candidate))))
  );
}

/** Intersect ownership scope, source/project identity and explicitly supplied selectors. */
async function selectedSessionPids(paths, cfg, kind, selectedProject = null, selection = {}, sourceDir = null) {
  const selectedCatalogue = catalogueIdentity(cfg);
  const scoped = Boolean(selectedCatalogue);
  const candidates = (await ownedSessions(paths)).filter((entry) =>
    matchesSessionCandidate(entry, { kind, selection, sourceDir, selectedProject }),
  );
  const siteName = selectedCatalogue?.siteName;
  const exactLegacyTarget =
    selection.state &&
    selection.port !== undefined &&
    String(selection.port) !== '0' &&
    candidates.filter(
      (entry) =>
        listenerPort(entry.url) === String(selection.port) &&
        (!entry.identity?.scope || samePath(entry.identity.scope.configFile, selectedCatalogue?.configFile)),
    ).length === 1;
  const scopeContext = {
    scoped,
    selectedProject,
    kind,
    sourceDir,
    selectedCatalogue,
    siteName,
    exactLegacyTarget,
    cfg,
  };
  return candidates.filter((entry) => matchesCatalogueScope(entry, scopeContext)).map((entry) => entry.pid);
}

function matchesSessionCandidate(entry, { kind, selection, sourceDir, selectedProject }) {
  if (
    (entry.identity?.runtime?.kind ?? (entry.sourceDir ? 'power-pages' : null)) !== kind ||
    !sessionSelectors(entry, selection)
  )
    return false;
  if (sourceDir && !samePath(entry.sourceDir, sourceDir)) return false;
  if (selectedProject) {
    if (!samePath(entry.project, selectedProject.configFile)) return false;
    if (selection.portal && entry.portal !== selection.portal) return false;
  } else if (entry.project && kind !== 'power-pages') return false;
  return true;
}

function matchesCatalogueScope(entry, context) {
  const { scoped, selectedProject, kind, sourceDir, selectedCatalogue, siteName, exactLegacyTarget, cfg } = context;
  if (!scoped) return selectedProject ? true : !entry.identity?.scope;
  // Older verified records may predate scoped identities. Their source and supplied state/port still constrain selection.
  const scope = entry.identity?.scope;
  if (!scope && !selectedProject) return kind === 'power-pages' && Boolean(sourceDir);
  if (scope && !samePath(scope.configFile, selectedCatalogue.configFile)) return false;
  if (scope && (scope.version !== undefined || scope.catalogueSite !== undefined))
    return scope.version === 1 && scope.catalogueSite === siteName;
  if (scope && (!selectedProject || scope.siteName !== entry.portal)) return scope.siteName === siteName;
  if (exactLegacyTarget) return true;
  context.catalogue ??= loadCatalogue({ config: selectedCatalogue.configFile, repo: cfg.sourceRoot });
  if (legacyProjectScopeMatches(context.catalogue, scope, siteName, selectedProject)) return true;
  throw new Error(
    'Legacy Mirage project ownership is ambiguous; supply --state and the actual listening --port to stop one recorded runtime.',
  );
}

function legacyProjectScopeMatches(catalogue, scope, siteName, selectedProject) {
  const mapped = Object.entries(catalogue.sites).filter(
    ([, site]) =>
      site.mirage?.project &&
      samePath(path.resolve(catalogue.configDir, site.mirage.project), selectedProject.configFile),
  );
  return (
    Object.keys(catalogue.sites).length === 1 &&
    mapped.length === 1 &&
    mapped[0][0] === siteName &&
    (!scope || !Object.hasOwn(catalogue.sites, scope.siteName) || scope.siteName === siteName)
  );
}

function stopSummary(report, scope, none) {
  const count = report.stopped.length,
    kept = report.unverified?.length ?? 0;
  let verdict;
  if (count) verdict = `Stopped ${count} toolkit-owned Mirage session(s) for ${scope}.`;
  else {
    const stopped = kept ? 'was stopped ' : '';
    verdict = `No toolkit-owned Mirage session ${stopped}for ${none}.`;
  }
  return kept ? `${verdict} ${kept} owned session(s) could not be verified and were kept.` : verdict;
}

/**
 * A selected session that could not be verified is still running, so the stop is not complete. The status is
 * returned rather than thrown: the report has already been printed, and a thrown error would append a second JSON document.
 */
function stopExitStatus(report, pids) {
  return report.unverified.some((item) => pids.includes(item.pid)) ? 2 : 0;
}

/** A nested observation, such as headers: "page name=value; webFile name=value, name=value". */
function observedValue(value) {
  if (!value || typeof value !== 'object') return String(value);
  const entries = Object.entries(value);
  return entries.every(([, item]) => !item || typeof item !== 'object')
    ? entries.map(([key, item]) => `${key}=${item}`).join(', ')
    : entries.map(([key, item]) => `${key} ${observedValue(item)}`).join('; ');
}

/** Observed platform behaviour as one line: "loginPath /SignIn, headers (page …) (evidence: …)". */
export function observedText(observed) {
  const { evidence, ...values } = observed;
  return `${Object.entries(values)
    .map(([key, value]) =>
      value && typeof value === 'object' ? `${key} (${observedValue(value)})` : `${key} ${value}`,
    )
    .join(', ')} (evidence: ${evidence})`;
}

/** Solution roots in load order, as the Mirage CLI will apply them. */
async function launchSolutionRoots(sourceDir, args, projectInfo) {
  if (projectInfo?.runtime?.kind && projectInfo.runtime.kind !== 'power-pages') return projectInfo.solutionRoots;
  if (projectInfo)
    return (
      projectInfo.portals.find((portal) => portal.id === (args.portal ?? projectInfo.defaultPortal))?.solutionRoots ??
      []
    );
  if (args['solution-root']?.length) return args['solution-root'].map((root) => path.resolve(root));
  if (!sourceDir) return [];
  return (await import('../../mirage/lib/solution-roots.mjs')).discoverSolutionRoots(sourceDir);
}

async function launchIdentity(cfg, args, projectInfo = null) {
  const runtime = args.runtime
    ? { kind: args.runtime }
    : (projectInfo?.runtime ?? cfg.runtime ?? { kind: 'power-pages' });
  const standalone = runtime.kind !== 'power-pages';
  const portalId = standalone ? null : (args.portal ?? projectInfo?.defaultPortal ?? null);
  const sourceDir = projectInfo ? projectInfo.portals.find((item) => item.id === portalId)?.sourceDir : cfg.sourceDir;
  let stateFile;
  if (args.state) stateFile = resolved(args.state);
  else if (projectInfo)
    stateFile = (await import('../../mirage/lib/project-config.mjs')).projectStateFile(
      projectInfo,
      standalone ? 'organization' : portalId,
      path.join(miragePaths(cfg, args).discoveryRoot, 'projects'),
    );
  else stateFile = path.join(miragePaths(cfg, args).discoveryRoot, cfg.siteName, 'state.json');
  const solutionRoots = (await launchSolutionRoots(sourceDir, args, projectInfo)).map((item) => resolved(item));
  // The registered settings (mirage/lib/config-keys.mjs) as the Mirage CLI resolves them, then the command-line choices.
  const { runtimeOptions, runtimeIdentity, startupPresetChoice } = await import('../../mirage/lib/config-keys.mjs');
  const options = runtimeOptions({
    project: projectInfo,
    portal: projectInfo?.portals.find((item) => item.id === portalId) ?? null,
    catalogue: cfg.mirageConfig,
  });
  options.runtime = runtime;
  // The startup preset the child applies (the child is launched with --site, so the catalogue site is in scope too).
  const startup = startupPresetChoice(args, { project: projectInfo, catalogue: cfg.mirageConfig });
  if (args.simulation) options.simulation = { level: args.simulation };
  const scope = catalogueIdentity(cfg);
  return {
    identity: {
      sourceDir: resolved(sourceDir),
      project: resolved(projectInfo?.configFile),
      portal: portalId,
      runtime,
      simulation: args.simulation ? { level: args.simulation } : (projectInfo?.simulation ?? null),
      modelDriven: projectInfo?.modelDriven ?? cfg.mirageConfig?.modelDriven ?? { trustedExtensions: false },
      dataverse: projectInfo?.dataverse ?? cfg.mirageConfig?.dataverse ?? null,
      // Compared by identityMatches: every identity row of the settings table (secrets hashed).
      settings: runtimeIdentity(options),
      scope: scope
        ? {
            version: 1,
            configFile: resolved(scope.configFile),
            siteName: scope.siteName,
            catalogueSite: scope.siteName,
          }
        : null,
      stateFile: resolved(stateFile),
      preset: startup.preset,
      presetMode: startup.presetMode,
      presetConfiguration: startup.presetConfiguration,
      allowLiveWrites: args['allow-live-writes'] === true,
      // Explicit layer order affects imported metadata; it is part of the reusable runtime identity.
      solutionRoots: [...solutionRoots],
      solutionOrder: projectInfo?.solutionOrder ?? solutionOrderOf(cfg),
      requestedPort: String(args.port ?? DEFAULT_PORT),
      render: renderSettings(cfg.mirageConfig?.render),
      personaContexts: cfg.mirageConfig?.personaContexts ?? { maxInstances: 4 },
      identityProvider: cfg.mirageConfig?.identityProvider ?? {},
      platform:
        cfg.mirageConfig?.platform ??
        projectInfo?.portals.find((item) => item.id === portalId)?.platform ??
        projectInfo?.platform ??
        null,
      deploymentProfiles:
        cfg.mirageConfig?.deploymentProfiles && samePath(cfg.mirageConfig.project, projectInfo?.configFile)
          ? cfg.mirageConfig.deploymentProfiles
          : (projectInfo?.portals.find((item) => item.id === portalId)?.deploymentProfiles ??
            cfg.mirageConfig?.deploymentProfiles ??
            null),
    },
    solutionRoots,
  };
}

// Identities record runtimeIdentity() as settings; one written before that compares its per-key fields.
function settingsMatch(left, right) {
  if (left.settings && right.settings) return JSON.stringify(left.settings) === JSON.stringify(right.settings);
  return (
    JSON.stringify(left.runtime ?? { kind: 'power-pages' }) ===
      JSON.stringify(right.runtime ?? { kind: 'power-pages' }) &&
    JSON.stringify(left.simulation ?? null) === JSON.stringify(right.simulation ?? null) &&
    JSON.stringify(left.modelDriven ?? { trustedExtensions: false }) ===
      JSON.stringify(right.modelDriven ?? { trustedExtensions: false }) &&
    JSON.stringify(left.dataverse ?? null) === JSON.stringify(right.dataverse ?? null) &&
    JSON.stringify(left.render ?? renderSettings()) === JSON.stringify(right.render ?? renderSettings()) &&
    JSON.stringify(left.platform ?? null) === JSON.stringify(right.platform ?? null) &&
    JSON.stringify(left.deploymentProfiles ?? null) === JSON.stringify(right.deploymentProfiles ?? null)
  );
}

function identityMatches(left, right) {
  return Boolean(
    left &&
    right &&
    (left.sourceDir || right.sourceDir ? samePath(left.sourceDir, right.sourceDir) : true) &&
    samePath(left.stateFile, right.stateFile) &&
    (left.project ?? null) === (right.project ?? null) &&
    (left.portal ?? null) === (right.portal ?? null) &&
    JSON.stringify(left.scope ?? null) === JSON.stringify(right.scope ?? null) &&
    settingsMatch(left, right) &&
    (left.preset ?? null) === (right.preset ?? null) &&
    (left.presetConfiguration ?? 'data-only') === (right.presetConfiguration ?? 'data-only') &&
    (left.presetMode ?? 'always') === (right.presetMode ?? 'always') &&
    Boolean(left.allowLiveWrites) === Boolean(right.allowLiveWrites) &&
    left.solutionOrder === right.solutionOrder &&
    JSON.stringify(left.solutionRoots ?? []) === JSON.stringify(right.solutionRoots ?? []) &&
    String(left.requestedPort ?? '') === String(right.requestedPort ?? ''),
  );
}

// ---- start
export async function start(
  cfg,
  args,
  {
    paths = miragePaths(cfg, args),
    command = 'mirage start',
    spawnRuntime = spawn,
    identityOf = processIdentityAsync,
    sleep = (ms, options) => delay(ms, undefined, options),
    now = Date.now,
    alive = isAlive,
    kill = process.kill,
  } = {},
) {
  let interrupted = false,
    child,
    cleanup;
  const controller = new AbortController();
  const interrupt = () => {
    interrupted = true;
    controller.abort(new Error('Mirage startup was interrupted; the starting process was stopped.'));
    if (child?.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
    }
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const check = () => {
    if (interrupted) throw new Error('Mirage startup was interrupted; the starting process was stopped.');
  };
  try {
    return await startRuntime(cfg, args, paths, {
      command,
      spawnRuntime,
      identityOf,
      sleep,
      now,
      alive,
      kill,
      check,
      signal: controller.signal,
      cancelled: () => interrupted,
      child: (value) => {
        child = value;
      },
      cleanup: (value) => {
        cleanup = value;
      },
    });
  } catch (error) {
    // The direct child handle is ours even if its OS start identity could not
    // yet be read. Do not leave a detached importer after early cancellation.
    if (child?.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
    }
    await cleanup?.();
    if (interrupted)
      throw Object.assign(new Error('Mirage startup was interrupted; the starting process was stopped.'), {
        writesFiles: error.writesFiles,
      });
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

/* NOSONAR */ async function startRuntime(cfg, args, paths, startup) {
  const started = startup.now() - (args.startup?.elapsedMs ?? 0);
  args.startup?.phase('source discovery', cfg.siteName);
  const port = String(runtimePort(args.port, DEFAULT_PORT));
  const timeout = args['startup-timeout'] === undefined ? DEFAULT_STARTUP_TIMEOUT : Number(args['startup-timeout']);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600_000)
    throw new Error(
      '--startup-timeout must be an integer from 1000 to 600000 milliseconds: the longest start-up silence allowed',
    );
  let projectInfo = null;
  if (args.project) {
    projectInfo = await loadProject(args.project);
    validateProjectLaunchArguments(projectInfo, args);
  } else {
    const missing = (args['solution-root'] ?? [])
      .map((root) => path.resolve(root))
      .filter((root) => !isDirectory(root));
    // Catalogue and command-line roots are a set: the dependency order applies unless the site
    // sets mirage.solutionOrder: explicit (the Mirage keeps the order it is given).
    if (!missing.length && args['solution-root']?.length > 1 && solutionOrderOf(cfg) !== 'explicit')
      args = {
        ...args,
        'solution-root': await derivedSolutionOrder(args['solution-root'], {
          cacheFile: path.join(paths.discoveryRoot, 'cache/solution-discovery.json'),
        }),
      };
    if (missing.length)
      throw new Error(
        `Mirage Solution root${missing.length > 1 ? 's do' : ' does'} not exist: ${missing.join(', ')}. Restore that checkout, pass --solution-root explicitly, or set "solutionRoots: []" for this site in paqvilo.config.local.yml to use sibling discovery.`,
      );
  }
  const { identity, solutionRoots } = await launchIdentity(cfg, { ...args, port }, projectInfo);
  const launch = { ...identity, solutionRoots };
  startup.check();
  args.startup?.phase('existing runtime and ownership', cfg.siteName);
  const owned = await ownedSessions(paths);
  // Listing local records is cheap. Probe only runtimes eligible for this
  // launch; unrelated listeners can each consume the full probe timeout.
  const candidates = (await discoveries(paths, { probe: false, signal: startup.signal })).filter((session) =>
    isReusableRuntimeCandidate(session, owned, identity),
  );
  startup.check();
  let existing;
  for (const session of candidates) {
    const currentIdentity = await startup.identityOf(session.pid, { signal: startup.signal });
    startup.check();
    const owner =
      currentIdentity &&
      owned.find(
        (item) =>
          item.pid === session.pid &&
          item.discovery === session.discovery &&
          item.processIdentity === currentIdentity &&
          identityMatches(item.identity, identity),
      );
    if (owner) {
      const runtime = await ownedRuntime(session, owner, { started, timeout, startup });
      if (runtime) {
        existing = { ...session, log: owner.log, ready: true, runtime };
        break;
      }
    }
  }
  if (existing) return { ...existing, owned: true, started: false, launch, writesFiles: [] };
  await refuseStateFileOwner(owned, identity, startup);
  if (startup.now() >= started + timeout)
    throw new Error(
      `Mirage startup exceeded ${timeout}ms during source discovery or ownership checks; no child was started.`,
    );
  if (port !== '0' && !(await portAvailable(Number(port))))
    throw new Error(
      `Port ${port} is already in use by another process or Mirage session with different settings. Pass --port 0 (any free port) or another --port, or stop that session first.`,
    );
  const { cli, values } = cliArgs(cfg, 'serve', { ...args, port, state: identity.stateFile }, projectInfo);
  let child;
  args.startup?.phase('process launch', identity.runtime?.kind ?? 'power-pages');
  await pruneStartupLogs(paths, await ownedSessions(paths));
  await fs.mkdir(paths.logRoot, { recursive: true });
  const log = path.join(paths.logRoot, `startup-${Date.now()}-${Math.random().toString(16).slice(2)}.log`); // NOSONAR: pseudo-random value for simulation, not a secret
  const logHandle = await fs.open(log, 'a');
  try {
    startup.check();
    // The /_setup/ page this child mounts names the command and catalogue site that started it (lense/setup/server.mjs).
    const setupRuntime = JSON.stringify({
      command: startup.command,
      ...(cfg.configFile ? { site: cfg.catalogueSite ?? cfg.siteName } : {}),
    });
    child = startup.spawnRuntime(process.execPath, [cli, ...values], {
      cwd: cfg.configDir ?? process.cwd(),
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      windowsHide: true,
      env: { ...process.env, MIRAGE_SETUP_RUNTIME: setupRuntime },
    });
    startup.child(child);
  } catch (error) {
    await logHandle.close();
    throw new Error(`Could not start Mirage: ${error.message}. Startup log: ${log}`, { cause: error });
  }
  await logHandle.close();
  child.unref();
  const discovery = path.join(paths.discoveryRoot, `session-${child.pid}.json`);
  let registered = false;
  startup.cleanup(async () => {
    await fs.rm(discovery, { force: true }).catch(() => {});
    // No ownership entry was published if cancellation interrupted its lock
    // acquisition. Published records get a bounded best-effort cleanup; a
    // contended foreign lock must not hold the cancelled command open.
    if (registered)
      await updateOwnedSessions(paths, (sessions) => sessions.filter((item) => item.pid !== child.pid), {
        signal: AbortSignal.timeout(1000),
      }).catch(() => {});
  });
  args.startup?.phase('process ownership', cfg.siteName);
  const childIdentity = await startup.identityOf(child.pid, { signal: startup.signal });
  startup.check();
  if (!childIdentity) {
    const error = !startup.alive(child.pid)
      ? await exitedBeforeReady(log, paths.logRoot)
      : new Error(
          `Could not verify the starting Mirage process ownership; the child was stopped. See startup log: ${log}`,
        );
    error.writesFiles = [log];
    throw error;
  }
  const identities = await rivalIdentities(paths, { childPid: child.pid, identity, startup });
  // Recorded before readiness, so `mirage stop` can end a process that hangs while importing.
  await updateOwnedSessions(
    paths,
    (sessions) => [
      ...otherSessionsForStart(sessions, identity, child.pid, { alive: startup.alive, identities }),
      {
        pid: child.pid,
        processIdentity: childIdentity,
        sourceDir: identity.sourceDir,
        project: identity.project,
        portal: identity.portal,
        discovery,
        url: null,
        stateFile: identity.stateFile,
        identity,
        log,
        ready: false,
        startedAt: new Date().toISOString(),
      },
    ],
    { signal: startup.signal },
  );
  registered = true;
  startup.check();
  const abandon = async () => {
    startup.check();
    if (
      childIdentity &&
      startup.alive(child.pid) &&
      (await startup.identityOf(child.pid, { signal: startup.signal })) === childIdentity
    ) {
      try {
        startup.kill(child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
    await fs.rm(discovery, { force: true }).catch(() => {});
    await updateOwnedSessions(
      paths,
      (sessions) => sessions.filter((item) => !(item.pid === child.pid && item.processIdentity === childIdentity)),
      { signal: startup.signal },
    ).catch(() => {});
  };
  const capAt = started + STARTUP_ABSOLUTE_CAP;
  args.startup?.phase('import, state restore and presets', identity.runtime?.kind ?? 'power-pages');
  let progressCursor,
    lastProgress = startup.now(),
    discovered = false;
  try {
    while (startup.now() < Math.min(lastProgress + timeout, capAt) && !startup.cancelled()) {
      const progress = await readStartupPhases(log, progressCursor).catch(() => null);
      if (progress) {
        progressCursor = progress.cursor;
        if (progress.events.length) lastProgress = startup.now();
        for (const event of progress.events)
          args.startup?.phase(
            event.phase.replaceAll('-', ' '),
            `${cfg.siteName}; ${event.elapsedMs}ms runtime elapsed`,
          );
      }
      try {
        const record = JSON.parse(await fs.readFile(discovery, 'utf8'));
        if (!discovered) {
          discovered = true;
          lastProgress = startup.now();
        }
        const portal = Array.isArray(record.portals)
          ? (record.portals.find((item) => item.id === (identity.portal ?? '')) ?? record.portals[0])
          : null;
        const { portals: ignoredPortals, ...base } = record; // NOSONAR: binding is excluded from the rest object or is a placeholder
        const session = {
          ...base,
          ...portal,
          id: portal?.id,
          discovery,
          processAlive: true,
          ready: false,
          runtime: null,
        };
        session.runtime = await readRuntime(session.url, session.id ?? cfg.siteName, { signal: startup.signal });
        session.ready = Boolean(session.runtime);
        if (session.ready) {
          await updateOwnedSessions(
            paths,
            (sessions) => [
              ...sessions.filter((item) => item.pid !== session.pid),
              {
                pid: session.pid,
                processIdentity: childIdentity,
                sourceDir: session.sourceDir,
                project: identity.project,
                portal: session.id ?? identity.portal,
                discovery,
                url: session.url,
                appsUrl: session.appsUrl,
                stateFile: session.stateFile,
                identity,
                log,
                ready: true,
                startedAt: new Date(started).toISOString(),
              },
            ],
            { signal: startup.signal },
          );
          startup.check();
          return {
            ...session,
            owned: true,
            started: true,
            log,
            launch,
            writesFiles: [identity.stateFile, discovery, log, paths.ownershipFile].filter(
              (file) => file && fsSync.existsSync(file),
            ),
          };
        }
      } catch {
        startup.check(); /* server has not written its discovery file yet */
      }
      if (!startup.alive(child.pid)) {
        await abandon();
        throw await exitedBeforeReady(log, paths.logRoot);
      }
      await startup.sleep(150, { signal: startup.signal });
    }
    await abandon();
    startup.check();
    const portMessage = port === '0' ? '' : ' on port ' + port;
    if (startup.now() >= capAt)
      throw new Error(
        `Mirage did not become ready within the ${STARTUP_ABSOLUTE_CAP} ms start-up cap${portMessage}. See startup log: ${log}`,
      );
    throw new Error(
      `Mirage reported no start-up progress for ${startup.now() - lastProgress} ms${portMessage} (--startup-timeout ${timeout} ms). See startup log: ${log}`,
    );
  } catch (error) {
    error.writesFiles = [log, paths.ownershipFile].filter((file) => fsSync.existsSync(file));
    throw error;
  }
}

async function exitedBeforeReady(log, logRoot) {
  const output = await readLocalFile(log, { root: logRoot, encoding: 'utf8' }).catch(() => '');
  const details = output.trim() ? '\n' + output.trim().slice(-3000) : '';
  return new Error(`Mirage exited before it became ready. See startup log: ${log}${details}`);
}

/**
 * The status of a runtime this toolkit started with the same settings. While its process lives with the recorded
 * identity it is this launch's runtime, however late it answers: the probe is repeated within the start-up silence
 * bound, and a runtime still silent then refuses the start instead of a second runtime sharing its state file.
 * Null once the process has exited, so the caller launches a new one.
 */
async function ownedRuntime(session, owner, { started, timeout, startup }) {
  for (;;) {
    // The CLI reports a fractional elapsed time; a fetch deadline is whole milliseconds.
    const remaining = Math.ceil(started + timeout - startup.now());
    const runtime =
      remaining > 0
        ? await readRuntime(session.url, session.id ?? null, { signal: startup.signal, timeout: remaining })
        : null;
    startup.check();
    if (runtime) return runtime;
    if (
      !startup.alive(session.pid) ||
      (await startup.identityOf(session.pid, { signal: startup.signal })) !== owner.processIdentity
    )
      return null;
    startup.check();
    if (startup.now() >= started + timeout) {
      const stop = mirageStopCommand(
        ['--runtime', owner.identity?.runtime?.kind ?? 'power-pages', '--state', owner.identity?.stateFile],
        { cli: TOOLKIT_CLI },
      );
      throw new Error(
        `Mirage pid ${session.pid} runs with these settings but its status at ${session.url} did not answer within ${timeout} ms (--startup-timeout); wait for it or stop it with ${stop}.`,
      );
    }
    await startup.sleep(150, { signal: startup.signal });
  }
}

function validateProjectLaunchArguments(projectInfo, args) {
  if (args['solution-root']?.length) throw new Error('--solution-root is supplied by the project configuration.');
  if (args.portal && !projectInfo.portals.some((item) => item.id === args.portal))
    throw new Error(`Unknown Mirage portal "${args.portal}" in ${projectInfo.configFile}`);
}

function isReusableRuntimeCandidate(session, owned, identity) {
  if (!session.processAlive) return false;
  if (identity.sourceDir ? !samePath(session.sourceDir, identity.sourceDir) : Boolean(session.sourceDir)) return false;
  return owned.some(
    (item) =>
      item.pid === session.pid && item.discovery === session.discovery && identityMatches(item.identity, identity),
  );
}

function sharesStateFile(entry, stateFile) {
  return samePath(entry.stateFile ?? entry.identity?.stateFile, stateFile);
}

function stateFileConflict(entry, identity) {
  const stop = mirageStopCommand(
    ['--runtime', entry.identity?.runtime?.kind ?? identity.runtime.kind, '--state', identity.stateFile],
    { cli: TOOLKIT_CLI },
  );
  return new Error(
    `Mirage pid ${entry.pid} already uses state file ${identity.stateFile} with different settings; stop it with ${stop} or pass --state <other file>.`,
  );
}

/** A live runtime with a verified start identity owns this state file with other settings: its saves would be overwritten. */
async function refuseStateFileOwner(owned, identity, { signal, identityOf, alive = isAlive }) {
  for (const entry of owned) {
    if (!entry.processIdentity || !alive(entry.pid) || !sharesStateFile(entry, identity.stateFile)) continue;
    if (identityMatches(entry.identity, identity)) continue;
    if ((await identityOf(entry.pid, { signal })) === entry.processIdentity) throw stateFileConflict(entry, identity);
  }
}

/**
 * Identities of the live records on this state file, read before the ownership lock: one read (PowerShell on
 * Windows) takes far longer than a read-modify-write, and other commands would wait on the lock meanwhile.
 */
async function rivalIdentities(paths, { childPid, identity, startup }) {
  const identities = new Map();
  for (const item of await ownedSessions(paths)) {
    if (item.pid === childPid || !item.processIdentity || !startup.alive(item.pid)) continue;
    if (sharesStateFile(item, identity.stateFile))
      identities.set(item.pid, {
        recorded: item.processIdentity,
        current: await startup.identityOf(item.pid, { signal: startup.signal }),
      });
  }
  return identities;
}

/**
 * Runs under the ownership lock, where a concurrent start's record is visible: a live rival on this state file
 * refuses the start, whose child the caller then stops. A record whose PID no longer carries its start identity
 * belongs to an exited runtime, so it is dropped instead. A record whose identity cannot be read is kept.
 * The identities come from `identities`, read before the lock, so this stays synchronous.
 */
function otherSessionsForStart(sessions, identity, startedPid, { alive = isAlive, identities = new Map() } = {}) {
  const kept = [];
  for (const item of sessions) {
    if (item.pid === startedPid) continue;
    const state = rivalState(item, identity, { alive, identities });
    if (state === 'rival') throw stateFileConflict(item, identity);
    if (state !== 'stale') kept.push(item);
  }
  return kept;
}

/**
 * 'rival': a live runtime still has this record's start identity. 'stale': its PID now belongs to another process.
 * 'other': not a live record on this state file, or its current identity is unread. A record that was not read
 * before the lock, or that replaced the record read for its PID, was written by a start still running, so its
 * recorded identity stands as the current one.
 */
function rivalState(item, identity, { alive, identities }) {
  if (!item.processIdentity || !alive(item.pid) || !sharesStateFile(item, identity.stateFile)) return 'other';
  const read = identities.get(item.pid);
  const current = read?.recorded === item.processIdentity ? read.current : item.processIdentity;
  if (current == null) return 'other';
  return current === item.processIdentity ? 'rival' : 'stale';
}

// Startup logs of the newest 20 unreferenced starts are kept; a log named by an owned record is always kept.
const STARTUP_LOG_RETENTION = 20;
const STARTUP_LOG_NAME = /^startup-(\d+)-[0-9a-f]+\.log$/;

export async function pruneStartupLogs(paths, owned) {
  let names;
  try {
    names = await fs.readdir(paths.logRoot);
  } catch {
    return;
  }
  const referenced = new Set(owned.filter((entry) => entry.log).map((entry) => path.resolve(entry.log)));
  const unreferenced = names
    .filter((name) => STARTUP_LOG_NAME.test(name) && !referenced.has(path.resolve(paths.logRoot, name)))
    .map((name) => ({ file: path.resolve(paths.logRoot, name), started: Number(STARTUP_LOG_NAME.exec(name)[1]) }))
    .toSorted((a, b) => b.started - a.started);
  for (const { file } of unreferenced.slice(STARTUP_LOG_RETENTION)) await removeStartupLog(file);
}

/** Only a start-up log directly in the log folder, so a damaged ownership record cannot name another file. */
function isStartupLogIn(paths, file) {
  return path.dirname(path.resolve(file)) === path.resolve(paths.logRoot) && STARTUP_LOG_NAME.test(path.basename(file));
}

/** A log still open by a stopping runtime is removed by a later prune. */
async function removeStartupLog(file) {
  await fs.rm(file, { force: true }).catch(() => {
    /* still open by a process that is stopping; a later prune removes it */
  });
}

// ---- init
const yamlPath = (from, target) => {
  const relative = path.relative(from, target);
  // Another drive, the folder itself or a distant folder keeps the absolute path.
  const distant = relative.split(/[\\/]/).filter((part) => part === '..').length > 4;
  return (!relative || path.isAbsolute(relative) || distant ? target : relative).replaceAll('\\', '/');
};
const httpsOrigin = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
};
const projectId = (value, used) => {
  let id =
    String(value)
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^[^a-z0-9]+/i, '') || 'solution';
  const base = id;
  for (let n = 2; used.has(id.toLowerCase()); n++) id = `${base}-${n}`; // NOSONAR: loop variable is advanced in the body on purpose
  used.add(id.toLowerCase());
  return id;
};

async function matchingPacks(cfg, dataPacks) {
  let registry;
  try {
    registry = await import('../../mirage/lib/preset-registry.mjs');
  } catch (error) {
    return {
      checked: false,
      reason:
        error.code === 'ERR_MODULE_NOT_FOUND'
          ? 'The Mirage preset registry is not available.'
          : error.message.split('\n')[0],
    };
  }
  if (typeof registry.discoverPacks !== 'function')
    return { checked: false, reason: 'The Mirage preset registry has no discoverPacks().' };
  try {
    const { importPortal } = await import('../../mirage/lib/importer.mjs');
    const portal = await importPortal(cfg.sourceDir);
    const packs = await registry.discoverPacks({
      portal,
      explicit: dataPacks.map(({ id, module }) => (id ? { id, module } : { module })),
    });
    return {
      checked: true,
      matching: packs.map((pack) => ({ id: pack.id, name: pack.name, description: pack.description })),
    };
  } catch (error) {
    return { checked: false, reason: error.message.split('\n')[0] };
  }
}

/** Writes a Mirage project file for the selected catalogue site and validates it by loading it. */
/* NOSONAR */ export async function initProject(cfg, args = {}) {
  const configured = cfg.mirageConfig ?? { solutionRoots: [], dataPacks: [] };
  // A standalone site is configured completely by its catalogue mapping; a project file only describes portals.
  if (cfg.runtime?.kind && cfg.runtime.kind !== 'power-pages' && !cfg.sourceDir)
    return {
      action: 'init',
      site: cfg.siteName,
      writesFiles: [],
      skipped: catalogueOwnedState(cfg)
        ? `Site "${cfg.siteName}" is a ${cfg.runtime.kind} Mirage site; its catalogue settings configure it and no project file is written.`
        : `This ${cfg.runtime.kind} Mirage runtime uses the selected command-line or project settings; no portal project file is written.`,
      next: mirageCommandHint(
        [['mirage', 'dev', ...hintScope(cfg, args), ...standaloneNextArguments(cfg, args)]],
        hintOptions(cfg),
      ),
    };
  const file = path.resolve(
    args.out ??
      configured.project ??
      path.join(path.dirname(miragePaths(cfg, args).discoveryRoot), 'mirage', `${cfg.siteName}.project.yml`),
  );
  validateInitFile(file, args);
  if (!PROJECT_ID.test(cfg.siteName)) throw new Error(`Site "${cfg.siteName}" cannot be used as a Mirage portal ID`);
  const listed = configured.solutionRoots?.length
    ? configured.solutionRoots
    : await (await import('../../mirage/lib/solution-roots.mjs')).discoverSolutionRoots(cfg.sourceDir);
  const missing = listed.filter((root) => !isDirectory(root));
  validateInitSolutionRoots(missing);
  // The project records the order its solutions are layered in: the dependency order (written
  // in that order), or the catalogue's listed order when the site sets solutionOrder: explicit.
  const solutionOrder = solutionOrderOf(cfg);
  const derived = await derivedSolutionOrder(listed, {
    cacheFile: path.join(miragePaths(cfg, args).discoveryRoot, 'cache/solution-discovery.json'),
  });
  const roots = solutionOrder === 'explicit' ? listed : derived;
  const missingPacks = (configured.dataPacks ?? []).filter((pack) => !isFile(pack.module));
  validateInitDataPacks(missingPacks);
  const base = path.dirname(file);
  const notes = [];
  if (solutionOrder === 'explicit' && !sameOrder(listed, derived))
    notes.push(
      `solutionOrder: explicit keeps the listed order ${rootNames(listed)}; the dependency order is ${rootNames(derived)}.`,
    );
  const origin = httpsOrigin(cfg.origin);
  if (!origin) notes.push(`${cfg.origin} is not an HTTPS origin, so the portal has no reference origin.`);
  const references = initReferences(cfg, notes);
  // Platform behaviour observed on the site's environment (mirage.observed), validated as the
  // Mirage validates a project portal's observed block and recorded on the portal entry.
  const observed = configured.observed
    ? (await import('../../mirage/lib/project-config.mjs')).observedConfig(
        configured.observed,
        `sites.${cfg.siteName}.mirage.observed`,
      )
    : null;
  const usedIds = new Set();
  const document = makeInitDocument({
    cfg,
    configured,
    base,
    origin,
    observed,
    roots,
    solutionOrder,
    references,
    usedIds,
  });
  const header = [
    `# Mirage project for the "${cfg.siteName}" portal, written by paqvilo mirage init (${cfg.siteName} @ ${cfg.envName}).`,
    '# Paths are relative to this file; the first reference is the selected environment. solutionOrder derived layers the',
    '# solutions in their dependency order (written in that order); explicit keeps the listed order.',
    '# Source import reads local files only; recording a reference origin does not connect to it.',
    '# Set preset: <id> to apply a data preset at each start; --preset overrides it.',
  ].join('\n');
  await fs.mkdir(base, { recursive: true });
  const write = async () => {
    const text = /\.json$/i.test(file)
      ? `${JSON.stringify(document, null, 2)}\n`
      : `${header}\n${YAML.stringify(document)}`;
    const temporary = `${file}.${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(temporary, text);
    await fs.rename(temporary, file);
  };
  await write();
  let loaded;
  try {
    loaded = await loadProject(file);
  } catch (error) {
    let loadFailure = error;
    // A newer loader names the version it requires; the fields written here are shared by all versions.
    const required = /version/i.test(error.message)
      ? Math.max(...(error.message.match(/\d+/g) ?? []).map(Number))
      : Number.NaN;
    if (Number.isInteger(required) && required > document.version) {
      document.version = required;
      await write();
      try {
        loaded = await loadProject(file);
      } catch (error_) {
        loadFailure = error_;
      }
    }
    if (!loaded) {
      await fs.rm(file, { force: true });
      throw new Error(`The generated project file did not load and was removed: ${loadFailure.message}`, {
        cause: error,
      });
    }
  }
  const packs = await matchingPacks(cfg, configured.dataPacks ?? []);
  const catalogued = Boolean(configured.project && samePath(configured.project, file));
  return {
    action: 'init',
    file,
    writesFiles: [file],
    site: cfg.siteName,
    env: cfg.envName,
    version: loaded.version,
    portal: {
      id: cfg.siteName,
      sourceDir: loaded.portals[0].sourceDir,
      origin: loaded.portals[0].origin ?? null,
      observed: loaded.portals[0].observed ?? null,
    },
    solutions: loaded.solutions.map((solution) => ({ id: solution.id, root: solution.root })),
    solutionOrder,
    references: loaded.references,
    dataPacks: document.dataPacks ?? [],
    packs,
    notes,
    catalogued,
    next: mirageCommandHint([['mirage', 'dev', ...hintScope(cfg, args), '--project', file]], hintOptions(cfg)),
  };
}

function validateInitFile(file, args) {
  if (!/\.(?:ya?ml|json)$/i.test(file)) throw new Error('The Mirage project file must end in .yml, .yaml or .json');
  if (isDirectory(file)) throw new Error(`${file} is a folder; name a project file`);
  if (fsSync.existsSync(file) && !args.force) throw new Error(`${file} already exists; pass --force to replace it`);
}

function validateInitSolutionRoots(missing) {
  if (missing.length)
    throw new Error(
      `Configured Solution root${missing.length > 1 ? 's do' : ' does'} not exist: ${missing.join(', ')}`,
    );
}

function validateInitDataPacks(missingPacks) {
  if (missingPacks.length)
    throw new Error(
      `Configured data pack module${missingPacks.length > 1 ? 's do' : ' does'} not exist: ${missingPacks.map((pack) => pack.module).join(', ')}`,
    );
}

function initReferences(cfg, notes) {
  const environments = Object.entries(cfg.site?.environments ?? {});
  const ordered = [
    ...environments.filter(([name]) => name === cfg.envName),
    ...environments.filter(([name]) => name !== cfg.envName),
  ];
  if (cfg.envName === 'custom' && !environments.some(([name]) => name === 'custom'))
    ordered.unshift(['custom', { url: cfg.origin }]);
  const references = [];
  const seenOrigins = new Set();
  for (const [name, environment] of ordered) {
    const reference = httpsOrigin(environment.url);
    if (!reference) {
      notes.push(`Environment ${name} (${environment.url}) is not an HTTPS origin and is not listed as a reference.`);
      continue;
    }
    if (!PROJECT_ID.test(name) || seenOrigins.has(reference)) continue;
    seenOrigins.add(reference);
    references.push({ id: name, origin: reference, ...(environment.caution ? { name: `${name} (real data)` } : {}) });
  }
  return references;
}

function makeInitDocument({ cfg, configured, base, origin, observed, roots, solutionOrder, references, usedIds }) {
  return {
    version: 1,
    defaultPortal: cfg.siteName,
    // dataModel: the catalogue site's data model for a source that does not record it (.powerpages-site).
    portals: [
      {
        id: cfg.siteName,
        path: yamlPath(base, cfg.sourceDir),
        ...(origin ? { origin } : {}),
        ...(observed ? { observed } : {}),
        ...(configured.dataModel ? { dataModel: configured.dataModel } : {}),
      },
    ],
    ...Object.fromEntries(
      ['confinePortalPages', 'externalAssets', 'externalFrameOrigins']
        .filter((key) => configured[key] !== undefined)
        .map((key) => [key, configured[key]]),
    ),
    ...(configured.platform ? { platform: configured.platform } : {}),
    solutions: roots.map((root) => ({ id: projectId(path.basename(root), usedIds), path: yamlPath(base, root) })),
    solutionOrder,
    references,
    ...deploymentProfilesDocument(configured.deploymentProfiles, base),
    ...dataPacksDocument(configured.dataPacks, base),
  };
}

function deploymentProfilesDocument(deploymentProfiles, base) {
  if (!deploymentProfiles) return {};
  return {
    deploymentProfiles: {
      ...deploymentProfiles,
      profiles: Object.fromEntries(
        Object.entries(deploymentProfiles.profiles).map(([id, sources]) => [
          id,
          Object.fromEntries(
            Object.entries(sources).map(([section, source]) => [
              section,
              Array.isArray(source) ? source.map((file) => yamlPath(base, file)) : yamlPath(base, source),
            ]),
          ),
        ]),
      ),
    },
  };
}

function dataPacksDocument(dataPacks, base) {
  return dataPacks?.length
    ? {
        dataPacks: dataPacks.map(({ id, module }) => ({ ...(id ? { id } : {}), module: yamlPath(base, module) })),
      }
    : {};
}

// ---- readiness
/** Offline check whether a loopback port can be bound now (it may be taken a moment later). */
export function portAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Mirage readiness for one resolved site, without starting it: dependencies, catalogued project,
 * Solution roots, data pack modules, a writable state folder and the configured port.
 */
/* NOSONAR: single-pass routine, splitting it would change shared state */ export async function mirageReadiness(
  cfg,
  { dependencies, stateRoot = miragePaths(cfg).discoveryRoot, checkPort = portAvailable } = {},
) {
  const configured = cfg.mirageConfig ?? { project: null, solutionRoots: [], dataPacks: [], port: null, preset: null };
  const errors = [],
    warnings = [];
  const readiness =
    dependencies ?? (await import('../../scripts/ensure-dependencies.mjs')).dependencyReadiness(TOOL_ROOT);
  const mirageDependencies = readiness.projects?.find((item) => item.name === 'mirage');
  const dependencyReport = mirageDependencies
    ? { ready: Boolean(mirageDependencies.ready), reason: mirageDependencies.reason }
    : { ready: false, reason: 'mirage/package.json is missing from this toolkit' };
  if (!dependencyReport.ready) errors.push(`Mirage dependencies: ${dependencyReport.reason}`);
  const project = {
    configured: Boolean(configured.project),
    file: configured.project ?? null,
    ready: !configured.project,
  };
  let loaded = null;
  if (configured.project) {
    if (!isFile(configured.project)) {
      project.ready = false;
      project.error = 'The project file does not exist.';
      errors.push(
        `Mirage project ${configured.project} does not exist; run ${mirageCommandHint([['mirage', 'init', ...configurationHintScope(cfg)]], { cli: TOOLKIT_CLI })}`,
      );
    } else {
      try {
        loaded = await loadProject(configured.project);
        Object.assign(project, {
          ready: true,
          version: loaded.version,
          defaultPortal: loaded.defaultPortal,
          portals: loaded.portals.map((item) => item.id),
          references: loaded.references.map((item) => item.id),
        });
      } catch {
        project.ready = false;
        project.error =
          'The project configuration could not be read or validated. Inspect its syntax, schema version and declared source paths.';
        errors.push(`Mirage project ${configured.project}: ${project.error}`);
      }
    }
  }
  let selectedRoots = readinessRoots(loaded, configured);
  if (!selectedRoots) {
    try {
      selectedRoots = {
        source: 'discovered',
        roots: await (await import('../../mirage/lib/solution-roots.mjs')).discoverSolutionRoots(cfg.sourceDir),
      };
    } catch (error) {
      warnings.push(`Solution discovery failed: ${error.message.split('\n')[0]}`);
      selectedRoots = { source: 'discovered', roots: [] };
    }
  }
  const { source, roots } = selectedRoots;
  // The order the runtime layers the roots in: the dependency order unless explicitly overridden
  // (a project's solutionOrder, else the site's mirage.solutionOrder).
  const order = readinessSolutionOrder(loaded, source, cfg);
  let effective = roots,
    derivedOrder = null;
  if (roots.length > 1 && source !== 'discovered' && roots.every((root) => isDirectory(root))) {
    const diagnostics = [];
    try {
      derivedOrder = await derivedSolutionOrder(roots, {
        diagnostics,
        cacheFile: path.join(stateRoot, 'cache/solution-discovery.json'),
      });
      if (order === 'derived') effective = derivedOrder;
      else if (!sameOrder(roots, derivedOrder)) {
        const owner = loaded ? 'Mirage project ' + configured.project : 'sites.' + cfg.siteName + '.mirage';
        let remedy = '';
        if (loaded)
          remedy =
            ' Set solutionOrder: derived or rerun ' +
            mirageCommandHint([['mirage', 'init', ...configurationHintScope(cfg), '--force']], { cli: TOOLKIT_CLI }) +
            '.';
        warnings.push(
          `${owner} layers its Solution roots in the listed order ${rootNames(roots)} (solutionOrder: explicit), which differs from their dependency order ${rootNames(derivedOrder)}; forms, views and tables can then resolve to other Solution files than discovery, bootstrap and the data scaffold use.${remedy}`,
        );
      }
      for (const item of diagnostics) warnings.push(`Solution order: ${item.message}`);
    } catch (error) {
      warnings.push(`The Solution dependency order could not be derived: ${error.message.split('\n')[0]}`);
    }
  }
  const solutionRoots = readinessSolutionRootSummary(source, order, effective, derivedOrder, errors);
  if (!roots.length && source !== 'project')
    warnings.push(
      'No Solution roots are configured or discovered; forms, views and table metadata come from the portal export only.',
    );
  // Platform behaviour observed on the environment: with a project file its portal entry applies
  // (as in the Mirage), else the catalogue site's mirage.observed.
  let observed = null,
    observedSource = null;
  const projectPortal = loaded
    ? (loaded.portals.find((item) => item.id === loaded.defaultPortal) ?? loaded.portals[0])
    : null;
  if (configured.observed) {
    try {
      const { observedConfig } = await import('../../mirage/lib/project-config.mjs');
      const catalogued = observedConfig(configured.observed, `sites.${cfg.siteName}.mirage.observed`);
      if (!configured.project) [observed, observedSource] = [catalogued, catalogued ? 'catalogue' : null];
      else if (loaded && JSON.stringify(catalogued) !== JSON.stringify(projectPortal?.observed ?? null))
        warnings.push(
          `sites.${cfg.siteName}.mirage.observed differs from portal ${projectPortal?.id} in ${configured.project}, whose observed behaviour applies; run ${mirageCommandHint([['mirage', 'init', ...configurationHintScope(cfg), '--force']], { cli: TOOLKIT_CLI })} to rewrite the project file`,
        );
    } catch (error) {
      errors.push(`Mirage observed behaviour: ${error.message.split('\n')[0]}`);
    }
  }
  if (projectPortal?.observed) [observed, observedSource] = [projectPortal.observed, 'project'];
  const dataPacks = (configured.dataPacks ?? []).map((pack) => ({ ...pack, exists: isFile(pack.module) }));
  for (const pack of dataPacks.filter((item) => !item.exists))
    errors.push(`Mirage data pack module does not exist: ${pack.module}`);
  const stateDir = { path: stateRoot, writable: false };
  try {
    await fs.mkdir(stateRoot, { recursive: true });
    const probe = path.join(stateRoot, `.doctor-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(probe, '');
    await fs.rm(probe, { force: true });
    stateDir.writable = true;
  } catch (error) {
    stateDir.error = error.message.split('\n')[0];
    errors.push(`Mirage state folder ${stateRoot} is not writable: ${stateDir.error}`);
  }
  const portNumber = Number.isInteger(configured.port) ? configured.port : DEFAULT_PORT;
  const port = { port: portNumber, available: portNumber === 0 ? true : await checkPort(portNumber) };
  if (!port.available)
    warnings.push(
      `Port ${portNumber} is in use. mirage dev/start reuse a matching toolkit-owned Mirage there; otherwise pass --port 0 (any free port) or another port.`,
    );
  let platformStyles = { mode: 'placeholder' };
  try {
    const { platformStylesStatus } = await import('../../mirage/lib/platform-styles.mjs');
    const file =
      projectPortal && loaded
        ? (await import('../../mirage/lib/project-config.mjs')).projectStateFile(
            loaded,
            projectPortal.id,
            path.join(miragePaths(cfg).discoveryRoot, 'projects'),
          )
        : path.join(miragePaths(cfg).discoveryRoot, cfg.siteName, 'state.json');
    const { readStateFile } = await import('../../mirage/lib/state-storage.mjs');
    platformStyles = platformStylesStatus(
      (await readStateFile(file, { sections: ['simulator'] })).simulator?.shellProfile,
    );
  } catch {
    /* Missing state uses the structural fallback. */
  }
  const { deploymentProfilesStatus, resolveDeploymentProfiles } =
    await import('../../mirage/lib/deployment-profiles.mjs');
  const deploymentProfiles = await deploymentProfilesStatus(
    configured.deploymentProfiles ?? projectPortal?.deploymentProfiles ?? resolveDeploymentProfiles(),
  );
  for (const profile of deploymentProfiles.profiles)
    if (!profile.valid) {
      const message = `Deployment profile '${profile.id}': ${profile.error.message}`;
      (profile.id === deploymentProfiles.default ? errors : warnings).push(message);
    }
  return {
    ready: errors.length === 0,
    catalogue: configured,
    dependencies: dependencyReport,
    project,
    solutionRoots,
    observed,
    observedSource,
    dataPacks,
    stateDir,
    port,
    platformStyles,
    deploymentProfiles,
    platform: configured.platform ?? projectPortal?.platform ?? null,
    localOverrides: configured.localOverrides,
    errors,
    warnings,
  };
}

function readinessRoots(loaded, configured) {
  if (loaded) return { source: 'project', roots: loaded.solutionRoots ?? [] };
  if (configured.project) return { source: 'project', roots: [] };
  if (configured.solutionRoots?.length) return { source: 'catalogue', roots: configured.solutionRoots };
  return null;
}

function readinessSolutionOrder(loaded, source, cfg) {
  if (loaded) return loaded.solutionOrder === 'derived' ? 'derived' : 'explicit';
  if (source === 'discovered') return 'derived';
  return solutionOrderOf(cfg);
}

function readinessSolutionRootSummary(source, order, effective, derivedOrder, errors) {
  const solutionRoots = {
    source,
    order,
    roots: effective.map((root) => ({ path: root, exists: isDirectory(root) })),
    ...(derivedOrder ? { derivedOrder } : {}),
  };
  for (const root of solutionRoots.roots.filter((item) => !item.exists))
    errors.push(`Mirage Solution root does not exist: ${root.path}`);
  return solutionRoots;
}

// ---- several portals
// One Mirage per catalogue site (each with its own project or source, state, port, references
// and session cookie); `dev` switches between them, and the live targets, in one browser.
const PER_PORTAL_OPTIONS = [
  'project',
  'portal',
  'port',
  'state',
  'preset',
  'preset-mode',
  'solution-root',
  'source',
  'url',
  'out',
];
/** With several portals, dev and start apply these options to the selected site's runtime only. */
const SELECTED_SITE_OPTIONS = ['port', 'state', 'preset', 'preset-mode', 'solution-root'];
const given = (args, option) => args[option] !== undefined && !(Array.isArray(args[option]) && !args[option].length);
const pick = (args, options) =>
  Object.fromEntries(options.filter((option) => given(args, option)).map((option) => [option, args[option]]));

/**
 * True when the command manages every catalogue site: `--portals all`, or the catalogue's
 * `portals: all` for dev and start (where --site picks the first portal); init and stop with an
 * explicit --site stay with that site.
 */
export function severalPortals(cfg, args, action) {
  if (!['init', 'start', 'dev', 'stop'].includes(action)) return false;
  if (args.portals !== undefined) return args.portals === 'all';
  if (cfg.portals !== 'all') return false;
  return ['start', 'dev'].includes(action) || args.site === undefined;
}

/** Catalogue sites with their resolved portal source folders (for labelling sessions). */
function catalogueSiteFolders(args) {
  try {
    const catalogue = loadCatalogue(args);
    return Object.entries(catalogue.sites)
      .map(([site, entry]) => ({ site, sourceDir: entry.sourceDir }))
      .filter((item) => item.sourceDir);
  } catch {
    return [];
  }
}

/**
 * Every catalogue site's configuration; a site that cannot be resolved is reported, not fatal.
 * dev and start apply --port, --state, --preset and --solution-root to the selected site
 * (--site, else the default site); other per-runtime options name a single runtime.
 */
async function portalConfigs(cfg, args, action) {
  const selectedOnly = ['start', 'dev'].includes(action) ? SELECTED_SITE_OPTIONS : [];
  const conflicts = PER_PORTAL_OPTIONS.filter((option) => given(args, option) && !selectedOnly.includes(option));
  if (conflicts.length) {
    const conflictNames = conflicts.map((option) => '--' + option).join(', ');
    let selectedHint = '';
    if (selectedOnly.length)
      selectedHint = ' (' + selectedOnly.map((option) => '--' + option).join(', ') + ' apply to the selected site.)';
    throw new Error(
      `--portals all manages one Mirage per catalogue site; ${conflictNames} applies to a single runtime.${selectedHint} Set it per site in the catalogue (sites.<id>.mirage) or use --portals selected.`,
    );
  }
  const catalogue = loadCatalogue(args);
  // The other sites resolve without the selected site's own options.
  const shared = Object.fromEntries(Object.entries(args).filter(([option]) => !PER_PORTAL_OPTIONS.includes(option)));
  const entries = [];
  for (const site of Object.keys(catalogue.sites)) {
    if (site === cfg.siteName) {
      entries.push({ site, cfg });
      continue;
    }
    try {
      // A Mirage-only site resolves as `mirage start --site <id>` resolves it (standalone runtime, no portal or environment).
      entries.push({
        site,
        cfg: mirageOnlySite(catalogue.sites[site])
          ? (await import('../standalone-mirage.mjs')).standaloneCatalogueConfiguration(catalogue, site, shared)
          : await loadConfig({ ...shared, site, env: undefined, portals: 'selected' }),
      });
    } catch (error) {
      entries.push({ site, error });
    }
  }
  return entries;
}

/** Sites configured on one port cannot all start (0 picks any free port). */
function portClashes(plans) {
  const sitesByPort = new Map();
  for (const plan of plans) {
    const port = String(runtimePort(plan.args.port, DEFAULT_PORT));
    if (port !== '0') sitesByPort.set(port, [...(sitesByPort.get(port) ?? []), plan.site]);
  }
  return [...sitesByPort]
    .filter(([, sites]) => sites.length > 1)
    .map(([port, sites]) => `port ${port}: ${sites.join(', ')}`);
}

/** Per-site start plans from the catalogue: each site's own project or source, port and preset. */
export function catalogueStartPlans(entries, args, selected = null) {
  // Every runtime reads its site's mirage settings from the catalogue this command resolved,
  // and live writes are allowed for all of them or none.
  const shared = pick(args, ['startup-timeout', 'config', 'repo', 'allow-live-writes', 'startup']);
  // --port, --state, --preset and --solution-root belong to the selected site's runtime.
  const own = pick(args, SELECTED_SITE_OPTIONS);
  return entries.map((entry) => {
    if (entry.error) return { site: entry.site, error: entry.error };
    try {
      return {
        site: entry.site,
        cfg: entry.cfg,
        args: catalogueArgs(entry.cfg, entry.site === selected ? { ...shared, ...own } : shared),
      };
    } catch (error) {
      return { site: entry.site, cfg: entry.cfg, error };
    }
  });
}

/**
 * Per-portal start plans for a project with several portals: `serve --project --portal` for each,
 * on consecutive ports from the selected one (0: any free port), each with its project state.
 */
function projectStartPlans(cfg, effective, portals) {
  if (effective.state !== undefined)
    throw new Error(
      '--state names one runtime; a project with several portals keeps a state file per portal. Pass --portal to start one of them with --state.',
    );
  const base = runtimePort(effective.port, DEFAULT_PORT);
  if (base && base + portals.length - 1 > 65535)
    throw new Error('The configured portal count exceeds the available port range.');
  return portals.map((portal, index) => ({
    site: portal.id,
    cfg: { ...cfg, catalogueSite: cfg.catalogueSite ?? cfg.siteName, siteName: portal.id, sourceDir: portal.sourceDir },
    args: { ...effective, portal: portal.id, port: String(base === 0 ? 0 : base + index) },
  }));
}

/** Starts (or reuses) every planned Mirage at once; a portal that fails does not stop the others. */
async function startPlans(plans, paths) {
  const clashes = portClashes(plans.filter((plan) => !plan.error));
  if (clashes.length)
    throw new Error(
      `Each Mirage needs its own port (${clashes.join('; ')}). Set sites.<id>.mirage.port to distinct ports, or 0 for any free port.`,
    );
  const results = await Promise.allSettled(
    plans.map((plan) => (plan.error ? Promise.reject(plan.error) : start(plan.cfg, plan.args, { paths }))),
  );
  return plans.map((plan, index) => ({
    ...plan,
    session: results[index].status === 'fulfilled' ? results[index].value : null,
    error: results[index].status === 'rejected' ? results[index].reason : null,
  }));
}

/** The dev target of one running Mirage: a local origin served in Mirage mode. */
export function mirageTarget(siteCfg, session) {
  const sourceDir = session.sourceDir ?? session.launch?.sourceDir ?? siteCfg.sourceDir;
  const stateFile = session.stateFile ?? session.launch?.stateFile ?? null;
  return {
    ...siteCfg,
    sourceDir,
    origin: session.url,
    envName: 'local',
    siteName: `${session.id ?? siteCfg.siteName} Mirage`,
    caution: false,
    mirage: true,
    mirageSite: siteCfg.siteName,
    mirageSourceRoots: [
      ...new Set([sourceDir, ...(session.launch?.solutionRoots ?? [])].filter(Boolean).map(realpath)),
    ],
    mirageSession: {
      url: session.url,
      adminUrl: session.adminUrl ?? adminUrlOf(session.url),
      appsUrl: session.appsUrl,
      stateFile,
      project: session.launch?.project ?? null,
      portal: session.launch?.portal ?? null,
      pid: session.pid,
      started: session.started,
    },
  };
}

/**
 * The dev selection for running Mirages: one local target per portal (cfg.siteName opens
 * first) plus the catalogue's live targets, all switchable without a restart.
 */
export async function portalSelection(cfg, args, running) {
  const targets = running.map((portal) => mirageTarget(portal.cfg, portal.session));
  let live = [],
    note = null;
  try {
    live = (await loadDevTargets({ ...args, project: undefined, portal: undefined, port: undefined, portals: 'all' }))
      .targets;
  } catch (error) {
    note = error.message.split('\n')[0];
  }
  const initial = targets.find((target) => target.mirageSite === cfg.siteName) ?? targets[0];
  return { selection: { mode: 'all', initial, targets: [...targets, ...live] }, live: live.length, note };
}

export async function stopStarted(portals, paths, stop = stopOwnedSessions, { source = process } = {}) {
  await guardShutdownSignals(
    async () => {
      for (const portal of portals.filter((item) => item.session?.started)) {
        const report = await stop({ paths, pids: [portal.session.pid] }).catch((error) => ({
          stopped: [],
          error,
        }));
        if (report.stopped?.length)
          console.log(`mirage   stopped ${portal.site} ${portal.session.url} (pid ${portal.session.pid})`);
        else {
          let retry;
          try {
            retry = `run: ${await sessionStopHint([portal], paths, { cleanupOnError: false })}`;
          } catch (error) {
            retry = `a retry command could not be prepared: ${error.message}`;
          }
          const errorMessage = report.error ? ': ' + report.error.message : '';
          console.error(`mirage   could not stop ${portal.site} pid ${portal.session.pid}${errorMessage}; ${retry}`);
          process.exitCode ||= 1;
        }
      }
    },
    undefined,
    { source },
  );
}

/** Starts the planned portals, then reports them (start) or opens them with the live targets (dev). */
async function runPortals({ cfg, args, action, plans, paths, initialSite }) {
  const portals = await startPlans(plans, paths);
  const running = portals.filter((portal) => portal.session);
  const stop = await sessionStopHint(running, paths);
  const summary = portals.map(portalStartSummary);
  if (action === 'start') {
    print({ action: 'start', portals: summary, stop }, args.json);
    if (running.length === portals.length)
      args.startup?.complete('runtime listeners available; browser application readiness was not requested');
    else args.startup?.fail('one or more runtime listeners failed; inspect per-site diagnostics');
    return running.length === portals.length ? 0 : 1;
  }
  printPortalStartSummaries(summary);
  // Mirage-only sites (standalone runtimes) run beside the portals; only portals enter the Lense portal selector.
  const portalSessions = running.filter(
    (portal) => !(portal.cfg?.runtime?.kind && portal.cfg.runtime.kind !== 'power-pages'),
  );
  printStandalonePortalSessions(running, portalSessions);
  try {
    if (!portalSessions.length)
      throw new Error(
        'No Mirage portal could start; see the messages above. A Mirage-only site opens its own browser with "npx paqvilo mirage dev --site <id>".',
      );
    const { selection, live, note } = await portalSelection({ ...cfg, siteName: initialSite }, args, portalSessions);
    if (note) console.log(`live        not offered: ${note}`);
    console.log(
      `switch      ${portalSessions.length} local Mirage portal(s) and ${live} live target(s) in the panel's portal selector`,
    );
    console.log('stop        Ctrl+C here or close the browser: the browser and the Mirages started here stop');
    const { default: runDev } = await import('./dev.mjs');
    return await withMirageDebugOutput(
      portalSessions.map((portal) => portal.session),
      () => runDev(selection.initial, { ...args, devSelection: selection }),
    );
  } finally {
    await stopStarted(portals, paths);
  }
}

function portalStartSummary(portal) {
  if (portal.session)
    return {
      site: portal.site,
      url: portal.session.url,
      adminUrl: portal.session.adminUrl ?? adminUrlOf(portal.session.url),
      appsUrl: portal.session.appsUrl,
      stateFile: portal.session.stateFile ?? portal.session.launch?.stateFile ?? null,
      sourceDir: portal.session.sourceDir,
      pid: portal.session.pid,
      started: portal.session.started,
      writesFiles: portal.session.writesFiles ?? [],
      liveWrites: portal.session.runtime?.liveWrites ?? null,
    };
  return {
    site: portal.site,
    error: portal.error?.message ?? String(portal.error),
    writesFiles: portal.error?.writesFiles ?? [],
  };
}

function printPortalStartSummaries(summary) {
  for (const item of summary) {
    if (item.error) console.log(`mirage   ${item.site.padEnd(8)} FAILED: ${item.error}`);
    else {
      const status = item.started ? 'started' : 'already running';
      console.log(
        `mirage   ${item.site.padEnd(8)} ${item.url}  (${status}, pid ${item.pid})  admin ${item.adminUrl}  live writes ${item.liveWrites ?? 'not reported'}`,
      );
    }
  }
}

export function printStandalonePortalSessions(running, portalSessions) {
  for (const item of running.filter((portal) => !portalSessions.includes(portal)))
    console.log(
      `app         ${item.site.padEnd(8)} ${appLinkOf(item.session, item.cfg.runtime.kind)} (${item.cfg.runtime.kind}; open it beside the portals)`,
    );
}

/* NOSONAR */ async function miragePortals(cfg, args, action, paths) {
  const entries = await portalConfigs(cfg, args, action);
  if (action === 'init') {
    const projects = [];
    for (const entry of entries) {
      if (entry.error) {
        projects.push({ site: entry.site, error: entry.error.message });
        continue;
      }
      try {
        projects.push({ site: entry.site, ...(await initProject(entry.cfg, { force: args.force })) });
      } catch (error) {
        projects.push({ site: entry.site, error: error.message });
      }
    }
    print(
      {
        action: 'init',
        projects,
        next: mirageCommandHint([['mirage', 'dev', ...hintScope(cfg, args, true)]], { cli: TOOLKIT_CLI }),
      },
      args.json,
    );
    return projects.some((project) => project.error) ? 1 : 0;
  }
  if (action === 'stop') {
    const pids = [];
    for (const { cfg: site } of entries) {
      if (!site) continue;
      const effective = catalogueArgs(site, {}, { requireProject: false });
      const project = effective.project ? await loadProject(effective.project) : null;
      pids.push(
        ...(await selectedSessionPids(
          paths,
          site,
          effective.runtime ?? project?.runtime.kind ?? site.runtime?.kind ?? 'power-pages',
          project,
          {},
          project ? null : site.sourceDir,
        )),
      );
    }
    const report = await stopOwnedSessions({ paths, pids });
    if (report.remaining.length)
      throw new Error(
        `Mirage process ${report.remaining.map((item) => item.pid).join(', ')} did not stop within ${(STOP_DEADLINE + 2000) / 1000} seconds`,
      );
    print(
      {
        action: 'stop',
        message: stopSummary(report, `${entries.length} catalogue portals`, 'the catalogue portals'),
        ...report,
      },
      args.json,
    );
    return 0;
  }
  return runPortals({
    cfg,
    args,
    action,
    plans: catalogueStartPlans(entries, args, cfg.siteName),
    paths,
    initialSite: cfg.siteName,
  });
}

/** A project with several portals and no --portal: one runtime per portal of that project. */
async function mirageProjectPortals(cfg, args, effective, action, project, paths) {
  if (action === 'stop') {
    const pids = [];
    const base = args.port === undefined ? undefined : runtimePort(args.port, DEFAULT_PORT);
    // A broad project stop includes recorded portals that were renamed or
    // removed since launch. A nonzero explicit base still selects the current
    // project's consecutive per-portal ports, matching projectStartPlans.
    if (base === undefined || base === 0)
      pids.push(...(await selectedSessionPids(paths, cfg, 'power-pages', project, args)));
    else
      for (const [index, portal] of project.portals.entries())
        pids.push(
          ...(await selectedSessionPids(paths, cfg, 'power-pages', project, {
            ...args,
            portal: portal.id,
            port: String(base + index),
          })),
        );
    const report = await stopOwnedSessions({ paths, pids });
    if (report.remaining.length)
      throw new Error(
        `Mirage process ${report.remaining.map((item) => item.pid).join(', ')} did not stop within ${(STOP_DEADLINE + 2000) / 1000} seconds`,
      );
    print(
      {
        action: 'stop',
        message: stopSummary(
          report,
          `the recorded portals of ${project.configFile}`,
          `the portals of ${project.configFile}`,
        ),
        ...report,
      },
      args.json,
    );
    return 0;
  }
  return runPortals({
    cfg,
    args,
    action,
    plans: projectStartPlans(cfg, effective, project.portals),
    paths,
    initialSite: project.defaultPortal,
  });
}

// Init recommendations select configuration and source inputs. Runtime stop
// ownership can live elsewhere, and must not remove the selected site here.
function configurationHintScope(cfg, args = {}) {
  const config = args.config ? path.resolve(args.config) : cfg.configFile;
  const repo = args.repo ? path.resolve(args.repo) : cfg.sourceRoot;
  const site = cfg.catalogueSite ?? cfg.siteName ?? args.site;
  return [
    ...(config ? ['--config', config] : []),
    ...(repo ? ['--repo', repo] : []),
    ...(site ? ['--site', site] : []),
  ];
}

function hintScope(cfg, args, all = false) {
  const parts = [];
  if (catalogueOwnedState(cfg)) {
    parts.push('--config', cfg.configFile);
    if (cfg.sourceRoot) parts.push('--repo', cfg.sourceRoot);
    parts.push('--site', cfg.catalogueSite ?? cfg.siteName, '--portals', all ? 'all' : 'selected');
  } else {
    if (cfg.catalogueScope)
      parts.push('--config', cfg.catalogueScope.configFile, '--site', cfg.catalogueScope.siteName);
    else if (args.config) parts.push('--config', path.resolve(args.config));
    else if (cfg.configFile) parts.push('--site', cfg.catalogueSite ?? cfg.siteName);
    if (args.repo) parts.push('--repo', path.resolve(args.repo));
  }
  return parts;
}

function hintOptions(cfg) {
  return { cli: TOOLKIT_CLI, ...(!catalogueOwnedState(cfg) ? { cwd: process.cwd() } : {}) };
}

function standaloneNextArguments(cfg, args) {
  const parts = ['--runtime', cfg.runtime.kind];
  if (args.project) parts.push('--project', path.resolve(args.project));
  if (args.state) parts.push('--state', path.resolve(args.state));
  for (const key of ['port', 'simulation', 'preset', 'preset-mode'])
    if (args[key] !== undefined) parts.push('--' + key, String(args[key]));
  for (const root of args['solution-root'] ?? []) parts.push('--solution-root', path.resolve(root));
  return parts;
}

function sessionStopArguments(cfg, args, session) {
  const launch = session.launch;
  const parts = hintScope(cfg, args);
  if (launch.project) {
    parts.push('--project', launch.project);
    if (launch.portal) parts.push('--portal', launch.portal);
  } else if (launch.sourceDir) parts.push('--source', launch.sourceDir);
  parts.push(
    '--runtime',
    launch.runtime.kind,
    '--state',
    session.stateFile ?? launch.stateFile,
    '--port',
    listenerPort(session.url),
  );
  return parts;
}

/* NOSONAR */ async function sessionStopHint(portals, paths, { cleanupOnError = true } = {}) {
  const commands = stopCommands(portals);
  if (!commands.length) return null;
  const options = stopHintOptions(portals, commands);
  const format = (storePayload) => formatStopHint(commands, options, storePayload);
  const externalPayload = new Error('Owned command payload storage is required.');
  const files = [];
  try {
    // Ordinary hints must not rewrite ownership records on a reused start.
    try {
      return format(() => {
        throw externalPayload;
      });
    } catch (error) {
      if (error !== externalPayload) throw error;
    }
    let hint;
    await updateOwnedSessions(paths, (entries) => {
      hint = format((bytes) => {
        const file = persistCommandPayload(path.join(path.dirname(paths.ownershipFile), 'commands'), bytes);
        files.push(file);
        return file;
      });
      return entries.map((entry) => attachHintFiles(entry, portals, files));
    });
    for (const { session } of portals)
      session.writesFiles = [...new Set([...(session.writesFiles ?? []), paths.ownershipFile, ...files])];
    return hint;
  } catch (error) {
    const started = cleanupOnError
      ? portals.filter((item) => item.session.started).map((item) => item.session.pid)
      : [];
    if (started.length) {
      let cleanup;
      try {
        cleanup = await stopOwnedSessions({ paths, pids: started });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'The stop hint could not be prepared and owned cleanup failed.',
          { cause: cleanupError },
        );
      }
      if (cleanup.remaining.length || cleanup.unverified.some((item) => started.includes(item.pid)))
        throw new AggregateError(
          [error],
          'The stop hint could not be prepared and owned runtimes remain active or unverified.',
          { cause: error },
        );
    }
    if (files.length) {
      try {
        await withOwnershipLock(paths, async () => {
          pruneCommandPayloads(
            path.join(path.dirname(paths.ownershipFile), 'commands'),
            files,
            (await ownedSessions(paths)).flatMap((entry) => entry.hintFiles ?? []),
          );
        });
      } catch (pruneError) {
        throw new AggregateError(
          [error, pruneError],
          'The stop hint could not be prepared and command payload cleanup failed.',
          { cause: pruneError },
        );
      }
    }
    throw error;
  }
}

function attachHintFiles(entry, portals, files) {
  return portals.some((portal) => portal.session.pid === entry.pid && portal.session.url === entry.url)
    ? { ...entry, hintFiles: [...new Set([...(entry.hintFiles ?? []), ...files])] }
    : entry;
}

function stopCommands(portals) {
  return portals.map(({ cfg, args, session }) => ['mirage', 'stop', ...sessionStopArguments(cfg, args, session)]);
}

function stopHintOptions(portals, commands) {
  // A runtime inferred from a standalone project can originally use the
  // catalogue's store. The explicit runtime in its stop argv selects the
  // standalone dispatcher, whose store is relative to cwd instead.
  const catalogueStandaloneProject = portals.find(
    ({ cfg, session }) =>
      catalogueOwnedState(cfg) && session.launch.project && session.launch.runtime.kind !== 'power-pages',
  );
  // A plain absolute project reconstructs its ownership directory on replay.
  // Config/site selectors can dispatch differently, so retain cwd for those.
  const projectAnchored = portals.every(
    ({ cfg, session }, index) =>
      session.launch.project &&
      samePath(cfg.stateDir, path.join(path.dirname(session.launch.project), '.paqvilo')) &&
      !commands[index].includes('--config') &&
      !commands[index].includes('--site'),
  );
  let cwd;
  if (catalogueStandaloneProject) cwd = path.dirname(catalogueStandaloneProject.cfg.stateDir);
  else if (!projectAnchored && portals.some(({ cfg }) => !catalogueOwnedState(cfg))) cwd = process.cwd();
  return { cli: TOOLKIT_CLI, ...(cwd ? { cwd } : {}) };
}

function formatStopHint(commands, options, storePayload) {
  return commands.length === 1
    ? mirageStopCommand(commands[0].slice(2), { ...options, storePayload })
    : mirageCommandHint(commands, { ...options, storePayload });
}

/** A diagnostic inspection can legitimately return a report with exit status 1. */
export function inspectProcessResult(result) {
  if (result.error) throw result.error;
  const failed = () => {
    const exit = result.signal ? 'was terminated by ' + result.signal : 'exited with ' + result.status;
    return new Error(String(result.stderr ?? '').trim() || `Mirage inspect ${exit}`);
  };
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw result.status !== 0 ? failed() : new Error('Mirage inspect returned invalid JSON');
  }
  const valid =
    report &&
    typeof report === 'object' &&
    !Array.isArray(report) &&
    ((['model-driven', 'dataverse-api'].includes(report.runtime?.kind) &&
      Array.isArray(report.solutions) &&
      Array.isArray(report.entities) &&
      Array.isArray(report.diagnostics)) ||
      (Array.isArray(report.pages) && Array.isArray(report.diagnostics) && typeof report.sourceDir === 'string') ||
      (Array.isArray(report.portals) &&
        typeof report.configFile === 'string' &&
        report.portals.every((portal) => portal && Array.isArray(portal.pages) && Array.isArray(portal.diagnostics))));
  if (!valid) throw result.status !== 0 ? failed() : new Error('Mirage inspect returned an invalid inspection report');
  if (result.status !== 0 && result.status !== 1) throw failed();
  const diagnostics = report.diagnostics ?? report.portals.flatMap((portal) => portal.diagnostics);
  const errors =
    result.status === 0
      ? []
      : diagnostics
          .filter((item) => typeof item?.code === 'string' && item.code.startsWith('invalid'))
          .map((item) => ({
            ...item,
            message: item.message ?? item.reason ?? `Source inspection reported ${item.code}`,
          }));
  if (result.status !== 0 && !errors.length) throw failed();
  return { report, exitCode: result.status, errors };
}

function print(value, json) {
  if (json) {
    printJson(value);
    return;
  }
  if (value.sessions) {
    printSessions(value.sessions);
    return;
  }
  if (value.action === 'init' && value.projects) {
    printInitProjects(value);
    return;
  }
  if (value.action === 'start' && value.portals) {
    printStartedPortals(value);
    return;
  }
  if (value.action === 'init' && value.skipped) {
    printSkippedInit(value);
    return;
  }
  if (value.action === 'init') {
    printInitReport(value);
    return;
  }
  if (value.action === 'stop') {
    printStoppedSessions(value);
    return;
  }
  if (value.url) {
    printStartedSession(value);
    return;
  }
  console.log(value.message ?? JSON.stringify(value, null, 2));
}

function printJson(value) {
  const entries = value.projects ?? value.portals ?? [];
  const errors = entries
    .filter((item) => item.error)
    .map((item) => ({ code: 'MIRAGE_PORTAL_FAILED', message: String(item.error), site: item.site }));
  const writesFiles = [...new Set(value.writesFiles ?? entries.flatMap((item) => item.writesFiles ?? []))];
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        command: 'mirage',
        ok: errors.length === 0,
        offline: ['init', 'inspect'].includes(value.action),
        errors,
        ...value,
        writesFiles,
        ...('started' in value || value.action === 'start' ? { runtimeWrites: value.started !== false } : {}),
      },
      null,
      2,
    ),
  );
}

function printSessions(sessions) {
  if (!sessions.length) console.log('No Mirage sessions found.');
  for (const session of sessions) printSession(session);
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ function printSession(session) {
  let state;
  if (session.ready) state = 'ready';
  else if (session.processAlive) state = 'starting';
  else state = 'stopped';
  const site = session.site ? '  [' + session.site + ']' : '';
  const runtime = session.runtime?.site
    ? '  (' + session.runtime.site + ', ' + session.runtime.pageCount + ' pages)'
    : '';
  console.log(
    `${state}${session.owned ? ' · toolkit managed' : ''}${site}  ${session.url ?? '(no URL yet)'}  ${session.sourceDir ?? ''}${runtime}`,
  );
  const details = [
    session.adminUrl && `admin ${session.adminUrl}`,
    session.identityProvider?.origin && `idp ${session.identityProvider.origin}`,
    session.runtime?.liveWrites && `live writes ${session.runtime.liveWrites}`,
    session.project && `project ${session.project}`,
    session.portal && `portal ${session.portal}`,
    session.stateFile && `state ${session.stateFile}`,
    `pid ${session.pid}`,
  ].filter(Boolean);
  console.log(`    ${details.join(' · ')}`);
  if (session.runtime?.startupPreset?.name)
    console.log(
      `    preset ${session.runtime.startupPreset.name}: ${session.runtime.startupPreset.applied ? 'applied at startup' : 'kept existing state'} (${session.runtime.startupPreset.mode})`,
    );
  if (session.runtime?.platformStyles) printPlatformStyles(session.runtime.platformStyles);
}

function printPlatformStyles(styles) {
  if (!styles) return;
  const description =
    styles.mode === 'captured'
      ? 'captured ' + styles.capturedAt + ' from ' + styles.origin
      : 'placeholder (local structural form rules)';
  console.log(`    platform stylesheets: ${description}`);
  if (styles.missingHeadStylesheets?.length)
    console.log(`    missing head stylesheets: ${styles.missingHeadStylesheets.join(', ')}`);
}

function printInitProjects(value) {
  for (const project of value.projects) {
    if (project.error) console.log(`${project.site}: NOT WRITTEN: ${project.error}`);
    else print({ ...project, action: 'init' }, false);
    console.log('');
  }
  console.log(`next: ${value.next}`);
}

function printStartedPortals(value) {
  for (const portal of value.portals) console.log(startedPortalSummary(portal));
  if (value.stop) console.log(`Stop:      ${value.stop}`);
}

function startedPortalSummary(portal) {
  if (portal.error) return `${portal.site.padEnd(8)} FAILED: ${portal.error}`;
  const status = portal.started ? 'started' : 'already running';
  return `${portal.site.padEnd(8)} ${portal.url}  (${status}, pid ${portal.pid})  admin ${portal.adminUrl}  state ${portal.stateFile}  live writes ${portal.liveWrites ?? 'not reported'}`;
}

function printSkippedInit(value) {
  console.log(`No Mirage project written: ${value.skipped}\nnext: ${value.next}`);
}

function printInitReport(value) {
  const portalOrigin = value.portal.origin ? '  (' + value.portal.origin + ')' : '';
  console.log(`Mirage project written: ${value.file}`);
  console.log(`  portal     ${value.portal.id}  ${value.portal.sourceDir}${portalOrigin}`);
  if (value.portal.observed) console.log(`  observed   ${observedText(value.portal.observed)}`);
  printInitSolutions(value);
  for (const reference of value.references) console.log(`  reference  ${reference.id}  ${reference.origin}`);
  for (const pack of value.dataPacks) {
    const id = pack.id ? pack.id + ' ' : '';
    console.log(`  data pack  ${id}${pack.module}`);
  }
  if (value.packs.checked)
    console.log(
      `  packs      ${value.packs.matching.length ? value.packs.matching.map((pack) => pack.id).join(', ') : 'no registered data pack matches this portal'}`,
    );
  for (const note of value.notes) console.log(`  note: ${note}`);
  console.log(`next: ${value.next}`);
}

function printInitSolutions(value) {
  for (const solution of value.solutions) console.log(`  solution   ${solution.id}  ${solution.root}`);
  if (value.solutions.length > 1)
    console.log(
      `  order      ${value.solutionOrder === 'explicit' ? 'explicit (listed order)' : 'derived (Solution dependency order)'}`,
    );
  if (!value.solutions.length) console.log('  solution   none configured or discovered');
}

function printStoppedSessions(value) {
  console.log(value.message);
  for (const item of value.stopped) {
    const target = item.url ?? 'pid ' + item.pid;
    console.log(`  stopped ${target}${item.graceful ? '' : ' (forced)'}${item.wasReady ? '' : ' while starting'}`);
  }
  for (const item of value.pruned) console.log(`  removed stale record: pid ${item.pid} (${item.reason})`);
  for (const item of value.unverified ?? [])
    console.log(`  not verified, kept: pid ${item.pid}${item.url ? ' ' + item.url : ''} (${item.reason})`);
}

function printStartedSession(value) {
  console.log(
    `Mirage: ${value.url}${value.started === false ? '  (already running)' : ''}\nAdmin:     ${value.adminUrl}\nState:     ${value.stateFile}\nSource:    ${value.sourceDir}\nLive writes: ${liveWritesText(value.runtime?.liveWrites)}`,
  );
  if (value.runtime?.startupPreset?.name)
    console.log(
      `Preset:    ${value.runtime.startupPreset.name} (${value.runtime.startupPreset.mode}; ${value.runtime.startupPreset.applied ? 'applied at startup' : 'kept existing state'})`,
    );
  if (value.launch?.project) {
    const portal = value.launch.portal ? ' (portal ' + value.launch.portal + ')' : '';
    console.log(`Project:   ${value.launch.project}${portal}`);
  }
  if (value.stop) console.log(`Stop:      ${value.stop}`);
}

export function validateMirageArguments(args, action = 'status') {
  validateMirageAction(action);
  if (['start', 'dev'].includes(action)) validateStartupArguments(args);
  if (action === 'dev' && args.json)
    throw new Error(
      'mirage dev is interactive; use mirage start --json and agent commands for structured session access',
    );
  if (action !== 'init' && (args.out !== undefined || args.force))
    throw new Error('--out and --force apply only to mirage init');
  if (args['allow-live-writes'] && !['start', 'dev'].includes(action))
    throw new Error('--allow-live-writes applies only to mirage dev and start');
  if (action === 'inspect')
    validateAllowedOptions(args, action, [
      'config',
      'repo',
      'site',
      'env',
      'source',
      'project',
      'portal',
      'solution-root',
      'runtime',
      'simulation',
      'json',
    ]);
  if (action === 'status') validateAllowedOptions(args, action, ['config', 'project', 'repo', 'json']);
}

function validateStartupArguments(args) {
  runtimePort(args.port, DEFAULT_PORT);
  if (args['startup-timeout'] === undefined) return;
  const timeout = Number(args['startup-timeout']);
  if (!/^\d+$/.test(args['startup-timeout']) || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000)
    throw new Error(
      '--startup-timeout must be an integer from 1000 to 600000 milliseconds: the longest start-up silence allowed',
    );
}

function validateAllowedOptions(args, action, allowedOptions) {
  const allowed = new Set(allowedOptions);
  for (const option of Object.keys(args))
    if (!allowed.has(option))
      throw Object.assign(new Error(`--${option} is not supported by mirage ${action}`), {
        code: 'unsupported_option',
      });
}

/* NOSONAR */ export default async function mirage(cfg, args, positionals = []) {
  const action = positionals[0] ?? 'status';
  validateMirageArguments(args, action);
  const paths = miragePaths(cfg, args);
  if (action === 'status') {
    const sessions = await mirageStatus(paths);
    const sites = catalogueSiteFolders(args);
    assignCatalogueSites(sessions, sites);
    print({ action: 'status', sessions }, args.json);
    return 0;
  }
  if (severalPortals(cfg, args, action)) return miragePortals(cfg, args, action, paths);
  if (action === 'init') {
    print(await initProject(cfg, args), args.json);
    return 0;
  }
  const effective = catalogueArgs(cfg, args, { requireProject: action !== 'stop' });
  if (['start', 'dev', 'stop'].includes(action) && effective.project && !effective.portal) {
    const project = await loadProject(effective.project);
    if (hasSeveralPowerPagesPortals(effective, project))
      return mirageProjectPortals(cfg, args, effective, action, project, paths);
  }
  if (action === 'stop') {
    let sourceDir = cfg.sourceDir;
    const selectedProject = effective.project ? await loadProject(effective.project) : null;
    const runtimeKind = effective.runtime ?? selectedProject?.runtime?.kind ?? cfg.runtime?.kind;
    if (runtimeKind && runtimeKind !== 'power-pages') {
      const kind = runtimeKind;
      const pids = await selectedSessionPids(paths, cfg, kind, selectedProject, args);
      const report = await stopOwnedSessions({ paths, pids });
      if (report.remaining.length) throw new Error('An owned standalone Mirage session did not stop.');
      print(
        {
          action: 'stop',
          message: stopSummary(report, selectedProject?.configFile ?? kind, selectedProject?.configFile ?? kind),
          ...report,
        },
        args.json,
      );
      return stopExitStatus(report, pids);
    }
    // Stop joins the recorded project/portal identity; current mappings can
    // legitimately point elsewhere or no longer contain the launched portal.
    if (selectedProject) sourceDir = null;
    const pids = await selectedSessionPids(paths, cfg, 'power-pages', selectedProject, args, sourceDir);
    const report = await stopOwnedSessions({ paths, pids });
    if (report.remaining.length)
      throw new Error(
        `Mirage process ${report.remaining.map((item) => item.pid).join(', ')} did not stop within ${(STOP_DEADLINE + 2000) / 1000} seconds`,
      );
    print({ action: 'stop', message: stopSummary(report, cfg.siteName, cfg.siteName), ...report }, args.json);
    return stopExitStatus(report, pids);
  }
  if (action === 'inspect') {
    let project = null;
    if (effective.project) {
      project = await loadProject(effective.project);
      validateSelectedProjectPortal(project, effective);
    }
    const { cli, values } = cliArgs(cfg, 'inspect', effective, project);
    const result = spawnSync(process.execPath, [cli, ...values, '--json'], {
      cwd: TOOL_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const { report, exitCode, errors } = inspectProcessResult(result);
    if (args.json) print({ ...report, action: 'inspect', ok: exitCode === 0, errors, writesFiles: [] }, true);
    else process.stdout.write(result.stdout);
    return exitCode;
  }
  const session = await start(cfg, effective, { paths, command: `mirage ${action}` });
  args.startup?.phase(
    'runtime listener',
    session.started ? 'listening; application readiness pending' : 'reused; application readiness pending',
  );
  const { launch } = session;
  const adminUrl = session.adminUrl ?? adminUrlOf(session.url);
  const stateFile = session.stateFile ?? launch.stateFile;
  const stop = await sessionStopHint([{ cfg, args: effective, session }], paths);
  if (action === 'dev') {
    if (launch.runtime?.kind && launch.runtime.kind !== 'power-pages') {
      const { controller, interrupt, interrupted } = codeAppInterrupt();
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      let servers;
      try {
        const started = await startProjectCodeApps(cfg, launch, session, controller);
        const { apps } = started;
        servers = started.servers;
        return await withMirageDebugOutput([session], async () =>
          (await import('../standalone-mirage.mjs')).developStandalone(
            { ...cfg, runtime: launch.runtime },
            { ...effective, path: effective.path ?? (apps.length ? '/_apps/code/' : undefined) },
            { ...session, adminUrl },
            { signal: controller.signal },
          ),
        );
      } catch (error) {
        // Only the interrupt's own reason is an interrupt: a failed Code App server aborts with its error.
        if (interrupted(error) || codeAppStartupInterrupted(error)) return 0;
        throw error;
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
        await guardShutdownSignals(() => stopDevelopmentSession(servers, session, paths, stop));
      }
    }
    const { controller, interrupt, interrupted } = codeAppInterrupt();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    let codeAppServers;
    let codeApps;
    try {
      ({ apps: codeApps, servers: codeAppServers } = await startProjectCodeApps(cfg, launch, session, controller));
    } catch (error) {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      if (session.started) await guardShutdownSignals(() => stopOwnedSessions({ paths, pids: [session.pid] }));
      if (codeAppStartupInterrupted(error)) return 0;
      throw error;
    }
    const mirageSourceRoots = [
      ...new Set([session.sourceDir ?? launch.sourceDir, ...launch.solutionRoots].filter(Boolean).map(realpath)),
    ];
    const mirageSession = {
      url: session.url,
      adminUrl,
      appsUrl: session.appsUrl,
      stateFile,
      project: launch.project,
      portal: launch.portal,
      pid: session.pid,
      started: session.started,
    };
    console.log(`mirage   ${session.url}  (${session.started ? 'started' : 'already running'}, pid ${session.pid})`);
    console.log(`admin       ${adminUrl}`);
    console.log(`state       ${stateFile}`);
    console.log(`source      ${session.sourceDir}`);
    console.log(`live writes ${liveWritesText(session.runtime?.liveWrites)}`);
    if (session.runtime?.startupPreset?.name)
      console.log(
        `preset      ${session.runtime.startupPreset.name} (${session.runtime.startupPreset.mode}; ${session.runtime.startupPreset.applied ? 'applied at startup' : 'kept existing state'})`,
      );
    if (launch.project) {
      const portal = launch.portal ? ' (portal ' + launch.portal + ')' : '';
      console.log(`project     ${launch.project}${portal}`);
    }
    console.log(
      `solutions   ${launch.solutionRoots.length ? launch.solutionRoots.join(', ') : 'none (no Solution roots configured or discovered)'}`,
    );
    console.log(
      `stop        ${session.started ? 'Ctrl+C here or close the browser: the browser and this Mirage stop' : 'Ctrl+C here or close the browser ends the browser session; the Mirage keeps running'}. Stop it any time with: ${stop}`,
    );
    const codeAppStart = codeApps.length > 0 && !effective.path;
    const localCfg = {
      ...cfg,
      ...(codeAppStart ? { site: { ...cfg.site, startPath: '/_apps/code/' } } : {}),
      startUrl: mirageStartUrl(session, codeAppStart ? '/_apps/code/' : (cfg.site.startPath ?? '/')),
      sourceDir: session.sourceDir,
      origin: session.url,
      envName: 'local',
      siteName: `${session.id ?? cfg.siteName} Mirage`,
      caution: false,
      mirage: true,
      mirageSourceRoots,
      mirageSession,
    };
    const { default: runDev } = await import('./dev.mjs');
    try {
      const result = await withMirageDebugOutput([session], () =>
        runDev(localCfg, { ...effective, mirageTarget: localCfg, codeAppSignal: controller.signal }),
      );
      if (controller.signal.aborted && !interrupted()) throw controller.signal.reason;
      return result;
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      await guardShutdownSignals(() => stopDevelopmentSession(codeAppServers, session, paths, stop));
    }
  }
  print({ action: 'start', ...session, adminUrl, stateFile, stop }, args.json);
  args.startup?.complete('runtime listening; no browser application readiness was requested');
  return 0;
}

export async function stopDevelopmentSession(
  codeAppServers,
  session,
  paths,
  stop,
  { stopSessions = stopOwnedSessions, report = console.error } = {},
) {
  try {
    await codeAppServers?.close();
  } finally {
    if (session.started) {
      const outcome = await stopSessions({ paths, pids: [session.pid] }).catch((error) => ({
        stopped: [],
        remaining: [{ pid: session.pid }],
        error,
      }));
      if (outcome.stopped.length) console.log(`mirage   stopped ${session.url} (pid ${session.pid})`);
      else {
        const errorMessage = outcome.error ? ': ' + outcome.error.message : '';
        report(`mirage   could not stop pid ${session.pid}${errorMessage}; run: ${stop}`);
        process.exitCode ||= 1;
      }
    }
  }
}

function assignCatalogueSites(sessions, sites) {
  for (const session of sessions)
    session.site = sites.find((item) => session.sourceDir && samePath(item.sourceDir, session.sourceDir))?.site ?? null;
}

function hasSeveralPowerPagesPortals(effective, project) {
  return (effective.runtime ?? project.runtime.kind) === 'power-pages' && project.portals.length > 1;
}

function validateSelectedProjectPortal(project, effective) {
  if (effective.portal && !project.portals.some((item) => item.id === effective.portal))
    throw new Error(`Unknown Mirage portal "${effective.portal}" in ${project.configFile}`);
}
