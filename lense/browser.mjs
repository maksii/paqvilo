// Browser side of the overlay: launch (or attach to) a Chromium-based browser, wire the routes
// and reload pages when sources change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { BROWSER_HANG_GUARD_MS, windowsLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { stripTrailingCharacters } from '../mirage/lib/text-scanning.mjs';
import { interceptOrigin } from './intercept.mjs';
import { createInspectionProvenanceTransport } from './inspection-provenance-transport.mjs';
import { refreshUrl } from './navigation.mjs';
import { pageKey } from './html-rewriter.mjs';
import { browserProfileInfo, validateBrowserProfile, validateDebuggerMode } from './browser-profile.mjs';
export { browserProfileDir } from './browser-profile.mjs';

// BROWSER_HANG_GUARD_MS (mirage/lib/browser-launch.mjs) bounds each browser start-up wait in place of Playwright's own
// defaults (180 s for a launch, 30 s for a CDP attach). It only stops an operation that never finishes;
// `overrides.hangGuardMs` replaces it.
// Hang guard for each step of closing: the final session-cookie save and the window placement restore.
const BROWSER_CLOSE_GUARD_MS = 30_000;
const DEBUGGER_POLL_MS = 200;

/**
 * @param {Awaited<ReturnType<import('./config.mjs').loadConfig>>} cfg
 * @param {{headless?: boolean, profileDir?: string, debugPort?: number, hangGuardMs?: number, closeGuardMs?: number}} [overrides]
 * @returns {Promise<{context: import('playwright-core').BrowserContext, attached: boolean, close: () => Promise<void>}>}
 */
export async function openBrowser(cfg, overrides = {}) {
  const b = cfg.browser;
  const guardMs = guardDuration(overrides.hangGuardMs, BROWSER_HANG_GUARD_MS, 'hangGuardMs');
  const closeGuardMs = guardDuration(overrides.closeGuardMs, BROWSER_CLOSE_GUARD_MS, 'closeGuardMs');
  validateDebuggerMode(b.cdpUrl, overrides.debugPort ?? b.debugPort);
  if (b.cdpUrl) {
    const browser = await connectAttachedBrowser(b.cdpUrl, guardMs);
    const contexts = browser.contexts();
    const context = contexts[0];
    if (contexts.length !== 1) {
      // A browser that stopped answering cannot hold the failure: its close ends at the guard too.
      await bounded(browser.close(), guardMs).catch(() => {});
      throw new Error(
        `Expected one browser context at the CDP endpoint, found ${contexts.length}. Attach to the debugging endpoint of the intended profile.`,
      );
    }
    // closing only detaches: the browser belongs to the user
    return { context, attached: true, profile: browserProfileInfo(cfg), close: () => browser.close() };
  }
  const profile = browserProfileInfo(cfg, overrides.profileDir);
  validateBrowserProfile(profile);
  const profileDir = profile.userDataDir;
  ensureOwnedProfileDirectory(profile, profileDir);
  const headless = overrides.headless ?? b.headless;
  const { previousWindow, initializePlacement, args } = browserWindowSettings(profile, profileDir, headless);
  // only the dev loop opens the port; it is bound to this machine
  const debugPort = overrides.debugPort ?? null;
  // Never attach VS Code to another account's browser because the requested port was occupied.
  if (debugPort && !(await debuggerPortAvailable(debugPort)))
    throw new Error(
      `Debugger port ${debugPort} is already in use. Choose another --debug-port (0 disables debugging), or attach to the intended browser with --cdp-url.`,
    );
  appendDebuggerArgs(args, debugPort);
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions(b, headless, args, guardMs));
  } catch (err) {
    const guarded = hangGuardError(err, 'Launching the browser profile', guardMs);
    if (guarded !== err) throw guarded;
    throwBrowserLaunchError(err, profileDir, profile, b);
  }
  if (initializePlacement) {
    try {
      await initializeBrowserWindow(context, profileDir, guardMs);
    } catch (error) {
      // A browser that stopped answering cannot hold the failure: its close ends at the guard too.
      await bounded(context.close(), guardMs).catch(() => {});
      throw stepHangGuardError(error, 'Setting up the browser window', guardMs);
    }
  }
  if (debugPort) {
    try {
      await awaitDebuggerEndpoint(context, debugPort, guardMs);
    } catch (error) {
      // A browser that stopped answering cannot hold the failure: its close ends at the guard too.
      await bounded(context.close(), guardMs).catch(() => {});
      throw stepHangGuardError(error, 'Querying the debugger endpoint', guardMs);
    }
  }
  // External profiles stay entirely browser-managed; never export their session credentials.
  const stopKeeping =
    profile.kind === 'external'
      ? async () => {}
      : await restoreOwnedSession(
          context,
          profileDir,
          overrides.cookieOrigins ?? [cfg.origin].filter(Boolean),
          guardMs,
        );
  keepHeadedDownloads(context, headless);
  return {
    context,
    attached: false,
    profile,
    debugPort: debugPort || null,
    close: () => closeLaunchedBrowser(context, stopKeeping, previousWindow, closeGuardMs),
  };
}

function ensureOwnedProfileDirectory(profile, profileDir) {
  if (profile.kind !== 'external') fs.mkdirSync(profileDir, { recursive: true });
}
function browserWindowSettings(profile, profileDir, headless) {
  // A headless viewport otherwise becomes the next headed window's saved size.
  // Read only placement metadata; restore it through CDP without editing browser storage.
  const previousWindow = headless ? savedWindowBounds(profileDir, profile.profileDirectory) : null;
  const initializePlacement = !headless && profile.kind !== 'external' && !fs.existsSync(`${profileDir}.window.json`);
  const args = initializePlacement ? ['--window-size=1280,900'] : [];
  if (profile.kind === 'external') args.push(`--profile-directory=${profile.profileDirectory}`);
  return { previousWindow, initializePlacement, args };
}
function appendDebuggerArgs(args, debugPort) {
  if (debugPort) args.push(`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1');
}
// The Lense command that opened the browser handles interrupts and closes it. Playwright's own handlers would exit the
// process in the middle of that cleanup, so they are never installed. Playwright's exit hook closes a browser left behind
// when the process exits normally.
export function launchOptions(b, headless, args, guardMs) {
  return { ...browserLaunchSettings(b, headless, args), timeout: guardMs, handleSIGINT: false, handleSIGTERM: false };
}
function browserLaunchSettings(b, headless, args) {
  return windowsLaunchOptions({
    channel: b.channel === 'chromium' ? undefined : b.channel,
    headless,
    // Desktop sessions use the browser sandbox. Linux headless fixture runners can
    // run inside containers without an available Chromium user-namespace sandbox.
    chromiumSandbox: process.platform === 'win32' || !headless,
    viewport: headless ? { width: 1440, height: 900 } : null,
    // a service worker would answer requests before the overlay sees them
    serviceWorkers: 'block',
    // An explicit development opt-in is needed when local edits invalidate the portal's CSP.
    bypassCSP: Boolean(b.bypassCSP),
    ignoreDefaultArgs: ['--enable-automation'],
    args,
  });
}
function keepHeadedDownloads(context, headless) {
  if (!headless) keepDownloads(context);
}

// Without a portal origin nothing is kept, so no session file is read, written or removed.
async function keepOwnedSession(context, profileDir, origins, signal) {
  if (!portalHosts(origins).size) return async () => {};
  removeLegacySessionFile(`${profileDir}.session.json`);
  return keepSessionCookies(context, sessionFileFor(profileDir, origins), { origins, signal });
}

// The session step of the open: it ends at the hang guard, and a step that failed or was given up on keeps nothing
// and leaves no browser behind.
async function restoreOwnedSession(context, profileDir, origins, guardMs) {
  const abandon = new AbortController();
  try {
    return await bounded(keepOwnedSession(context, profileDir, origins, abandon.signal), guardMs);
  } catch (error) {
    abandon.abort();
    // A browser that stopped answering cannot hold the failure: its close ends at the guard too.
    await bounded(context.close(), guardMs).catch(() => {});
    throw stepHangGuardError(error, 'Restoring the portal session', guardMs);
  }
}

// Each portal scope has its own session file. The name carries a hash of the scope's hosts, so no host text appears in it.
export function sessionFileFor(profileDir, origins) {
  const hosts = [...portalHosts(origins)]
    .map((host) => host.toLowerCase())
    .toSorted((a, b) => a.localeCompare(b, 'en'));
  const scope = createHash('sha256').update(hosts.join(',')).digest('hex').slice(0, 16);
  return `${profileDir}.session.${scope}.json`;
}

// The unscoped session file of earlier versions may hold identity-provider cookies, so it is deleted and never read.
function removeLegacySessionFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    console.error(
      `Could not remove the unscoped session file ${file}: ${error.message.split('\n')[0]}. It is not read.`,
    );
  }
}

// Chromium holds the profile lock in the user-data root: `lockfile` on Windows and `SingletonLock` on POSIX, a symbolic
// link to `<hostname>-<pid>`. Both names are checked on every platform. The lock counts as held while its link is
// present, unless it names another host or a process that has exited.
export function profileLockPresent(userDataRoot, { hostname = os.hostname(), alive = processIsAlive } = {}) {
  return (
    lockFileExists(path.join(userDataRoot, 'lockfile')) ||
    singletonLockHeld(path.join(userDataRoot, 'SingletonLock'), hostname, alive)
  );
}

// An existence test is not enough for a symbolic link, because `lstat` also sees a link whose target is missing.
function lockFileExists(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

function singletonLockHeld(file, hostname, alive) {
  if (!lockFileExists(file)) return false;
  let target;
  try {
    target = fs.readlinkSync(file);
  } catch {
    // A regular file or an unreadable link cannot be shown to be stale, so it counts as held.
    return true;
  }
  const match = /^(.*)-(\d+)$/.exec(path.basename(target));
  if (!match) return true;
  return match[1] === hostname && alive(Number(match[2]));
}

// ESRCH is the only answer that means the process has exited; EPERM means it exists under another account.
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function throwBrowserLaunchError(err, profileDir, profile, b) {
  const first = err.message.split('\n')[0];
  if (/is not found at|distribution .* is not found|executable doesn't exist/i.test(err.message)) {
    throw new Error(
      `browser "${b.channel}" is not installed. Set PAQVILO_BROWSER in .env to msedge or chrome. (${first})`,
      { cause: err },
    );
  }
  if (profileLockPresent(profileDir)) {
    throw new Error(
      `the browser profile ${profileDir} (${profile.profileDirectory}) is in use or could not start. Close the browser using that user-data root, choose another --profile, or attach with --cdp-url to its existing debugging endpoint. (${first})`,
      { cause: err },
    );
  }
  throw err;
}

// Largest delay that setTimeout honours; a longer guard would fire at once.
const MAX_GUARD_MS = 2_147_483_647;
const GUARD_TIMEOUT_CODE = 'PAQVILO_GUARD_TIMEOUT';

// An override is checked where it is read, so a bad value is reported before any browser starts.
function guardDuration(value, fallback, name) {
  const ms = value ?? fallback;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${name} must be a positive number of milliseconds.`);
  return Math.min(ms, MAX_GUARD_MS);
}

// A browser that has disconnected, or has no page left open (its last window was closed, so it is exiting), is gone.
// The state is decided before or as a shutdown call fails. The error text differs by platform and browser version
// (Chromium on Linux answers a call made while it exits with "Browser context management is not supported."), so the
// message test below is only a secondary signal.
function browserGone(context) {
  return context.browser?.()?.isConnected() === false || context.pages?.().length === 0;
}

// A browser the user has closed cannot answer the final save; the session file then stays as it was, without a notice.
function browserClosedError(error) {
  return /Target page, context or browser has been closed/.test(error.message);
}

function sessionSaveNotice(error, guardMs) {
  if (error.code === GUARD_TIMEOUT_CODE)
    return `Session cookies were not saved: the browser did not answer within ${guardMs / 1000} s.`;
  return `Session cookies were not saved: ${error.message.split('\n')[0]}`;
}

// A file-system failure (it names a syscall) and a browser that never answered are always reported; any other failure
// is reported unless the browser is gone.
function reportsSaveFailure(context, error) {
  if (error.syscall || error.code === GUARD_TIMEOUT_CODE) return true;
  return !browserGone(context) && !browserClosedError(error);
}

// A close that fails on a browser that exited on its own is not a failure: the browser is disconnected, or it has no page
// left and the error says the target is closed. Any other rejection is a cleanup failure.
function closedOnItsOwn(context, error) {
  if (context.browser?.()?.isConnected() === false) return true;
  return context.pages?.().length === 0 && browserClosedError(error);
}

async function closeLaunchedBrowser(context, stopKeeping, previousWindow, guardMs) {
  try {
    try {
      await bounded(stopKeeping(), guardMs);
    } catch (error) {
      if (reportsSaveFailure(context, error)) console.error(sessionSaveNotice(error, guardMs));
    }
    if (previousWindow) {
      try {
        await bounded(restoreBrowserWindow(context, previousWindow), guardMs);
      } catch (error) {
        if (!browserGone(context))
          console.error(`Could not restore browser window placement: ${error.message.split('\n')[0]}`);
      }
    }
  } finally {
    await context.close().catch((error) => {
      if (!closedOnItsOwn(context, error)) throw error;
    });
  }
}

function savedWindowBounds(profileDir, profileDirectory) {
  try {
    const { browser } = JSON.parse(fs.readFileSync(path.join(profileDir, profileDirectory, 'Preferences'), 'utf8'));
    const p = browser?.window_placement;
    if (!p || ![p.left, p.top, p.right, p.bottom].every(Number.isInteger)) return null;
    const width = p.right - p.left,
      height = p.bottom - p.top;
    return width > 0 && height > 0
      ? { left: p.left, top: p.top, width, height, maximized: p.maximized === true }
      : null;
  } catch {
    return null;
  } // A new profile has no previous headed placement.
}

async function restoreBrowserWindow(context, placement) {
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    const { maximized, ...bounds } = placement;
    await cdp.send('Browser.setWindowBounds', { windowId, bounds });
    if (maximized) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
  } finally {
    await cdp.detach();
  }
}

/** Normalize old forced-maximized toolkit windows once; then retain the user's placement. */
async function initializeBrowserWindow(context, profileDir, guardMs) {
  const page = context.pages()[0] ?? (await bounded(context.newPage(), guardMs));
  const cdp = await bounded(context.newCDPSession(page), guardMs);
  try {
    const { windowId } = await bounded(cdp.send('Browser.getWindowForTarget'), guardMs);
    await bounded(cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }), guardMs);
    await bounded(cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1280, height: 900 } }), guardMs);
    fs.writeFileSync(`${profileDir}.window.json`, '{"version":1}\n');
  } finally {
    await bounded(cdp.detach(), guardMs);
  }
}

async function debuggerPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

// Playwright's own 30 s deadline is replaced by the named hang guard; a timeout error names the guard and the wait.
function hangGuardError(error, what, guardMs) {
  if (error?.name !== 'TimeoutError') return error;
  return hangGuardMessage(what, guardMs, error);
}

// A set-up step that stops answering (its `bounded` guard expired) ends with the same message as a launch.
function stepHangGuardError(error, what, guardMs) {
  if (error?.code !== GUARD_TIMEOUT_CODE) return error;
  return hangGuardMessage(what, guardMs, error);
}

function hangGuardMessage(what, guardMs, cause) {
  return new Error(
    `${what} did not finish within ${guardMs} ms. That is the browser hang guard, not a readiness deadline.`,
    {
      cause,
    },
  );
}

async function connectAttachedBrowser(endpoint, guardMs) {
  try {
    return await chromium.connectOverCDP(endpoint, { timeout: guardMs });
  } catch (error) {
    throw hangGuardError(error, 'Attaching to the debugging endpoint', guardMs);
  }
}

// The debugger wait ends when the browser context closes or when the hang guard expires.
function debuggerWaitSignal(context, guardMs) {
  const closed = new AbortController();
  context.once('close', () => closed.abort());
  return AbortSignal.any([closed.signal, AbortSignal.timeout(guardMs)]);
}

async function awaitDebuggerEndpoint(context, debugPort, guardMs) {
  const page = context.pages()[0] ?? (await bounded(context.newPage(), guardMs));
  const cdp = await bounded(context.newCDPSession(page), guardMs);
  let targetId;
  try {
    targetId = (await bounded(cdp.send('Target.getTargetInfo'), guardMs)).targetInfo.targetId;
  } finally {
    await bounded(cdp.detach(), guardMs);
  }
  if (!(await debuggerListening(debugPort, targetId, { signal: debuggerWaitSignal(context, guardMs) })))
    throw new Error(
      `Debugger port ${debugPort} did not expose the selected browser profile before the browser closed or the ${guardMs} ms hang guard expired. The new browser has been closed; choose a free port and retry.`,
    );
}

/**
 * Confirm the endpoint exposes a page from this exact launched browser, not another profile. Refused connections and
 * listings without the target are polled again; only the signal ends the wait without a listing.
 */
async function debuggerListening(
  port,
  targetId,
  { fetch: request = globalThis.fetch, signal = AbortSignal.timeout(BROWSER_HANG_GUARD_MS) } = {},
) {
  while (!signal?.aborted) {
    if (await debuggerListsTarget(port, targetId, request, signal)) return true;
    await new Promise((resolve) => setTimeout(resolve, DEBUGGER_POLL_MS));
  }
  return false;
}

async function debuggerListsTarget(port, targetId, request, signal) {
  try {
    const res = await request(`http://127.0.0.1:${port}/json/list`, { signal });
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    const targets = await res.json();
    return Array.isArray(targets) && targets.some((target) => target.id === targetId);
  } catch {
    // Refused, or a listing without the target: the caller polls again until its signal ends the wait.
    return false;
  }
}

/**
 * An automated browser keeps downloads in a temporary folder under random names and deletes them
 * when it closes. Put them where the user expects them: the Downloads folder, under their own name.
 */
export function safeDownloadName(suggested) {
  const name =
    stripTrailingCharacters(
      path.win32
        .basename(path.posix.basename(suggested))
        // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
        .replace(/[<>:"|?*\x00-\x1f]/g, '_'),
      '. ',
    ) || 'download';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

function keepDownloads(context) {
  const dir = path.join(os.homedir(), 'Downloads');
  const watch = (page) =>
    page.on('download', async (download) => {
      try {
        // A server-supplied name is never allowed to select a directory on the workstation.
        const name = safeDownloadName(download.suggestedFilename());
        const { name: stem, ext } = path.parse(name);
        fs.mkdirSync(dir, { recursive: true });
        let target = path.join(dir, name);
        // Reserve a name before awaiting: two simultaneous downloads can suggest the same name.
        for (let n = 1; ; n++) {
          try {
            fs.closeSync(fs.openSync(target, 'wx'));
            break;
          } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            target = path.join(dir, `${stem} (${n})${ext}`);
          }
        }
        try {
          await download.saveAs(target);
        } catch (err) {
          fs.rmSync(target, { force: true });
          throw err;
        }
        console.log(`download saved to ${target}`);
      } catch {
        /* cancelled, or the browser closed */
      }
    });
  context.pages().forEach(watch);
  context.on('page', watch);
}

// Cookie domains and URL host names are compared lower-case, and IPv6 brackets are not part of a host name.
function bareHost(host) {
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function portalHosts(origins) {
  return new Set(
    origins.flatMap((origin) => {
      try {
        return [bareHost(new URL(origin).hostname)];
      } catch {
        return [];
      }
    }),
  );
}

function removeTemporaryFile(temporary) {
  try {
    fs.rmSync(temporary, { force: true });
  } catch {
    /* unavailable filesystem: the write error is the one reported */
  }
}

function ignoreFailedPeriodicSave() {
  // A failed periodic save keeps the last complete cookie file; the final save at close reports its own failure.
}

// RFC 6265 domain matching: a host-only cookie names a portal host, and a domain cookie names a portal host or a
// parent of one. A domain without a dot, such as '.localhost', matches only that exact host, never every name under it.
function inPortalScope(cookie, hosts) {
  const domain = bareHost(String(cookie.domain ?? ''));
  if (!domain.startsWith('.')) return hosts.has(domain);
  const parent = domain.slice(1);
  if (!parent.includes('.')) return hosts.has(parent);
  return [...hosts].some((host) => host === parent || host.endsWith(`.${parent}`));
}

/**
 * The portal's sign-in cookie is a session cookie, and a browser forgets those when it closes. They
 * are written next to the profile and put back on the next launch, so one sign-in lasts until the
 * portal itself expires it.
 * Only cookies that belong to the hosts of `origins` are written or restored; other sites' sessions stay in the
 * browser's own store. Without any origin nothing is restored and the stored file is left as it is.
 * A `signal` aborted before the cookies have been read keeps nothing: no save is armed and nothing is written.
 * @returns {Promise<() => Promise<void>>} stops the periodic save after one last save
 */
export async function keepSessionCookies(context, file, { origins = [], signal } = {}) {
  const hosts = portalHosts(origins);
  if (!hosts.size) return async () => {};
  const ports = new Set(
    origins.flatMap((origin) => {
      try {
        const url = new URL(origin);
        return [url.port || (url.protocol === 'https:' ? '443' : '80')];
      } catch {
        return [];
      }
    }),
  );
  const stale = (cookie) =>
    ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(cookie.domain?.replace(/^\./, '')) &&
    /^paqvilo-mirage-(?:auth|idp)-(\d+)$/.test(cookie.name) &&
    ports.size &&
    !ports.has(cookie.name.split('-').at(-1));
  const keep = (cookie) => !stale(cookie) && inPortalScope(cookie, hosts);
  for (const cookie of await context.cookies())
    if (stale(cookie)) await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
  let lastSaved = null;
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const saved = Array.isArray(stored) ? stored.filter(keep) : stored;
    if (Array.isArray(saved)) {
      if (saved.length) await context.addCookies(saved);
      lastSaved = JSON.stringify(stored);
    }
  } catch {
    /* first run, or an unreadable file: start signed out */
  }
  // The open that asked for this has given up: nothing is kept and nothing is saved.
  if (signal?.aborted) return async () => {};
  let closed = false;
  let saving = null;
  const writeSession = async () => {
    const session = (await context.cookies()).filter((c) => c.expires === -1 && keep(c));
    const serialized = JSON.stringify(session);
    if (serialized === lastSaved) return;
    const temporary = `${file}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { mode: 0o600 });
      fs.renameSync(temporary, file);
      lastSaved = serialized;
    } catch (error) {
      // Preserve the last complete cookie file if a write fails midway; the caller reports the error.
      removeTemporaryFile(temporary);
      throw error;
    }
  };
  const save = async () => {
    if (closed) return;
    if (saving) return saving;
    saving = writeSession().finally(() => {
      saving = null;
    });
    return saving;
  };
  // the user may simply close the window, so do not rely on a save at shutdown
  const timer = setInterval(() => save().catch(ignoreFailedPeriodicSave), 5000);
  timer.unref();
  context.once('close', () => {
    closed = true;
    clearInterval(timer);
  });
  let stopping;
  return () =>
    (stopping ??= (async () => {
      clearInterval(timer);
      // a periodic save still writing may fail; the final save below reports its own result
      await saving?.catch(ignoreFailedPeriodicSave);
      await save();
    })());
}

/** Routes the portal origin of `context` through the overlay session. */
export async function attachSession(context, session) {
  const provenance = createInspectionProvenanceTransport(context, [session.cfg]);
  session.provenanceSlot = provenance.slot;
  session.domProvenanceSlot = provenance.domSlot;
  return interceptOrigin(context, session.cfg.origin, session.route, {
    bypassCSP: Boolean(session.cfg.browser?.bypassCSP),
    onAttach: provenance.onAttach,
  });
}

// a reload that has not got its document by then is given up on, so later saves still reload
const RELOAD_TIMEOUT = 60_000;
const STYLE_TIMEOUT = 5000;

// Reload through an explicit GET. Chromium's reload() can repeat the POST that produced a
// form result, so a local save must never use it to replay the user's last submission.
async function refreshDocument(page, signal) {
  if (signal?.aborted) return false;
  try {
    await bounded(
      page.goto(refreshUrl(page.url()), { waitUntil: 'commit', timeout: RELOAD_TIMEOUT }),
      RELOAD_TIMEOUT,
      signal,
    );
    return true;
  } catch (error) {
    reportGivenUpReload(error, signal);
    return false;
  }
}

// A reload that gets no document in time keeps the tab on its previous document; the caller's log does not show that.
function reportGivenUpReload(error, signal) {
  const timedOut = error.name === 'TimeoutError' || error.code === GUARD_TIMEOUT_CODE;
  if (timedOut && !signal?.aborted)
    console.error(
      `Browser tab was not reloaded: its document did not arrive within ${RELOAD_TIMEOUT / 1000} s. It keeps its previous document.`,
    );
}

function guardTimeoutError() {
  return Object.assign(new Error('browser operation timed out'), { code: GUARD_TIMEOUT_CODE });
}

async function bounded(promise, ms, signal) {
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(guardTimeoutError()), ms);
        onAbort = () => reject(new Error('browser operation stopped'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * What saved files mean for open tabs: web stylesheets and page custom CSS are swapped in place,
 * sources that belong to one page only reload the tabs showing that page, and everything else
 * (web scripts, forms, templates, snippets, unknown files) reloads every tab of the portal.
 */
function planRefresh(session, files) {
  const plan = { cssUrls: [], styles: [], reloadKeys: new Set(), reloadAll: false };
  const changes = session.rewriter?.blockChanges;
  const disabled = session.disabled ?? new Set();
  for (const file of files) planRefreshFile(session, file, plan, changes, disabled);
  return plan;
}

function planRefreshFile(session, file, plan, changes, disabled) {
  if (session.rel && disabled.has(session.rel(file))) return;
  const webFile = session.model.webFiles.find((w) => w.file === file);
  if (webFile?.url && /\.css$/i.test(webFile.url)) {
    let url = webFile.url;
    try {
      url = decodeURIComponent(url);
    } catch {
      /* literal percent */
    }
    if (!plan.cssUrls.includes(url.toLowerCase())) plan.cssUrls.push(url.toLowerCase());
    return;
  }
  const sources = (session.model.inlineSources ?? []).filter((source) => source.file === file);
  if (!sources.length) {
    plan.reloadAll = true;
    return;
  }
  for (const source of sources) planInlineSource(source, plan, changes, disabled);
}

function planInlineSource(source, plan, changes, disabled) {
  // forms, lists, templates and snippets can appear on any page
  if (!source.kind.startsWith('page-') || !source.pageUrl) {
    plan.reloadAll = true;
    return;
  }
  if (disabled.has(source.rel)) return; // a paused override changes nothing in the page
  const key = pageKey(source.pageUrl);
  const change = source.kind === 'page-css' && !source.extract ? changes?.get(source.rel) : null;
  if (typeof change?.before === 'string' && change.before.trim() && typeof change.after === 'string')
    plan.styles.push({ pageKey: key, before: change.before, after: change.after });
  else plan.reloadKeys.add(key);
}

const pageKeyOf = (address, model) => {
  try {
    return pageKey(new URL(address).pathname, model);
  } catch {
    return null;
  }
};

/** Files which can affect this tab. Global sources and unindexed/deleted files affect every tab. */
export function filesForPage(session, files, address) {
  const key = pageKeyOf(address, session.model);
  return files.filter((file) => {
    if (session.rel && session.disabled?.has(session.rel(file))) return false;
    const sources = (session.model.inlineSources ?? []).filter((source) => source.file === file);
    return (
      !sources.length ||
      sources.some((source) => !source.kind.startsWith('page-') || !source.pageUrl || pageKey(source.pageUrl) === key)
    );
  });
}

/** Runs in the page: re-links changed stylesheets and replaces the text of changed inline styles. */
function swapStyles({ urls, styles }) {
  const links = new Set();
  for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const u = new URL(link.href, location.href);
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      /* literal percent in an unrelated URL */
    }
    if (u.origin !== location.origin || !urls.includes(pathname.toLowerCase())) continue;
    u.searchParams.set('paqvilo', Date.now().toString());
    link.href = u.href;
    links.add(pathname.toLowerCase());
  }
  const norm = (text) => text.replace(/\r\n?/g, '\n').trim();
  let swapped = 0;
  for (const { before, after } of styles) {
    const target = norm(before);
    let found = false;
    for (const style of document.querySelectorAll('style')) {
      if (norm(style.textContent) !== target) continue;
      style.textContent = after;
      found = true;
    }
    if (found) swapped++;
  }
  return { links: links.size, styles: swapped };
}

/**
 * Brings portal tabs up to date after `files` changed, swapping styles in place where possible.
 * @returns {Promise<'css'|'reload'|'skipped'|'none'>} 'skipped': no open tab shows the changed page
 */
export async function refreshPages(context, session, files, { force = false, outcomes = new Map(), signal } = {}) {
  const pages = context.pages().filter((p) => {
    try {
      return !p.isClosed() && new URL(p.url()).origin === session.cfg.origin;
    } catch {
      return false;
    }
  });
  for (const page of pages)
    outcomes.set(page, { how: 'none', files: force ? files : filesForPage(session, files, page.url()) });
  if (session.bypass || signal?.aborted) return 'none';
  if (!pages.length || (!files.length && !force)) return 'none';
  // only until the new document arrives: a page held at a breakpoint would never finish loading
  // (the caller must not start another reload before this one has returned: see watchSources)
  if (force) {
    await Promise.all(
      pages.map(async (page) => {
        if (await refreshDocument(page, signal)) outcomes.get(page).how = 'reload';
      }),
    );
    return [...outcomes.values()].some((result) => result.how === 'reload') ? 'reload' : 'none';
  }
  const plan = planRefresh(session, files);
  if (plan.reloadAll) {
    await Promise.all(
      pages.map(async (page) => {
        if (await refreshDocument(page, signal)) outcomes.get(page).how = 'reload';
      }),
    );
    return [...outcomes.values()].some((result) => result.how === 'reload') ? 'reload' : 'none';
  }
  let reloaded = false;
  let swapped = false;
  await Promise.all(
    pages.map(async (p) => {
      const key = pageKeyOf(p.url(), session.model);
      const outcome = outcomes.get(p);
      if (plan.reloadKeys.has(key)) {
        if (await refreshDocument(p, signal)) {
          reloaded = true;
          outcome.how = 'reload';
        }
        return;
      }
      const styles = plan.styles.filter((style) => style.pageKey === key);
      if (!plan.cssUrls.length && !styles.length) {
        outcome.how = 'skipped';
        return;
      }
      const result = await bounded(
        p.evaluate(swapStyles, { urls: plan.cssUrls, styles: styles.map(({ before, after }) => ({ before, after })) }),
        STYLE_TIMEOUT,
        signal,
      ).catch(() => null);
      // Imported CSS has no link of its own, and a style block that is not in the page yet
      // (first custom CSS of a page) cannot be swapped: reload to refresh those too.
      if (result && result.links >= plan.cssUrls.length && result.styles >= styles.length) {
        swapped = true;
        outcome.how = 'css';
        return;
      }
      if (await refreshDocument(p, signal)) {
        reloaded = true;
        outcome.how = 'reload';
      }
    }),
  );
  if (reloaded) return 'reload';
  if (swapped) return 'css';
  if ([...outcomes.values()].some((result) => result.how === 'none')) return 'none';
  return 'skipped';
}
