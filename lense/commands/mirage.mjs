// Toolkit wrapper around the bundled Mirage runtime: project bootstrap, lifecycle and readiness.
// It only stops loopback Mirage processes it started itself (recorded with their process start
// identity), and it never contacts a portal environment.
import fs from 'node:fs/promises';
import { adminServes, appsPath } from '../../mirage/lib/admin-origin.mjs';
import { renderSettings } from '../../mirage/lib/render-settings.mjs';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';
import { catalogueNotFound, loadCatalogue, loadConfig, loadDevTargets, mirageOnlySite } from '../config.mjs';
import { runtimePort } from '../../mirage/lib/runtime-port.mjs';
import { RUNTIME_KINDS } from '../../mirage/lib/runtime-config.mjs';
import { RUNTIME_ALIVE, RUNTIME_READY, runtimeStartupEvent } from '../startup-progress.mjs';
import { START_CHANNEL_ENV, openStartChannel } from '../start-channel.mjs';
import { CODE_APP_STARTUP_CANCELLED } from '../code-app-dev-servers.mjs';
import { readLocalFile } from '../local-file.mjs';
import { mirageStopCommand, mirageCommandHint, listenerPort } from '../stop-command.mjs';
import { paqviloCommand } from '../command-hint.mjs';
import { LENSE_OPTIONS, MIRAGE_ACTION_OPTIONS } from '../cli-options.mjs';
import { persistCommandPayload, pruneCommandPayloads } from '../command-payload.mjs';
import { withMirageDebugOutput } from '../mirage-debug-output-scope.mjs';
import { guardShutdownSignals } from '../signal-forwarding.mjs';
import { watchRuntimeGone } from '../runtime-liveness.mjs';
// Every identity read of a recorded PID is awaited, so a start keeps its heartbeat and cancellation responsive.
import {
  endRecordedWindowsProcess,
  isAlive,
  lockHost,
  newStartIdentity,
  processIdentityAsync,
  recordedIdentityNow,
  START_TOKEN_OPTION,
  startTokenOf,
} from '../process-identity.mjs';

export { isAlive, processIdentityAsync };
export { processIdentity } from '../process-identity.mjs';

/**
 * The identity of the process that holds a recorded PID now, for comparison with the identity `recorded` for it
 * (recordedIdentityNow): a start token costs a pipe listing, an operating-system start time a read of the process.
 * The default `identityOf` of start, stop and status; a caller that injects its own reader gets the same arguments.
 */
const recordedIdentity = (pid, { signal, recorded } = {}) => recordedIdentityNow(pid, recorded, { signal });

/**
 * How the lifecycle commands reach the operating system's processes, as one object a caller may replace in part:
 * `spawnRuntime` starts a runtime, `identityOf` reads the identity of the process that holds a recorded PID,
 * `alive` says whether a PID is running, `kill` signals one, `openChannel` opens the endpoint a starting runtime
 * announces itself on, `portAvailable` says whether a loopback port can be bound, `commandHint` formats the
 * commands a report advertises, and `probeTimeout` replaces the limit a status gives each runtime to answer (`null`:
 * none). The default export `mirage`
 * takes it as its fourth argument and hands it to every start, stop and status it performs, so the selection, reuse
 * and hint logic of a command runs unchanged against runtimes that are not operating-system processes.
 */
const hostOf = (host = {}) => {
  const processes = Object.fromEntries(
    ['identityOf', 'alive', 'kill'].filter((key) => host[key] !== undefined).map((key) => [key, host[key]]),
  );
  const launch = Object.fromEntries(
    ['spawnRuntime', 'openChannel', 'portAvailable']
      .filter((key) => host[key] !== undefined)
      .map((key) => [key, host[key]]),
  );
  return {
    alive: host.alive ?? isAlive,
    commandHint: host.commandHint ?? mirageCommandHint,
    start: (cfg, args, options) => start(cfg, args, { ...options, ...processes, ...launch }),
    stop: (options) => stopOwnedSessions({ ...options, ...processes }),
    status: (paths, options) => {
      const { kill: ignoredKill, ...read } = processes; // NOSONAR: binding is excluded from the rest object
      const probe = host.probeTimeout === undefined ? {} : { probeTimeout: host.probeTimeout };
      return mirageStatus(paths, { ...probe, ...options, ...read });
    },
  };
};
const SYSTEM_HOST = hostOf();

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

/*
 * Which runtimes a lifecycle selection names — ONE rule for `mirage status` and `mirage stop`:
 * - The selection is --project F (with --portal P): the runtimes started for F (and P). Otherwise it is the catalogue
 *   site that --config/--site select (default: the working directory's paqvilo.config.yml and its defaultSite, every
 *   site with portals: all): the runtimes started for that site and, when the site maps a project (mirage.project),
 *   the runtimes started for that project. A project runtime started without a catalogue site belongs to F alone.
 *   A standalone runtime started with --runtime for a catalogue site belongs to that site; one started with --runtime
 *   without a catalogue site or project belongs to the selection without selectors (siteStandalonePids).
 * - Records are read from the selection's ownership folder (.paqvilo beside the --config or --project file, else the
 *   working directory), from the working directory's, from the selected project file's, and from every folder a start
 *   in the working directory recorded there (rememberRecordFolder).
 * - stop stops exactly the toolkit-owned runtimes status lists for the same selectors. Both report every other
 *   toolkit-owned runtime found in those records as outside the selection, with the selectors that name it.
 */
const RECORD_FOLDERS = 'record-folders.json';
const ownershipFolder = (paths) => path.dirname(path.dirname(paths.ownershipFile));

/** A folder as samePath compares it: its real path, letter case ignored on Windows. */
const canonicalPath = (value) => {
  const real = realpath(value);
  return process.platform === 'win32' ? real.toLowerCase() : real;
};
/** The folders of `list` without repeats (by canonical path), first spelling kept. */
const uniqueFolders = (list) => {
  const seen = new Set();
  return list.filter((folder) => {
    const key = canonicalPath(folder);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Every folder a note records, as written. */
async function notedFolders(stateDir) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(path.join(stateDir, 'mirage', RECORD_FOLDERS), 'utf8'));
  } catch {
    return [];
  }
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && path.isAbsolute(item)) : [];
}

/**
 * The noted folders that exist now, each once: a missing folder (removed, or on a drive not mounted now) holds no
 * record to read. It is skipped on one cheap check and stays in the note for a later read.
 */
async function readRecordFolders(stateDir) {
  return uniqueFolders((await notedFolders(stateDir)).filter((item) => isDirectory(item)));
}

/**
 * Records, in the working directory's ownership folder, another folder a start there recorded its runtime in, so
 * status and stop run from this folder find it. Only a project folder (one with .paqvilo, a catalogue or a package)
 * gets the note; elsewhere nothing is written.
 */
async function rememberRecordFolder(paths, cwd = process.cwd()) {
  const local = path.join(cwd, '.paqvilo');
  const folder = ownershipFolder(paths);
  if (samePath(folder, local)) return;
  if (!['.paqvilo', 'paqvilo.config.yml', 'package.json'].some((name) => fsSync.existsSync(path.join(cwd, name))))
    return;
  // Every noted folder is kept, also one missing now: it may be on a drive that is mounted again later.
  const known = uniqueFolders(await notedFolders(local));
  if (known.some((item) => samePath(item, folder))) return;
  await fs.mkdir(path.join(local, 'mirage'), { recursive: true });
  // ponytail: last writer wins when two starts race; a lost note only hides a runtime from this folder's bare status.
  await fs.writeFile(path.join(local, 'mirage', RECORD_FOLDERS), `${JSON.stringify([...known, folder], null, 2)}\n`);
}

/** The ownership folders the selection rule above reads, the selection's own first. */
export async function recordFolders(paths, projectFile = null) {
  const folders = [ownershipFolder(paths), path.join(process.cwd(), '.paqvilo')];
  if (projectFile) folders.push(path.join(path.dirname(path.resolve(projectFile)), '.paqvilo'));
  const noted = [];
  for (const folder of folders) noted.push(...(await readRecordFolders(folder)));
  folders.push(...noted);
  return [
    paths,
    ...uniqueFolders(folders)
      .slice(1)
      .map((stateDir) => miragePaths({ stateDir })),
  ];
}
export const DEFAULT_PORT = 8787;
const DEFAULT_STARTUP_TIMEOUT = 120_000;
// Start-up progress extends the silence bound, but never past this absolute cap.
export const STARTUP_ABSOLUTE_CAP = 600_000;
const STOP_DEADLINE = 5000;
const ACTIONS = ['init', 'start', 'dev', 'status', 'inspect', 'stop'];
export function validateMirageAction(action) {
  if (!ACTIONS.includes(action))
    throw new Error(
      `Unknown mirage action "${action}"; use ${ACTIONS.slice(0, -1).join(', ')} or ${ACTIONS.at(-1)}. Run ${paqviloCommand(['mirage', '--help'])} for options.`,
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
// Resolved at each use from the working directory of that command, as the other `.paqvilo` paths are.
const solutionOrderCache = () => path.join(process.cwd(), '.paqvilo', 'simulator', 'cache', 'solution-discovery.json');
const solutionOrderOf = (cfg) => (cfg?.mirageConfig?.solutionOrder === 'explicit' ? 'explicit' : 'derived');
const sameOrder = (a, b) => a.length === b.length && a.every((item, index) => samePath(item, b[index]));
const rootNames = (roots) => roots.map((root) => path.basename(root)).join(' → ');

/**
 * Solution roots in their dependency order, the order Solution discovery, bootstrap and the
 * data scaffold apply: a root exporting a table's full definition precedes roots that only
 * extend it; independent roots keep name order. Cycles are added to `diagnostics`.
 */
export async function derivedSolutionOrder(roots, { diagnostics = [], cacheFile = solutionOrderCache() } = {}) {
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
 * Only a records file that does not exist means "no sessions"; any other read failure is surfaced, never taken as empty, and
 * says what the user can do about it.
 */
export async function ownedSessions(paths = DEFAULT_PATHS) {
  const sessionFolder = paths.discoveryRoot ? ' in ' + paths.discoveryRoot : '';
  const remedy = () =>
    ` Inspect or remove ${paths.ownershipFile} and run the command again. Without that file Paqvilo no longer` +
    ` recognises the Mirages it listed, so "${paqviloCommand(['mirage', 'stop'])}" cannot stop them; end them by` +
    ` their process IDs, which the session-<pid>.json files${sessionFolder} name.`;
  let text;
  try {
    text = await fs.readFile(paths.ownershipFile, 'utf8');
  } catch (error) {
    // ENOTDIR (POSIX; Windows answers ENOENT): a folder on the way is a file, so the records file does not exist either.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
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
/**
 * Whether a runtime record (an ownership entry or a discovery file) was written on another host than `here`, as a
 * lock is: its PID names a process in another process namespace (Windows and WSL, or several runners sharing one
 * checkout), so it is never judged, pruned, removed or signalled here. A record without `host` counts as local.
 */
const foreignRecord = (record, here) => typeof record?.host === 'string' && record.host !== here;

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

/**
 * What a status probe showed. 'answered': the runtime described itself. 'refused': it answered that it is not ready
 * (an error status or an unreadable body). 'no-answer': nothing came back, within the probe's limit or at all — the
 * runtime may be busy, so this says nothing about its state. 'not-probed': no loopback address to ask.
 */
const PROBE_ANSWERED = 'answered',
  PROBE_REFUSED = 'refused',
  PROBE_NO_ANSWER = 'no-answer',
  PROBE_NOT_PROBED = 'not-probed';

// timeout null leaves the wait to the caller's signal: for a caller that has observed the runtime ready.
async function readRuntime(url, fallbackSite = null, options = {}) {
  return (await probeRuntime(url, fallbackSite, options)).runtime;
}

/** The fields of an answered status document that a probe keeps; `data` is the parsed body of the status read. */
function answeredRuntime(data, fallbackSite) {
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
}

/** The signal that ends the status reads of one probe: the caller's, and the probe's own limit unless `timeout` is null. */
function probeSignal(signal, timeout) {
  const limits = [signal, timeout == null ? null : AbortSignal.timeout(timeout)].filter(Boolean);
  return limits.length ? AbortSignal.any(limits) : undefined;
}

async function probeRuntime(url, fallbackSite = null, { signal, timeout = 2500 } = {}) {
  signal?.throwIfAborted();
  const outcome = (probe, runtime = null) => ({ probe, runtime });
  if (!url || !loopbackUrl(url)) return outcome(PROBE_NOT_PROBED);
  const readSignal = probeSignal(signal, timeout);
  // The light status endpoint first; older runtimes answer 404 there and expose the state summary.
  for (const pathname of ['/_sim/api/status', '/_sim/api/state?summary=1', '/__sim/api/state?summary=1']) {
    let response;
    try {
      response = await fetch(new URL(pathname, url), { signal: readSignal });
    } catch {
      signal?.throwIfAborted();
      return outcome(PROBE_NO_ANSWER);
    }
    if (response.status === 404) continue;
    if (!response.ok) return outcome(PROBE_REFUSED);
    try {
      return outcome(PROBE_ANSWERED, answeredRuntime(await response.json(), fallbackSite));
    } catch (error) {
      signal?.throwIfAborted();
      // A body that did not arrive in time is no answer; one that is not a status document is a refusal.
      return outcome(error?.name === 'SyntaxError' ? PROBE_REFUSED : PROBE_NO_ANSWER);
    }
  }
  return outcome(PROBE_REFUSED);
}

const platformOf = (host) => String(host).split('/', 1)[0];
const recordKey = (entry) => `${entry.pid} ${entry.processIdentity}`;

/**
 * Which ownership records are another host's: `(entry) => boolean`. A record stamped with this platform under another
 * machine name is this machine's own, written before its name changed (macOS renames itself with the network), when
 * its process is alive here with its full recorded identity: on Windows a start token (128 random bits, held by the
 * live runtime and shown on its command line before any signal), on macOS its start time to the second. Linux records
 * are never taken over: containers on one kernel share PID numbers and start ticks, so an identity there does not tell
 * hosts apart. Every other record stamped with another host stays foreign.
 */
async function foreignJudge(entries, { hostName, alive = isAlive, identityOf = recordedIdentity, signal }) {
  const here = platformOf(hostName);
  const adopted = new Set();
  for (const entry of entries) {
    if (!foreignRecord(entry, hostName) || platformOf(entry.host) !== here || !entry.processIdentity) continue;
    if (here !== 'darwin' && !startTokenOf(entry.processIdentity)) continue;
    if (!alive(entry.pid)) continue;
    if ((await identityOf(entry.pid, { signal, recorded: entry.processIdentity })) === entry.processIdentity)
      adopted.add(recordKey(entry));
  }
  return (entry) => foreignRecord(entry, hostName) && !adopted.has(recordKey(entry));
}

/**
 * Whether a discovery record belongs to another host than `hostName`. A runtime stamps its discovery file with its
 * host, which decides, unless a record this machine took over under its earlier name (`isForeign`) names that file
 * with that host. A file without a host (an older runtime's) is foreign when a foreign ownership record names it and
 * no local record does. Unreadable ownership records name none: the commands that need them read and report them.
 */
async function foreignDiscoveries(paths, hostName, isForeign, alive = isAlive) {
  const owned = paths.ownershipFile ? await ownedSessions(paths).catch(() => []) : [];
  const foreign = isForeign ?? (await foreignJudge(owned, { hostName, alive }));
  const named = (wanted) =>
    new Set(
      owned
        .filter((entry) => entry.discovery && foreign(entry) === wanted)
        .map((entry) => path.resolve(entry.discovery)),
    );
  // Hosts with one PID number name the same file: a local record of it keeps an unstamped file local.
  const local = named(false),
    elsewhere = named(true);
  const renamed = new Map(
    owned
      .filter((entry) => entry.discovery && foreignRecord(entry, hostName) && !foreign(entry))
      .map((entry) => [path.resolve(entry.discovery), entry.host]),
  );
  return (record, file) =>
    typeof record?.host === 'string'
      ? foreignRecord(record, hostName) && renamed.get(path.resolve(file)) !== record.host
      : elsewhere.has(path.resolve(file)) && !local.has(path.resolve(file));
}

/**
 * Discovered Mirage portals; `probe` asks each live process whether its runtime answers. `ready` is true for a runtime
 * that answered; `probe` says what the question showed (see probeRuntime), so a caller can tell a runtime that gave
 * no answer in time from one that is not ready.
 */
export async function discoveries(
  paths = DEFAULT_PATHS,
  { probe = true, signal, probeTimeout, alive = isAlive, hostName = lockHost(), isForeign } = {},
) {
  const sessions = [];
  const foreign = await foreignDiscoveries(paths, hostName, isForeign, alive);
  for (const { record, file } of await discoveryRecords(paths, { signal })) {
    signal?.throwIfAborted();
    // Another host's runtime: its PID says nothing here, so it is neither listed nor removed.
    if (foreign(record, file)) continue;
    const processAlive = alive(record.pid);
    if (!processAlive) {
      await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }
    // The machine name stays in the record: the sessions a status or start reports do not publish it.
    const { portals, host: ignoredHost, ...base } = record; // NOSONAR: binding is excluded from the rest object
    const entries = Array.isArray(portals) ? portals.map((portal) => ({ ...base, ...portal, id: portal.id })) : [base];
    for (const entry of entries) {
      signal?.throwIfAborted();
      const asked =
        processAlive && probe
          ? await probeRuntime(entry.url, entry.id ?? null, { signal, timeout: probeTimeout })
          : { probe: PROBE_NOT_PROBED, runtime: null };
      sessions.push({
        ...entry,
        discovery: file,
        processAlive,
        ready: Boolean(asked.runtime),
        probe: asked.probe,
        runtime: asked.runtime,
      });
    }
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

const anySignal = (...signals) => {
  const list = signals.filter(Boolean);
  return list.length ? AbortSignal.any(list) : undefined;
};

/**
 * Asks the runtime at `url` to shut down. There is no elapsed limit: a runtime that answers late under load still
 * stops gracefully instead of being signalled, and the caller's `signal` or interrupt ends the wait.
 */
async function requestShutdown(url, { signal } = {}) {
  if (!loopbackUrl(url)) return false;
  try {
    let prefix = '/_sim/api';
    let response = await fetch(new URL(`${prefix}/state?summary=1`, url), { signal });
    if (response.status === 404) {
      prefix = '/__sim/api';
      response = await fetch(new URL(`${prefix}/state?summary=1`, url), { signal });
    }
    if (!response.ok) return false;
    const state = await response.json();
    if (typeof state.csrf !== 'string' || !state.csrf) return false;
    const stopped = await fetch(new URL(`${prefix}/shutdown`, url), {
      method: 'POST',
      headers: { 'x-sim-csrf': state.csrf },
      signal,
    });
    return stopped.status === 202;
  } catch {
    return false;
  }
}

/**
 * Stops toolkit-owned Mirage processes selected by portal source folder or PID. An entry is only
 * acted on while its PID still has the recorded start identity; entries of exited processes (or of a
 * reused PID) are pruned, and discovery files of exited processes are removed. An acknowledged shutdown is
 * waited for until the runtime exits; `interrupt` (Ctrl+C) or `signal` ends the wait; after an interrupt a runtime
 * still running gets the grace before it is ended.
 */
/* NOSONAR: single-pass routine, splitting it would change shared state */ export async function stopOwnedSessions({
  paths = DEFAULT_PATHS,
  sourceDir = null,
  sourceDirs = null,
  pids = null,
  deadline = STOP_DEADLINE,
  identityOf = recordedIdentity,
  alive = isAlive,
  kill = process.kill,
  signal,
  interrupt,
  hostName = lockHost(),
} = {}) {
  const folders = sourceDirs ?? (sourceDir ? [sourceDir] : []);
  const owned = await ownedSessions(paths);
  const records = await discoveryRecords(paths);
  const isForeign = await foreignJudge(owned, { hostName, alive, identityOf, signal });
  const elsewhere = await foreignDiscoveries(paths, hostName, isForeign, alive);
  const stale = [],
    targets = [],
    unverified = [];
  const current = (entry) => identityOf(entry.pid, { signal, recorded: entry.processIdentity });
  await classifyOwnedTargets(owned, {
    alive,
    current,
    folders,
    pids,
    stale,
    targets,
    unverified,
    isForeign,
    ownershipFile: paths.ownershipFile,
  });
  // A discovery file another host's runtime wrote under the same PID number is never removed or asked to shut down.
  const foreignFile = async (file) => {
    try {
      return elsewhere(JSON.parse(await fs.readFile(file, 'utf8')), file);
    } catch {
      return false;
    }
  };
  // A runtime that did not acknowledge its shutdown, or did not exit after it, is ended: only while its PID still has
  // the recorded identity. Windows ends a process at once on either signal and reads it as exited before its listening
  // port is released, so there one helper checks the identity, ends the process and waits for the observed exit
  // (endRecordedWindowsProcess); a graceful runtime closes its listeners itself before it exits.
  const ended = new Set(),
    foreign = new Set();
  const force = async (entry, name) => {
    if (process.platform === 'win32' && identityOf === recordedIdentity) {
      // Another program holds the PID: asking again would start the helper for the same answer.
      if (foreign.has(entry)) return;
      const answer = await endRecordedWindowsProcess(entry.pid, entry.processIdentity, { signal });
      if (answer === 'ended' || answer === 'gone') ended.add(entry);
      if (answer === 'other') foreign.add(entry);
      return;
    }
    if ((await current(entry)) !== entry.processIdentity) return;
    try {
      kill(entry.pid, name);
      if (name === 'SIGKILL') ended.add(entry);
    } catch {
      /* already stopped */
    }
  };
  const results = [];
  for (const entry of targets) {
    const record = records.find((item) => item.record.pid === entry.pid && !elsewhere(item.record, item.file))?.record;
    // The recorded URL is ours; a discovery URL is only used while ours is not known yet (starting).
    const urls = [
      ...new Set(
        entry.url ? [entry.url] : [record?.url, ...(record?.portals ?? []).map((portal) => portal.url)].filter(Boolean),
      ),
    ];
    let graceful = false,
      answered = null;
    for (const url of urls)
      if (!graceful && (graceful = await requestShutdown(url, { signal: anySignal(signal, interrupt) })))
        answered = url;
    if (!graceful) await force(entry, 'SIGTERM');
    // A runtime that answered its shutdown at its published URL was serving, as status reports it, even when its
    // ownership record still holds the start-up placeholder (ready: false, no URL).
    results.push({ entry, graceful, url: entry.url ?? answered, ready: entry.ready !== false || Boolean(answered) });
  }
  // A runtime that acknowledged its shutdown is waited for until it exits; one that did not gets `deadline` to exit
  // by itself. After that the runtime is ended, never reported on elapsed time alone.
  const acked = new Set(results.filter((item) => item.graceful).map((item) => item.entry));
  let graceEnd = Date.now() + deadline;
  // Ctrl+C ends the wait for an acknowledged shutdown; whatever still runs then gets `deadline` to exit before SIGKILL.
  const extend = () => (graceEnd = Math.max(graceEnd, Date.now() + deadline));
  interrupt?.addEventListener('abort', extend, { once: true });
  const waiting = () =>
    targets.some((entry) => alive(entry.pid) && ((acked.has(entry) && !interrupt?.aborted) || Date.now() < graceEnd));
  try {
    while (waiting() && !signal?.aborted) await sleep(100);
  } finally {
    interrupt?.removeEventListener('abort', extend);
  }
  // POSIX signals can be handled; force only the process that still has the recorded identity.
  for (const entry of targets) if (alive(entry.pid)) await force(entry, 'SIGKILL');
  // A process that was ended exits: the wait for it has no time limit and ends with the caller's signal. One that
  // could not be ended (its identity unread, or the system refused) is not waited for and is reported as remaining.
  while ([...ended].some((entry) => !hasExited(entry.pid, alive)) && !signal?.aborted) await sleep(100);
  const remaining = [];
  for (const entry of targets) {
    if (hasExited(entry.pid, alive)) continue;
    const now = await current(entry);
    if (now == null || now === entry.processIdentity) remaining.push(entry);
  }
  const removedDiscoveries = [];
  for (const { record, file } of await discoveryRecords(paths)) {
    if (elsewhere(record, file) || alive(record.pid)) continue;
    await fs.rm(file, { force: true });
    removedDiscoveries.push(file);
  }
  const forget = [...targets.filter((item) => !remaining.includes(item)), ...stale.map((item) => item.entry)];
  for (const entry of forget) {
    if (!entry.discovery || removedDiscoveries.includes(entry.discovery) || alive(entry.pid)) continue;
    const relative = path.relative(paths.discoveryRoot, entry.discovery);
    if (
      /^session-\d+\.json$/.test(relative) &&
      fsSync.existsSync(entry.discovery) &&
      !(await foreignFile(entry.discovery))
    ) {
      await fs.rm(entry.discovery, { force: true });
      removedDiscoveries.push(entry.discovery);
    }
  }
  // A folder that records no runtime is left without one: a stop there creates no state.
  const recorded = fsSync.existsSync(paths.ownershipFile);
  if (recorded)
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
    .filter(({ entry, graceful, ready }) => graceful && ready && !remaining.includes(entry))
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
      .map(({ entry, graceful, url, ready }) => ({ ...describe(entry), url: url ?? null, graceful, wasReady: ready })),
    remaining: remaining.map(describe),
    pruned: stale.map(({ entry, reason }) => ({ ...describe(entry), reason })),
    // `foreignHost`: kept because another host recorded it; it is never part of a selection (stopExitStatus).
    unverified: unverified.map(({ entry, reason, foreignHost }) => ({
      ...describe(entry),
      reason,
      ...(foreignHost ? { foreignHost } : {}),
    })),
    removedDiscoveries,
    writesFiles: recorded ? [paths.ownershipFile] : [],
  };
}

/**
 * Whether a process that was signalled has exited. A Linux zombie (ended, not yet collected by its parent) has
 * released everything it held and still answers signal 0, so its state is read; elsewhere liveness decides.
 */
function hasExited(pid, alive = isAlive) {
  if (!alive(pid)) return true;
  // A caller that supplies its own liveness answers for the process: the system's table is not asked about it.
  if (process.platform !== 'linux' || alive !== isAlive) return false;
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch {
    return true;
  }
}

/** The failure of a stop that left a selected runtime running (`remaining`): it was not ended, whatever time passed. */
const stillRunning = (report) =>
  `Mirage process ${report.remaining.map((item) => item.pid).join(', ')} is still running: it could not be ended, or its start identity could not be read. Run the stop again, or end the process by its ID.`;

async function classifyOwnedTargets(
  owned,
  { alive, current, folders, pids, stale, targets, unverified, isForeign, ownershipFile },
) {
  for (const entry of owned) {
    const status = await inspectOwnedTarget(entry, { alive, current, isForeign, ownershipFile });
    if (status.kind === 'unverified') {
      unverified.push({ entry, reason: status.reason, foreignHost: status.foreignHost === true });
      continue;
    }
    if (status.kind === 'stale') {
      stale.push({ entry, reason: status.reason });
      continue;
    }
    if (isSelectedOwnedTarget(entry, pids, folders)) targets.push(entry);
  }
}

/** Why stop leaves another host's record, and the way out when that host is gone. */
const foreignStopReason = (entry, ownershipFile) =>
  `it was started on ${entry.host}; stop it there. If it no longer runs on ${entry.host} (the host was renamed or removed), delete its entry from ${ownershipFile}`;

async function inspectOwnedTarget(entry, { alive, current: read, isForeign, ownershipFile }) {
  // Its PID names a process of another host: whether it runs can only be judged there, so its record stays.
  if (isForeign(entry))
    return { kind: 'unverified', foreignHost: true, reason: foreignStopReason(entry, ownershipFile) };
  const running = alive(entry.pid);
  // A record without an identity is never read: nothing could be compared with it.
  const current = running && entry.processIdentity ? await read(entry) : null;
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

/** Sessions with ownership, project and portal information merged from both record kinds. */
export async function mirageStatus(
  paths = DEFAULT_PATHS,
  { identityOf = recordedIdentity, alive = isAlive, signal, probeTimeout, hostName = lockHost() } = {},
) {
  // Another host's records name processes this one cannot see: they are its status to list.
  const recorded = await ownedSessions(paths);
  const isForeign = await foreignJudge(recorded, { hostName, alive, identityOf, signal });
  const owned = recorded.filter((entry) => !isForeign(entry));
  const found = await discoveries(paths, { signal, probeTimeout, alive, hostName, isForeign });
  // Each record's PID is read once, against the identity that record names.
  const reads = new Map();
  const ours = (entry) => {
    const key = `${entry.pid} ${entry.processIdentity}`;
    if (!reads.has(key))
      reads.set(
        key,
        Promise.resolve(identityOf(entry.pid, { signal, recorded: entry.processIdentity })).then(
          (current) => current === entry.processIdentity,
        ),
      );
    return reads.get(key);
  };
  const sessions = [];
  for (const session of found) {
    const owner = owned.find((item) => item.pid === session.pid && item.discovery === session.discovery);
    const isOwned = Boolean(owner && session.processAlive && owner.processIdentity && (await ours(owner)));
    sessions.push({
      ...session,
      // A runtime this toolkit recorded as ready, whose process still has the recorded identity, stays ready when a
      // probe got no answer in time: a busy runtime answers late. Only an answer (or the process ending, which
      // removes the session) changes what is known about it.
      ready: session.ready || (session.probe === PROBE_NO_ANSWER && isOwned && owner.ready === true),
      adminUrl: session.adminUrl ?? (session.url ? adminUrlOf(session.url) : null),
      owned: isOwned,
      project: session.project ?? owner?.project ?? null,
      portal: session.id ?? owner?.portal ?? null,
    });
  }
  for (const entry of owned) {
    if (
      found.some((session) => session.pid === entry.pid) ||
      !alive(entry.pid) ||
      !entry.processIdentity ||
      !(await ours(entry))
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
      probe: PROBE_NOT_PROBED,
      starting: true,
      owned: true,
      runtime: null,
    });
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

// ---- configuration
/**
 * The configuration `paqvilo mirage <action>` runs with for the options of its command line (lense/cli.mjs): a
 * standalone runtime's own configuration, else the catalogue site's. Status selects as stop does, so it reads the same
 * configuration without checking the source folder; without selectors, an unreadable working-directory catalogue
 * gives none (status then lists every recorded runtime). `pick` may complete the site and environment selection in
 * `values` before the catalogue site is loaded. A --project file that no longer exists is left to stop and status,
 * which still find the runtimes recorded for it.
 */
export async function mirageCommandConfiguration(
  values,
  action = 'status',
  { env = process.env, pick = null, checkSource = true } = {},
) {
  if (action === 'status') return statusConfiguration(values, env);
  // A removed catalogue still names its ownership folder: stop selects there as status does (stopRemovedCatalogue).
  if (action === 'stop' && values.config && !isFile(values.config)) return null;
  if (values.project && action !== 'stop' && !isFile(values.project))
    throw new Error(`--project file not found: ${path.resolve(values.project)}. Pass an existing file.`);
  const standalone = await standaloneConfiguration(values, action);
  if (standalone) return standalone;
  const bare = await bareFolderConfiguration(values, action);
  if (bare) return bare;
  if (values.pick) await pick?.(values);
  // stop selects the runtimes recorded for the selection, so the selected sources need not exist (as for status).
  const cfg = await loadConfig(values, env, { checkSource: checkSource && !values.project && action !== 'stop' });
  // A source given in a folder without a catalogue runs the sample site with this folder's state (loadCatalogue).
  if (values.project && !values.config) {
    cfg.configDir = path.dirname(path.resolve(values.project));
    cfg.stateDir = path.join(cfg.configDir, '.paqvilo');
    cfg.portals = 'selected';
  }
  return cfg;
}

/** The configuration status selects with: stop's, without the source check (mirageCommandConfiguration). */
async function statusConfiguration(values, env) {
  // A removed catalogue still names its ownership folder (miragePaths); every runtime recorded there is listed.
  if (values.config && !isFile(values.config)) return null;
  try {
    return await mirageCommandConfiguration(values, 'stop', { env, checkSource: false });
  } catch (error) {
    if (values.config || values.site || values.project) throw error;
    return null;
  }
}

/**
 * In a folder without a catalogue, and without --config, --project or a source, the toolkit's sample catalogue is not
 * the selection: stop and status select this folder's runtimes started without a catalogue site (siteName null), and
 * every other action is refused as a missing catalogue. Null when the selection names a catalogue or a source.
 */
async function bareFolderConfiguration(values, action) {
  const local = path.resolve('paqvilo.config.yml');
  if (values.config || values.project || values.source || isFile(local)) return null;
  if (action !== 'stop' || values.site)
    throw catalogueNotFound(local, { alternatives: '--config <catalogue>, --project <file> or --runtime <kind>' });
  const { standaloneMirageConfiguration } = await import('../standalone-mirage.mjs');
  return { ...standaloneMirageConfiguration(null, values), siteName: null };
}

/** A standalone runtime's own configuration when the selection names one, else null. */
async function standaloneConfiguration(values, action) {
  let standaloneProject = null;
  if (values.project && !values.config && !values.site && (action !== 'stop' || isFile(values.project))) {
    const { loadProjectConfig } = await import('../../mirage/lib/project-config.mjs');
    const candidate = await loadProjectConfig(values.project);
    if (candidate.runtime?.kind !== 'power-pages') standaloneProject = candidate;
  }
  if (!values.project && (values.config || values.site)) {
    const catalogue = loadCatalogue(values),
      name = values.site ?? catalogue.root.defaultSite;
    if (catalogue.sites[name]?.mirage?.runtime?.kind && catalogue.sites[name].mirage.runtime.kind !== 'power-pages')
      return (await import('../standalone-mirage.mjs')).standaloneCatalogueConfiguration(catalogue, name, values);
  }
  if (standaloneProject || (values.runtime && values.runtime !== 'power-pages'))
    return (await import('../standalone-mirage.mjs')).standaloneMirageConfiguration(standaloneProject, values);
  return null;
}

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
 * The abort controller of a Code App dev session. Only the reasons its interrupt and its runtime's end abort with count.
 */
export function codeAppInterrupt() {
  const controller = new AbortController();
  const reason = new Error('Code App development stopped.');
  const ended = new Error('The Mirage runtime of this development session stopped.');
  return {
    controller,
    interrupt: () => controller.abort(reason),
    runtimeEnded: () => controller.abort(ended),
    interrupted: (error = controller.signal.reason) => error === reason || error === ended,
    runtimeStopped: () => controller.signal.reason === ended,
  };
}

/**
 * Ends a dev session when the runtime it started exits on its own, however it exits. `exit` holds the exit once it happened
 * (null before). `ending` is set when the dev session starts its own teardown: the runtime's exit is then expected.
 */
export function endSessionOnRuntimeExit(session, controller, runtimeEnded, { watch = watchRuntimeGone } = {}) {
  const state = { exit: null, ending: false, stopWatching: () => {} };
  // A runtime this command reused is not its child and carries no exit: its end is observed at its listener. How it
  // ended is then unknown, so the session reports that it no longer runs and ends as after a failed runtime.
  let exited = session.exited;
  if (!exited && session.started === false && session.pid && session.url) {
    const watched = watch(session);
    state.stopWatching = watched.stop;
    exited = watched.gone.then(() => ({ code: null, signal: null, observed: false }));
  }
  exited?.then((exit) => {
    state.exit = exit;
    if (state.ending || controller.signal.aborted) return; // Ctrl+C, a failure or the teardown already ends the session.
    let how = exit.code === 0 ? 'stopped' : `exited (${exit.signal ?? 'code ' + exit.code})`;
    if (exit.observed === false) how = 'is no longer running';
    console.log(`mirage   ${session.url} (pid ${session.pid}) ${how}; ending this development session`);
    if (exit.code !== 0) {
      if (session.log) console.log(`mirage   see the runtime log: ${session.log}`);
      process.exitCode ||= 1;
    }
    runtimeEnded();
  });
  return state;
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
  const catalogueSite = projectCatalogueSite(cfg, args, project);
  return {
    cli,
    values: [
      action,
      '--project',
      project.configFile,
      ...(portal ? ['--portal', portal] : []),
      ...(catalogueSite
        ? ['--site', catalogueSite.site, ...(catalogueSite.env ? ['--env', catalogueSite.env] : [])]
        : []),
      ...((args.config || !args.project || catalogueSite) && cfg?.configFile ? ['--config', cfg.configFile] : []),
      ...common,
    ],
  };
}

/**
 * The catalogue site whose catalogue-only settings (personaContexts, identityProvider, deployment profiles) a project
 * runtime takes: the site an explicit --site selects, even when its mirage.project names another file (explicit options
 * win, as in catalogueArgs); else the selected site when its mirage.project is this project file; else the one other
 * site that maps it. --config alone selects no site.
 */
function projectCatalogueSite(cfg, args, project) {
  if (!cfg?.configFile) return null;
  const selected = { site: cfg.catalogueSite ?? cfg.siteName, env: cfg.envName };
  if (args.site || samePath(cfg.mirageConfig?.project, project.configFile)) return selected;
  // A catalogue that is not on disk (an in-memory configuration) maps no project.
  if (!fsSync.existsSync(cfg.configFile)) return null;
  const mapped = sitesMappingProject(
    loadCatalogue({ config: cfg.configFile, repo: cfg.sourceRoot }),
    project.configFile,
  );
  if (mapped.length > 1)
    throw Object.assign(
      new Error(`Sites ${mapped.join(', ')} all map the project ${project.configFile}; choose one with --site <id>.`),
      { code: 'invalid_argument' },
    );
  return mapped.length ? { site: mapped[0], env: args.env } : null;
}

/** The catalogue sites whose mirage.project is the given project file. */
function sitesMappingProject(catalogue, projectFile) {
  return Object.entries(catalogue.sites)
    .filter(
      ([, site]) =>
        site.mirage?.project && samePath(path.resolve(catalogue.configDir, site.mirage.project), projectFile),
    )
    .map(([name]) => name);
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
function liveWritesText(value, kind = 'power-pages') {
  if (value === 'enabled') return 'enabled: create, update and delete requests reach the live environment';
  if (value === 'off') return 'allowed by --allow-live-writes; off until switched on in _sim';
  if (value === 'disabled') return 'disabled (start with --allow-live-writes to allow them)';
  // A standalone runtime (model-driven, dataverse-api) serves only simulated data: it has no live origin to write to.
  if (kind && kind !== 'power-pages') return `do not apply (a ${kind} runtime has no live environment)`;
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

/**
 * The ownership records of every folder, the first one's errors reported, another's unreadable records skipped
 * (they belong to another selection, whose own command reports them).
 */
async function ownedSessionsIn(folders) {
  const entries = [];
  for (const [index, folder] of folders.entries()) {
    try {
      for (const entry of await ownedSessions(folder))
        if (!entries.some((item) => item.pid === entry.pid && item.processIdentity === entry.processIdentity))
          entries.push(entry);
    } catch (error) {
      if (index === 0) throw error;
    }
  }
  return entries;
}

/** Stops the selected PIDs in the ownership folder that records each, as one report. */
async function stopSelected(host, paths, pids, projectFile = null) {
  const reports = [];
  for (const [index, folder] of (await recordFolders(paths, projectFile)).entries()) {
    const recorded = await ownedSessionsIn([folder]).catch(() => []);
    const here = pids.filter((pid) => recorded.some((entry) => entry.pid === pid));
    // The selection's own folder is always visited, so its stale records are pruned as before.
    if (index > 0 && !here.length) continue;
    reports.push(await guardShutdownSignals((interrupt) => host.stop({ paths: folder, pids: here, interrupt })));
  }
  const all = (key) => reports.flatMap((report) => report[key] ?? []);
  return {
    stopped: all('stopped'),
    remaining: all('remaining'),
    pruned: all('pruned'),
    unverified: all('unverified'),
    removedDiscoveries: all('removedDiscoveries'),
    writesFiles: [...new Set(all('writesFiles'))],
  };
}

/** Intersect ownership scope, source/project identity and explicitly supplied selectors. */
async function selectedSessionPids(paths, cfg, kind, selectedProject = null, selection = {}, sourceDir = null) {
  const selectedCatalogue = catalogueIdentity(cfg);
  const scoped = Boolean(selectedCatalogue);
  const recorded = await ownedSessionsIn(await recordFolders(paths, selectedProject?.configFile));
  // As status lists them: another host's runtime is never part of a selection here.
  const isForeign = await foreignJudge(recorded, { hostName: lockHost() });
  const candidates = recorded.filter(
    (entry) => !isForeign(entry) && matchesSessionCandidate(entry, { kind, selection, sourceDir, selectedProject }),
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
  // A project runtime recorded without a catalogue scope (projectOnlyLaunch) belongs to its project file alone: a
  // project selection owns it, a catalogue selection does not.
  const owns = (entry) =>
    entry.project && entry.identity?.scope === null
      ? Boolean(selectedProject)
      : matchesCatalogueScope(entry, scopeContext);
  return candidates.filter(owns).map((entry) => entry.pid);
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
  const mapped = sitesMappingProject(catalogue, selectedProject.configFile);
  return (
    Object.keys(catalogue.sites).length === 1 &&
    mapped.length === 1 &&
    mapped[0] === siteName &&
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
 * What a stop without a project selected: the catalogue site, and, for a selection without selectors, the runtimes
 * started in the folder without a catalogue site (siteStandalonePids); without a catalogue only those.
 */
function siteSelectionLabel(cfg, args) {
  const site = cfg.siteName ?? '';
  if (args.config || args.site || args.project) return site;
  const unscoped = `the runtimes started in ${process.cwd()} without a catalogue site`;
  return site ? `${site} and ${unscoped}` : unscoped;
}

/**
 * A selected session that could not be verified is still running, so the stop is not complete. The status is
 * returned rather than thrown: the report has already been printed, and a thrown error would append a second JSON document.
 */
export function stopExitStatus(report, pids) {
  return report.unverified.some((item) => !item.foreignHost && pids.includes(item.pid)) ? 2 : 0;
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

/**
 * A Power Pages project runtime started with neither --config nor --site, whose project no catalogue site maps: it
 * is recorded without a catalogue scope and belongs to its project file alone, whichever catalogue the working
 * directory holds.
 */
function projectOnlyLaunch(cfg, args, projectInfo) {
  return Boolean(
    projectInfo &&
    (args.runtime ?? projectInfo.runtime?.kind ?? 'power-pages') === 'power-pages' &&
    cfg.configFile &&
    !args.config &&
    !args.site &&
    !projectCatalogueSite(cfg, args, projectInfo),
  );
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
  const scope = projectOnlyLaunch(cfg, args, projectInfo) ? null : catalogueIdentity(cfg);
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
    identityOf = recordedIdentity,
    sleep = (ms, options) => delay(ms, undefined, options),
    now = Date.now,
    alive = isAlive,
    kill = process.kill,
    openChannel = openStartChannel,
    portAvailable: available = portAvailable,
    // The host this start records its runtime on (lockHost); another host's records are foreign to it.
    hostName = lockHost(),
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
      // The launcher names the identity of the runtime it starts (a start token) where reading it from the operating
      // system is expensive. A caller that injects its own reader is asked for the identity instead.
      startIdentity: identityOf === recordedIdentity ? newStartIdentity() : null,
      sleep,
      now,
      alive,
      kill,
      openChannel,
      available,
      hostName,
      ownershipFile: paths.ownershipFile,
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
  // Another host's runtime is never reused: this host cannot reach or judge its process.
  startup.isForeign = await foreignJudge(owned, {
    hostName: startup.hostName,
    alive: startup.alive,
    identityOf: startup.identityOf,
    signal: startup.signal,
  });
  const local = owned.filter((item) => !startup.isForeign(item));
  // Listing local records is cheap. Probe only runtimes eligible for this
  // launch; unrelated listeners can each consume the full probe timeout.
  const candidates = (
    await discoveries(paths, {
      probe: false,
      signal: startup.signal,
      alive: startup.alive,
      hostName: startup.hostName,
      isForeign: startup.isForeign,
    })
  ).filter((session) => isReusableRuntimeCandidate(session, local, identity));
  startup.check();
  let existing;
  for (const session of candidates) {
    const owner = local.find(
      (item) =>
        item.pid === session.pid &&
        item.discovery === session.discovery &&
        item.processIdentity &&
        identityMatches(item.identity, identity),
    );
    const currentIdentity =
      owner && (await startup.identityOf(session.pid, { signal: startup.signal, recorded: owner.processIdentity }));
    startup.check();
    if (owner && currentIdentity === owner.processIdentity) {
      const runtime = await ownedRuntime(session, owner, { started, timeout, startup });
      if (runtime) {
        existing = { ...session, log: owner.log, ready: true, runtime, processIdentity: owner.processIdentity };
        break;
      }
    }
  }
  if (existing) {
    const { processIdentity, ...reused } = existing;
    const result = {
      ...reused,
      ...(existing.runtime && !existing.runtime.simulation && identity.simulation
        ? { runtime: { ...existing.runtime, simulation: identity.simulation } }
        : {}),
      owned: true,
      started: false,
      launch,
      writesFiles: [],
    };
    // What a development session checks the reused process against; not part of the printed result.
    Object.defineProperty(result, 'processIdentity', { value: processIdentity, enumerable: false });
    return result;
  }
  await refuseStateFileOwner(owned, identity, startup);
  if (startup.now() >= started + timeout)
    throw new Error(
      `Mirage startup exceeded ${timeout}ms during source discovery or ownership checks; no child was started.`,
    );
  if (port !== '0' && !(await startup.available(Number(port))))
    throw new Error(
      `Port ${port} is already in use by another process or Mirage session with different settings. Pass --port 0 (any free port) or another --port, or stop that session first.`,
    );
  const { cli, values } = cliArgs(cfg, 'serve', { ...args, port, state: identity.stateFile }, projectInfo);
  // On the command line, so the operating system can show which process was started with it.
  if (startup.startIdentity) values.push(START_TOKEN_OPTION, startTokenOf(startup.startIdentity));
  let child, exited;
  args.startup?.phase('process launch', identity.runtime?.kind ?? 'power-pages');
  await pruneStartupLogs(paths, await ownedSessions(paths));
  await createStateFolder(paths.logRoot);
  const log = path.join(paths.logRoot, `startup-${Date.now()}-${Math.random().toString(16).slice(2)}.log`); // NOSONAR: pseudo-random value for simulation, not a secret
  const logHandle = await fs.open(log, 'a');
  // The runtime announces its start-up progress and its readiness to this command here (lense/start-channel.mjs).
  let channel;
  try {
    startup.check();
    channel = await startup.openChannel();
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
      env: { ...process.env, MIRAGE_SETUP_RUNTIME: setupRuntime, [START_CHANNEL_ENV]: channel.address },
    });
    // The exit of the runtime's process, as the event of this child; a handle that already shows its exit has it.
    exited = new Promise((resolve) => {
      if (child.exitCode != null || child.signalCode != null)
        resolve({ code: child.exitCode ?? null, signal: child.signalCode ?? null });
      else child.once?.('exit', (code, signal) => resolve({ code, signal }));
    });
    startup.child(child);
  } catch (error) {
    await logHandle.close();
    await channel?.close().catch(() => {});
    throw new Error(`Could not start Mirage: ${error.message}. Startup log: ${log}`, { cause: error });
  }
  await logHandle.close();
  child.unref();
  const discovery = path.join(paths.discoveryRoot, `session-${child.pid}.json`);
  // The record of this child: another host's record may carry the same PID number.
  const childRecord = (item) => item.pid === child.pid && !startup.isForeign(item);
  // Removes the child's discovery file, unless another host's runtime with this PID number wrote that file.
  const removeOwnDiscovery = async () => {
    try {
      if (foreignRecord(JSON.parse(await fs.readFile(discovery, 'utf8')), startup.hostName)) return;
    } catch {
      /* missing or incomplete: the child's own, or nothing */
    }
    await fs.rm(discovery, { force: true }).catch(() => {});
  };
  let registered = false;
  startup.cleanup(async () => {
    await channel.close().catch(() => {});
    await removeOwnDiscovery();
    // No ownership entry was published if cancellation interrupted its lock
    // acquisition. Published records get a bounded best-effort cleanup; a
    // contended foreign lock must not hold the cancelled command open.
    if (registered)
      await updateOwnedSessions(paths, (sessions) => sessions.filter((item) => !childRecord(item)), {
        signal: AbortSignal.timeout(1000),
      }).catch(() => {});
  });
  args.startup?.phase('process ownership', cfg.siteName);
  const childIdentity =
    startup.startIdentity ?? (await startup.identityOf(child.pid, { signal: startup.signal, recorded: null }));
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
      ...otherSessionsForStart(sessions, identity, child.pid, {
        alive: startup.alive,
        identities,
        isForeign: startup.isForeign,
        ownershipFile: paths.ownershipFile,
      }),
      {
        pid: child.pid,
        processIdentity: childIdentity,
        host: startup.hostName,
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
    // This command holds the runtime as its own child: while that handle shows no exit, a signal through it reaches
    // the runtime and nothing else. A PID would have to be shown to still be the runtime's first (an identity read,
    // which a start token's pipe alone does not prove), so a PID is signalled only for a caller that supplies `kill`.
    if (startup.kill === process.kill && typeof child.kill === 'function') {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already exited */
        }
      }
    } else if (
      childIdentity &&
      startup.alive(child.pid) &&
      (await startup.identityOf(child.pid, { signal: startup.signal, recorded: childIdentity })) === childIdentity
    ) {
      try {
        startup.kill(child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
    await removeOwnDiscovery();
    await updateOwnedSessions(
      paths,
      (sessions) => sessions.filter((item) => !(childRecord(item) && item.processIdentity === childIdentity)),
      { signal: startup.signal },
    ).catch(() => {});
  };
  const capAt = started + STARTUP_ABSOLUTE_CAP;
  args.startup?.phase('import, state restore and presets', identity.runtime?.kind ?? 'power-pages');
  /**
   * The session of the runtime once it has published its discovery record and answers its status; null until then.
   * `limit` bounds the status question in milliseconds.
   */
  const readySession = async (limit) => {
    let record;
    try {
      record = JSON.parse(await fs.readFile(discovery, 'utf8'));
    } catch {
      startup.check(); /* the runtime has not written its discovery file yet */
      return null;
    }
    // Another host's runtime with this PID number wrote it: this child has not published its record yet.
    if (foreignRecord(record, startup.hostName)) return null;
    const portal = Array.isArray(record.portals)
      ? (record.portals.find((item) => item.id === (identity.portal ?? '')) ?? record.portals[0])
      : null;
    // The machine name stays in the records: a start report does not publish it.
    const { portals: ignoredPortals, host: ignoredHost, ...base } = record; // NOSONAR: binding is excluded from the rest object or is a placeholder
    const session = { ...base, ...portal, id: portal?.id, discovery, processAlive: true, ready: false, runtime: null };
    session.runtime = await readRuntime(session.url, session.id ?? cfg.siteName, {
      signal: startup.signal,
      timeout: limit,
    });
    startup.check();
    session.ready = Boolean(session.runtime);
    if (!session.ready) return null;
    await updateOwnedSessions(
      paths,
      (sessions) => [
        ...sessions.filter((item) => !(item.pid === session.pid && !startup.isForeign(item))),
        {
          pid: session.pid,
          processIdentity: childIdentity,
          host: startup.hostName,
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
    await channel.close().catch(() => {});
    // A note only: a folder that cannot take it still has the runtime recorded in its own ownership folder.
    await rememberRecordFolder(paths).catch(() => {});
    const result = {
      ...session,
      // The simulation level the runtime was started with, on every start path, when the runtime does not report one.
      ...(session.runtime && !session.runtime.simulation && identity.simulation
        ? { runtime: { ...session.runtime, simulation: identity.simulation } }
        : {}),
      owned: true,
      started: true,
      log,
      launch,
      writesFiles: [identity.stateFile, discovery, log, paths.ownershipFile].filter(
        (file) => file && fsSync.existsSync(file),
      ),
    };
    Object.defineProperty(result, 'exited', { value: exited, enumerable: false });
    return result;
  };
  // The start waits for what happens next, never for an interval: an announcement of the runtime (a phase, that its
  // event loop turns, that it is ready), the exit of its process, the caller's interrupt, or the end of the start-up
  // silence bound, which every announcement moves.
  let lastProgress = startup.now();
  const silenceEnd = () => Math.min(lastProgress + timeout, capAt);
  const runtimeExit = exited.then(() => ({ exit: true }));
  try {
    while (!startup.cancelled()) {
      const bound = silenceEnd() - startup.now();
      if (bound <= 0) {
        // An announcement can be lost (its channel is best effort); the record it would have announced is not.
        const late = await readySession();
        if (late) return late;
        break;
      }
      const waiting = new AbortController();
      const silent = () => ({ silent: true });
      const event = await Promise.race([
        channel.next(),
        runtimeExit,
        Promise.resolve(startup.sleep(bound, { signal: AbortSignal.any([startup.signal, waiting.signal]) })).then(
          silent,
          silent,
        ),
      ]);
      waiting.abort();
      startup.check();
      if (event.exit) {
        await abandon();
        throw await exitedBeforeReady(log, paths.logRoot);
      }
      if (!event.phase) continue;
      lastProgress = startup.now();
      if (event.phase === RUNTIME_READY) {
        // The CLI reports a fractional elapsed time; a fetch deadline is whole milliseconds.
        const session = await readySession(Math.max(1, Math.ceil(silenceEnd() - lastProgress)));
        if (session) return session;
      } else if (event.phase !== RUNTIME_ALIVE)
        args.startup?.phase(event.phase.replaceAll('-', ' '), `${cfg.siteName}; ${event.elapsedMs}ms runtime elapsed`);
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

const STATE_FOLDER_BLOCKED = new Set(['ENOTDIR', 'EEXIST']);
const STATE_FOLDER_READ_ONLY = new Set(['EACCES', 'EPERM', 'EROFS']);

/** The nearest existing path at or above `folder`: what blocks, or would hold, the folder that could not be made. */
function nearestExisting(folder) {
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    let stats = null;
    try {
      stats = fsSync.statSync(current, { throwIfNoEntry: false }) ?? null;
    } catch {
      /* below a file, or unreadable: look further up */
    }
    if (stats || path.dirname(current) === current) return { path: current, stats };
  }
}

/**
 * Creates a folder of the local state (.paqvilo). A file in its place, or a place that cannot be written, is reported
 * with the folder, the cause and the next step; any other failure is passed on unchanged.
 */
export async function createStateFolder(folder, { mkdir = fs.mkdir } = {}) {
  try {
    await mkdir(folder, { recursive: true });
  } catch (error) {
    const blocked = STATE_FOLDER_BLOCKED.has(error?.code);
    if (!blocked && !STATE_FOLDER_READ_ONLY.has(error?.code)) throw error;
    const existing = nearestExisting(folder);
    const at = existing.stats ? existing.path : (error.path ?? folder);
    const reason = blocked
      ? `${at} exists but is not a folder (${error.code}). Remove or rename it`
      : `${at} is not writable (${error.code}). Allow writing there`;
    throw Object.assign(
      new Error(
        `Cannot create the local state folder ${folder}: ${reason}, or run from a project folder you can write to.`,
        { cause: error },
      ),
      { code: error.code },
    );
  }
}

async function exitedBeforeReady(log, logRoot) {
  const output = await readLocalFile(log, { root: logRoot, encoding: 'utf8' }).catch(() => '');
  // The runtime's start-up progress records stay in the log for progress consumers; the message keeps what it said.
  const said = output
    .split(/\r?\n/)
    .filter((line) => !runtimeStartupEvent(line.trim()))
    .join('\n')
    .trim();
  const details = said ? '\n' + said.slice(-3000) : '';
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
      (await startup.identityOf(session.pid, { signal: startup.signal, recorded: owner.processIdentity })) !==
        owner.processIdentity
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
  // The same settings: a start that is still running, or one made at the same moment, recorded this runtime.
  if (identityMatches(entry.identity, identity))
    return new Error(
      `Mirage pid ${entry.pid} is already starting (or running) for state file ${identity.stateFile} with the same settings; wait until it is ready and run the command again to reuse it, or stop it with ${stop}.`,
    );
  return new Error(
    `Mirage pid ${entry.pid} already uses state file ${identity.stateFile} with different settings; stop it with ${stop} or pass --state <other file>.`,
  );
}

/** A runtime recorded on another host on this state file: this host can neither judge nor stop its process. */
function foreignStateFileOwner(entry, identity, ownershipFile) {
  return new Error(
    `Mirage pid ${entry.pid} on ${entry.host} is recorded for state file ${identity.stateFile}; this host cannot see or stop that process. Stop it on ${entry.host} (which also clears its record) or pass --state <other file>. If it no longer runs on ${entry.host} (the host was renamed or removed), delete its entry from ${ownershipFile}.`,
  );
}

/**
 * A live runtime with a verified start identity owns this state file with other settings: its saves would be
 * overwritten. A runtime recorded on another host on this state file refuses any start here.
 */
async function refuseStateFileOwner(
  owned,
  identity,
  { signal, identityOf, alive = isAlive, isForeign, ownershipFile },
) {
  for (const entry of owned) {
    if (isForeign(entry)) {
      if (sharesStateFile(entry, identity.stateFile)) throw foreignStateFileOwner(entry, identity, ownershipFile);
      continue;
    }
    if (!entry.processIdentity || !alive(entry.pid) || !sharesStateFile(entry, identity.stateFile)) continue;
    if (identityMatches(entry.identity, identity)) continue;
    if ((await identityOf(entry.pid, { signal, recorded: entry.processIdentity })) === entry.processIdentity)
      throw stateFileConflict(entry, identity);
  }
}

/**
 * Identities of the live records on this state file, read before the ownership lock: a read of the operating system
 * can take far longer than a read-modify-write, and other commands would wait on the lock meanwhile.
 */
async function rivalIdentities(paths, { childPid, identity, startup }) {
  const identities = new Map();
  for (const item of await ownedSessions(paths)) {
    if (startup.isForeign(item)) continue;
    if (item.pid === childPid || !item.processIdentity || !startup.alive(item.pid)) continue;
    if (sharesStateFile(item, identity.stateFile))
      identities.set(item.pid, {
        recorded: item.processIdentity,
        current: await startup.identityOf(item.pid, { signal: startup.signal, recorded: item.processIdentity }),
      });
  }
  return identities;
}

/**
 * Runs under the ownership lock, where a concurrent start's record is visible: a live rival on this state file
 * refuses the start, whose child the caller then stops. A record whose process has exited, or whose PID no longer
 * carries its start identity, belongs to an exited runtime, so it is dropped instead. A record of a live process whose
 * identity cannot be read is kept. Another
 * host's record is always kept, and refuses the start when it is on this state file.
 * The identities come from `identities`, read before the lock, so this stays synchronous.
 */
function otherSessionsForStart(
  sessions,
  identity,
  startedPid,
  { alive = isAlive, identities = new Map(), isForeign, ownershipFile } = {},
) {
  const kept = [];
  for (const item of sessions) {
    if (isForeign(item)) {
      if (sharesStateFile(item, identity.stateFile)) throw foreignStateFileOwner(item, identity, ownershipFile);
      kept.push(item);
      continue;
    }
    if (item.pid === startedPid) continue;
    // A local record whose process has exited owns nothing any more. Without this, runtimes that were killed leave
    // one record each until the next `mirage stop`.
    if (!alive(item.pid)) continue;
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
  // --solution-root replaces the catalogued roots in the written project, as it does for start and dev.
  let listed = args['solution-root']?.length
    ? args['solution-root'].map((root) => path.resolve(root))
    : configured.solutionRoots;
  if (!listed?.length)
    listed = await (await import('../../mirage/lib/solution-roots.mjs')).discoverSolutionRoots(cfg.sourceDir);
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
    // A project file holds no runtime options: the dev command it prints carries them on, as for a standalone runtime.
    next: mirageCommandHint(
      [['mirage', 'dev', ...hintScope(cfg, args), '--project', file, ...runtimeNextArguments(args)]],
      hintOptions(cfg),
    ),
  };
}

/** The runtime options of an init command line (--state, --port, --preset, --preset-mode), for the dev it prints. */
function runtimeNextArguments(args, keys = ['port', 'preset', 'preset-mode']) {
  const parts = args.state ? ['--state', path.resolve(args.state)] : [];
  for (const key of keys) if (args[key] !== undefined) parts.push('--' + key, String(args[key]));
  return parts;
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
        ...(observed ? { observed: portableObserved(observed, base, cfg.configDir) } : {}),
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

/**
 * Observed behaviour with each plug-in source root written as portablePluginRoot writes it, so the project keeps
 * working when the folder moves or is shared.
 */
function portableObserved(observed, base, configDir) {
  if (!observed.pluginSources || !configDir) return observed;
  const portable = ({ root, ...source }) => {
    const written = root ? portablePluginRoot(root, base, configDir) : undefined;
    return written === undefined ? source : { ...source, root: written };
  };
  return {
    ...observed,
    pluginSources: Object.fromEntries(
      Object.entries(observed.pluginSources).map(([name, source]) => [name, portable(source)]),
    ),
  };
}

/**
 * The project-file value of a resolved (absolute) plug-in source root. The project file resolves a relative root
 * against its own folder `base` (mirage/lib/project-config.mjs), so the value always resolves back to `root`:
 * undefined when `root` is `base` (the reader's default), a `/`-separated path relative to `base` when `root` is
 * inside the catalogue folder `configDir`, else `root` unchanged (outside the catalogue folder or on another drive).
 * `paths` is the path module of the platform the paths belong to.
 */
export function portablePluginRoot(root, base, configDir, paths = path) {
  const fromCatalogue = paths.relative(configDir, root);
  if (paths.isAbsolute(fromCatalogue) || fromCatalogue.split(paths.sep)[0] === '..') return root;
  const fromProject = paths.relative(base, root);
  if (!fromProject) return undefined;
  return paths.isAbsolute(fromProject) ? root : fromProject.split(paths.sep).join('/');
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
async function startPlans(plans, paths, host = SYSTEM_HOST) {
  const clashes = portClashes(plans.filter((plan) => !plan.error));
  if (clashes.length)
    throw new Error(
      `Each Mirage needs its own port (${clashes.join('; ')}). Set sites.<id>.mirage.port to distinct ports, or 0 for any free port.`,
    );
  const results = await Promise.allSettled(
    plans.map((plan) => (plan.error ? Promise.reject(plan.error) : host.start(plan.cfg, plan.args, { paths }))),
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

export async function stopStarted(
  portals,
  paths,
  stop = stopOwnedSessions,
  { source = process, alive = isAlive, host = SYSTEM_HOST } = {},
) {
  await guardShutdownSignals(
    async (interrupt) => {
      for (const portal of portals.filter((item) => item.session?.started)) {
        const report = await stop({ paths, pids: [portal.session.pid], interrupt }).catch((error) => ({
          stopped: [],
          error,
        }));
        if (stoppedOrGone(report, portal.session.pid, alive)) {
          if (report.stopped?.length)
            console.log(`mirage   stopped ${portal.site} ${portal.session.url} (pid ${portal.session.pid})`);
          else console.log(`mirage   ${portal.site} ${portal.session.url} (pid ${portal.session.pid}) already stopped`);
        } else {
          let retry;
          try {
            retry = `run: ${await sessionStopHint([portal], paths, { cleanupOnError: false, host })}`;
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
async function runPortals({ cfg, args, action, plans, paths, initialSite, host = SYSTEM_HOST, selection }) {
  const portals = await startPlans(plans, paths, host);
  const running = portals.filter((portal) => portal.session);
  const stop = await sessionStopHint(running, paths, { host, selection });
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
        `No Mirage portal could start; see the messages above. A Mirage-only site opens its own browser with "${paqviloCommand(['mirage', 'dev'], { config: cfg.configFile, extra: ['--site', '<id>'] })}".`,
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
    await stopStarted(portals, paths, host.stop, { alive: host.alive, host });
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

/** The runtimes `mirage stop` selects for every catalogue site (portals: all). */
async function cataloguePortalPids(entries, paths) {
  const pids = [];
  for (const { cfg: site } of entries) {
    if (!site) continue;
    const effective = catalogueArgs(site, {}, { requireProject: false });
    const project = effective.project ? await selectedProjectOf(effective.project, paths) : null;
    pids.push(
      ...(await selectedSessionPids(
        paths,
        site,
        effective.runtime ?? project?.runtime?.kind ?? site.runtime?.kind ?? 'power-pages',
        project,
        {},
        project ? null : site.sourceDir,
      )),
    );
  }
  return pids;
}

/** The runtimes `mirage stop` selects for a project with several Power Pages portals. */
async function projectPortalPids(paths, cfg, project, args) {
  const base = args.port === undefined ? undefined : runtimePort(args.port, DEFAULT_PORT);
  // A broad project stop includes recorded portals that were renamed or
  // removed since launch. A nonzero explicit base still selects the current
  // project's consecutive per-portal ports, matching projectStartPlans.
  if (base === undefined || base === 0) return selectedSessionPids(paths, cfg, 'power-pages', project, args);
  const pids = [];
  for (const [index, portal] of project.portals.entries())
    pids.push(
      ...(await selectedSessionPids(paths, cfg, 'power-pages', project, {
        ...args,
        portal: portal.id,
        port: String(base + index),
      })),
    );
  return pids;
}

/**
 * A selected project file; one that no longer exists still selects the runtimes recorded for it (`missing`), with
 * the runtime kind they were started with.
 */
async function selectedProjectOf(file, paths) {
  const configFile = path.resolve(file);
  if (isFile(configFile)) return loadProject(configFile);
  const recorded = (await ownedSessionsIn(await recordFolders(paths, configFile))).find((entry) =>
    samePath(entry.project, configFile),
  );
  return { configFile, portals: [], runtime: recorded?.identity?.runtime ?? { kind: 'power-pages' }, missing: true };
}

/**
 * What `mirage stop` selects for these arguments under the selection rule above (miragePaths): the PIDs, the selected
 * project and the runtime kind. status lists the same selection.
 */
async function stopSelection(cfg, args, paths) {
  if (severalPortals(cfg, args, 'stop'))
    return { pids: await cataloguePortalPids(await portalConfigs(cfg, args, 'stop'), paths), project: null };
  const effective = catalogueArgs(cfg, args, { requireProject: false });
  const project = effective.project ? await selectedProjectOf(effective.project, paths) : null;
  if (project && !effective.portal && !project.missing && hasSeveralPowerPagesPortals(effective, project))
    return { pids: await projectPortalPids(paths, cfg, project, args), project, kind: 'power-pages' };
  const kind = effective.runtime ?? project?.runtime?.kind ?? cfg.runtime?.kind ?? 'power-pages';
  const sourceDir = kind === 'power-pages' && !project ? cfg.sourceDir : null;
  const pids = await selectedSessionPids(paths, cfg, kind, project, args, sourceDir);
  if (!effective.runtime && !project) pids.push(...(await siteStandalonePids(paths, cfg, args, kind)));
  return { pids: [...new Set(pids)], project, kind };
}

/**
 * The standalone runtimes a catalogue site selection names besides those of its own kind: the ones started for that
 * site with --runtime, and, for a selection without selectors, the ones started in the folder without a catalogue site
 * or project (they belong to that folder).
 */
async function siteStandalonePids(paths, cfg, args, kind) {
  const pids = [];
  const unscoped = { ...cfg, configFile: null, catalogueScope: null };
  const bare = !args.config && !args.site && !args.project;
  for (const other of RUNTIME_KINDS.filter((item) => item !== 'power-pages')) {
    if (other !== kind && catalogueIdentity(cfg))
      pids.push(...(await selectedSessionPids(paths, cfg, other, null, args)));
    if (bare) pids.push(...(await selectedSessionPids(paths, unscoped, other, null, args)));
  }
  return pids;
}

/** A brief of each toolkit-owned runtime that is outside the selection, with the status command that names it. */
function outsideSelection(entries) {
  return entries.map((entry) => {
    const scope = entry.identity?.scope;
    let selectors = [];
    if (entry.project) selectors = ['--project', entry.project];
    else if (scope?.configFile)
      selectors = ['--config', scope.configFile, '--site', scope.catalogueSite ?? scope.siteName];
    return {
      pid: entry.pid,
      url: entry.url ?? null,
      project: entry.project ?? null,
      site: scope ? (scope.catalogueSite ?? scope.siteName) : null,
      status: paqviloCommand(['mirage', 'status'], { extra: selectors }),
    };
  });
}

/** The live toolkit-owned runtimes recorded in the folders the selection reads that it does not select. */
async function othersOf(host, paths, selection) {
  const folders = await recordFolders(paths, selection.project?.configFile);
  const recorded = await ownedSessionsIn(folders);
  const isForeign = await foreignJudge(recorded, { hostName: lockHost(), alive: host.alive });
  const entries = recorded.filter(
    (entry) => !isForeign(entry) && !selection.pids.includes(entry.pid) && host.alive(entry.pid),
  );
  return outsideSelection(entries);
}

const othersNote = (others) =>
  others.length
    ? ` ${others.length} other toolkit-owned Mirage session(s) outside this selection are running; list each with: ${others.map((item) => item.status).join(' | ')}`
    : '';

/**
 * The runtimes status lists for the selection that no toolkit start owns, such as a foreground `mirage serve`: they
 * have no recorded start identity, so stop never signals them (stopOwnedSessions) and names them instead.
 */
async function foregroundSessions(cfg, args, paths, host) {
  try {
    const { sessions } = await selectedStatus(cfg, args, paths, host);
    return sessions
      .filter((session) => !session.owned && session.processAlive)
      .map(({ pid, url }) => ({ pid, url: url ?? null }));
  } catch {
    return [];
  }
}

const foregroundNote = (foreground) => {
  if (!foreground.length) return '';
  const one = foreground.length === 1;
  const names = foreground.map((item) => `${item.url ?? '(no URL yet)'} (pid ${item.pid})`).join(', ');
  return ` ${foreground.length} foreground ${one ? 'runtime is' : 'runtimes are'} not stopped by stop: ${names}; press Ctrl+C in ${one ? 'its terminal' : 'their terminals'}.`;
};

/* NOSONAR */ async function miragePortals(cfg, args, action, paths, host = SYSTEM_HOST) {
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
        next: host.commandHint([['mirage', 'dev', ...hintScope(cfg, args, true)]], { cli: TOOLKIT_CLI }),
      },
      args.json,
    );
    return projects.some((project) => project.error) ? 1 : 0;
  }
  if (action === 'stop') {
    const pids = await cataloguePortalPids(entries, paths);
    const report = await stopSelected(host, paths, pids);
    if (report.remaining.length) throw new Error(stillRunning(report));
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
    host,
    // `stop --portals all` selects every catalogue site's runtimes (severalPortals, cataloguePortalPids).
    selection: catalogueOwnedState(cfg) && {
      args: () => hintScope(cfg, args, true),
      pids: () => cataloguePortalPids(entries, paths),
    },
  });
}

/** A project with several portals and no --portal: one runtime per portal of that project. */
async function mirageProjectPortals(cfg, args, effective, action, project, paths, host = SYSTEM_HOST) {
  if (action === 'stop') {
    const pids = await projectPortalPids(paths, cfg, project, args);
    const report = await stopSelected(host, paths, pids, project.configFile);
    if (report.remaining.length) throw new Error(stillRunning(report));
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
    host,
    // Each runtime's stop command up to its project file, without --portal, selects every portal of the project.
    selection: {
      args: ([first]) => {
        const parts = sessionStopArguments(first.cfg, first.args, first.session);
        const at = parts.indexOf('--project');
        return at < 0 ? null : parts.slice(0, at + 2);
      },
      pids: () => projectPortalPids(paths, cfg, project, { ...args, port: undefined, state: undefined }),
    },
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
  parts.push(...runtimeNextArguments(args, ['port', 'simulation', 'preset', 'preset-mode']));
  for (const root of args['solution-root'] ?? []) parts.push('--solution-root', path.resolve(root));
  return parts;
}

function sessionStopArguments(cfg, args, session) {
  const launch = session.launch;
  // A project runtime recorded without a catalogue scope (projectOnlyLaunch) is selected by its project file alone.
  const projectOnly =
    launch.project && projectOnlyLaunch(cfg, args, { configFile: launch.project, runtime: launch.runtime });
  const parts = projectOnly ? [...(args.repo ? ['--repo', path.resolve(args.repo)] : [])] : hintScope(cfg, args);
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

/* NOSONAR */ async function sessionStopHint(
  portals,
  paths,
  { cleanupOnError = true, host = SYSTEM_HOST, selection } = {},
) {
  const own = stopCommands(portals);
  if (!own.length) return null;
  const options = { ...stopHintOptions(portals, own), lines: true };
  const commands = (await sharedStopCommand(portals, selection)) ?? own;
  // One command is the stop hint of its runtimes; several are one batch with each runtime's own selectors.
  const format = (storePayload) => host.commandHint(commands, { ...options, storePayload });
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
        cleanup = await guardShutdownSignals((interrupt) => host.stop({ paths, pids: started, interrupt }));
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

/**
 * The one stop selection that started runtimes share (`selection.args(portals)`), when the runtimes it selects
 * (`selection.pids()`) are exactly the ones running: a readable hint instead of one command per runtime.
 */
async function sharedStopCommand(portals, selection) {
  if (!selection || portals.length < 2) return null;
  const args = selection.args(portals);
  const selected = args && new Set(await selection.pids().catch(() => []));
  if (!selected || selected.size !== portals.length || portals.some(({ session }) => !selected.has(session.pid)))
    return null;
  return [['mirage', 'stop', ...args]];
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

/** A diagnostic inspection can legitimately return a report with exit status 1. */
export function inspectProcessResult(result) {
  if (result.error) throw result.error;
  let report;
  const failed = () => {
    const exit = result.signal ? 'was terminated by ' + result.signal : 'exited with ' + result.status;
    // With --json the runtime CLI reports its own failure on stdout ({ ok: false, error: { message } }).
    const reported = typeof report?.error?.message === 'string' ? report.error.message.trim() : '';
    return new Error(String(result.stderr ?? '').trim() || reported || `Mirage inspect ${exit}`);
  };
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

/** The text of a status report: the selected sessions, then every other toolkit-owned one with how to list it. */
function printStatus(value) {
  if (value.projectMissing)
    console.log(`The project file ${value.projectMissing} no longer exists; listing the runtimes recorded for it.`);
  const others = value.others ?? [];
  if (!value.sessions.length && others.length) console.log('No Mirage session in this selection.');
  else printSessions(value.sessions);
  if (!others.length) return;
  console.log(`${others.length} other toolkit-owned Mirage session(s) outside this selection:`);
  for (const other of others) console.log(`  ${other.pid} ${other.url ?? '(starting)'}  list it with: ${other.status}`);
}

/** Prints a lifecycle report: the JSON document with `json`, else its text form. */
export function print(value, json) {
  if (json) {
    printJson(value);
    return;
  }
  if (value.sessions) {
    printStatus(value);
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

/** A running runtime no toolkit start owns (foregroundSessions) is labelled foreground: stop does not stop it. */
const foregroundLabel = (session) => {
  if (session.owned) return ' · toolkit managed';
  return session.processAlive ? ' · foreground' : '';
};

function printSessions(sessions) {
  if (!sessions.length) console.log('No Mirage sessions found.');
  for (const session of sessions) printSession(session);
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ function printSession(session) {
  let state;
  if (session.ready) state = 'ready';
  // A runtime that was not known to be ready and gave no answer in time may be busy: that is not "starting".
  else if (session.processAlive) state = session.probe === PROBE_NO_ANSWER ? 'no answer yet' : 'starting';
  else state = 'stopped';
  const site = session.site ? '  [' + session.site + ']' : '';
  const runtime = session.runtime?.site
    ? '  (' + session.runtime.site + ', ' + session.runtime.pageCount + ' pages)'
    : '';
  console.log(
    `${state}${foregroundLabel(session)}${site}  ${session.url ?? '(no URL yet)'}  ${session.sourceDir ?? ''}${runtime}`,
  );
  const details = [
    session.adminUrl && `admin ${session.adminUrl}`,
    session.identityProvider?.origin && `idp ${session.identityProvider.origin}`,
    // The organization URL of the simulated Dataverse API (mirage/docs/dataverse-api.md) and its token authority.
    session.runtime?.links?.dataverseApi && `dataverse api ${session.runtime.links.dataverseApi}`,
    session.runtime?.links?.dataverseAuthority && `authority ${session.runtime.links.dataverseAuthority}`,
    session.runtime?.liveWrites && `live writes ${session.runtime.liveWrites}`,
    session.project && `project ${session.project}`,
    session.portal && `portal ${session.portal}`,
    session.stateFile && `state ${session.stateFile}`,
    `pid ${session.pid}`,
  ].filter(Boolean);
  console.log(`    ${details.join(' · ')}`);
  // Ready on the evidence of its own record, without an answer now: what only the answer reports is unknown.
  if (session.ready && session.probe === PROBE_NO_ANSWER)
    console.log(
      '    the runtime did not answer this status in time, so its site, pages and preset are not shown; run the status again',
    );
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
  // A hint of one readable command per runtime continues under the first.
  if (value.stop) console.log(`Stop:      ${value.stop.replaceAll('\n', '\n           ')}`);
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
  const state =
    value.runtime?.simulation?.level === 'dry-run' ? 'not persisted (dry-run keeps state in memory)' : value.stateFile;
  const kind = value.runtime?.runtime?.kind ?? value.launch?.runtime?.kind;
  console.log(`Mirage: ${value.url}${value.started === false ? '  (already running)' : ''}`);
  console.log(`Admin:     ${value.adminUrl}`);
  console.log(`State:     ${state}`);
  if (value.sourceDir) console.log(`Source:    ${value.sourceDir}`);
  console.log(`Live writes: ${liveWritesText(value.runtime?.liveWrites, kind)}`);
  // A standalone runtime has no portal source; its organization API is what it serves.
  if (value.runtime?.links?.dataverseApi) console.log(`Dataverse API: ${value.runtime.links.dataverseApi}`);
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
  // These options keep their own explanation (an invalid_argument); any other option outside the action's table is
  // refused below as unsupported_option.
  if (action === 'dev' && args.json)
    throw new Error(
      'mirage dev is interactive; use mirage start --json and agent commands for structured session access',
    );
  if (action !== 'init' && (args.out !== undefined || args.force))
    throw new Error('--out and --force apply only to mirage init');
  if (args['allow-live-writes'] && !['start', 'dev'].includes(action))
    throw new Error('--allow-live-writes applies only to mirage dev and start');
  validateAllowedOptions(args, action, MIRAGE_ACTION_OPTIONS[action]);
  validateOptionValues(args);
}

const VALUE_CHOICES = {
  runtime: RUNTIME_KINDS,
  simulation: ['dry-run', 'simulation', 'deep'],
  'preset-mode': ['bootstrap', 'always'],
};

/** The values of every action's options, checked before an action reads or writes anything. */
function validateOptionValues(args) {
  if (args.port !== undefined) runtimePort(args.port, DEFAULT_PORT);
  for (const [option, choices] of Object.entries(VALUE_CHOICES))
    if (args[option] !== undefined && !choices.includes(args[option]))
      throw new Error(`--${option} must be ${choices.slice(0, -1).join(', ')} or ${choices.at(-1)}`);
  if (args['startup-timeout'] === undefined) return;
  const timeout = Number(args['startup-timeout']);
  if (!/^\d+$/.test(args['startup-timeout']) || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000)
    throw new Error(
      '--startup-timeout must be an integer from 1000 to 600000 milliseconds: the longest start-up silence allowed',
    );
}

function validateAllowedOptions(args, action, allowedOptions) {
  const allowed = new Set(allowedOptions);
  // Only command-line options are checked; a caller's own values (such as the startup progress) are not options.
  for (const option of Object.keys(args))
    if (Object.hasOwn(LENSE_OPTIONS, option) && !allowed.has(option))
      throw Object.assign(new Error(`--${option} is not supported by mirage ${action}`), {
        code: 'unsupported_option',
      });
}

/**
 * `paqvilo mirage <action>`. `runtimeHost` replaces how the command reaches processes (see hostOf); the command line
 * passes none.
 */
/* NOSONAR */ export default async function mirage(cfg, args, positionals = [], runtimeHost = undefined) {
  const action = positionals[0] ?? 'status';
  validateMirageArguments(args, action);
  const paths = miragePaths(cfg, args);
  const host = runtimeHost ? hostOf(runtimeHost) : SYSTEM_HOST;
  if (action === 'status') {
    const { sessions, others, project } = await selectedStatus(cfg, args, paths, host);
    print(
      {
        action: 'status',
        sessions,
        ...(others.length ? { others } : {}),
        ...(project?.missing ? { projectMissing: project.configFile } : {}),
      },
      args.json,
    );
    return 0;
  }
  if (action === 'stop' && !cfg) return stopRemovedCatalogue(args, paths, host);
  if (severalPortals(cfg, args, action)) return miragePortals(cfg, args, action, paths, host);
  if (action === 'init') {
    print(await initProject(cfg, args), args.json);
    return 0;
  }
  const effective = catalogueArgs(cfg, args, { requireProject: action !== 'stop' });
  if (['start', 'dev', 'stop'].includes(action) && effective.project && !effective.portal) {
    const project =
      action === 'stop' ? await selectedProjectOf(effective.project, paths) : await loadProject(effective.project);
    if (!project.missing && hasSeveralPowerPagesPortals(effective, project))
      return mirageProjectPortals(cfg, args, effective, action, project, paths, host);
  }
  if (action === 'stop') {
    // Stop joins the recorded project/portal identity; current mappings can
    // legitimately point elsewhere or no longer contain the launched portal.
    const selection = await stopSelection(cfg, args, paths);
    const { pids, project, kind } = selection;
    const others = await othersOf(host, paths, selection);
    const report = await stopSelected(host, paths, pids, project?.configFile);
    if (report.remaining.length)
      throw new Error(
        kind === 'power-pages' ? stillRunning(report) : 'An owned standalone Mirage session did not stop.',
      );
    const label = kind === 'power-pages' && !project ? siteSelectionLabel(cfg, args) : (project?.configFile ?? kind);
    const missing = project?.missing
      ? ` The project file ${project.configFile} no longer exists; the runtimes recorded for it were selected.`
      : '';
    const foreground = await foregroundSessions(cfg, args, paths, host);
    print(
      {
        action: 'stop',
        message: stopSummary(report, label, label) + missing + othersNote(others) + foregroundNote(foreground),
        ...report,
        ...(others.length ? { others } : {}),
        ...(foreground.length ? { foreground } : {}),
      },
      args.json,
    );
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
  const session = await host.start(cfg, effective, { paths, command: `mirage ${action}` });
  args.startup?.phase(
    'runtime listener',
    session.started ? 'listening; application readiness pending' : 'reused; application readiness pending',
  );
  const { launch } = session;
  const adminUrl = session.adminUrl ?? adminUrlOf(session.url);
  const stateFile = session.stateFile ?? launch.stateFile;
  const stop = await sessionStopHint([{ cfg, args: effective, session }], paths, { host });
  if (action === 'dev') {
    if (launch.runtime?.kind && launch.runtime.kind !== 'power-pages') {
      const { controller, interrupt, runtimeEnded, interrupted } = codeAppInterrupt();
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      const codeAppRuntime = endSessionOnRuntimeExit(session, controller, runtimeEnded);
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
        await guardShutdownSignals((interrupt) =>
          stopDevelopmentSession(servers, session, paths, stop, {
            runtime: codeAppRuntime,
            stopSessions: host.stop,
            alive: host.alive,
            interrupt,
          }),
        );
      }
    }
    const { controller, interrupt, runtimeEnded, interrupted } = codeAppInterrupt();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const runtime = endSessionOnRuntimeExit(session, controller, runtimeEnded);
    let codeAppServers;
    let codeApps;
    try {
      ({ apps: codeApps, servers: codeAppServers } = await startProjectCodeApps(cfg, launch, session, controller));
    } catch (error) {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      runtime.ending = true;
      if (session.started && !runtime.exit)
        await guardShutdownSignals((interrupt) => host.stop({ paths, pids: [session.pid], interrupt }));
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
      await guardShutdownSignals((interrupt) =>
        stopDevelopmentSession(codeAppServers, session, paths, stop, {
          runtime,
          stopSessions: host.stop,
          alive: host.alive,
          interrupt,
        }),
      );
    }
  }
  print({ action: 'start', ...session, adminUrl, stateFile, stop }, args.json);
  args.startup?.complete('runtime listening; no browser application readiness was requested');
  return 0;
}

/** A stop that found nothing to stop because the process had already exited stopped it. */
const stoppedOrGone = (report, pid, alive = isAlive) =>
  Boolean(report.stopped?.length) || (!report.error && !report.remaining?.length && !alive(pid));

export async function stopDevelopmentSession(
  codeAppServers,
  session,
  paths,
  stop,
  { stopSessions = stopOwnedSessions, report = console.error, alive = isAlive, runtime, interrupt } = {},
) {
  // The teardown starts here: the runtime's exit from now on is expected, so its listener stays silent.
  if (runtime) runtime.ending = true;
  runtime?.stopWatching?.();
  try {
    await codeAppServers?.close();
  } finally {
    if (session.started) {
      const outcome = await stopSessions({ paths, pids: [session.pid], interrupt }).catch((error) => ({
        stopped: [],
        remaining: [{ pid: session.pid }],
        error,
      }));
      if (stoppedOrGone(outcome, session.pid, alive)) {
        if (outcome.stopped.length) console.log(`mirage   stopped ${session.url} (pid ${session.pid})`);
        else console.log(`mirage   ${session.url} (pid ${session.pid}) already stopped`);
      } else {
        const errorMessage = outcome.error ? ': ' + outcome.error.message : '';
        report(`mirage   could not stop pid ${session.pid}${errorMessage}; run: ${stop}`);
        process.exitCode ||= 1;
      }
    }
  }
}

/**
 * The sessions `mirage status` lists under the selection rule above (miragePaths): the runtimes stop would select for
 * the same arguments, plus a runtime the toolkit does not own when it serves the selected project or site source
 * (or no selector was given), and the other toolkit-owned runtimes found in the same records (`others`).
 * Without a configuration (no selector and no readable catalogue) every recorded runtime is listed.
 */
/** The sessions of every ownership folder, once each; the first folder's errors are reported, another's skipped. */
async function listedSessions(folders, host) {
  const found = [];
  for (const [index, folder] of folders.entries()) {
    const listed = await host.status(folder).catch((error) => {
      if (index === 0) throw error;
      return [];
    });
    for (const session of listed) if (!found.some((item) => item.pid === session.pid)) found.push(session);
  }
  return found.sort((a, b) => a.pid - b.pid);
}

/**
 * stop for a removed catalogue: the toolkit-owned runtimes status lists for it (selectedStatus without a
 * configuration), narrowed by the --state and nonzero --port a printed stop command carries.
 */
async function stopRemovedCatalogue(args, paths, host) {
  const { sessions } = await selectedStatus(null, args, paths, host);
  const port = args.port !== undefined && String(args.port) !== '0' ? String(args.port) : null;
  const pids = sessions
    .filter(
      (session) =>
        session.owned &&
        (!args.state || samePath(session.stateFile, path.resolve(args.state))) &&
        (!port || listenerPort(session.url) === port),
    )
    .map((session) => session.pid);
  const report = await stopSelected(host, paths, pids);
  if (report.remaining.length) throw new Error(stillRunning(report));
  const label = `the removed catalogue ${path.resolve(args.config)}`;
  const foreground = await foregroundSessions(null, args, paths, host);
  print(
    {
      action: 'stop',
      message: stopSummary(report, label, label) + foregroundNote(foreground),
      ...report,
      ...(foreground.length ? { foreground } : {}),
    },
    args.json,
  );
  return stopExitStatus(report, pids);
}

async function selectedStatus(cfg, args, paths, host) {
  let selection = null;
  if (cfg)
    try {
      selection = await stopSelection(cfg, args, paths);
    } catch (error) {
      // Status takes no --state or --port, so it lists an ambiguous legacy record instead of refusing.
      if (!String(error.message).startsWith('Legacy Mirage project ownership is ambiguous')) throw error;
    }
  const folders = await recordFolders(paths, selection?.project?.configFile);
  const found = await listedSessions(folders, host);
  const owned = await ownedSessionsIn(folders);
  assignCatalogueSites(found, catalogueSiteFolders(args), owned);
  const explicit = Boolean(args.config || args.site || args.project);
  const serves = (session) =>
    selection.project
      ? samePath(session.project, selection.project.configFile)
      : Boolean(cfg.sourceDir && !session.project && samePath(session.sourceDir, cfg.sourceDir));
  const selected = (session) => {
    if (!selection) return true;
    if (session.owned) return selection.pids.includes(session.pid);
    return !explicit || serves(session);
  };
  const outside = found.filter((session) => session.owned && !selected(session));
  return {
    sessions: found.filter(selected),
    others: outsideSelection(owned.filter((entry) => outside.some((session) => session.pid === entry.pid))),
    project: selection?.project ?? null,
  };
}

/**
 * The catalogue site of each session: the one recorded for a toolkit-owned runtime at its start (a current scope;
 * an older record's may name a portal), else the first site of the catalogue that serves its source folder (several
 * sites can share one folder).
 */
function assignCatalogueSites(sessions, sites, owned = []) {
  for (const session of sessions) {
    const scope = session.owned ? owned.find((entry) => entry.pid === session.pid)?.identity?.scope : null;
    session.site =
      (scope?.version === 1 ? scope.catalogueSite : null) ??
      sites.find((item) => session.sourceDir && samePath(item.sourceDir, session.sourceDir))?.site ??
      null;
  }
}

function hasSeveralPowerPagesPortals(effective, project) {
  return (effective.runtime ?? project.runtime.kind) === 'power-pages' && project.portals.length > 1;
}

function validateSelectedProjectPortal(project, effective) {
  if (effective.portal && !project.portals.some((item) => item.id === effective.portal))
    throw new Error(`Unknown Mirage portal "${effective.portal}" in ${project.configFile}`);
}
