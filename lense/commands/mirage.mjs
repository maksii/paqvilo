// Toolkit wrapper around the bundled Mirage runtime: project bootstrap, lifecycle and readiness.
// It only stops loopback Mirage processes it started itself (recorded with their process start
// identity), and it never contacts a portal environment.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadCatalogue, loadConfig, loadDevTargets } from '../config.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIRAGE_ROOT = path.join(TOOL_ROOT, 'mirage');
/** Where Mirage processes announce themselves and where the toolkit records the ones it started. */
export function miragePaths(cfg = null, args = {}) {
  const directory = args.config ? path.dirname(path.resolve(args.config))
    : args.project ? path.dirname(path.resolve(args.project)) : process.cwd();
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
const STOP_DEADLINE = 5000;
const ACTIONS = ['init', 'start', 'dev', 'status', 'inspect', 'stop'];
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolved = (value) => value ? path.resolve(value) : null;
export const samePath = (a, b) => {
  if (!a || !b) return false;
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
};
const isDirectory = (dir) => { try { return fsSync.statSync(dir).isDirectory(); } catch { return false; } };
const isFile = (file) => { try { return fsSync.statSync(file).isFile(); } catch { return false; } };
const realpath = (target) => { try { return fsSync.realpathSync.native(target); } catch { return path.resolve(target); } };
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
  try { await scan.cache?.save({ prune: false }); } catch { /* the cache only saves parsing time */ }
  diagnostics.push(...(scan.diagnostics ?? []).filter((item) => item.code === 'SOLUTION_ORDER_CYCLE'));
  const ordered = [];
  for (const layer of scan.layers) {
    const input = resolved.find((root) => samePath(root, layer.input));
    if (input && !ordered.includes(input)) ordered.push(input);
  }
  return [...ordered, ...resolved.filter((root) => !ordered.includes(root))];
}
const adminUrlOf = (url) => { try { return new URL('/_sim/', url).href; } catch { return null; } };
/** Mirage binds only to loopback; never send runtime probes or shutdowns anywhere else. */
const loopbackUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && !parsed.username && !parsed.password;
  } catch { return false; }
};

/** True when the process exists (EPERM: it exists but belongs to another account). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The process start time: a recorded PID only names our Mirage while this value is unchanged. */
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    // PowerShell can start slowly on a busy machine: give it time and retry a read that timed
    // out, because an unread identity must not be mistaken for a reused process ID.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      if (!result.error && result.signal == null) return result.status === 0 ? result.stdout.trim() || null : null;
    }
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null; // field 22: process start time since boot
  } catch { /* macOS and other proc-less systems */ }
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

// ------------------------------------------------------------------------------ ownership records
export async function ownedSessions(paths = DEFAULT_PATHS) {
  try {
    const value = JSON.parse(await fs.readFile(paths.ownershipFile, 'utf8'));
    return Array.isArray(value.sessions) ? value.sessions.filter((item) => item && Number.isInteger(item.pid)) : [];
  } catch { return []; }
}

async function saveOwnedSessions(paths, sessions) {
  await fs.mkdir(path.dirname(paths.ownershipFile), { recursive: true });
  const temporary = `${paths.ownershipFile}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  const body = JSON.stringify({ version: 1, sessions }, null, 2);
  await fs.writeFile(temporary, body);
  try { await fs.rename(temporary, paths.ownershipFile); }
  catch {
    // A reader holding the file open on Windows can refuse the replacement; write in place instead.
    await fs.writeFile(paths.ownershipFile, body);
    await fs.rm(temporary, { force: true });
  }
}

/** A lock file is stale after this long: a read-modify-write of the records takes milliseconds. */
const OWNERSHIP_LOCK_STALE = 10_000;
/**
 * Runs `action` holding the ownership lock (`<sessions file>.lock`, created exclusively), so
 * toolkit commands in other processes cannot interleave their read-modify-write with this one.
 */
async function withOwnershipLock(paths, action) {
  const lock = `${paths.ownershipFile}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 3 * OWNERSHIP_LOCK_STALE;
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.writeFile(String(process.pid)).finally(() => handle.close());
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      try {
        if (Date.now() - (await fs.stat(lock)).mtimeMs > OWNERSHIP_LOCK_STALE) await fs.rm(lock, { force: true });
      } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error(`The Mirage ownership records stayed locked: ${lock}`);
      await sleep(20 + Math.floor(Math.random() * 40));
    }
  }
  try {
    return await action();
  } finally {
    await fs.rm(lock, { force: true }).catch(() => {});
  }
}

/**
 * Read-modify-write, so entries added meanwhile by another toolkit command are retained. Updates
 * are queued within this process and locked across processes: Mirages starting at once, from
 * one command or several, must not lose a record.
 */
const ownershipUpdates = new Map();
export async function updateOwnedSessions(paths, change) {
  const key = path.resolve(paths.ownershipFile);
  const run = (ownershipUpdates.get(key) ?? Promise.resolve()).then(() => withOwnershipLock(paths, async () => {
    const next = change(await ownedSessions(paths));
    await saveOwnedSessions(paths, next);
    return next;
  }));
  ownershipUpdates.set(key, run.catch(() => {}));
  return run;
}

// ------------------------------------------------------------------------------ discovery records
async function discoveryRecords(paths) {
  let names = [];
  try { names = await fs.readdir(paths.discoveryRoot); } catch { return []; }
  const records = [];
  for (const name of names.filter((item) => /^session-\d+\.json$/.test(item)).sort()) {
    const file = path.join(paths.discoveryRoot, name);
    try {
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isInteger(record.pid) || (!record.url && !Array.isArray(record.portals))) continue;
      records.push({ record, file });
    } catch { /* incomplete discovery file */ }
  }
  return records;
}

async function readRuntime(url, fallbackSite = null) {
  if (!url || !loopbackUrl(url)) return null;
  // The light status endpoint first; older runtimes answer 404 there and expose the state summary.
  for (const pathname of ['/_sim/api/status', '/_sim/api/state?summary=1', '/__sim/api/state?summary=1']) {
    let response;
    try { response = await fetch(new URL(pathname, url), { signal: AbortSignal.timeout(2500) }); }
    catch { return null; }
    if (response.status === 404) continue;
    if (!response.ok) return null;
    try {
      const data = await response.json();
      const status = data?.status ?? data ?? {};
      return {
        site: status.site ?? fallbackSite, pageCount: status.pageCount ?? 0, sourceFingerprint: status.sourceFingerprint ?? null, revision: status.revision ?? null,
        // "disabled" unless the runtime was started with --allow-live-writes; then "off" or "enabled".
        liveWrites: typeof status.liveWrites === 'string' ? status.liveWrites : null,
      };
    } catch { return null; }
  }
  return null;
}

/** Discovered Mirage portals; `probe` asks each live process whether its runtime answers. */
export async function discoveries(paths = DEFAULT_PATHS, { probe = true } = {}) {
  const sessions = [];
  for (const { record, file } of await discoveryRecords(paths)) {
    const processAlive = isAlive(record.pid);
    const { portals, ...base } = record;
    const entries = Array.isArray(portals) ? portals.map((portal) => ({ ...base, ...portal, id: portal.id })) : [base];
    for (const entry of entries) {
      const runtime = processAlive && probe ? await readRuntime(entry.url, entry.id ?? null) : null;
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
      method: 'POST', headers: { 'x-sim-csrf': state.csrf }, signal: AbortSignal.timeout(2500),
    });
    return stopped.status === 202;
  } catch { return false; }
}

/**
 * Stops toolkit-owned Mirage processes selected by portal source folder or PID. An entry is only
 * acted on while its PID still has the recorded start identity; entries of exited processes (or of a
 * reused PID) are pruned, and discovery files of exited processes are removed.
 */
export async function stopOwnedSessions({ paths = DEFAULT_PATHS, sourceDir = null, sourceDirs = null, pids = null, deadline = STOP_DEADLINE, identityOf = processIdentity } = {}) {
  const folders = sourceDirs ?? (sourceDir ? [sourceDir] : []);
  const owned = await ownedSessions(paths);
  const records = await discoveryRecords(paths);
  const stale = [], targets = [], unverified = [];
  for (const entry of owned) {
    const alive = isAlive(entry.pid);
    const current = alive ? identityOf(entry.pid) : null;
    // A live process whose start identity was never recorded or cannot be read now is neither
    // proof of a reused process ID nor safe to signal: its record stays for a later stop.
    if (alive && (!entry.processIdentity || current == null)) {
      unverified.push({ entry, reason: entry.processIdentity ? 'its start identity could not be read now; run stop again' : 'no start identity was recorded when it started, so it is never signalled' });
      continue;
    }
    if (!alive || current !== entry.processIdentity) {
      stale.push({ entry, reason: !alive ? 'process exited' : 'process ID now belongs to another program' });
      continue;
    }
    const selected = pids ? pids.includes(entry.pid) : folders.some((folder) => samePath(entry.sourceDir, folder));
    if (selected) targets.push(entry);
  }
  const results = [];
  for (const entry of targets) {
    const record = records.find((item) => item.record.pid === entry.pid)?.record;
    // The recorded URL is ours; a discovery URL is only used while ours is not known yet (starting).
    const urls = [...new Set(entry.url ? [entry.url] : [record?.url, ...(record?.portals ?? []).map((portal) => portal.url)].filter(Boolean))];
    let graceful = false;
    for (const url of urls) if (!graceful) graceful = await requestShutdown(url);
    if (!graceful && identityOf(entry.pid) === entry.processIdentity) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
    results.push({ entry, graceful });
  }
  const waitForExit = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end && targets.some((entry) => isAlive(entry.pid))) await sleep(100);
  };
  await waitForExit(deadline);
  for (const entry of targets) {
    // POSIX signals can be handled; force only the process that still has the recorded identity.
    if (isAlive(entry.pid) && identityOf(entry.pid) === entry.processIdentity) {
      try { process.kill(entry.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
  }
  if (targets.some((entry) => isAlive(entry.pid))) await waitForExit(2000);
  const remaining = targets.filter((entry) => {
    if (!isAlive(entry.pid)) return false;
    const current = identityOf(entry.pid);
    return current == null || current === entry.processIdentity;
  });
  const removedDiscoveries = [];
  for (const { record, file } of await discoveryRecords(paths)) {
    if (isAlive(record.pid)) continue;
    await fs.rm(file, { force: true });
    removedDiscoveries.push(file);
  }
  const forget = [...targets.filter((item) => !remaining.includes(item)), ...stale.map((item) => item.entry)];
  for (const entry of forget) {
    if (!entry.discovery || removedDiscoveries.includes(entry.discovery) || isAlive(entry.pid)) continue;
    const relative = path.relative(paths.discoveryRoot, entry.discovery);
    if (/^session-\d+\.json$/.test(relative) && fsSync.existsSync(entry.discovery)) {
      await fs.rm(entry.discovery, { force: true });
      removedDiscoveries.push(entry.discovery);
    }
  }
  await updateOwnedSessions(paths, (current) => current.filter((item) => !forget.some((entry) => entry.pid === item.pid && entry.processIdentity === item.processIdentity)));
  const describe = (entry) => ({ pid: entry.pid, url: entry.url ?? null, sourceDir: entry.sourceDir ?? null, stateFile: entry.stateFile ?? null, project: entry.project ?? null, portal: entry.portal ?? null });
  return {
    stopped: results.filter(({ entry }) => !remaining.includes(entry)).map(({ entry, graceful }) => ({ ...describe(entry), graceful, wasReady: entry.ready !== false })),
    remaining: remaining.map(describe),
    pruned: stale.map(({ entry, reason }) => ({ ...describe(entry), reason })),
    unverified: unverified.map(({ entry, reason }) => ({ ...describe(entry), reason })),
    removedDiscoveries,
  };
}

/** Sessions with ownership, project and portal information merged from both record kinds. */
export async function mirageStatus(paths = DEFAULT_PATHS) {
  const owned = await ownedSessions(paths);
  const found = await discoveries(paths);
  const identities = new Map();
  const identity = (pid) => {
    if (!identities.has(pid)) identities.set(pid, processIdentity(pid));
    return identities.get(pid);
  };
  const sessions = found.map((session) => {
    const owner = owned.find((item) => item.pid === session.pid && item.discovery === session.discovery);
    const isOwned = Boolean(owner && session.processAlive && owner.processIdentity && owner.processIdentity === identity(session.pid));
    return { ...session, adminUrl: session.url ? adminUrlOf(session.url) : session.adminUrl ?? null, owned: isOwned, project: session.project ?? owner?.project ?? null, portal: session.id ?? owner?.portal ?? null };
  });
  for (const entry of owned) {
    if (found.some((session) => session.pid === entry.pid) || !isAlive(entry.pid) || entry.processIdentity !== identity(entry.pid)) continue;
    sessions.push({ pid: entry.pid, url: entry.url ?? null, adminUrl: entry.url ? adminUrlOf(entry.url) : null, sourceDir: entry.sourceDir ?? null, stateFile: entry.stateFile ?? null, project: entry.project ?? null, portal: entry.portal ?? null, discovery: entry.discovery ?? null, processAlive: true, ready: false, starting: true, owned: true, runtime: null });
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

// ------------------------------------------------------------------------------ configuration
async function loadProject(file) {
  const { loadProjectConfig } = await import('../../mirage/lib/project-config.mjs');
  return loadProjectConfig(path.resolve(file));
}

/**
 * Applies catalogue Mirage settings (`cfg.mirageConfig`) to the command-line options: a
 * catalogued project, then catalogued Solution roots, port and preset. Explicit options always win.
 */
export function catalogueArgs(cfg, args = {}, { requireProject = true } = {}) {
  const configured = cfg?.mirageConfig ?? {};
  const effective = { ...args };
  if (effective.project === undefined && configured.project) {
    if (isFile(configured.project)) effective.project = configured.project;
    else if (requireProject) throw new Error(`Site "${cfg.siteName}" selects the Mirage project ${configured.project}, which does not exist. Create it with "npx paqvilo mirage init --site ${cfg.siteName}", or remove mirage.project for this site.`);
  }
  if (!effective.project && !effective['solution-root']?.length && configured.solutionRoots?.length) effective['solution-root'] = [...configured.solutionRoots];
  if (effective.port === undefined && Number.isInteger(configured.port)) effective.port = String(configured.port);
  if (effective.preset === undefined && configured.preset) effective.preset = configured.preset;
  return effective;
}

export function cliArgs(cfg, action, args, project = null) {
  const cli = path.join(MIRAGE_ROOT, 'cli.mjs');
  const common = [
    '--state-dir', path.dirname(miragePaths(cfg, args).discoveryRoot),
    ...(args.port ? ['--port', String(args.port)] : []), ...(args.state ? ['--state', path.resolve(args.state)] : []), ...(args.preset ? ['--preset', args.preset] : []),
    // Live writes stay impossible unless this runtime is started with the flag (off by default).
    ...(args['allow-live-writes'] === true ? ['--allow-live-writes'] : []),
  ];
  if (project) {
    const portal = args.portal ?? (action === 'serve' ? project.defaultPortal : null);
    return { cli, values: [action, '--project', project.configFile, ...(portal ? ['--portal', portal] : []), ...common] };
  }
  const origin = httpsOrigin(cfg.origin);
  const values = [action, '--site', cfg.siteName, '--env', cfg.envName, '--source', cfg.sourceDir, ...(origin ? ['--origin', origin] : []), ...common];
  // The Mirage reads the site's mirage settings (such as observed behaviour) from the
  // catalogue: the same catalogue file and portal checkout the toolkit resolved.
  if (args.config) values.push('--config', path.resolve(args.config));
  if (args.repo) values.push('--repo', path.resolve(args.repo));
  for (const root of args['solution-root'] ?? []) values.push('--solution-root', path.resolve(root));
  // The Mirage layers --solution-root values in their dependency order unless told otherwise.
  if (args['solution-root']?.length) values.push('--solution-order', solutionOrderOf(cfg));
  return { cli, values };
}

/** Whether create, update and delete requests can reach the live environment from this runtime. */
function liveWritesText(value) {
  if (value === 'enabled') return 'enabled: create, update and delete requests reach the live environment';
  if (value === 'off') return 'allowed by --allow-live-writes; off until switched on in _sim';
  if (value === 'disabled') return 'disabled (start with --allow-live-writes to allow them)';
  return 'not reported by this Mirage';
}

/**
 * The stop summary: how many sessions were stopped for `scope` (`none` when there were none), and
 * how many owned records were kept because their process could not be verified.
 */
function stopSummary(report, scope, none) {
  const count = report.stopped.length, kept = report.unverified?.length ?? 0;
  const verdict = count
    ? `Stopped ${count} toolkit-owned Mirage session(s) for ${scope}.`
    : `No toolkit-owned Mirage session ${kept ? 'was stopped ' : ''}for ${none}.`;
  return kept ? `${verdict} ${kept} owned session(s) could not be verified and were kept.` : verdict;
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
  return `${Object.entries(values).map(([key, value]) => (value && typeof value === 'object' ? `${key} (${observedValue(value)})` : `${key} ${value}`)).join(', ')} (evidence: ${evidence})`;
}

/** Solution roots in load order, as the Mirage CLI will apply them. */
async function launchSolutionRoots(sourceDir, args, projectInfo) {
  if (projectInfo) return projectInfo.solutionRoots ?? [];
  if (args['solution-root']?.length) return args['solution-root'].map((root) => path.resolve(root));
  return (await import('../../mirage/lib/solution-roots.mjs')).discoverSolutionRoots(sourceDir);
}

async function launchIdentity(cfg, args, projectInfo = null) {
  const portalId = args.portal ?? projectInfo?.defaultPortal ?? null;
  const sourceDir = projectInfo
    ? projectInfo.portals.find((item) => item.id === portalId)?.sourceDir
    : cfg.sourceDir;
  const stateFile = args.state
    ? resolved(args.state)
    : projectInfo
      ? (await import('../../mirage/lib/project-config.mjs')).projectStateFile(projectInfo, portalId, path.join(miragePaths(cfg, args).discoveryRoot, 'projects'))
      : path.join(miragePaths(cfg, args).discoveryRoot, cfg.siteName, 'state.json');
  const solutionRoots = (await launchSolutionRoots(sourceDir, args, projectInfo)).map((item) => resolved(item));
  return {
    identity: {
      sourceDir: resolved(sourceDir), project: resolved(projectInfo?.configFile), portal: portalId,
      stateFile: resolved(stateFile), preset: args.preset ?? null, allowLiveWrites: args['allow-live-writes'] === true,
      // Sorted only for matching records written by earlier toolkit versions; the CLI keeps load order.
      solutionRoots: [...solutionRoots].sort(),
      requestedPort: String(args.port ?? DEFAULT_PORT),
    },
    solutionRoots,
  };
}

function identityMatches(left, right) {
  return Boolean(left && right && samePath(left.sourceDir, right.sourceDir)
    && samePath(left.stateFile, right.stateFile)
    && (left.project ?? null) === (right.project ?? null)
    && (left.portal ?? null) === (right.portal ?? null)
    && (left.preset ?? null) === (right.preset ?? null)
    && Boolean(left.allowLiveWrites) === Boolean(right.allowLiveWrites)
    && JSON.stringify(left.solutionRoots ?? []) === JSON.stringify(right.solutionRoots ?? [])
    && String(left.requestedPort ?? '') === String(right.requestedPort ?? ''));
}

// ------------------------------------------------------------------------------ start
async function start(cfg, args, { paths = miragePaths(cfg, args) } = {}) {
  const port = args.port === undefined ? String(DEFAULT_PORT) : String(args.port);
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('--port must be an integer from 0 to 65535');
  const timeout = args['startup-timeout'] === undefined ? DEFAULT_STARTUP_TIMEOUT : Number(args['startup-timeout']);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600_000) throw new Error('--startup-timeout must be an integer from 1000 to 600000 milliseconds');
  let projectInfo = null;
  if (args.project) {
    projectInfo = await loadProject(args.project);
    if (args['solution-root']?.length) throw new Error('--solution-root is supplied by the project configuration.');
    if (args.portal && !projectInfo.portals.some((item) => item.id === args.portal)) throw new Error(`Unknown Mirage portal "${args.portal}" in ${projectInfo.configFile}`);
  } else {
    const missing = (args['solution-root'] ?? []).map((root) => path.resolve(root)).filter((root) => !isDirectory(root));
    // Catalogue and command-line roots are a set: the dependency order applies unless the site
    // sets mirage.solutionOrder: explicit (the Mirage keeps the order it is given).
    if (!missing.length && args['solution-root']?.length > 1 && solutionOrderOf(cfg) !== 'explicit')
      args = { ...args, 'solution-root': await derivedSolutionOrder(args['solution-root'], { cacheFile: path.join(paths.discoveryRoot, 'cache/solution-discovery.json') }) };
    if (missing.length) throw new Error(`Mirage Solution root${missing.length > 1 ? 's do' : ' does'} not exist: ${missing.join(', ')}. Restore that checkout, pass --solution-root explicitly, or set "solutionRoots: []" for this site in paqvilo.config.local.yml to use sibling discovery.`);
  }
  const { identity, solutionRoots } = await launchIdentity(cfg, { ...args, port }, projectInfo);
  const launch = { ...identity, solutionRoots };
  const owned = await ownedSessions(paths);
  const existing = (await discoveries(paths)).find((session) => session.processAlive && session.ready
    && samePath(session.sourceDir, identity.sourceDir)
    && owned.some((item) => item.pid === session.pid && item.discovery === session.discovery
      && item.processIdentity && item.processIdentity === processIdentity(session.pid)
      && identityMatches(item.identity, identity)));
  if (existing) return { ...existing, owned: true, started: false, launch };
  if (port !== '0' && !(await portAvailable(Number(port)))) throw new Error(`Port ${port} is already in use by another process or Mirage session with different settings. Pass --port 0 (any free port) or another --port, or stop that session first.`);
  const { cli, values } = cliArgs(cfg, 'serve', { ...args, port, state: identity.stateFile }, projectInfo);
  let child;
  await fs.mkdir(paths.logRoot, { recursive: true });
  const log = path.join(paths.logRoot, `startup-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const logHandle = await fs.open(log, 'a');
  try {
    child = spawn(process.execPath, [cli, ...values], { cwd: cfg.configDir ?? process.cwd(), detached: true, stdio: ['ignore', logHandle.fd, logHandle.fd], windowsHide: true });
  } catch (error) { await logHandle.close(); throw new Error(`Could not start Mirage: ${error.message}. Startup log: ${log}`); }
  await logHandle.close();
  child.unref();
  const discovery = path.join(paths.discoveryRoot, `session-${child.pid}.json`);
  const childIdentity = processIdentity(child.pid);
  // Recorded before readiness, so `mirage stop` can end a process that hangs while importing.
  await updateOwnedSessions(paths, (sessions) => [...sessions.filter((item) => item.pid !== child.pid), {
    pid: child.pid, processIdentity: childIdentity, sourceDir: identity.sourceDir, project: identity.project, portal: identity.portal,
    discovery, url: null, stateFile: identity.stateFile, identity, log, ready: false, startedAt: new Date().toISOString(),
  }]);
  const abandon = async () => {
    if (isAlive(child.pid) && processIdentity(child.pid) === childIdentity) {
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* already exited */ }
    }
    await fs.rm(discovery, { force: true }).catch(() => {});
    await updateOwnedSessions(paths, (sessions) => sessions.filter((item) => !(item.pid === child.pid && item.processIdentity === childIdentity))).catch(() => {});
  };
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const started = Date.now();
  const deadline = started + timeout;
  let nextProgress = started + 15_000;
  try {
    while (Date.now() < deadline && !interrupted) {
      try {
        const record = JSON.parse(await fs.readFile(discovery, 'utf8'));
        const portal = Array.isArray(record.portals) ? record.portals.find((item) => item.id === (identity.portal ?? '')) ?? record.portals[0] : null;
        const { portals: ignoredPortals, ...base } = record;
        const session = { ...base, ...(portal ?? {}), id: portal?.id, discovery, processAlive: true, ready: false, runtime: null };
        session.runtime = await readRuntime(session.url, session.id ?? cfg.siteName);
        session.ready = Boolean(session.runtime);
        if (session.ready) {
          await updateOwnedSessions(paths, (sessions) => [...sessions.filter((item) => item.pid !== session.pid), {
            pid: session.pid, processIdentity: childIdentity, sourceDir: session.sourceDir, project: identity.project, portal: session.id ?? identity.portal,
            discovery, url: session.url, stateFile: session.stateFile, identity, log, ready: true, startedAt: new Date(started).toISOString(),
          }]);
          return { ...session, owned: true, started: true, launch };
        }
      } catch { /* server has not written its discovery file yet */ }
      if (!isAlive(child.pid)) {
        await abandon();
        const output = await fs.readFile(log, 'utf8').catch(() => '');
        throw new Error(`Mirage exited before it became ready. See startup log: ${log}${output.trim() ? `\n${output.trim().slice(-3000)}` : ''}`);
      }
      if (Date.now() >= nextProgress) { console.error(`Mirage is still importing portal data (${Math.round((Date.now() - started) / 1000)}s elapsed)…`); nextProgress = Date.now() + 15_000; }
      await sleep(150);
    }
    await abandon();
    if (interrupted) throw new Error('Mirage startup was interrupted; the starting process was stopped.');
    throw new Error(`Mirage did not become ready within ${timeout}ms${port === '0' ? '' : ` on port ${port}`}. See startup log: ${log}`);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

// ------------------------------------------------------------------------------ init
const yamlPath = (from, target) => {
  const relative = path.relative(from, target);
  // Another drive, the folder itself or a distant folder keeps the absolute path.
  const distant = relative.split(/[\\/]/).filter((part) => part === '..').length > 4;
  return (!relative || path.isAbsolute(relative) || distant ? target : relative).replace(/\\/g, '/');
};
const httpsOrigin = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null; } catch { return null; }
};
const projectId = (value, used) => {
  let id = String(value).replace(/[^a-z0-9._-]+/gi, '-').replace(/^[^a-z0-9]+/i, '') || 'solution';
  const base = id;
  for (let n = 2; used.has(id.toLowerCase()); n++) id = `${base}-${n}`;
  used.add(id.toLowerCase());
  return id;
};

async function matchingPacks(cfg, dataPacks) {
  let registry;
  try { registry = await import('../../mirage/lib/preset-registry.mjs'); } catch (error) {
    return { checked: false, reason: error.code === 'ERR_MODULE_NOT_FOUND' ? 'The Mirage preset registry is not available.' : error.message.split('\n')[0] };
  }
  if (typeof registry.discoverPacks !== 'function') return { checked: false, reason: 'The Mirage preset registry has no discoverPacks().' };
  try {
    const { importPortal } = await import('../../mirage/lib/importer.mjs');
    const portal = await importPortal(cfg.sourceDir);
    const packs = await registry.discoverPacks({ portal, explicit: dataPacks.map(({ id, module }) => (id ? { id, module } : { module })) });
    return { checked: true, matching: packs.map((pack) => ({ id: pack.id, name: pack.name, description: pack.description })) };
  } catch (error) { return { checked: false, reason: error.message.split('\n')[0] }; }
}

/** Writes a Mirage project file for the selected catalogue site and validates it by loading it. */
export async function initProject(cfg, args = {}) {
  const configured = cfg.mirageConfig ?? { solutionRoots: [], dataPacks: [] };
  const file = path.resolve(args.out ?? configured.project ?? path.join(path.dirname(miragePaths(cfg, args).discoveryRoot), 'mirage', `${cfg.siteName}.project.yml`));
  if (!/\.(?:ya?ml|json)$/i.test(file)) throw new Error('The Mirage project file must end in .yml, .yaml or .json');
  if (isDirectory(file)) throw new Error(`${file} is a folder; name a project file`);
  if (fsSync.existsSync(file) && !args.force) throw new Error(`${file} already exists; pass --force to replace it`);
  if (!PROJECT_ID.test(cfg.siteName)) throw new Error(`Site "${cfg.siteName}" cannot be used as a Mirage portal ID`);
  const listed = configured.solutionRoots?.length
    ? configured.solutionRoots
    : await (await import('../../mirage/lib/solution-roots.mjs')).discoverSolutionRoots(cfg.sourceDir);
  const missing = listed.filter((root) => !isDirectory(root));
  if (missing.length) throw new Error(`Configured Solution root${missing.length > 1 ? 's do' : ' does'} not exist: ${missing.join(', ')}`);
  // The project records the order its solutions are layered in: the dependency order (written
  // in that order), or the catalogue's listed order when the site sets solutionOrder: explicit.
  const solutionOrder = solutionOrderOf(cfg);
  const derived = await derivedSolutionOrder(listed, { cacheFile: path.join(miragePaths(cfg, args).discoveryRoot, 'cache/solution-discovery.json') });
  const roots = solutionOrder === 'explicit' ? listed : derived;
  const missingPacks = (configured.dataPacks ?? []).filter((pack) => !isFile(pack.module));
  if (missingPacks.length) throw new Error(`Configured data pack module${missingPacks.length > 1 ? 's do' : ' does'} not exist: ${missingPacks.map((pack) => pack.module).join(', ')}`);
  const base = path.dirname(file);
  const notes = [];
  if (solutionOrder === 'explicit' && !sameOrder(listed, derived)) notes.push(`solutionOrder: explicit keeps the listed order ${rootNames(listed)}; the dependency order is ${rootNames(derived)}.`);
  const origin = httpsOrigin(cfg.origin);
  if (!origin) notes.push(`${cfg.origin} is not an HTTPS origin, so the portal has no reference origin.`);
  const environments = Object.entries(cfg.site?.environments ?? {});
  const ordered = [...environments.filter(([name]) => name === cfg.envName), ...environments.filter(([name]) => name !== cfg.envName)];
  if (cfg.envName === 'custom' && !environments.some(([name]) => name === 'custom')) ordered.unshift(['custom', { url: cfg.origin }]);
  const references = [];
  const seenOrigins = new Set();
  for (const [name, environment] of ordered) {
    const reference = httpsOrigin(environment.url);
    if (!reference) { notes.push(`Environment ${name} (${environment.url}) is not an HTTPS origin and is not listed as a reference.`); continue; }
    if (!PROJECT_ID.test(name) || seenOrigins.has(reference)) continue;
    seenOrigins.add(reference);
    references.push({ id: name, origin: reference, ...(environment.caution ? { name: `${name} (real data)` } : {}) });
  }
  // Platform behaviour observed on the site's environment (mirage.observed), validated as the
  // Mirage validates a project portal's observed block and recorded on the portal entry.
  const observed = configured.observed
    ? (await import('../../mirage/lib/project-config.mjs')).observedConfig(configured.observed, `sites.${cfg.siteName}.mirage.observed`)
    : null;
  const usedIds = new Set();
  const document = {
    version: 1,
    defaultPortal: cfg.siteName,
    // dataModel: the catalogue site's data model for a source that does not record it (.powerpages-site).
    portals: [{ id: cfg.siteName, path: yamlPath(base, cfg.sourceDir), ...(origin ? { origin } : {}), ...(observed ? { observed } : {}), ...(configured.dataModel ? { dataModel: configured.dataModel } : {}) }],
    solutions: roots.map((root) => ({ id: projectId(path.basename(root), usedIds), path: yamlPath(base, root) })),
    solutionOrder,
    references,
    ...(configured.dataPacks?.length ? { dataPacks: configured.dataPacks.map(({ id, module }) => ({ ...(id ? { id } : {}), module: yamlPath(base, module) })) } : {}),
  };
  const header = [
    `# Mirage project for the "${cfg.siteName}" portal, written by paqvilo mirage init (${cfg.siteName} @ ${cfg.envName}).`,
    '# Paths are relative to this file; the first reference is the selected environment. solutionOrder derived layers the',
    '# solutions in their dependency order (written in that order); explicit keeps the listed order.',
    '# Source import reads local files only; recording a reference origin does not connect to it.',
  ].join('\n');
  await fs.mkdir(base, { recursive: true });
  const write = async () => {
    const text = /\.json$/i.test(file) ? `${JSON.stringify(document, null, 2)}\n` : `${header}\n${YAML.stringify(document)}`;
    const temporary = `${file}.${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(temporary, text);
    await fs.rename(temporary, file);
  };
  await write();
  let loaded;
  try { loaded = await loadProject(file); }
  catch (error) {
    // A newer loader names the version it requires; the fields written here are shared by all versions.
    const required = /version/i.test(error.message) ? Math.max(...(error.message.match(/\d+/g) ?? []).map(Number)) : NaN;
    if (Number.isInteger(required) && required > document.version) {
      document.version = required;
      await write();
      try { loaded = await loadProject(file); } catch (retry) { error = retry; }
    }
    if (!loaded) {
      await fs.rm(file, { force: true });
      throw new Error(`The generated project file did not load and was removed: ${error.message}`);
    }
  }
  const packs = await matchingPacks(cfg, configured.dataPacks ?? []);
  const catalogued = Boolean(configured.project && samePath(configured.project, file));
  return {
    action: 'init', file, site: cfg.siteName, env: cfg.envName, version: loaded.version,
    portal: { id: cfg.siteName, sourceDir: loaded.portals[0].sourceDir, origin: loaded.portals[0].origin ?? null, observed: loaded.portals[0].observed ?? null },
    solutions: loaded.solutions.map((solution) => ({ id: solution.id, root: solution.root })),
    solutionOrder,
    references: loaded.references,
    dataPacks: document.dataPacks ?? [],
    packs, notes, catalogued,
    next: catalogued
      ? `The catalogue selects this project: npx paqvilo mirage dev --site ${cfg.siteName}`
      : `npx paqvilo mirage dev --project ${JSON.stringify(file)}  (or set sites.${cfg.siteName}.mirage.project in paqvilo.config.local.yml to use it automatically)`,
  };
}

// ------------------------------------------------------------------------------ readiness
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
export async function mirageReadiness(cfg, { dependencies, stateRoot = miragePaths(cfg).discoveryRoot, checkPort = portAvailable } = {}) {
  const configured = cfg.mirageConfig ?? { project: null, solutionRoots: [], dataPacks: [], port: null, preset: null };
  const errors = [], warnings = [];
  const readiness = dependencies ?? (await import('../../scripts/ensure-dependencies.mjs')).dependencyReadiness(TOOL_ROOT);
  const mirageDependencies = readiness.projects?.find((item) => item.name === 'mirage');
  const dependencyReport = mirageDependencies
    ? { ready: Boolean(mirageDependencies.ready), reason: mirageDependencies.reason }
    : { ready: false, reason: 'mirage/package.json is missing from this toolkit' };
  if (!dependencyReport.ready) errors.push(`Mirage dependencies: ${dependencyReport.reason}`);
  const project = { configured: Boolean(configured.project), file: configured.project ?? null, ready: !configured.project };
  let loaded = null;
  if (configured.project) {
    if (!isFile(configured.project)) {
      project.ready = false;
      project.error = 'The project file does not exist.';
      errors.push(`Mirage project ${configured.project} does not exist; run npx paqvilo mirage init --site ${cfg.siteName}`);
    } else {
      try {
        loaded = await loadProject(configured.project);
        Object.assign(project, { ready: true, version: loaded.version, defaultPortal: loaded.defaultPortal, portals: loaded.portals.map((item) => item.id), references: loaded.references.map((item) => item.id) });
      } catch (error) {
        project.ready = false;
        project.error = error.message.split('\n')[0];
        errors.push(`Mirage project ${configured.project}: ${project.error}`);
      }
    }
  }
  let source = 'discovered', roots = [];
  if (loaded) { source = 'project'; roots = loaded.solutionRoots ?? []; }
  else if (configured.project) source = 'project';
  else if (configured.solutionRoots?.length) { source = 'catalogue'; roots = configured.solutionRoots; }
  else {
    try { roots = await (await import('../../mirage/lib/solution-roots.mjs')).discoverSolutionRoots(cfg.sourceDir); }
    catch (error) { warnings.push(`Solution discovery failed: ${error.message.split('\n')[0]}`); }
  }
  // The order the runtime layers the roots in: the dependency order unless explicitly overridden
  // (a project's solutionOrder, else the site's mirage.solutionOrder).
  const order = loaded ? (loaded.solutionOrder === 'derived' ? 'derived' : 'explicit') : source === 'discovered' ? 'derived' : solutionOrderOf(cfg);
  let effective = roots, derivedOrder = null;
  if (roots.length > 1 && source !== 'discovered' && roots.every((root) => isDirectory(root))) {
    const diagnostics = [];
    try {
      derivedOrder = await derivedSolutionOrder(roots, { diagnostics, cacheFile: path.join(stateRoot, 'cache/solution-discovery.json') });
      if (order === 'derived') effective = derivedOrder;
      else if (!sameOrder(roots, derivedOrder)) warnings.push(`${loaded ? `Mirage project ${configured.project}` : `sites.${cfg.siteName}.mirage`} layers its Solution roots in the listed order ${rootNames(roots)} (solutionOrder: explicit), which differs from their dependency order ${rootNames(derivedOrder)}; forms, views and tables can then resolve to other Solution files than discovery, bootstrap and the data scaffold use.${loaded ? ' Set solutionOrder: derived or rerun mirage init --force.' : ''}`);
      for (const item of diagnostics) warnings.push(`Solution order: ${item.message}`);
    } catch (error) {
      warnings.push(`The Solution dependency order could not be derived: ${error.message.split('\n')[0]}`);
    }
  }
  const solutionRoots = { source, order, roots: effective.map((root) => ({ path: root, exists: isDirectory(root) })), ...(derivedOrder ? { derivedOrder } : {}) };
  for (const root of solutionRoots.roots.filter((item) => !item.exists)) errors.push(`Mirage Solution root does not exist: ${root.path}`);
  if (!roots.length && source !== 'project') warnings.push('No Solution roots are configured or discovered; forms, views and table metadata come from the portal export only.');
  // Platform behaviour observed on the environment: with a project file its portal entry applies
  // (as in the Mirage), else the catalogue site's mirage.observed.
  let observed = null, observedSource = null;
  const projectPortal = loaded ? loaded.portals.find((item) => item.id === loaded.defaultPortal) ?? loaded.portals[0] : null;
  if (configured.observed) {
    try {
      const { observedConfig } = await import('../../mirage/lib/project-config.mjs');
      const catalogued = observedConfig(configured.observed, `sites.${cfg.siteName}.mirage.observed`);
      if (!configured.project) [observed, observedSource] = [catalogued, catalogued ? 'catalogue' : null];
      else if (loaded && JSON.stringify(catalogued) !== JSON.stringify(projectPortal?.observed ?? null))
        warnings.push(`sites.${cfg.siteName}.mirage.observed differs from portal ${projectPortal?.id} in ${configured.project}, whose observed behaviour applies; run npx paqvilo mirage init --site ${cfg.siteName} --force to rewrite the project file`);
    } catch (error) {
      errors.push(`Mirage observed behaviour: ${error.message.split('\n')[0]}`);
    }
  }
  if (projectPortal?.observed) [observed, observedSource] = [projectPortal.observed, 'project'];
  const dataPacks = (configured.dataPacks ?? []).map((pack) => ({ ...pack, exists: isFile(pack.module) }));
  for (const pack of dataPacks.filter((item) => !item.exists)) errors.push(`Mirage data pack module does not exist: ${pack.module}`);
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
  if (!port.available) warnings.push(`Port ${portNumber} is in use. mirage dev/start reuse a matching toolkit-owned Mirage there; otherwise pass --port 0 (any free port) or another port.`);
  return { ready: errors.length === 0, catalogue: configured, dependencies: dependencyReport, project, solutionRoots, observed, observedSource, dataPacks, stateDir, port, errors, warnings };
}

// ------------------------------------------------------------------------------ output
// ------------------------------------------------------------------------------ several portals
// One Mirage per catalogue site (each with its own project or source, state, port, references
// and session cookie); `dev` switches between them, and the live targets, in one browser.
const PER_PORTAL_OPTIONS = ['project', 'portal', 'port', 'state', 'preset', 'solution-root', 'source', 'url', 'out'];
/** With several portals, dev and start apply these options to the selected site's runtime only. */
const SELECTED_SITE_OPTIONS = ['port', 'state', 'preset', 'solution-root'];
const given = (args, option) => args[option] !== undefined && !(Array.isArray(args[option]) && !args[option].length);
const pick = (args, options) => Object.fromEntries(options.filter((option) => given(args, option)).map((option) => [option, args[option]]));

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
    return Object.entries(catalogue.sites).map(([site, entry]) => ({ site, sourceDir: entry.sourceDir })).filter((item) => item.sourceDir);
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
  if (conflicts.length) throw new Error(`--portals all manages one Mirage per catalogue site; ${conflicts.map((option) => `--${option}`).join(', ')} applies to a single runtime.${selectedOnly.length ? ` (${selectedOnly.map((option) => `--${option}`).join(', ')} apply to the selected site.)` : ''} Set it per site in the catalogue (sites.<id>.mirage) or use --portals selected.`);
  const catalogue = loadCatalogue(args);
  // The other sites resolve without the selected site's own options.
  const shared = Object.fromEntries(Object.entries(args).filter(([option]) => !PER_PORTAL_OPTIONS.includes(option)));
  const entries = [];
  for (const site of Object.keys(catalogue.sites)) {
    if (site === cfg.siteName) { entries.push({ site, cfg }); continue; }
    try {
      entries.push({ site, cfg: await loadConfig({ ...shared, site, env: undefined, portals: 'selected' }) });
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
    const port = String(plan.args.port ?? DEFAULT_PORT);
    if (port !== '0') sitesByPort.set(port, [...(sitesByPort.get(port) ?? []), plan.site]);
  }
  return [...sitesByPort].filter(([, sites]) => sites.length > 1).map(([port, sites]) => `port ${port}: ${sites.join(', ')}`);
}

/** Starts (or reuses) every site's Mirage at once; a site that fails does not stop the others. */
/** Per-site start plans from the catalogue: each site's own project or source, port and preset. */
export function catalogueStartPlans(entries, args, selected = null) {
  // Every runtime reads its site's mirage settings from the catalogue this command resolved,
  // and live writes are allowed for all of them or none.
  const shared = pick(args, ['startup-timeout', 'config', 'repo', 'allow-live-writes']);
  // --port, --state, --preset and --solution-root belong to the selected site's runtime.
  const own = pick(args, SELECTED_SITE_OPTIONS);
  return entries.map((entry) => {
    if (entry.error) return { site: entry.site, error: entry.error };
    try {
      return { site: entry.site, cfg: entry.cfg, args: catalogueArgs(entry.cfg, entry.site === selected ? { ...shared, ...own } : shared) };
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
  if (effective.state !== undefined) throw new Error('--state names one runtime; a project with several portals keeps a state file per portal. Pass --portal to start one of them with --state.');
  const base = effective.port === undefined ? DEFAULT_PORT : Number(effective.port);
  return portals.map((portal, index) => ({
    site: portal.id,
    cfg: { ...cfg, siteName: portal.id, sourceDir: portal.sourceDir },
    args: { ...effective, portal: portal.id, port: String(base === 0 ? 0 : base + index) },
  }));
}

/** Starts (or reuses) every planned Mirage at once; a portal that fails does not stop the others. */
async function startPlans(plans, paths) {
  const clashes = portClashes(plans.filter((plan) => !plan.error));
  if (clashes.length) throw new Error(`Each Mirage needs its own port (${clashes.join('; ')}). Set sites.<id>.mirage.port to distinct ports, or 0 for any free port.`);
  const results = await Promise.allSettled(plans.map((plan) => (plan.error ? Promise.reject(plan.error) : start(plan.cfg, plan.args, { paths }))));
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
    mirageSourceRoots: [...new Set([sourceDir, ...(session.launch?.solutionRoots ?? [])].filter(Boolean).map(realpath))],
    mirageSession: { url: session.url, adminUrl: adminUrlOf(session.url), stateFile, project: session.launch?.project ?? null, portal: session.launch?.portal ?? null, pid: session.pid, started: session.started },
  };
}

/**
 * The dev selection for running Mirages: one local target per portal (cfg.siteName opens
 * first) plus the catalogue's live targets, all switchable without a restart.
 */
export async function portalSelection(cfg, args, running) {
  const targets = running.map((portal) => mirageTarget(portal.cfg, portal.session));
  let live = [], note = null;
  try {
    live = (await loadDevTargets({ ...args, project: undefined, portal: undefined, port: undefined, portals: 'all' })).targets;
  } catch (error) {
    note = error.message.split('\n')[0];
  }
  const initial = targets.find((target) => target.mirageSite === cfg.siteName) ?? targets[0];
  return { selection: { mode: 'all', initial, targets: [...targets, ...live] }, live: live.length, note };
}

async function stopStarted(portals, paths, stop) {
  for (const portal of portals.filter((item) => item.session?.started)) {
    const report = await stopOwnedSessions({ paths, pids: [portal.session.pid] }).catch((error) => ({ stopped: [], error }));
    console.log(report.stopped?.length ? `mirage   stopped ${portal.site} ${portal.session.url} (pid ${portal.session.pid})` : `mirage   could not stop ${portal.site} pid ${portal.session.pid}${report.error ? `: ${report.error.message}` : ''}; run: ${stop}`);
  }
}

/** Starts the planned portals, then reports them (start) or opens them with the live targets (dev). */
async function runPortals({ cfg, args, action, plans, paths, stop, initialSite }) {
  const portals = await startPlans(plans, paths);
  const running = portals.filter((portal) => portal.session);
  const summary = portals.map((portal) => portal.session
    ? { site: portal.site, url: portal.session.url, adminUrl: adminUrlOf(portal.session.url), stateFile: portal.session.stateFile ?? portal.session.launch?.stateFile ?? null, sourceDir: portal.session.sourceDir, pid: portal.session.pid, started: portal.session.started, liveWrites: portal.session.runtime?.liveWrites ?? null }
    : { site: portal.site, error: portal.error?.message ?? String(portal.error) });
  if (action === 'start') {
    print({ action: 'start', portals: summary, stop }, args.json);
    return running.length === portals.length ? 0 : 1;
  }
  for (const item of summary) console.log(item.error ? `mirage   ${item.site.padEnd(8)} FAILED: ${item.error}` : `mirage   ${item.site.padEnd(8)} ${item.url}  (${item.started ? 'started' : 'already running'}, pid ${item.pid})  admin ${item.adminUrl}  live writes ${item.liveWrites ?? 'not reported'}`);
  if (!running.length) throw new Error('No Mirage portal could start; see the messages above.');
  const { selection, live, note } = await portalSelection({ ...cfg, siteName: initialSite }, args, running);
  if (note) console.log(`live        not offered: ${note}`);
  console.log(`switch      ${running.length} local Mirage portal(s) and ${live} live target(s) in the panel's portal selector`);
  console.log('stop        Ctrl+C here or close the browser: the browser and the Mirages started here stop');
  const { default: runDev } = await import('./dev.mjs');
  try {
    return await runDev(selection.initial, { ...args, devSelection: selection });
  } finally {
    await stopStarted(portals, paths, stop);
  }
}

async function miragePortals(cfg, args, action, paths) {
  const entries = await portalConfigs(cfg, args, action);
  if (action === 'init') {
    const projects = [];
    for (const entry of entries) {
      if (entry.error) { projects.push({ site: entry.site, error: entry.error.message }); continue; }
      try {
        projects.push({ site: entry.site, ...(await initProject(entry.cfg, { force: args.force })) });
      } catch (error) {
        projects.push({ site: entry.site, error: error.message });
      }
    }
    print({ action: 'init', projects, next: 'npx paqvilo mirage dev --portals all' }, args.json);
    return projects.some((project) => project.error) ? 1 : 0;
  }
  if (action === 'stop') {
    const folders = entries.filter((entry) => entry.cfg).map((entry) => entry.cfg.sourceDir);
    const report = await stopOwnedSessions({ paths, sourceDirs: folders });
    if (report.remaining.length) throw new Error(`Mirage process ${report.remaining.map((item) => item.pid).join(', ')} did not stop within ${(STOP_DEADLINE + 2000) / 1000} seconds`);
    print({ action: 'stop', message: stopSummary(report, `${entries.length} catalogue portals`, 'the catalogue portals'), ...report }, args.json);
    return 0;
  }
  return runPortals({ cfg, args, action, plans: catalogueStartPlans(entries, args, cfg.siteName), paths, stop: 'npx paqvilo mirage stop --portals all', initialSite: cfg.siteName });
}

/** A project with several portals and no --portal: one runtime per portal of that project. */
async function mirageProjectPortals(cfg, args, effective, action, project, paths) {
  const stop = `npx paqvilo mirage stop --project ${JSON.stringify(project.configFile)}`;
  if (action === 'stop') {
    const report = await stopOwnedSessions({ paths, sourceDirs: project.portals.map((portal) => portal.sourceDir) });
    if (report.remaining.length) throw new Error(`Mirage process ${report.remaining.map((item) => item.pid).join(', ')} did not stop within ${(STOP_DEADLINE + 2000) / 1000} seconds`);
    print({ action: 'stop', message: stopSummary(report, `the ${project.portals.length} portals of ${project.configFile}`, `the portals of ${project.configFile}`), ...report }, args.json);
    return 0;
  }
  return runPortals({ cfg, args, action, plans: projectStartPlans(cfg, effective, project.portals), paths, stop, initialSite: project.defaultPortal });
}

function stopHint(cfg, args) {
  const parts = ['npx paqvilo mirage stop', `--site ${cfg.siteName}`];
  if (args.source) parts.push(`--source ${JSON.stringify(path.resolve(args.source))}`);
  if (args.project && !(cfg.mirageConfig?.project && samePath(args.project, cfg.mirageConfig.project))) parts.push(`--project ${JSON.stringify(path.resolve(args.project))}`);
  if (args.portal) parts.push(`--portal ${args.portal}`);
  return parts.join(' ');
}

function print(value, json) {
  if (json) {
    console.log(JSON.stringify({ schemaVersion: 1, command: 'mirage', ok: true, ...value }, null, 2));
    return;
  }
  if (value.sessions) {
    if (!value.sessions.length) console.log('No Mirage sessions found.');
    for (const session of value.sessions) {
      const state = session.ready ? 'ready' : session.processAlive ? 'starting' : 'stopped';
      console.log(`${state}${session.owned ? ' · toolkit managed' : ''}${session.site ? `  [${session.site}]` : ''}  ${session.url ?? '(no URL yet)'}  ${session.sourceDir ?? ''}${session.runtime?.site ? `  (${session.runtime.site}, ${session.runtime.pageCount} pages)` : ''}`);
      const details = [session.adminUrl && `admin ${session.adminUrl}`, session.identityProvider?.origin && `idp ${session.identityProvider.origin}`, session.runtime?.liveWrites && `live writes ${session.runtime.liveWrites}`, session.project && `project ${session.project}`, session.portal && `portal ${session.portal}`, session.stateFile && `state ${session.stateFile}`, `pid ${session.pid}`].filter(Boolean);
      console.log(`    ${details.join(' · ')}`);
    }
    return;
  }
  if (value.action === 'init' && value.projects) {
    for (const project of value.projects) {
      if (project.error) console.log(`${project.site}: NOT WRITTEN: ${project.error}`);
      else print({ ...project, action: 'init' }, false);
      console.log('');
    }
    console.log(`next: ${value.next}`);
    return;
  }
  if (value.action === 'start' && value.portals) {
    for (const portal of value.portals) {
      console.log(portal.error
        ? `${portal.site.padEnd(8)} FAILED: ${portal.error}`
        : `${portal.site.padEnd(8)} ${portal.url}  (${portal.started ? 'started' : 'already running'}, pid ${portal.pid})  admin ${portal.adminUrl}  state ${portal.stateFile}  live writes ${portal.liveWrites ?? 'not reported'}`);
    }
    if (value.stop) console.log(`Stop:      ${value.stop}`);
    return;
  }
  if (value.action === 'init') {
    console.log(`Mirage project written: ${value.file}`);
    console.log(`  portal     ${value.portal.id}  ${value.portal.sourceDir}${value.portal.origin ? `  (${value.portal.origin})` : ''}`);
    if (value.portal.observed) console.log(`  observed   ${observedText(value.portal.observed)}`);
    for (const solution of value.solutions) console.log(`  solution   ${solution.id}  ${solution.root}`);
    if (value.solutions.length > 1) console.log(`  order      ${value.solutionOrder === 'explicit' ? 'explicit (listed order)' : 'derived (Solution dependency order)'}`);
    if (!value.solutions.length) console.log('  solution   none configured or discovered');
    for (const reference of value.references) console.log(`  reference  ${reference.id}  ${reference.origin}`);
    for (const pack of value.dataPacks) console.log(`  data pack  ${pack.id ? `${pack.id} ` : ''}${pack.module}`);
    if (value.packs.checked) console.log(`  packs      ${value.packs.matching.length ? value.packs.matching.map((pack) => pack.id).join(', ') : 'no registered data pack matches this portal'}`);
    for (const note of value.notes) console.log(`  note: ${note}`);
    console.log(`next: ${value.next}`);
    return;
  }
  if (value.action === 'stop') {
    console.log(value.message);
    for (const item of value.stopped) console.log(`  stopped ${item.url ?? `pid ${item.pid}`}${item.graceful ? '' : ' (forced)'}${item.wasReady ? '' : ' while starting'}`);
    for (const item of value.pruned) console.log(`  removed stale record: pid ${item.pid} (${item.reason})`);
    for (const item of value.unverified ?? []) console.log(`  not verified, kept: pid ${item.pid}${item.url ? ` ${item.url}` : ''} (${item.reason})`);
    return;
  }
  if (value.url) {
    console.log(`Mirage: ${value.url}${value.started === false ? '  (already running)' : ''}\nAdmin:     ${value.adminUrl}\nState:     ${value.stateFile}\nSource:    ${value.sourceDir}\nLive writes: ${liveWritesText(value.runtime?.liveWrites)}`);
    if (value.launch?.project) console.log(`Project:   ${value.launch.project}${value.launch.portal ? ` (portal ${value.launch.portal})` : ''}`);
    if (value.stop) console.log(`Stop:      ${value.stop}`);
    return;
  }
  console.log(value.message ?? JSON.stringify(value, null, 2));
}

export default async function mirage(cfg, args, positionals = []) {
  const action = positionals[0] ?? 'status';
  if (!ACTIONS.includes(action)) throw new Error(`Unknown mirage action "${action}"; use ${ACTIONS.slice(0, -1).join(', ')} or ${ACTIONS.at(-1)}`);
  if (action !== 'init' && (args.out !== undefined || args.force)) throw new Error('--out and --force apply only to mirage init');
  if (args['allow-live-writes'] && !['start', 'dev'].includes(action)) throw new Error('--allow-live-writes applies only to mirage dev and start');
  const paths = miragePaths(cfg, args);
  if (action === 'status') {
    const sessions = await mirageStatus(paths);
    const sites = catalogueSiteFolders(args);
    for (const session of sessions) session.site = sites.find((item) => session.sourceDir && samePath(item.sourceDir, session.sourceDir))?.site ?? null;
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
    if (project.portals.length > 1) return mirageProjectPortals(cfg, args, effective, action, project, paths);
  }
  if (action === 'stop') {
    let sourceDir = cfg.sourceDir;
    if (effective.project) {
      const project = await loadProject(effective.project);
      sourceDir = project.portals.find((item) => item.id === (effective.portal ?? project.defaultPortal))?.sourceDir;
      if (!sourceDir) throw new Error(`Unknown Mirage portal "${effective.portal}" in ${project.configFile}`);
    }
    const report = await stopOwnedSessions({ paths, sourceDir });
    if (report.remaining.length) throw new Error(`Mirage process ${report.remaining.map((item) => item.pid).join(', ')} did not stop within ${(STOP_DEADLINE + 2000) / 1000} seconds`);
    print({ action: 'stop', message: stopSummary(report, cfg.siteName, cfg.siteName), ...report }, args.json);
    return 0;
  }
  if (action === 'inspect') {
    let project = null;
    if (effective.project) {
      project = await loadProject(effective.project);
      if (effective.portal && !project.portals.some((item) => item.id === effective.portal)) throw new Error(`Unknown Mirage portal "${effective.portal}" in ${project.configFile}`);
    }
    const { cli, values } = cliArgs(cfg, 'inspect', effective, project);
    const result = spawnSync(process.execPath, [cli, ...values, '--json'], { cwd: TOOL_ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Mirage inspect exited with ${result.status}`);
    process.stdout.write(result.stdout);
    return 0;
  }
  const session = await start(cfg, effective, { paths });
  const { launch } = session;
  const adminUrl = adminUrlOf(session.url);
  const stateFile = session.stateFile ?? launch.stateFile;
  const stop = stopHint(cfg, effective);
  if (action === 'dev') {
    const mirageSourceRoots = [...new Set([session.sourceDir ?? launch.sourceDir, ...launch.solutionRoots].filter(Boolean).map(realpath))];
    const mirageSession = { url: session.url, adminUrl, stateFile, project: launch.project, portal: launch.portal, pid: session.pid, started: session.started };
    console.log(`mirage   ${session.url}  (${session.started ? 'started' : 'already running'}, pid ${session.pid})`);
    console.log(`admin       ${adminUrl}`);
    console.log(`state       ${stateFile}`);
    console.log(`source      ${session.sourceDir}`);
    console.log(`live writes ${liveWritesText(session.runtime?.liveWrites)}`);
    if (launch.project) console.log(`project     ${launch.project}${launch.portal ? ` (portal ${launch.portal})` : ''}`);
    console.log(`solutions   ${launch.solutionRoots.length ? launch.solutionRoots.join(', ') : 'none (no Solution roots configured or discovered)'}`);
    console.log(`stop        ${session.started ? 'Ctrl+C here or close the browser: the browser and this Mirage stop' : 'Ctrl+C here or close the browser ends the browser session; the Mirage keeps running'}. Stop it any time with: ${stop}`);
    const localCfg = { ...cfg, sourceDir: session.sourceDir, origin: session.url, envName: 'local', siteName: `${session.id ?? cfg.siteName} Mirage`, caution: false, mirage: true, mirageSourceRoots, mirageSession };
    const { default: runDev } = await import('./dev.mjs');
    try {
      return await runDev(localCfg, { ...effective, mirageTarget: localCfg });
    } finally {
      if (session.started) {
        const report = await stopOwnedSessions({ paths, pids: [session.pid] }).catch((error) => ({ stopped: [], remaining: [{ pid: session.pid }], error }));
        console.log(report.stopped.length ? `mirage   stopped ${session.url} (pid ${session.pid})` : `mirage   could not stop pid ${session.pid}${report.error ? `: ${report.error.message}` : ''}; run: ${stop}`);
      }
    }
  }
  print({ action: 'start', ...session, adminUrl, stateFile, stop }, args.json);
  return 0;
}
