// Browser side of the overlay: launch (or attach to) a Chromium-based browser, wire the routes
// and reload pages when sources change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { interceptOrigin } from './intercept.mjs';
import { refreshUrl } from './navigation.mjs';
import { pageKey } from './html-rewriter.mjs';
import { browserProfileInfo, validateBrowserProfile } from './browser-profile.mjs';
export { browserProfileDir, browserProfileInfo } from './browser-profile.mjs';

/**
 * @param {Awaited<ReturnType<import('./config.mjs').loadConfig>>} cfg
 * @param {{headless?: boolean, profileDir?: string, debugPort?: number}} [overrides]
 * @returns {Promise<{context: import('playwright-core').BrowserContext, attached: boolean, close: () => Promise<void>}>}
 */
export async function openBrowser(cfg, overrides = {}) {
  const b = cfg.browser;
  if (b.cdpUrl) {
    const browser = await chromium.connectOverCDP(b.cdpUrl);
    const contexts = browser.contexts();
    const context = contexts[0];
    if (contexts.length !== 1) {
      await browser.close().catch(() => {});
      throw new Error(`Expected one browser context at the CDP endpoint, found ${contexts.length}. Attach to the debugging endpoint of the intended profile.`);
    }
    // closing only detaches: the browser belongs to the user
    return { context, attached: true, profile: browserProfileInfo(cfg), close: () => browser.close() };
  }
  const profile = browserProfileInfo(cfg, overrides.profileDir);
  validateBrowserProfile(profile);
  const profileDir = profile.userDataDir;
  if (profile.kind !== 'external') fs.mkdirSync(profileDir, { recursive: true });
  const headless = overrides.headless ?? b.headless;
  // A headless viewport otherwise becomes the next headed window's saved size.
  // Read only placement metadata; restore it through CDP without editing browser storage.
  const previousWindow = headless ? savedWindowBounds(profileDir, profile.profileDirectory) : null;
  const initializePlacement = !headless && profile.kind !== 'external' && !fs.existsSync(`${profileDir}.window.json`);
  const args = initializePlacement ? ['--window-size=1280,900'] : [];
  if (profile.kind === 'external') args.push(`--profile-directory=${profile.profileDirectory}`);
  // only the dev loop opens the port; it is bound to this machine
  let debugPort = overrides.debugPort ?? null;
  // Never attach VS Code to another account's browser because the requested port was occupied.
  if (debugPort && !(await debuggerPortAvailable(debugPort))) throw new Error(`Debugger port ${debugPort} is already in use. Choose another --debug-port (0 disables debugging), or attach to the intended browser with --cdp-url.`);
  if (debugPort) args.push(`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1');
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
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
  } catch (err) {
    const first = err.message.split('\n')[0];
    if (/already (?:in use|running)|ProcessSingleton|SingletonLock|Target page, context or browser has been closed/i.test(err.message)) {
      throw new Error(`the browser profile ${profileDir} (${profile.profileDirectory}) is in use or could not start. Close the browser using that user-data root, choose another --profile, or attach with --cdp-url to its existing debugging endpoint. (${first})`);
    }
    if (/is not found at|distribution .* is not found|executable doesn't exist/i.test(err.message)) {
      throw new Error(`browser "${b.channel}" is not installed. Set PAQVILO_BROWSER in .env to msedge or chrome. (${first})`);
    }
    throw err;
  }
  if (initializePlacement) {
    try { await initializeBrowserWindow(context, profileDir); }
    catch (error) { await context.close().catch(() => {}); throw error; }
  }
  if (debugPort) {
    try {
      const page = context.pages()[0] ?? await context.newPage();
      const cdp = await context.newCDPSession(page);
      let targetId;
      try { targetId = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
      finally { await cdp.detach(); }
      if (!(await debuggerListening(debugPort, targetId))) throw new Error(`Debugger port ${debugPort} did not expose the selected browser profile. The new browser has been closed; choose a free port and retry.`);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
  // External profiles stay entirely browser-managed; never export their session credentials.
  const stopKeeping = profile.kind === 'external' ? async () => {} : await keepSessionCookies(context, `${profileDir}.session.json`);
  if (!headless) keepDownloads(context);
  return {
    context,
    attached: false,
    profile,
    debugPort: debugPort || null,
    close: async () => {
      try {
        try { await bounded(stopKeeping(), 5000); } catch { /* browser stopped responding */ }
        if (previousWindow) {
          try { await bounded(restoreBrowserWindow(context, previousWindow), 5000); }
          catch (error) { console.error(`Could not restore browser window placement: ${error.message.split('\n')[0]}`); }
        }
      } finally { await context.close(); }
    },
  };
}

function savedWindowBounds(profileDir, profileDirectory) {
  try {
    const { browser } = JSON.parse(fs.readFileSync(path.join(profileDir, profileDirectory, 'Preferences'), 'utf8'));
    const p = browser?.window_placement;
    if (!p || ![p.left, p.top, p.right, p.bottom].every(Number.isInteger)) return null;
    const width = p.right - p.left, height = p.bottom - p.top;
    return width > 0 && height > 0 ? { left: p.left, top: p.top, width, height, maximized: p.maximized === true } : null;
  } catch { return null; } // A new profile has no previous headed placement.
}

async function restoreBrowserWindow(context, placement) {
  const page = context.pages()[0] ?? await context.newPage();
  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    const { maximized, ...bounds } = placement;
    await cdp.send('Browser.setWindowBounds', { windowId, bounds });
    if (maximized) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
  } finally { await cdp.detach(); }
}

/** Normalize old forced-maximized toolkit windows once; then retain the user's placement. */
export async function initializeBrowserWindow(context, profileDir) {
  const page = context.pages()[0] ?? await context.newPage();
  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1280, height: 900 } });
    fs.writeFileSync(`${profileDir}.window.json`, '{"version":1}\n');
  } finally { await cdp.detach(); }
}

async function debuggerPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** Confirm the endpoint exposes a page from this exact launched browser, not another profile. */
async function debuggerListening(port, targetId, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const targets = await res.json();
        if (Array.isArray(targets) && targets.some((target) => target.id === targetId)) return true;
      } else await res.body?.cancel();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * An automated browser keeps downloads in a temporary folder under random names and deletes them
 * when it closes. Put them where the user expects them: the Downloads folder, under their own name.
 */
export function safeDownloadName(suggested) {
  const name = path.win32.basename(path.posix.basename(suggested)).replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'download';
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

/**
 * The portal's sign-in cookie is a session cookie, and a browser forgets those when it closes. They
 * are written next to the profile and put back on the next launch, so one sign-in lasts until the
 * portal itself expires it.
 * @returns {Promise<() => Promise<void>>} stops the periodic save after one last save
 */
export async function keepSessionCookies(context, file) {
  let lastSaved = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(saved)) {
      if (saved.length) await context.addCookies(saved);
      lastSaved = JSON.stringify(saved);
    }
  } catch {
    /* first run, or an unreadable file: start signed out */
  }
  let closed = false;
  let saving = null;
  const save = async () => {
    if (closed) return;
    if (saving) return saving;
    saving = (async () => {
      const temporary = `${file}.tmp`;
      try {
        const session = (await context.cookies()).filter((c) => c.expires === -1);
        const serialized = JSON.stringify(session);
        if (serialized === lastSaved) return;
        fs.writeFileSync(temporary, serialized, { mode: 0o600 });
        fs.renameSync(temporary, file);
        lastSaved = serialized;
      } catch {
        // Preserve the last complete cookie file if a browser closes during a save.
        try { fs.rmSync(temporary, { force: true }); } catch { /* unavailable filesystem */ }
      }
    })();
    try { await saving; } finally { saving = null; }
  };
  // the user may simply close the window, so do not rely on a save at shutdown
  const timer = setInterval(save, 5000);
  timer.unref();
  context.once('close', () => {
    closed = true;
    clearInterval(timer);
  });
  let stopping;
  return () => stopping ??= (async () => {
    clearInterval(timer);
    await saving;
    await save();
  })();
}

/** Routes the portal origin of `context` through the overlay session. */
export async function attachSession(context, session) {
  return interceptOrigin(context, session.cfg.origin, session.route, { bypassCSP: Boolean(session.cfg.browser?.bypassCSP) });
}

// a reload that has not got its document by then is given up on, so later saves still reload
const RELOAD_TIMEOUT = 60_000;
const STYLE_TIMEOUT = 5000;

// Reload through an explicit GET. Chromium's reload() can repeat the POST that produced a
// form result, so a local save must never use it to replay the user's last submission.
const refreshDocument = (page, signal) => signal?.aborted ? Promise.resolve(false)
  : bounded(page.goto(refreshUrl(page.url()), { waitUntil: 'commit', timeout: RELOAD_TIMEOUT }), RELOAD_TIMEOUT, signal).then(() => true, () => false);

async function bounded(promise, ms, signal) {
  let timer;
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('browser operation timed out')), ms);
      onAbort = () => reject(new Error('browser operation stopped'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    })]);
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
export function planRefresh(session, files) {
  const plan = { cssUrls: [], styles: [], reloadKeys: new Set(), reloadAll: false };
  const changes = session.rewriter?.blockChanges;
  const disabled = session.disabled ?? new Set();
  for (const file of files) {
    if (session.rel && disabled.has(session.rel(file))) continue;
    const webFile = session.model.webFiles.find((w) => w.file === file);
    if (webFile?.url && /\.css$/i.test(webFile.url)) {
      let url = webFile.url;
      try { url = decodeURIComponent(url); } catch { /* literal percent */ }
      if (!plan.cssUrls.includes(url.toLowerCase())) plan.cssUrls.push(url.toLowerCase());
      continue;
    }
    const sources = (session.model.inlineSources ?? []).filter((source) => source.file === file);
    if (!sources.length) { plan.reloadAll = true; continue; }
    for (const source of sources) {
      // forms, lists, templates and snippets can appear on any page
      if (!source.kind.startsWith('page-') || !source.pageUrl) { plan.reloadAll = true; continue; }
      if (disabled.has(source.rel)) continue; // a paused override changes nothing in the page
      const key = pageKey(source.pageUrl);
      const change = source.kind === 'page-css' && !source.extract ? changes?.get(source.rel) : null;
      if (typeof change?.before === 'string' && change.before.trim() && typeof change.after === 'string') plan.styles.push({ pageKey: key, before: change.before, after: change.after });
      else plan.reloadKeys.add(key);
    }
  }
  return plan;
}

const pageKeyOf = (address) => { try { return pageKey(new URL(address).pathname); } catch { return null; } };

/** Files which can affect this tab. Global sources and unindexed/deleted files affect every tab. */
export function filesForPage(session, files, address) {
  const key = pageKeyOf(address);
  return files.filter((file) => {
    if (session.rel && session.disabled?.has(session.rel(file))) return false;
    const sources = (session.model.inlineSources ?? []).filter((source) => source.file === file);
    return !sources.length || sources.some((source) => !source.kind.startsWith('page-') || !source.pageUrl || pageKey(source.pageUrl) === key);
  });
}

/** Runs in the page: re-links changed stylesheets and replaces the text of changed inline styles. */
function swapStyles({ urls, styles }) {
  const links = new Set();
  for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const u = new URL(link.href, location.href);
    let pathname = u.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* literal percent in an unrelated URL */ }
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
    try { return !p.isClosed() && new URL(p.url()).origin === session.cfg.origin; } catch { return false; }
  });
  for (const page of pages) outcomes.set(page, { how: 'none', files: force ? files : filesForPage(session, files, page.url()) });
  if (session.bypass || signal?.aborted) return 'none';
  if (!pages.length || (!files.length && !force)) return 'none';
  // only until the new document arrives: a page held at a breakpoint would never finish loading
  // (the caller must not start another reload before this one has returned: see watchSources)
  if (force) {
    await Promise.all(pages.map(async (page) => {
      if (await refreshDocument(page, signal)) outcomes.get(page).how = 'reload';
    }));
    return [...outcomes.values()].some((result) => result.how === 'reload') ? 'reload' : 'none';
  }
  const plan = planRefresh(session, files);
  if (plan.reloadAll) {
    await Promise.all(pages.map(async (page) => {
      if (await refreshDocument(page, signal)) outcomes.get(page).how = 'reload';
    }));
    return [...outcomes.values()].some((result) => result.how === 'reload') ? 'reload' : 'none';
  }
  let reloaded = false;
  let swapped = false;
  await Promise.all(
    pages.map(async (p) => {
      const key = pageKeyOf(p.url());
      const outcome = outcomes.get(p);
      if (plan.reloadKeys.has(key)) {
        if (await refreshDocument(p, signal)) { reloaded = true; outcome.how = 'reload'; }
        return;
      }
      const styles = plan.styles.filter((style) => style.pageKey === key);
      if (!plan.cssUrls.length && !styles.length) { outcome.how = 'skipped'; return; }
      const result = await bounded(p.evaluate(swapStyles, { urls: plan.cssUrls, styles: styles.map(({ before, after }) => ({ before, after })) }), STYLE_TIMEOUT, signal).catch(() => null);
      // Imported CSS has no link of its own, and a style block that is not in the page yet
      // (first custom CSS of a page) cannot be swapped: reload to refresh those too.
      if (result && result.links >= plan.cssUrls.length && result.styles >= styles.length) {
        swapped = true;
        outcome.how = 'css';
        return;
      }
      if (await refreshDocument(p, signal)) { reloaded = true; outcome.how = 'reload'; }
    }),
  );
  return reloaded ? 'reload' : swapped ? 'css' : [...outcomes.values()].some((result) => result.how === 'none') ? 'none' : 'skipped';
}
