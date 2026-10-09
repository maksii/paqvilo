// The dev panel, on the side of the dev loop: what each tab's panel shows, and what its buttons do.
// The part that runs in the page is panel-ui.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { panelUi, removePanelUi } from './panel-ui.mjs';
import { diffLines } from './line-diff.mjs';
import { pageKey, INLINE_PREFIX } from './html-rewriter.mjs';
import { urlKey, sourceText } from './portal-model.mjs';
import { portalResourceUrl } from './online.mjs';
import { filesForPage } from './browser.mjs';

/** Alt+Shift+<key>, by key position so they work on any keyboard layout. */
const KEYS = { hide: 'KeyL', panel: 'KeyP', mode: 'KeyO' };
const keyName = (code) => `Alt+Shift+${code.replace(/^Key/, '')}`;

/** what the panel remembers between pages and sessions */
function cleanUi(input) {
  const ui = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ui;
  for (const key of ['open', 'hidden', 'large', 'localOnly']) if (typeof input[key] === 'boolean') ui[key] = input[key];
  if (['overrides', 'runtime', 'tweaks', 'issues', 'activity', 'explore'].includes(input.tab)) ui.tab = input.tab;
  if (['all', 'edited', 'differs'].includes(input.filter)) ui.filter = input.filter;
  const pos = input.pos;
  if (pos && ['left', 'right'].includes(pos.h) && ['top', 'bottom'].includes(pos.v) && Number.isFinite(pos.dx) && Number.isFinite(pos.dy)) {
    ui.pos = { h: pos.h, v: pos.v, dx: Math.max(0, pos.dx), dy: Math.max(0, pos.dy) };
  }
  if (input.collapsed && typeof input.collapsed === 'object' && !Array.isArray(input.collapsed)) {
    ui.collapsed = Object.fromEntries(Object.entries(input.collapsed).filter(([key, value]) => /^[a-z][a-z-]{0,40}$/.test(key) && typeof value === 'boolean'));
  }
  return ui;
}

const MAX_PROBLEMS = 200;
const MAX_ACTIVITY = 100;
const MAX_DIFF_LINES = 3000;
const MAX_DIFF_BYTES = 3 * 1024 * 1024;
const MAX_API_BYTES = 32 * 1024;
const BINARY_EXT = /\.(?:png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|pdf|zip|mp4|mp3)$/i;

const GROUP_OF = {
  'page-js': 'page',
  'page-css': 'page',
  'page-copy': 'page',
  'page-summary': 'page',
  'basic-form-js': 'forms',
  'advanced-form-step-js': 'forms',
  'list-js': 'forms',
  'web-template': 'markup',
  'content-snippet': 'markup',
};
const SOURCE_LABEL = {
  'page-js': 'JavaScript',
  'page-css': 'CSS',
  'page-copy': 'copy',
  'page-summary': 'summary',
  'basic-form-js': 'form JS',
  'advanced-form-step-js': 'form step JS',
  'list-js': 'list JS',
};

function webFileGroup(url) {
  if (/\.m?js$/i.test(url)) return 'js';
  if (/\.css$/i.test(url)) return 'css';
  if (/\.(?:png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|otf)$/i.test(url)) return 'media';
  return 'other';
}

const toLines = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
const sameOrigin = (address, origin) => {
  try { return new URL(address).origin === origin; } catch { return false; }
};
const readableName = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

/**
 * A comparison ready to print: [type, old line number, new line number, text] with type ' ', '-',
 * '+' or '@' (a run of unchanged lines that is left out).
 * @param {string} before
 * @param {string} after
 */
export function comparison(before, after, context = 3, max = MAX_DIFF_LINES) {
  const a = toLines(before);
  const b = toLines(after);
  const hunks = diffLines(a, b);
  const lines = [];
  const added = hunks.reduce((n, h) => n + h.bEnd - h.bStart, 0);
  const removed = hunks.reduce((n, h) => n + h.aEnd - h.aStart, 0);
  if (!hunks.length) return { lines, added, removed, truncated: false };
  const clip = (s) => (s.length > 500 ? s.slice(0, 500) + ' ...' : s);
  let ai = 0;
  let bi = 0;
  for (let k = 0; k <= hunks.length && lines.length < max; k++) {
    const h = hunks[k];
    const end = h ? h.aStart : a.length;
    const run = end - ai;
    const head = k === 0 ? 0 : context;
    const tail = h ? context : 0;
    const same = (from, to) => {
      for (let i = from; i < to && lines.length <= max; i++) lines.push([' ', i + 1, bi + (i - ai) + 1, clip(a[i])]);
    };
    if (run <= head + tail + 1) same(ai, end);
    else {
      same(ai, ai + head);
      lines.push(['@', null, null, `${run - head - tail} unchanged lines`]);
      same(end - tail, end);
    }
    bi += run;
    ai = end;
    if (!h) break;
    for (; ai < h.aEnd && lines.length <= max; ai++) lines.push(['-', ai + 1, null, clip(a[ai])]);
    for (; bi < h.bEnd && lines.length <= max; bi++) lines.push(['+', null, bi + 1, clip(b[bi])]);
  }
  const truncated = lines.length > max || ai < a.length || bi < b.length;
  return { lines: lines.slice(0, max), added, removed, truncated };
}

/**
 * Opens `file` at a line in the editor (`code -g file:line:col` and compatible).
 * @returns {Promise<string|null>} null when it worked, else why not
 */
export function openInEditor(editor, file, line = 1, col = 1) {
  return new Promise((resolve) => {
    const target = `${file}:${line}:${col}`;
    // the command runs through the shell on Windows (code is a .cmd there): nothing in the path
    // may be able to end the quoted argument
    if (/["%!\r\n]/.test(target)) return resolve('the file name has characters that cannot be passed to the editor');
    if (typeof editor !== 'string' || !editor.trim() || /["%!\r\n&|<>^]/.test(editor)) return resolve('editor must be an executable name or path without shell commands');
    let child;
    try {
      child =
        process.platform === 'win32'
          ? spawn(`"${editor}" -g "${target}"`, { shell: true, stdio: 'ignore', windowsHide: true })
          : spawn(editor, ['-g', target], { stdio: 'ignore' });
    } catch (err) {
      return resolve(err.message);
    }
    // an editor that stays in the foreground (no hand-over to a running window) counts as opened
    const timer = setTimeout(() => resolve(null), 4000);
    timer.unref();
    const done = (error) => {
      clearTimeout(timer);
      resolve(error);
    };
    child.on('error', (err) => done(err.message));
    child.on('exit', (code) => done(code ? `"${editor}" ended with code ${code}` : null));
    child.unref();
  });
}

/**
 * Shows the dev panel in every portal tab and keeps it up to date.
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('./session.mjs').OverlaySession} session
 * @param {{open?: typeof openInEditor}} [opts]
 */
/**
 * Runs in a portal page: the portal's own sign-in or sign-out, as a person would run it. Sign-out
 * navigates to its URL. Sign-in ends a current session first (the platform links an external
 * login to a signed-in account instead of switching), reads an antiforgery token the way the
 * portal does (/_layout/tokenhtml) and posts the sign-in form: ExternalLogin with a login_hint, or
 * the local persona sign-in page. The navigation starts just after this returns, so the panel's
 * request is still answered. Returns true, or the reason it could not start.
 */
async function runSessionFlow(flow) {
  if (flow.navigate) {
    setTimeout(() => location.assign(flow.navigate), 50);
    return true;
  }
  if (flow.logOff) await fetch(flow.logOff, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
  const response = await fetch(flow.token, { credentials: 'same-origin', cache: 'no-store' });
  const html = response.ok ? await response.text() : '';
  const token = new DOMParser().parseFromString(html, 'text/html').querySelector('input[name="__RequestVerificationToken"]')?.value;
  if (!token) return `The portal returned no antiforgery token at ${flow.token} (HTTP ${response.status}).`;
  const form = document.createElement('form');
  form.method = 'post';
  form.action = flow.action;
  form.hidden = true;
  for (const [name, value] of Object.entries({ ...flow.fields, __RequestVerificationToken: token })) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  (document.body ?? document.documentElement).append(form);
  setTimeout(() => HTMLFormElement.prototype.submit.call(form), 50);
  return true;
}

export function enablePanel(context, session, opts = {}) {
  const { cfg } = session;
  const open = opts.open ?? openInEditor;
  // A per-session token rejects unrelated requests. Scripts executing on the portal itself
  // share its privileges; this is not an isolation boundary against a compromised portal.
  const token = crypto.randomBytes(16).toString('hex');
  const uiFile = cfg.stateDir ? path.join(cfg.stateDir, 'panel.json') : null;
  let ui = {};
  try {
    const saved = JSON.parse(fs.readFileSync(uiFile, 'utf8'));
    ui = cleanUi(saved);
  } catch {
    /* first run */
  }
  /** @type {WeakMap<object, Array<object>>} errors and failed requests per tab since its last navigation */
  const problems = new WeakMap();
  const runtimeByPage = new WeakMap();
  const runtimeFilesByPage = new WeakMap();
  const activity = [];
  /** files changed since the tabs last loaded (only grows while live reload is off) */
  const pending = new WeakMap();
  const pendingBaseline = new WeakSet();
  const pendingFor = (page) => {
    if (!pending.has(page)) pending.set(page, new Set());
    return pending.get(page);
  };
  let changed = session.changedFiles ?? session.baseline.changedFiles();
  let lastChange = null;
  const pageChanges = new WeakMap();
  let catalogVersion = 0;
  let disposed = false;
  const timers = new Map();
  const drawings = new WeakMap();
  const dirtyDrawings = new WeakSet();
  let sourceIndex;
  const pageInfoCache = new Map();
  const indexSources = () => {
    const model = session.model;
    if (sourceIndex?.inline === model.inlineSources && sourceIndex?.web === model.webFiles && sourceIndex?.pages === model.pages) return sourceIndex;
    const inlineByRel = new Map(model.inlineSources.map((source) => [source.rel, source]));
    const webByRel = new Map(model.webFiles.filter((source) => source.file).map((source) => [session.rel(source.file), source]));
    const pagesByKey = new Map();
    const sourcesByPage = new Map();
    for (const page of model.pages.values()) {
      const url = model.pagePath(page.id);
      if (url != null && !pagesByKey.has(pageKey(url))) pagesByKey.set(pageKey(url), { page, url });
    }
    for (const source of model.inlineSources) {
      for (const key of new Set([source.pageUrl, ...(source.usedOn ?? [])].filter(Boolean).map(pageKey))) {
        if (!sourcesByPage.has(key)) sourcesByPage.set(key, []);
        sourcesByPage.get(key).push(source);
      }
    }
    pageInfoCache.clear();
    sourceIndex = { inline: model.inlineSources, web: model.webFiles, pages: model.pages, inlineByRel, webByRel, pagesByKey, sourcesByPage };
    return sourceIndex;
  };
  const sourceFile = (rel) => {
    const index = indexSources();
    return index.inlineByRel.get(rel)?.file ?? index.webByRel.get(rel)?.file ?? path.resolve(cfg.sourceDir, rel);
  };
  const listeners = new Set();
  const on = (target, event, handler) => {
    target.on(event, handler);
    const remove = () => { target.off(event, handler); listeners.delete(remove); };
    listeners.add(remove);
    return remove;
  };

  const log = (entry) => {
    activity.unshift({ at: Date.now(), ...entry });
    activity.length = Math.min(activity.length, MAX_ACTIVITY);
  };
  // The Mirage administration shares the local origin; it is a tool, not a portal page.
  const adminPage = (address) => {
    if (!cfg.mirage) return false;
    try { return /^\/_{1,2}sim(?:\/|$)/i.test(new URL(address).pathname); } catch { return false; }
  };
  const portalPages = () => context.pages().filter((p) => !p.isClosed() && sameOrigin(p.url(), cfg.origin) && !adminPage(p.url()));

  /** Local file behind an address of the portal, as `rel`; null when it is not one of ours. */
  const relOfUrl = (address) => {
    let u;
    try {
      u = new URL(address);
    } catch {
      return null;
    }
    if (u.origin !== cfg.origin) return null;
    if (u.pathname.startsWith(INLINE_PREFIX)) {
      try {
        return decodeURIComponent(u.pathname.slice(INLINE_PREFIX.length));
      } catch {
        return null;
      }
    }
    const hit = session.bypass ? null : session.resolver.resolve(u.pathname);
    return hit ? session.rel(hit.file) : null;
  };

  /** Absolute path of a source the panel names, or null: only files of the sources are ever opened. */
  const fileOf = (rel, page = null) => {
    if (typeof rel !== 'string' || !rel) return null;
    rel = rel.replace(/\\/g, '/');
    const index = indexSources();
    const source = index.inlineByRel.get(rel);
    const webFile = index.webByRel.get(rel);
    const runtimeFile = cfg.mirage ? runtimeFilesByPage.get(page)?.get(rel) : null;
    if (cfg.mirage && !source && !webFile && !runtimeFile) return null;
    const file = source?.file ?? webFile?.file ?? runtimeFile ?? path.resolve(cfg.sourceDir, rel);
    const roots = [...(source || webFile ? [cfg.sourceDir] : []), ...(cfg.site.routes ?? []).filter((r) => r.dir).map((r) => path.resolve(cfg.sourceDir, r.dir)), ...(runtimeFile ? (runtimeByPage.get(page)?.roots ?? []) : [])];
    try {
      const real = fs.realpathSync.native(file);
      const within = roots.some((root) => {
        try {
          const relative = path.relative(fs.realpathSync.native(root), real);
          return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        } catch { return false; }
      });
      const mapped = (cfg.site.routes ?? []).some((r) => r.file && path.resolve(cfg.sourceDir, r.file) === file);
      if (!within && !mapped) return null;
      return fs.statSync(file).isFile() ? file : null;
    } catch {
      return null;
    }
  };

  const webFileState = (url) => {
    const state = session.onlineState.get(urlKey(url));
    return { differs: state === 'different' ? true : state === 'same' ? false : null, isNew: state === 'not online (local only)' };
  };

  /** Branch, HEAD and how the comparison baseline relates to them: what the developer is looking at. */
  const gitState = () => {
    const head = session.head ?? null;
    const { baseline } = session;
    const requested = cfg.site.markup?.requestedBaseline ?? cfg.site.markup?.baseline ?? baseline.spec;
    return {
      branch: head?.branch ?? null,
      commit: head?.commit ?? null,
      detached: Boolean(head?.detached),
      baseline: { requested, commit: baseline.available ? baseline.commit : null, available: Boolean(baseline.available), pinned: baseline.available && requested !== baseline.spec },
      headMoved: Boolean(head && baseline.available && head.commit !== baseline.commit),
      canRepin: Boolean(head && requested === 'HEAD' && typeof session.repinBaseline === 'function'),
    };
  };

  // ------------------------------------------------------------------------------ what a tab shows
  const pageInfo = (pathname) => {
    const key = pageKey(pathname);
    const index = indexSources();
    if (pageInfoCache.has(key)) return pageInfoCache.get(key);
    const entry = index.pagesByKey.get(key);
    if (entry) {
      const sources = (index.sourcesByPage.get(key) ?? []).map((s) => {
        const lang = /\/content-pages\/[^/]*?\.([a-z]{2}-[A-Z]{2})\./.exec(s.rel)?.[1];
        const text = sourceText(s);
        return { rel: s.rel, label: `${SOURCE_LABEL[s.kind] ?? s.kind}${lang ? ` (${lang})` : ''}`, empty: !text || !text.trim() };
      });
      const info = { path: entry.url, name: entry.page.name ?? '', dir: session.rel(entry.page.dir), sources };
      pageInfoCache.set(key, info);
      return info;
    }
    return null;
  };

  // ------------------------------------------------------------------------------ Mirage inspection
  // The Mirage reports what a page is made of. Its files open only when they lie in a root this
  // toolkit launched the Mirage with (portal source and Solution roots), so a report can never
  // widen what the editor action may open.
  let runtimeVersion = 0;
  const runtimeJobs = new WeakMap();
  const inside = (root, file) => {
    const delta = path.relative(root, file);
    return Boolean(delta) && delta !== '..' && !delta.startsWith(`..${path.sep}`) && !path.isAbsolute(delta);
  };
  // The Mirage reports native real paths. Short (8.3) names, junctions and case differences in
  // the configured roots must not decide whether a reported file belongs to them.
  const realNative = (value) => {
    try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
  };
  const trustedRoots = (reported = []) => {
    const configured = Array.isArray(cfg.mirageSourceRoots) && cfg.mirageSourceRoots.length ? cfg.mirageSourceRoots : reported;
    return [...new Set([cfg.sourceDir, ...configured].filter((value) => typeof value === 'string' && value).map(realNative))];
  };
  /** Portal files keep their source-relative path; other roots are named after their folder. */
  const runtimeRef = (file, roots) => {
    const absolute = realNative(file);
    const sourceRoot = roots[0];
    if (inside(sourceRoot, absolute)) return path.relative(sourceRoot, absolute).replace(/\\/g, '/');
    const index = roots.findIndex((root, position) => position > 0 && inside(root, absolute));
    if (index < 0) return null;
    const name = path.basename(roots[index]);
    const duplicate = roots.slice(0, index).some((root) => path.basename(root) === name);
    return `@${name}${duplicate ? `~${index}` : ''}/${path.relative(roots[index], absolute).replace(/\\/g, '/')}`;
  };
  /** Gives every reported source file a reference the panel can open, and indexes them. */
  const annotateRuntime = (report, roots) => {
    const files = new Map();
    const reference = (file) => {
      if (typeof file !== 'string' || !file) return null;
      const ref = runtimeRef(file, roots);
      if (ref) files.set(ref, realNative(file));
      return ref ? { ref, path: realNative(file) } : null;
    };
    const visit = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 8) return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      const absolute = typeof value.sourceFile === 'string' ? value.sourceFile
        : typeof value.file === 'string' ? value.file
          : typeof value.relativePath === 'string' ? path.resolve(cfg.sourceDir, value.relativePath)
            : typeof value.rel === 'string' ? path.resolve(cfg.sourceDir, value.rel) : null;
      const found = reference(absolute);
      if (found) Object.assign(value, found);
      if (Array.isArray(value.sourceFiles)) value.sourceRefs = value.sourceFiles.map(reference).filter(Boolean);
      for (const [key, child] of Object.entries(value)) if (key !== 'sourceRefs' && child && typeof child === 'object') visit(child, depth + 1);
    };
    visit(report, 0);
    return files;
  };
  const mirageUrl = (route) => new URL(route, cfg.origin).href;
  /** GET a Mirage admin route, preferring the documented /_sim alias over /__sim. */
  const mirageGet = async (route, timeout, request = context.request) => {
    let response = await request.get(mirageUrl(`/_sim/api${route}`), { timeout, failOnStatusCode: false });
    if (response.status() === 404) response = await request.get(mirageUrl(`/__sim/api${route}`), { timeout, failOnStatusCode: false });
    return response;
  };
  /**
   * This browser's Mirage sign-in session. The request goes through the page's own browser
   * context, whose cookie jar (HttpOnly cookies included) is the one the page uses.
   */
  const readSession = async (page) => {
    const response = await mirageGet('/session', 4000, page.context().request);
    if (response.status() === 404) return { supported: false };
    if (!response.ok()) return { supported: true, signedIn: false, roles: [], error: `The session endpoint answered HTTP ${response.status()}.` };
    const data = await response.json();
    return {
      supported: true,
      signedIn: Boolean(data?.signedIn),
      contactId: data?.contactId ?? null,
      name: data?.name ?? null,
      roles: Array.isArray(data?.roles) ? data.roles : [],
      roleSource: data?.roleSource ?? null,
      accountId: data?.accountId ?? null,
      identityProvider: identityProviderSummary(data?.identityProvider),
    };
  };
  /**
   * The identity provider behind the portal's sign-in (Mirage /session identityProvider): the
   * default provider, its callback path and the local identity provider's port; null for a
   * Mirage that does not report one.
   */
  const identityProviderSummary = (value) => {
    if (!value || typeof value !== 'object') return null;
    const providers = (Array.isArray(value.providers) ? value.providers : []).filter((item) => item && typeof item === 'object');
    const chosen = providers.find((item) => item.default) ?? providers[0] ?? null;
    return {
      available: value.available === true && Boolean(chosen?.id),
      reason: typeof value.reason === 'string' ? value.reason : null,
      port: Number.isInteger(value.port) ? value.port : null,
      provider: chosen ? { id: chosen.id ?? null, name: chosen.name ?? null, caption: chosen.caption ?? null, type: chosen.type ?? null, callbackPath: chosen.callbackPath ?? null } : null,
      callbackPaths: providers.map((item) => item.callbackPath).filter((item) => typeof item === 'string'),
    };
  };
  /** The current status shape, or the summary state of Mirages without /status. */
  const readMirageStatus = async () => {
    let response = await mirageGet('/status', 2500);
    if (response.status() === 404) response = await mirageGet('/state?summary=1', 4000);
    if (!response.ok()) return null;
    const data = await response.json();
    if (!data?.status) return data && typeof data === 'object' ? data : null;
    return {
      csrf: data.csrf,
      site: data.status.site,
      format: data.status.format,
      sourceDir: data.status.sourceDir,
      solutionRoots: Array.isArray(data.status.solutionMetadata?.roots) ? data.status.solutionMetadata.roots : [],
      sourceFingerprint: data.status.sourceFingerprint ?? null,
      revision: data.status.revision ?? null,
      pageCount: data.status.pageCount ?? null,
      diagnostics: { total: Array.isArray(data.diagnostics) ? data.diagnostics.length : 0 },
      identity: data.status.effectiveIdentity ?? null,
      permissionMode: data.config?.permissionMode ?? null,
      permissionSource: data.config?.permissionSource ?? null,
      signInPath: data.status.bootstrap?.signInPath?.path ?? null,
      presets: data.status.availablePresets ?? [],
      scenarios: [],
    };
  };
  let lastMirageStatus = null;
  const length = (value) => (Array.isArray(value) ? value.length : 0);
  /** The summary a Mirage without view=summary support would have sent. */
  const summarize = (report) => ({
    path: report.path,
    page: report.page ? { name: report.page.name, pageName: report.page.pageName ?? null, url: report.page.url, access: { allowed: report.page.access?.allowed ?? null } } : null,
    tables: (report.tables ?? []).map((table) => table.logicalName ?? table.name).filter(Boolean),
    counts: {
      accessRules: length(report.page?.access?.rules),
      templates: length(report.webTemplates),
      snippets: length(report.snippets),
      settings: length(report.siteSettings),
      forms: length(report.forms),
      views: length(report.views),
      tables: length(report.tables),
      columns: length(report.columns),
      usages: length(report.usages),
      related: length(report.related?.weblinks) + length(report.related?.sitemarkers) + length(report.related?.redirects) + length(report.related?.shortcuts),
      unresolved: length(report.unresolved),
    },
  });
  const pathOf = (address) => {
    try { return new URL(address).pathname; } catch { return null; }
  };
  const loadRuntime = async (page, requestedPath) => {
    if (disposed || page.isClosed() || !sameOrigin(page.url(), cfg.origin) || adminPage(page.url())) return;
    // A navigation is reported before the tab commits it; its own path wins over page.url().
    const pathname = typeof requestedPath === 'string' && requestedPath.startsWith('/') ? requestedPath : pathOf(page.url()) ?? '/';
    if (adminPage(new URL(pathname, cfg.origin).href)) return;
    try {
      // Every navigation asks for a small summary; the Inspect tab loads the full report on demand.
      // Page inspection and the session read carry this browser's session cookie.
      const [status, summaryResponse, session] = await Promise.all([
        readMirageStatus(),
        mirageGet(`/page-resources?path=${encodeURIComponent(pathname)}&view=summary`, 8000, page.context().request),
        readSession(page).catch(() => null),
      ]);
      if (disposed || page.isClosed() || !sameOrigin(page.url(), cfg.origin)) return;
      if (!status) {
        runtimeByPage.set(page, { active: false, error: 'The local Mirage status endpoint did not return runtime metadata.' });
        runtimeFilesByPage.delete(page);
      } else {
        lastMirageStatus = status;
        const answer = summaryResponse.ok() ? await summaryResponse.json() : null;
        // Mirages without summaries answer with the whole report.
        const report = answer && answer.view !== 'summary' ? answer : null;
        const roots = trustedRoots([...(Array.isArray(answer?.sourceRoots) ? answer.sourceRoots : []), ...(Array.isArray(status.solutionRoots) ? status.solutionRoots : [])].map((entry) => typeof entry === 'string' ? entry : entry?.path ?? entry?.sourceDir));
        const files = report ? annotateRuntime(report, roots) : new Map();
        runtimeByPage.set(page, {
          active: true,
          status,
          summary: answer ? (report ? summarize(report) : answer) : null,
          session,
          report,
          roots,
          path: pathname,
          version: ++runtimeVersion,
          error: answer ? null : `Page inspection returned HTTP ${summaryResponse.status()}.`,
        });
        runtimeFilesByPage.set(page, files);
      }
    } catch (error) {
      runtimeByPage.set(page, { active: false, error: error.message.split('\n')[0] });
      runtimeFilesByPage.delete(page);
    }
    schedule(page);
  };
  /** One inspection per tab at a time; requests arriving meanwhile collapse into one rerun. */
  const refreshRuntime = (page, requestedPath) => {
    if (!cfg.mirage || disposed || !page || page.isClosed()) return Promise.resolve();
    let job = runtimeJobs.get(page);
    if (!job) runtimeJobs.set(page, (job = { running: null, again: false, path: undefined }));
    job.path = requestedPath;
    if (job.running) {
      job.again = true;
      return job.running;
    }
    job.running = (async () => {
      do {
        job.again = false;
        const path = job.path;
        job.path = undefined;
        await loadRuntime(page, path);
      } while (job.again && !disposed && !page.isClosed());
    })().finally(() => { job.running = null; });
    return job.running;
  };
  const publicStatus = (status) => {
    if (!status) return null;
    const { csrf: ignored, presets, scenarios, ...rest } = status;
    return { ...rest, presetCount: Array.isArray(presets) ? presets.length : 0, scenarioCount: Array.isArray(scenarios) ? scenarios.length : 0 };
  };
  /** What every redraw carries: status and counts. The report itself is fetched by the Inspect tab. */
  const mirageSummary = (page) => {
    const runtime = runtimeByPage.get(page);
    if (!runtime) return null;
    if (!runtime.active) return { active: false, error: runtime.error };
    const summary = runtime.summary;
    const counts = summary?.counts ? { ...summary.counts } : null;
    if (counts) counts.total = (counts.templates ?? 0) + (counts.snippets ?? 0) + (counts.settings ?? 0) + (counts.forms ?? 0) + (counts.views ?? 0) + (counts.tables ?? 0);
    const s = runtime.status ?? {};
    return {
      active: true,
      version: runtime.version,
      error: runtime.error,
      path: runtime.path,
      page: summary?.page ? { name: summary.page.pageName ?? summary.page.name ?? null, url: summary.page.url ?? null, allowed: summary.page.access?.allowed ?? null } : null,
      counts,
      session: runtime.session ?? null,
      status: {
        site: s.site ?? null,
        format: s.format ?? null,
        sourceDir: s.sourceDir ?? null,
        revision: s.revision ?? null,
        sourceFingerprint: s.sourceFingerprint ?? null,
        reloading: Boolean(s.reloading),
        pendingReload: Boolean(s.pendingReload),
        diagnostics: s.diagnostics?.total ?? 0,
        identity: s.identity ? { name: s.identity.name ?? null, contactId: s.identity.contactId ?? null, roles: s.identity.roles ?? [] } : null,
        permissionMode: s.permissionMode ?? null,
        permissionSource: s.permissionSource ?? null,
        activeScenario: s.activeScenario ?? null,
      },
    };
  };
  /** Write through the Mirage admin API with its CSRF token; a restarted runtime gets one retry. */
  const mirageWrite = async (route, method, body, request = context.request) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!lastMirageStatus?.csrf || attempt) lastMirageStatus = await readMirageStatus();
      const csrf = lastMirageStatus?.csrf;
      if (!csrf) return { ok: false, error: 'The Mirage did not provide an administration token.' };
      const response = await request.fetch(mirageUrl(`/_sim/api${route}`), {
        method,
        headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf },
        data: body === undefined ? undefined : JSON.stringify(body),
        failOnStatusCode: false,
        timeout: 120_000,
      });
      let result = null;
      try { result = await response.json(); } catch { result = null; }
      if (response.ok()) return { ok: true, result };
      const message = result?.error?.message ?? result?.error ?? `Mirage answered HTTP ${response.status()}`;
      if (response.status() === 403 && /CSRF/i.test(String(message)) && !attempt) continue;
      return { ok: false, error: String(message) };
    }
    return { ok: false, error: 'The Mirage rejected the administration token.' };
  };
  const afterTweak = (text) => {
    log({ type: 'switch', text });
    for (const portalPage of portalPages()) refreshRuntime(portalPage).catch(() => {});
  };
  /**
   * Where signing in or out returns. On a sign-in page (the Mirage's sign-in path, an exported
   * LoginPath, an observed one or /signin, with or without a language prefix, and
   * /Account/Login/...) that is its ReturnUrl; on a provider callback it is the home page; else this page.
   */
  const localReturnPath = (page, session) => {
    try {
      const url = new URL(page.url());
      if (url.searchParams.has('paqvilo')) url.searchParams.delete('paqvilo');
      const signIn = String(lastMirageStatus?.signInPath ?? '/signin').replace(/\/+$/, '').toLowerCase();
      const pathname = url.pathname.replace(/\/+$/, '').toLowerCase();
      const unprefixed = pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2,4})?(?=\/)/, '');
      if ((signIn && (pathname === signIn || unprefixed === signIn)) || /^\/account\/login(?:\/|$)/.test(unprefixed)) {
        const target = url.searchParams.get('ReturnUrl') ?? url.searchParams.get('returnUrl') ?? '/';
        return /^\/(?![/\\])/.test(target) && !target.includes('\\') ? target : '/';
      }
      if ((session?.identityProvider?.callbackPaths ?? []).some((item) => item.replace(/\/+$/, '').toLowerCase() === pathname)) return '/';
      return `${url.pathname}${url.search}`;
    } catch {
      return '/';
    }
  };
  /**
   * The portal's own sign-in for a contact: the identity provider's external login when the site
   * has one (ExternalLogin with a login_hint, which the local identity provider answers without a
   * click), else the local persona sign-in page. It never sets the session cookie itself.
   */
  const signInFlow = (session, contactId, returnUrl) => {
    const idp = session.identityProvider;
    const external = Boolean(idp?.available);
    return {
      logOff: session.signedIn ? '/Account/Login/LogOff?returnUrl=%2F' : null,
      token: '/_layout/tokenhtml',
      action: external ? `/Account/Login/ExternalLogin?returnUrl=${encodeURIComponent(returnUrl)}` : `/SignIn?ReturnUrl=${encodeURIComponent(returnUrl)}`,
      fields: external ? { provider: idp.provider.id, login_hint: contactId } : { contactId },
    };
  };
  /**
   * Sign this page's browser in as a contact (or out, null) through the portal: the page posts
   * the sign-in form, or goes to /Account/Login/LogOff, which ends the session through the
   * provider's end-session. The page then navigates and comes back to the return path.
   */
  const startSessionFlow = async (page, contactId) => {
    const session = await readSession(page);
    if (!session.supported) return { ok: false, error: 'This Mirage has no browser sessions.' };
    if (!contactId && !session.signedIn) return { ok: true, navigating: false, session };
    const returnUrl = localReturnPath(page, session);
    const flow = contactId ? signInFlow(session, contactId, returnUrl) : { navigate: `/Account/Login/LogOff?returnUrl=${encodeURIComponent(returnUrl)}` };
    let started;
    try {
      started = await page.evaluate(runSessionFlow, flow);
    } catch (error) {
      started = error.message.split('\n')[0];
    }
    if (started !== true) return { ok: false, error: typeof started === 'string' ? started : 'The portal sign-in did not start.' };
    const provider = session.identityProvider?.provider;
    const via = !contactId ? 'the portal sign-out' : flow.fields.provider ? provider?.caption ?? provider?.name ?? 'the identity provider' : 'the local sign-in page';
    log({ type: 'switch', text: contactId ? `Signing in as ${contactId} through ${via}` : 'Signing out through the portal' });
    return { ok: true, navigating: true, via, returnUrl, contactId: contactId ?? null };
  };
  /** The page's next load, or `ms` later when no reload comes; cancel() drops it. */
  const nextLoad = (page, ms) => {
    let timer, listener;
    const promise = new Promise((resolve) => {
      listener = () => {
        clearTimeout(timer);
        page.off?.('load', listener);
        resolve();
      };
      timer = setTimeout(listener, ms);
      page.once?.('load', listener);
    });
    return { promise, cancel: () => { clearTimeout(timer); page.off?.('load', listener); } };
  };
  const lineOf = (file, find) => {
    if (typeof find !== 'string' || !find || find.length > 300) return null;
    try {
      if (fs.statSync(file).size > 16 * 1024 * 1024) return null;
      const needle = find.toLowerCase();
      const index = fs.readFileSync(file, 'utf8').split(/\r?\n/).findIndex((text) => text.toLowerCase().includes(needle));
      return index >= 0 ? index + 1 : null;
    } catch {
      return null;
    }
  };

  const stateFor = (page) => {
    const hits = session.pageHits.get(page) ?? [];
    const fresh = lastChange && Date.now() - lastChange.at < 8000 ? new Set(lastChange.files) : new Set();
    const items = new Map();
    for (const hit of hits) {
      for (const s of hit.sources ?? []) {
        const isFile = hit.type === 'file';
        const key = isFile ? `file|${hit.url.toLowerCase()}` : `html|${s.rel}`;
        const existing = items.get(key);
        if (existing) {
          existing.count += hit.count ?? 1;
          continue;
        }
        const item = {
          kind: s.kind ?? (isFile ? 'web-file' : 'other'),
          group: isFile ? webFileGroup(hit.url) : (GROUP_OF[s.kind] ?? 'other'),
          rel: s.rel,
          url: isFile ? hit.url : null,
          title: isFile ? readableName(hit.url.split('/').pop() || hit.url) : null,
          count: hit.count ?? 1,
          edited: changed.has(sourceFile(s.rel)),
          fresh: fresh.has(session.rel(sourceFile(s.rel))),
          canPause: true,
          canDiff: !BINARY_EXT.test(s.rel),
        };
        if (isFile) Object.assign(item, webFileState(hit.url), { note: s.action === 'web-file' ? null : s.action });
        else Object.assign(item, { differs: !/^injected/.test(s.action), isNew: /^injected/.test(s.action), note: s.action.replace(/^replaced inline block$/, 'replaced').replace(/^injected.*/, 'injected') });
        items.set(key, item);
      }
    }
    const shown = new Set([...items.values()].map((i) => i.rel));
    const document = hits.findLast((h) => h.type === 'html' && h.navigation) ?? hits.findLast((h) => h.type === 'html');
    const insync = (document?.matched ?? [])
      .filter((m) => m.identical && !shown.has(m.rel) && !session.disabled.has(m.rel))
      .map((m) => ({ kind: m.kind, group: 'insync', rel: m.rel, differs: false, canDiff: false, canPause: false, edited: changed.has(m.file) }));
    const paused = [...session.disabled].map((rel) => {
      const index = indexSources();
      const webFile = index.webByRel.get(rel);
      const src = index.inlineByRel.get(rel);
      return { kind: src?.kind ?? 'web-file', group: 'paused', rel, url: webFile?.url ?? null, title: webFile ? webFile.url.split('/').pop() : null, paused: true, canPause: true, canDiff: !BINARY_EXT.test(rel), edited: changed.has(sourceFile(rel)) };
    });
    let pathname = '/';
    try {
      pathname = new URL(page.url()).pathname;
    } catch {
      /* about:blank */
    }
    return {
      token,
      origin: cfg.origin,
      mirage: cfg.mirage ? mirageSummary(page) : null,
      site: cfg.siteName,
      env: cfg.envName,
      targets: (cfg.devTargets ?? [{ siteName: cfg.siteName, envName: cfg.envName, origin: cfg.origin, startPath: cfg.site.startPath ?? '/', caution: cfg.caution }]).map(({ siteName, envName, origin, startPath, caution }) => ({ siteName, envName, origin, startPath, caution: Boolean(caution) })),
      caution: Boolean(cfg.caution),
      mirageMode: cfg.mirage === true,
      scope: cfg.site.scope,
      sourceDir: cfg.sourceDir.replace(/\\/g, '/'),
      online: cfg.mirage ? false : session.bypass,
      live: cfg.mirage ? false : session.liveReload !== false,
      now: Date.now(),
      ui,
      keys: Object.fromEntries(Object.entries(KEYS).map(([k, code]) => [k, keyName(code)])),
      keyCodes: KEYS,
      page: pageInfo(pathname),
      items: [...items.values()],
      insync,
      paused,
      needsDeploy: cfg.mirage || session.bypass ? [] : session.rewriter.unsupported,
      notes: [...hits.flatMap((h) => h.notes ?? []), ...(!cfg.mirage && session.baseline.available === false ? [{ reason: session.baseline.error ?? 'Git baseline unavailable; template patches and changed scope need a valid baseline' }] : [])],
      problems: problems.get(page) ?? [],
      activity,
      pending: [...pendingFor(page)],
      pendingBaseline: !cfg.mirage && pendingBaseline.has(page),
      git: cfg.mirage ? null : gitState(),
      catalogVersion,
      lastChange: pageChanges.get(page) ?? lastChange,
      stats: { webFiles: session.model.webFileByUrl.size, blocks: cfg.mirage ? 0 : session.rewriter.activeBlocks, patches: cfg.mirage ? 0 : session.rewriter.patches.length },
    };
  };

  const draw = async (page) => {
    if (disposed || page.isClosed() || !sameOrigin(page.url(), cfg.origin) || adminPage(page.url())) return;
    if (drawings.has(page)) { dirtyDrawings.add(page); return drawings.get(page); }
    const drawing = Promise.resolve().then(() => disposed ? undefined : page.evaluate(panelUi, stateFor(page))).catch(() => {}).finally(() => {
      drawings.delete(page);
      if (dirtyDrawings.delete(page)) schedule(page);
    });
    drawings.set(page, drawing);
    await drawing;
  };
  const schedule = (page) => {
    if (disposed || !page || page.isClosed() || !sameOrigin(page.url(), cfg.origin) || adminPage(page.url()) || timers.has(page)) return;
    if (drawings.has(page)) { dirtyDrawings.add(page); return; }
    timers.set(
      page,
      setTimeout(() => {
        timers.delete(page);
        draw(page).catch(() => {});
      }, 250),
    );
  };
  const scheduleAll = () => portalPages().forEach(schedule);

  // ------------------------------------------------------------------------------ what went wrong on a page
  const problem = (page, entry) => {
    if (disposed || page.isClosed() || !sameOrigin(page.url(), cfg.origin)) return;
    const list = problems.get(page) ?? [];
    problems.set(page, list);
    const same = list.find((p) => p.type === entry.type && p.text === entry.text && p.rel === entry.rel && p.line === entry.line && p.where === entry.where);
    if (same) {
      same.count++;
      same.at = Date.now();
    } else if (list.length < MAX_PROBLEMS) list.push({ count: 1, at: Date.now(), ...entry });
    schedule(page);
  };
  /** where in the sources an address + position of the page is */
  const place = (address, line, col) => {
    if (!address) return {};
    const rel = relOfUrl(address);
    let where = address;
    try {
      const u = new URL(address);
      where = (u.origin === cfg.origin ? u.pathname : u.href) + (line ? `:${line}` : '');
    } catch {
      /* not an address: keep as it is */
    }
    return rel ? { rel, line, col, where } : { where };
  };
  const watch = (page) => {
    const removers = [];
    const listen = (event, handler) => removers.push(on(page, event, handler));
    listen('pageerror', (err) => {
      if (!sameOrigin(page.url(), cfg.origin)) return;
      const at = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/.exec(err.stack ?? '');
      problem(page, { type: 'error', text: err.message || String(err), ...(at ? place(at[1], Number(at[2]), Number(at[3])) : {}) });
    });
    listen('console', (msg) => {
      if (!sameOrigin(page.url(), cfg.origin) || msg.type() !== 'error') return;
      const text = msg.text();
      // the browser's own line about a failed request; the request itself is listed
      if (/^Failed to load resource/.test(text)) return;
      const loc = msg.location();
      problem(page, { type: 'console', text: text.slice(0, 2000), ...place(loc.url, loc.url ? loc.lineNumber + 1 : undefined, loc.url ? loc.columnNumber + 1 : undefined) });
    });
    listen('response', (res) => {
      if (res.status() < 400 || !sameOrigin(res.url(), cfg.origin)) return;
      const u = new URL(res.url());
      problem(page, { type: 'http', status: res.status(), text: `${res.request().method()} ${u.pathname}`, where: u.search ? u.pathname + u.search : '' });
    });
    listen('requestfailed', (req) => {
      const reason = req.failure()?.errorText ?? '';
      // a navigation or reload cancels what was still loading; that is not a failure
      if (/ERR_ABORTED|ERR_CACHE_MISS/.test(reason) || !sameOrigin(req.url(), cfg.origin)) return;
      problem(page, { type: 'failed', text: `${req.method()} ${new URL(req.url()).pathname}`, where: reason });
    });
    listen('domcontentloaded', () => {
      schedule(page);
      // A tab whose report describes another address (history navigation, a missed hit) is re-inspected.
      if (cfg.mirage && !adminPage(page.url()) && runtimeByPage.get(page)?.path !== pathOf(page.url())) refreshRuntime(page).catch(() => {});
    });
    listen('load', () => schedule(page));
    listen('close', () => {
      clearTimeout(timers.get(page));
      timers.delete(page);
      dirtyDrawings.delete(page);
      removers.forEach((remove) => remove());
    });
  };
  context.pages().forEach(watch);
  on(context, 'page', watch);

  on(session, 'hit', (hit) => {
    if (!hit.page) return;
    if (hit.navigation) {
      problems.set(hit.page, []);
      // a page loaded now shows the current sources
      pendingFor(hit.page).clear();
      pendingBaseline.delete(hit.page);
      refreshRuntime(hit.page, typeof hit.url === 'string' ? hit.url : undefined).catch(() => {});
    }
    schedule(hit.page);
  });
  on(session, 'fault', (err, url) => {
    log({ type: 'fault', text: `overlay could not apply: ${err.message.split('\n')[0]}`, files: [url] });
    scheduleAll();
  });
  on(session, 'online-state', scheduleAll);
  on(session, 'head', scheduleAll);
  on(session, 'refreshed', ({ files, how, baselineChanged = false, pageResults }) => {
    catalogVersion++;
    changed = session.changedFiles ?? session.baseline.changedFiles();
    pageInfoCache.clear();
    const rels = files.map((f) => session.rel(f));
    lastChange = { at: Date.now(), how, files: rels, baselineChanged };
    const text = baselineChanged ? `Git baseline updated${how === 'reload' ? ', page reloaded' : ' (no reload)'}`
      : { css: 'Styles swapped without a reload', reload: 'Saved, page reloaded', skipped: 'Saved; no open tab shows that page' }[how] ?? 'Saved (no reload)';
    log({ type: 'change', how, text, files: rels });
    for (const page of portalPages()) {
      const result = pageResults?.get(page);
      const pageHow = result?.how ?? how;
      const pageRels = (result?.files ?? filesForPage(session, files, page.url())).map((file) => session.rel(file));
      pageChanges.set(page, { ...lastChange, how: pageHow, files: pageRels });
      if (pageHow === 'none') for (const rel of pageRels) pendingFor(page).add(rel);
      else if (pageHow === 'reload') pendingFor(page).clear();
      if (cfg.mirage) refreshRuntime(page).catch(() => {});
      if (pageHow === 'css') for (const rel of pageRels) pendingFor(page).delete(rel);
      if (baselineChanged && pageHow !== 'reload') pendingBaseline.add(page);
      else if (pageHow === 'reload') pendingBaseline.delete(page);
    }
    scheduleAll();
  });

  // ------------------------------------------------------------------------------ what the buttons do
  const saveUi = () => {
    if (!uiFile) return;
    try {
      fs.mkdirSync(path.dirname(uiFile), { recursive: true });
      fs.writeFileSync(uiFile, JSON.stringify(ui, null, 2));
    } catch {
      /* not being able to remember the position is no reason to fail */
    }
  };

  const compare = async (page, { rel, url }) => {
    const file = fileOf(rel);
    if (!file) return { ok: false, error: 'this file is not part of the local sources' };
    if (BINARY_EXT.test(file)) return { ok: false, error: 'not a text file' };
    if (fs.statSync(file).size > MAX_DIFF_BYTES) return { ok: false, error: 'the file is too large to compare here' };
    const src = indexSources().inlineByRel.get(rel);
    const local = src ? sourceText(src) : fs.readFileSync(file, 'utf8');
    if (local == null) return { ok: false, error: 'the local file cannot be read' };
    let before = null;
    let against = null;
    if (!src && url) {
      let address;
      try { address = new URL(portalResourceUrl(cfg.origin, url)); } catch { /* invalid URL */ }
      const matched = address?.origin === cfg.origin && session.resolver.resolve(address.pathname);
      if (!matched || path.resolve(matched.file) !== file) return { ok: false, error: 'this URL does not map to the selected local source' };
      // a web file: against what the environment serves right now, with the sign-in of the browser
      let res;
      try {
        res = await context.request.fetch(address.href, { method: 'GET', maxRedirects: 0, failOnStatusCode: false, timeout: 60_000 });
        if (res.status() === 404) return { ok: true, against: `${cfg.envName} (not there yet: all of it is new)`, ...comparison('', local) };
        if (res.status() !== 200) return { ok: false, against: cfg.envName, error: `${cfg.envName} answered HTTP ${res.status()} for ${url}` };
        const body = await res.body();
        if (body.length > MAX_DIFF_BYTES) return { ok: false, against: cfg.envName, error: 'the file is too large to compare here' };
        before = body.toString('utf8');
        against = `${cfg.envName} online`;
      } catch (err) {
        return { ok: false, against: cfg.envName, error: err.message.split('\n')[0] };
      } finally {
        await res?.dispose?.().catch(() => {});
      }
    } else {
      // an inline script or style: against the block the portal printed into this page
      const printed = (session.pageHits.get(page) ?? []).flatMap((h) => h.matched ?? []).find((m) => m.rel === rel && m.online != null);
      if (printed && src?.mode === 'block') {
        before = printed.online;
        against = `${cfg.envName} online`;
      } else {
        // a template or snippet is rendered by the portal: the deployed text is what git has
        const raw = session.baseline.show(file);
        before = raw == null ? '' : src ? (sourceText(src, raw) ?? '') : raw;
        against = `git ${session.baseline.spec}`;
      }
    }
    if (Buffer.byteLength(before) > MAX_DIFF_BYTES || Buffer.byteLength(local) > MAX_DIFF_BYTES) return { ok: false, error: 'the file is too large to compare here' };
    const trimmed = src?.mode === 'block' && against.endsWith('online') ? local.replace(/\r\n?/g, '\n').trim() : local;
    return { ok: true, against, ...comparison(before, trimmed) };
  };

  const catalog = () => {
    const entries = [];
    for (const page of session.model.pages.values()) {
      const url = session.model.pagePath(page.id);
      if (url) entries.push({ t: 'page', title: page.name || url, url });
    }
    entries.sort((a, b) => a.url.localeCompare(b.url));
    for (const s of session.model.inlineSources) entries.push({ t: s.kind, kind: s.kind, title: s.label ?? null, rel: s.rel, url: s.pageUrl ?? s.usedOn?.[0] ?? null });
    for (const w of session.model.webFileByUrl.values()) entries.push({ t: 'web-file', kind: 'web-file', title: w.url.split('/').pop(), rel: session.rel(w.file), url: w.url });
    return entries;
  };

  const actions = {
    ui: (body) => {
      Object.assign(ui, cleanUi(body));
      saveUi();
      return { ok: true };
    },
    open: async (body, page) => {
      const file = fileOf(body.rel, page);
      if (!file) return { ok: false, error: 'this file is not part of the local sources' };
      // A reported record (a setting in a shared YAML file, a column in Entity.xml) opens at its line.
      const line = Number.isInteger(body.line) && body.line > 0 ? body.line : (lineOf(file, body.find) ?? 1);
      const col = Number.isInteger(body.col) && body.col > 0 ? body.col : 1;
      const error = await open(cfg.editor ?? 'code', file, line, col);
      if (!error) return { ok: true };
      // the editor's command is not on the PATH: its link does the same from the browser
      return { ok: false, error, url: /^code(?:-insiders)?$/.test(cfg.editor ?? 'code') ? `vscode://file/${pathToFileURL(file).pathname.replace(/^\//, '')}:${line}:${col}` : undefined };
    },
    toggle: (body) => {
      if (cfg.mirage) return { ok: false, error: 'Mirage serves source edits directly; source pausing is unavailable in this runtime.' };
      if (!fileOf(body.rel)) return { ok: false, error: 'this file is not part of the local sources' };
      if (body.off) session.disabled.add(body.rel);
      else session.disabled.delete(body.rel);
      // nothing on disk changed: rebuild from the cached sources instead of re-reading them all
      session.rewriter.refresh([]);
      log({ type: 'switch', text: body.off ? 'Override paused' : 'Override back on', files: [body.rel] });
      return { ok: true };
    },
    rebaseline: async () => {
      if (typeof session.repinBaseline !== 'function') return { ok: false, error: 'the baseline of this session cannot be moved' };
      const head = await session.repinBaseline();
      log({ type: 'switch', text: `Baseline pinned at HEAD ${head.commit.slice(0, 7)}${head.branch ? ` (${head.branch})` : ''}` });
      // other tabs learn about it the way they learn about any baseline change: a banner until reloaded
      session.emit('refreshed', { files: [], how: 'none', baselineChanged: true });
      return { ok: true };
    },
    mode: (body) => {
      if (cfg.mirage) return { ok: false, error: 'Mirage owns this local runtime mode.' };
      session.bypass = Boolean(body.online);
      log({ type: 'switch', text: session.bypass ? `Overrides off: the site as ${cfg.envName} serves it` : 'Overrides on' });
      return { ok: true };
    },
    live: (body) => {
      if (cfg.mirage) return { ok: false, error: 'Mirage owns source reloads in this runtime.' };
      session.liveReload = Boolean(body.on);
      log({ type: 'switch', text: `Live reload ${session.liveReload ? 'on' : 'off'}` });
      return { ok: true };
    },
    scope: (body) => {
      if (!['all', 'changed'].includes(body.scope)) return { ok: false, error: 'scope is all or changed' };
      cfg.site.scope = body.scope;
      session.refresh();
      log({ type: 'switch', text: `Scope: ${body.scope}` });
      return { ok: true };
    },
    clear: (body, page) => {
      if (body.what === 'activity') activity.length = 0;
      else problems.set(page, []);
      return { ok: true };
    },
    diff: (body, page) => compare(page, body),
    catalog: () => ({ ok: true, entries: catalog() }),
    // ---- Mirage inspection and tweaks (local runtime only)
    inspect: async (body, page) => {
      const runtime = runtimeByPage.get(page);
      if (!cfg.mirage || !runtime?.active) return { ok: false, error: runtime?.error ?? 'Mirage inspection is not available on this page.' };
      if (!runtime.report && runtime.summary) {
        // Loaded once per page version, when the Inspect tab asks for it.
        runtime.loading ??= (async () => {
          const response = await mirageGet(`/page-resources?path=${encodeURIComponent(runtime.path)}`, 30_000, page.context().request);
          if (!response.ok()) throw new Error(`Page inspection returned HTTP ${response.status()}.`);
          const report = await response.json();
          const files = annotateRuntime(report, runtime.roots);
          runtime.report = report;
          if (runtimeByPage.get(page) === runtime) runtimeFilesByPage.set(page, files);
        })().finally(() => { runtime.loading = null; });
        try {
          await runtime.loading;
        } catch (error) {
          return { ok: false, error: error.message.split('\n')[0] };
        }
      }
      // The flat dependency list repeats the typed groups; it stays indexed here for opening files.
      const { dependencies, ...visible } = runtime.report ?? {};
      return { ok: true, version: runtime.version, report: runtime.report ? visible : null, status: publicStatus(runtime.status), error: runtime.error };
    },
    tweaks: async (body, page) => {
      if (!cfg.mirage) return { ok: false, error: 'Tweaks change the local Mirage runtime only.' };
      const [status, personasResponse, session] = await Promise.all([readMirageStatus(), mirageGet('/personas', 4000), readSession(page)]);
      if (!status) return { ok: false, error: 'The Mirage status endpoint is unavailable.' };
      lastMirageStatus = status;
      const personas = personasResponse.ok() ? await personasResponse.json() : null;
      const summary = runtimeByPage.get(page)?.summary;
      return {
        ok: true,
        revision: status.revision ?? null,
        // This browser's session; `identity` is the Mirage default (the sign-in page persona).
        session,
        identity: personas?.identity ?? status.identity ?? null,
        personas: Array.isArray(personas?.personas) ? personas.personas.map(({ contactId, name, roles, active }) => ({ contactId, name, roles, active })) : [],
        personasAvailable: Boolean(personas),
        permissionMode: status.permissionMode ?? personas?.permissionMode ?? null,
        permissionSource: status.permissionSource ?? personas?.permissionSource ?? null,
        presets: Array.isArray(status.presets) ? status.presets.filter((preset) => !preset.unavailable).map(({ id, name, description, source }) => ({ id, name, description, source })) : [],
        scenarios: Array.isArray(status.scenarios) ? status.scenarios.map(({ id, name, description }) => ({ id, name, description })) : [],
        activeScenario: status.activeScenario ?? null,
        tables: Array.isArray(summary?.tables) ? summary.tables : [],
        status: publicStatus(status),
      };
    },
    persona: async (body) => {
      if (!cfg.mirage) return { ok: false, error: 'Personas belong to the local Mirage runtime.' };
      if (body.contactId !== null && (typeof body.contactId !== 'string' || !body.contactId)) return { ok: false, error: 'choose a persona or anonymous' };
      const result = await mirageWrite('/personas/select', 'POST', { contactId: body.contactId });
      if (result.ok) afterTweak(`Persona: ${result.result?.identity?.name ?? (body.contactId ? body.contactId : 'Anonymous')}`);
      return result.ok ? { ok: true, identity: result.result?.identity ?? null } : result;
    },
    signin: async (body, page) => {
      if (!cfg.mirage) return { ok: false, error: 'Sign-in sessions belong to the local Mirage runtime.' };
      if (typeof body.contactId !== 'string' || !body.contactId) return { ok: false, error: 'choose a persona to sign in as' };
      return startSessionFlow(page, body.contactId);
    },
    signout: async (body, page) => {
      if (!cfg.mirage) return { ok: false, error: 'Sign-in sessions belong to the local Mirage runtime.' };
      return startSessionFlow(page, null);
    },
    permissions: async (body) => {
      if (!cfg.mirage) return { ok: false, error: 'Permission enforcement belongs to the local Mirage runtime.' };
      if (!['enforce', 'permissive'].includes(body.mode)) return { ok: false, error: 'permission mode is enforce or permissive' };
      const result = await mirageWrite('/config', 'PATCH', { permissionMode: body.mode });
      if (result.ok) afterTweak(`Table permissions: ${body.mode}`);
      return result.ok ? { ok: true } : result;
    },
    preset: async (body) => {
      if (!cfg.mirage) return { ok: false, error: 'Presets change the local Mirage runtime only.' };
      if (typeof body.id !== 'string' || !/^[\w.-]+$/.test(body.id)) return { ok: false, error: 'choose a preset' };
      const result = await mirageWrite(`/presets/${encodeURIComponent(body.id)}/apply`, 'POST', {});
      if (result.ok) afterTweak(`Preset applied: ${body.id}`);
      return result.ok ? { ok: true } : result;
    },
    scenario: async (body, page) => {
      if (!cfg.mirage) return { ok: false, error: 'Scenarios change the local Mirage runtime only.' };
      if (typeof body.id !== 'string' || !/^[\w.-]+$/.test(body.id)) return { ok: false, error: 'choose a scenario' };
      const status = lastMirageStatus ?? (await readMirageStatus());
      const scenario = (Array.isArray(status?.scenarios) ? status.scenarios : []).find((item) => item.id === body.id);
      // A scenario persona (null = anonymous) also applies to this browser, through the portal's
      // sign-in or sign-out. The scenario is applied first (its preset can create the persona);
      // the sign-in runs once the page has taken the Mirage's reload, so the two navigations
      // never race.
      const session = scenario && scenario.persona !== undefined ? await readSession(page) : null;
      const contactId = scenario?.persona?.contactId ?? null;
      const change = Boolean(session?.supported) && (session.signedIn ? session.contactId : null) !== contactId;
      const reloaded = change ? nextLoad(page, 4000) : null;
      const result = await mirageWrite(`/scenarios/${encodeURIComponent(body.id)}/apply`, 'POST', {});
      if (!result.ok) {
        reloaded?.cancel();
        return result;
      }
      afterTweak(`Scenario applied: ${body.id}`);
      if (!change) return { ok: true };
      reloaded.promise.then(() => startSessionFlow(page, contactId)).then((started) => {
        if (!started.ok) log({ type: 'switch', text: `Scenario applied, but this browser's session did not change: ${started.error}` });
      }).catch(() => {});
      return { ok: true, navigating: true, contactId };
    },
  };

  const api = async (route, name) => {
    const request = route.request();
    const json = (status, body) =>
      route.fulfill({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) }).catch(() => {});
    if (request.method() !== 'POST' || request.headers()['x-paqvilo-token'] !== token || !Object.hasOwn(actions, name)) {
      return json(403, { ok: false, error: 'not allowed' });
    }
    let page = null;
    try {
      page = request.frame().page();
    } catch {
      /* no page */
    }
    if (!page || !sameOrigin(page.url(), cfg.origin)) return json(403, { ok: false, error: 'not allowed' });
    let result;
    try {
      const raw = await request.postData();
      if (raw && Buffer.byteLength(raw) > MAX_API_BYTES) return json(413, { ok: false, error: 'request too large' });
      const body = raw ? JSON.parse(raw.toString()) : {};
      result = await actions[name](body && typeof body === 'object' ? body : {}, page);
    } catch (err) {
      result = { ok: false, error: err.message.split('\n')[0] };
    }
    await json(200, result);
    // every tab shows the new state, not only the one that asked
    if (!['ui', 'diff', 'catalog', 'inspect', 'tweaks', 'open'].includes(name)) scheduleAll();
  };

  session.api = api;
  let disposal;
  const dispose = () => {
    if (disposal) return disposal;
    disposed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const remove of listeners) remove();
    if (session.api === api) session.api = null;
    let timer;
    // A paused debugger must not hold shutdown open indefinitely. The queued cleanup also
    // retires this token, so a late draw cannot recreate the panel after it resumes.
    const cleanup = Promise.allSettled(portalPages().map((page) => page.evaluate(removePanelUi, { token })));
    disposal = Promise.race([cleanup, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]).finally(() => clearTimeout(timer));
    return disposal;
  };
  return { keys: Object.fromEntries(Object.entries(KEYS).map(([k, code]) => [k, keyName(code)])), stateFor, draw, dispose };
}
