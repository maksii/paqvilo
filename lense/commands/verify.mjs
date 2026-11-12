// `paqvilo verify`: end-to-end proof that the loop works against the configured environment.
//
// The sources are copied to a temporary git repository, a real browser is opened on the online site
// through the overlay, the copies are edited the way a developer would, and the page is checked for
// each edit. Source changes stay in the copy and browser overlay; normal portal page code still runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { OverlaySession } from '../session.mjs';
import { openBrowser, attachSession } from '../browser.mjs';
import { enablePanel } from '../panel.mjs';
import { watchSources } from './dev.mjs';
import { pageKey } from '../html-rewriter.mjs';
import { PortalModel, sourceText, urlKey } from '../portal-model.mjs';
import { GitBaseline } from '../git.mjs';
import { editSource } from '../source-edit.mjs';
import { portalResourceUrl } from '../online.mjs';
import { replaceDelimitedAlternatives } from '../../mirage/lib/text-scanning.mjs';
import { shutdownSignalCounter } from '../signal-forwarding.mjs';

/** Waits `ms`; an interrupt clears the timer at once and ends the wait with the interrupt reason. */
function sleep(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onInterrupt = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onInterrupt);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onInterrupt, { once: true });
  });
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const DIAGNOSTIC_LIMITS = { entriesPerCategory: 200, textCharacters: 1000 };
const diagnosticText = (value) => (typeof value === 'string' ? value.slice(0, DIAGNOSTIC_LIMITS.textCharacters) : '');
const diagnosticLocation = (value) => {
  const text = diagnosticText(value);
  if (/^(?:data|javascript):/i.test(text)) return '[inline URL omitted]';
  try {
    const url = new URL(text);
    return diagnosticText(url.origin + url.pathname);
  } catch {
    return text.replace(/[?#].*$/, ''); // NOSONAR: diagnosticText above enforces a 1000-code-unit bound.
  }
};

/** Page location for messages: a sign-in redirect's query carries state and nonce, so only its presence shows. */
export function redactedPageUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`;
  } catch {
    return '[redacted URL]';
  }
}

/** Copy only bounded diagnostic fields: never the panel token, activities, or source bodies. */
export function diagnosticSnapshot(state) {
  const snapshot = { counts: {}, truncated: {} };
  for (const category of ['problems', 'notes', 'needsDeploy']) {
    const input = Array.isArray(state?.[category]) ? state[category] : [];
    snapshot.counts[category] = input.length;
    const fields = category === 'problems' ? ['type', 'text', 'rel', 'where'] : ['rel', 'reason'];
    snapshot.truncated[category] =
      input.length > DIAGNOSTIC_LIMITS.entriesPerCategory ||
      input.some((entry) =>
        fields.some(
          (field) => typeof entry[field] === 'string' && entry[field].length > DIAGNOSTIC_LIMITS.textCharacters,
        ),
      );
    snapshot[category] = input.slice(0, DIAGNOSTIC_LIMITS.entriesPerCategory).map((entry) => {
      if (category !== 'problems') return { rel: diagnosticText(entry.rel), reason: diagnosticText(entry.reason) };
      const problem = {
        type: diagnosticText(entry.type),
        text: diagnosticText(entry.text),
        count: Number.isSafeInteger(entry.count) && entry.count > 0 ? entry.count : 1,
      };
      if (entry.rel) problem.rel = diagnosticText(entry.rel);
      if (entry.where) problem.where = diagnosticLocation(entry.where);
      for (const key of ['status', 'line', 'col']) if (Number.isSafeInteger(entry[key])) problem[key] = entry[key];
      return problem;
    });
  }
  return snapshot;
}

export function compareDiagnostics(before, after) {
  if (!before || !after) return null;
  const result = {};
  for (const category of ['problems', 'notes', 'needsDeploy']) {
    // Appending a verification marker can shift line numbers without changing an existing error.
    const key =
      category === 'problems'
        ? (item) =>
            JSON.stringify([item.type, item.text, item.status, item.rel || item.where?.replace(/:\d+(?::\d+)?$/, '')])
        : (item) => JSON.stringify([item.rel, item.reason]);
    const previous = new Set(before[category].map(key));
    const current = new Set(after[category].map(key));
    result[category] = {
      existingCount: after[category].filter((item) => previous.has(key(item))).length,
      newObservations: after[category].filter((item) => !previous.has(key(item))),
      noLongerObserved: before[category].filter((item) => !current.has(key(item))),
      incomplete: before.truncated[category] || after.truncated[category],
    };
  }
  return result;
}

/** Strict mode treats new observations and truncated/missing diagnostics as an incomplete gate. */
export function assessVerification(checks, diagnostics, strict = false) {
  const failed = checks.filter((check) => check.ok === false).length;
  const exercised = checks.some(
    (check) =>
      check.ok &&
      /^(?:web file|page custom|basic-form|advanced-form|list-js|web template|content snippet)/.test(check.name),
  );
  const comparison = diagnostics?.comparison;
  const diagnosticsComplete = Boolean(comparison) && Object.values(comparison).every((item) => !item.incomplete);
  const newObservations = comparison
    ? Object.values(comparison).reduce((count, item) => count + item.newObservations.length, 0)
    : 0;
  return {
    passed: failed === 0 && exercised && (!strict || (diagnosticsComplete && newObservations === 0)),
    coverage: checks.some((check) => check.ok === null) ? 'partial' : 'complete',
    exercised,
    strict,
    diagnosticsComplete,
    newObservations,
    counts: {
      passed: checks.filter((check) => check.ok === true).length,
      failed,
      skipped: checks.filter((check) => check.ok === null).length,
    },
  };
}

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  execFileSync(
    'git', // NOSONAR: fixed tool name resolved through PATH by developer tooling
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.longpaths=true',
      '-c',
      'core.safecrlf=false',
      '-c',
      'core.hooksPath=',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      stdio: 'ignore',
      windowsHide: true,
      env,
      timeout: 120_000,
    },
  );
}

const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'];

/**
 * Aborts the run's wait loops on the first interrupt; the second is absorbed and the third forces the exit.
 * The returned function removes the listeners again.
 */
export function abortOnInterrupt(controller, options = {}) {
  const onSignal = shutdownSignalCounter({
    onFirst: (signal) => controller.abort(new Error(`Verification was interrupted by ${signal}`)),
    ...options,
  });
  const listeners = INTERRUPT_SIGNALS.map((signal) => [signal, () => onSignal(signal)]);
  for (const [signal, listener] of listeners) process.on(signal, listener);
  return () => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
  };
}

/**
 * Settles with `promise`, or rejects with the interrupt reason as soon as the run is interrupted. The rejection
 * handler stays attached after an interrupt, so a promise that fails later is not reported as unhandled.
 */
function untilInterrupted(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onInterrupt = () => reject(signal.reason);
    signal.addEventListener('abort', onInterrupt, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onInterrupt));
  });
}

/** Polls `fn` until it returns something truthy; survives reloads that destroy the page context. */
async function until(fn, timeout = 30_000, signal) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* page is navigating */
    }
    await sleep(250, signal);
  }
  return last || null;
}

/** Finds a literal line of a markup source that occurs exactly once in the page, to hang an edit on. */
function findAnchorLine(text, html, accept, wholeLine = true) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t.length < 25 || /\{%|\{\{|%\}|\}\}/.test(line) || !accept(t)) continue;
    if (lines.indexOf(line) !== i || lines.lastIndexOf(line) !== i) continue;
    const at = html.indexOf(line);
    if (at < 0 || html.includes(line, at + 1)) continue;
    // it has to be a whole line in the page as well, or it is some other markup that merely looks alike
    if (wholeLine && (!/[\r\n]/.test(html[at - 1] ?? '\n') || !/[\r\n]/.test(html[at + line.length] ?? '\n'))) continue;
    return i;
  }
  return -1;
}

/** Opens the start page again while the displayed document's body cannot be read; three attempts at most. */
async function openStableDocument(open, startPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const opened = await open();
    if (opened.html !== null || !opened.response) return opened;
  }
  throw new Error(`${startPath} kept navigating while it loaded; its document could not be read`);
}

/* NOSONAR */ export default async function verify(cfg, args) {
  const log = args.json ? (...values) => console.error(...values) : (...values) => console.log(...values);
  const signInTimeout = args['sign-in-timeout'] === undefined ? 900_000 : Number(args['sign-in-timeout']);
  if (!Number.isSafeInteger(signInTimeout) || signInTimeout < 1 || signInTimeout > 900_000)
    throw new Error('--sign-in-timeout must be an integer between 1 and 900000 milliseconds');
  const token = `ppv${crypto.randomBytes(4).toString('hex')}`;
  const token2 = `${token}b`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-verify-'));
  const tempSource = path.join(work, 'source');
  let close;
  let watcher;
  let detach;
  let panel;
  let page;
  let report;
  let failure;
  let inlineBaseline = null;
  const workingBlockTexts = new Map();
  const workingText = (source) =>
    workingBlockTexts.has(source.rel) ? workingBlockTexts.get(source.rel) : sourceText(source);
  const outDir = path.join(cfg.stateDir, 'verify');
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${token}`;
  const startPath = args.path ?? cfg.site.startPath ?? '/';
  const checks = [];
  const diagnostics = {
    limits: { ...DIAGNOSTIC_LIMITS },
    baseline: null,
    afterEdits: null,
    comparison: null,
    assessment:
      'Diagnostic differences are observations, not proof that local edits caused a regression. Strict mode fails on new observations or incomplete diagnostics; existing observations do not fail it.',
  };
  const captureDiagnostics = (phase) => {
    if (!panel || !page || page.isClosed()) return;
    diagnostics[phase] = diagnosticSnapshot(panel.stateFor(page));
    diagnostics.comparison = compareDiagnostics(diagnostics.baseline, diagnostics.afterEdits);
  };
  const check = (name, ok, detail = '') => {
    interrupt.signal.throwIfAborted();
    checks.push({ name, ok: Boolean(ok), detail });
    const detailText = detail ? `  (${detail})` : '';
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detailText}`);
  };
  const skip = (name, why) => {
    interrupt.signal.throwIfAborted();
    checks.push({ name, ok: null, detail: why });
    log(`  SKIP  ${name}  (${why})`);
  };
  const interrupt = new AbortController();
  const stopInterruptListeners = abortOnInterrupt(interrupt);

  try {
    log(`verifying ${cfg.siteName} @ ${cfg.envName}  ${cfg.origin}${startPath}`);
    log(`copying sources to ${tempSource} ...`);
    // The selected extract itself may be reached through a junction. Resolve that root once,
    // while still excluding nested links so verification never copies another directory's data.
    fs.cpSync(fs.realpathSync.native(cfg.sourceDir), tempSource, {
      recursive: true,
      filter: (file) =>
        !['.git', '.paqvilo', 'node_modules'].includes(path.basename(file)) && !fs.lstatSync(file).isSymbolicLink(),
    });
    // the copy is synchronous, so the interrupt is observed once it has returned
    interrupt.signal.throwIfAborted();
    // A current local block may already differ from the served page. Preserve the caller's
    // comparison baseline in the temporary Git repository, then test its working text below.
    // Otherwise committing nonempty new CSS here would erase its empty-baseline injection case.
    const parentBaseline = new GitBaseline(cfg.sourceDir, cfg.site.markup.baseline);
    const parentChanged = await untilInterrupted(
      parentBaseline.changedFilesAsync({ refreshRef: false }),
      interrupt.signal,
    );
    inlineBaseline = {
      requested: parentBaseline.spec,
      commit: parentBaseline.commit ?? null,
      available: parentBaseline.available,
      strategy: parentBaseline.available ? 'selected-git-reference' : 'working-copy',
      seededSources: [],
      fallbackReason: parentBaseline.error ?? null,
    };
    if (parentBaseline.available) {
      const copiedModel = await untilInterrupted(PortalModel.create(tempSource), interrupt.signal);
      const candidates = copiedModel.inlineSources
        .filter((source) => source.mode === 'block')
        .map((source) => ({ source, original: path.join(cfg.sourceDir, path.relative(tempSource, source.file)) }))
        .filter(({ original }) => parentChanged.has(original));
      parentBaseline.preload(candidates.map(({ original }) => original));
      // Cache each field before writing any shared enhanced XML component.
      const seeds = candidates.map(({ source, original }) => ({
        source,
        working: sourceText(source),
        base: sourceText(source, parentBaseline.show(original)) ?? '',
      }));
      for (const { source, working, base } of seeds) {
        if (working === null || working === base) continue;
        workingBlockTexts.set(source.rel, working);
        editSource(source, () => base);
        inlineBaseline.seededSources.push(source.rel);
      }
      log(
        `inline baseline: ${inlineBaseline.requested} (${inlineBaseline.commit}); preserved ${inlineBaseline.seededSources.length} changed block sources`,
      );
    } else log(`inline baseline: using the copied working sources; ${inlineBaseline.fallbackReason}`);
    git(tempSource, 'init', '-q');
    git(tempSource, 'add', '-A');
    git(tempSource, '-c', 'user.name=paqvilo', '-c', 'user.email=paqvilo@localhost', 'commit', '-q', '-m', 'baseline');

    // scope 'changed': at first nothing is overridden, afterwards exactly the files edited below
    const vcfg = {
      ...cfg,
      sourceDir: tempSource,
      site: { ...cfg.site, routes: [], scope: 'changed', markup: { ...cfg.site.markup, baseline: 'HEAD' } },
    };
    const session = await untilInterrupted(OverlaySession.create(vcfg), interrupt.signal);
    const hits = [];
    session.on('hit', (h) => hits.push(h));

    // Preserve the complete dev identity, including an external root's child directory and
    // browser-managed credential policy. A root-only override would silently select Default.
    const browserOverrides = { headless: !args.headed, ownInterrupts: true };
    if (!args['signed-in']) browserOverrides.profileDir = path.join(work, 'profile');
    const launching = openBrowser({ ...vcfg, browser: { ...cfg.browser, cdpUrl: null } }, browserOverrides);
    // An interrupt can end this wait first; a browser that finishes launching after it is closed here.
    launching.then((late) => interrupt.signal.aborted && late.close()).catch(() => {});
    const opened = await untilInterrupted(launching, interrupt.signal);
    close = opened.close;
    interrupt.signal.throwIfAborted();
    const { context } = opened;
    detach = await attachSession(context, session);
    panel = enablePanel(context, session, browserOverrides);
    watcher = watchSources(session, context, { log: () => {} });
    await untilInterrupted(watcher.ready, interrupt.signal);
    page = context.pages()[0] ?? (await untilInterrupted(context.newPage(), interrupt.signal));

    // Capture the unmodified page before testing local overlays.
    const requested = new Set();
    page.on('request', (r) => {
      try {
        const u = new URL(r.url());
        if (u.origin === cfg.origin) requested.add(u.pathname);
      } catch {
        /* ignore */
      }
    });
    let navigations = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    const onTarget = () => {
      const u = new URL(page.url());
      return (
        u.origin === cfg.origin &&
        pageKey(u.pathname, session.model) === pageKey(new URL(startPath, cfg.origin).pathname, session.model)
      );
    };
    // 'load' can take very long on data-heavy pages; the document itself is what matters here.
    // The body is read at once: a response cannot be read after the page has navigated away from it.
    const open = async () => {
      const res = await untilInterrupted(
        page.goto(cfg.origin + startPath, { waitUntil: 'domcontentloaded', timeout: 120_000 }),
        interrupt.signal,
      );
      const navigationsAtLoad = navigations;
      const html = res ? await res.text().catch(() => null) : null;
      // a load timeout is tolerated; an interrupt is not
      await untilInterrupted(page.waitForLoadState('load', { timeout: 30_000 }), interrupt.signal).catch(() =>
        interrupt.signal.throwIfAborted(),
      );
      // fixed settle pause after the load; the page's navigations are compared after it
      await sleep(1500, interrupt.signal);
      return { response: res, html: navigations === navigationsAtLoad ? html : null };
    };
    let started = await open();
    if (!onTarget()) {
      if (!args.headed) {
        throw new Error(
          `${startPath} needs a sign-in (ended on ${redactedPageUrl(page.url())}). Run: npm run verify -- --headed --signed-in --path ${startPath}  and sign in in the window that opens`,
        );
      }
      log(
        `  ....  ${startPath} needs a sign-in: please sign in in the browser window (waiting up to ${signInTimeout} ms)`,
      );
      if (!(await until(async () => onTarget(), signInTimeout, interrupt.signal)))
        throw new Error('Sign-in did not complete within the configured deadline');
      check('sign-in works through the overlay', true, 'identity provider round trip ended back on the page');
      requested.clear();
      hits.length = 0;
      started = await open();
    }
    if (started.html === null) started = await untilInterrupted(openStableDocument(open, startPath), interrupt.signal);
    if (started.response?.status() !== 200) {
      const answer = started.response ? `HTTP ${started.response.status()}` : 'no document response';
      throw new Error(`${startPath} answered ${answer}`);
    }
    // the HTML of the displayed document; nothing is overridden yet (recognised inline scripts are already
    // loaded from their local files, which does not matter for picking template and snippet lines)
    const rawHtml = started.html;
    if (process.env.PAQVILO_DEBUG) fs.writeFileSync(path.join(work, 'last-page.html'), rawHtml);
    check(
      'page loads through the overlay',
      true,
      `HTTP ${started.response.status()}, ${requested.size} same-origin requests`,
    );
    check(
      'nothing is overridden before any edit',
      hits.every((h) => !(h.sources ?? []).length),
    );
    captureDiagnostics('baseline');

    // ---- choose what to edit, from what this page really uses
    const model = session.model;
    const used = [...requested].map((p) => model.findWebFile(p)).filter((w) => w?.file);
    const cssFile =
      used.find((w) => /\.css$/i.test(w.url) && !/\.min\.css$/i.test(w.url)) ?? used.find((w) => /\.css$/i.test(w.url));
    const jsFile = used.find((w) => /\.js$/i.test(w.url) && !/\.min\.js$/i.test(w.url));
    const imgFile = used.find((w) => /\.(?:png|jpe?g|gif|svg|ico)$/i.test(w.url));
    const docKey = pageKey(new URL(startPath, cfg.origin).pathname, model);
    const editable = model.inlineSources;
    const pageSources = editable.filter((s) => s.pageUrl && pageKey(s.pageUrl) === docKey);
    const preferLang = (a, b) => Number(b.rel.includes('/content-pages/')) - Number(a.rel.includes('/content-pages/'));
    const pageCss = pageSources.filter((s) => s.kind === 'page-css').sort(preferLang);
    const pageJs = pageSources.filter((s) => s.kind === 'page-js').sort(preferLang);
    const cssBlock = pageCss.find((s) => workingText(s)?.trim()) ?? pageCss[0];
    const jsBlock = pageJs.find((s) => workingText(s)?.trim());
    const jsEmpty = pageJs.find((s) => !workingText(s)?.trim());

    // Exercise each rendered form/list category independently. A basic-form match must not hide
    // a broken list or advanced-step overlay on the same page, or imply those kinds were tested.
    const matchedForms = hits.findLast((h) => h.type === 'html' && h.navigation)?.matched ?? [];
    const formScripts = ['basic-form-js', 'advanced-form-step-js', 'list-js'].flatMap((kind) => {
      const match = matchedForms.find((entry) => entry.kind === kind);
      const source = editable.find((entry) => entry.rel === match?.rel);
      return source ? [source] : [];
    });

    const templates = editable
      .filter((s) => s.kind === 'web-template')
      .map((source) => ({ ...source, text: sourceText(source) ?? '' }));
    // Generic container rows can be shared by unrelated, unrendered Liquid templates. Only a
    // complete element with distinctive static text can identify a literal markup patch here.
    const textElement = /^<(div|section|footer|header|nav|ul|p|h[1-6])\b[^>]*>([^<]+)<\/\1>$/i;
    const anchorOwners = new Map();
    for (const source of templates)
      for (const line of source.text.split(/\r?\n/)) {
        const literal = line.trim();
        if (!textElement.test(literal)) continue;
        if (!anchorOwners.has(literal)) anchorOwners.set(literal, new Set());
        anchorOwners.get(literal).add(source.rel);
      }
    const templateCandidates = [];
    for (const source of templates) {
      const line = findAnchorLine(source.text, rawHtml, (literal) => {
        const match = textElement.exec(literal);
        return (
          match &&
          replaceDelimitedAlternatives(match[2], [['&', ';', 1]], ' ').trim().length >= 8 &&
          anchorOwners.get(literal)?.size === 1
        );
      });
      if (line >= 0) templateCandidates.push({ ...source, line });
      if (templateCandidates.length >= 100) break;
    }
    let template = null;
    if (templateCandidates.length) {
      const supported = await untilInterrupted(
        page.evaluate(
          ({ candidates, html }) => {
            const excluded = 'script,style,textarea,title,template,noscript,iframe,xmp,noembed,noframes,#paqvilo-panel';
            const tags = 'div,section,footer,header,nav,ul,p,h1,h2,h3,h4,h5,h6';
            const original = new DOMParser().parseFromString(html, 'text/html');
            const literals = new Set(
              [...original.querySelectorAll(tags)]
                .filter((node) => !node.childElementCount && !node.closest(excluded))
                .map((node) => node.outerHTML),
            );
            const visibility = new WeakMap();
            const visible = (node) => {
              if (!node) return true;
              if (visibility.has(node)) return visibility.get(node);
              const style = getComputedStyle(node);
              const value =
                style.visibility !== 'hidden' &&
                style.visibility !== 'collapse' &&
                style.display !== 'none' &&
                style.opacity !== '0' &&
                visible(node.parentElement);
              visibility.set(node, value);
              return value;
            };
            const rendered = new Set(
              [...document.querySelectorAll(tags)]
                .filter((node) => {
                  if (node.childElementCount || node.closest(excluded)) return false;
                  return node.getClientRects().length > 0 && visible(node);
                })
                .map((node) => node.outerHTML),
            );
            return candidates
              .filter((candidate) => {
                const node = new DOMParser().parseFromString(candidate.literal, 'text/html').body.firstElementChild;
                return node && literals.has(node.outerHTML) && rendered.has(node.outerHTML);
              })
              .map((candidate) => candidate.rel);
          },
          {
            candidates: templateCandidates.map(({ rel, text, line }) => ({
              rel,
              literal: text.replaceAll('\r\n', '\n').split('\n')[line].trim(),
            })),
            html: rawHtml,
          },
        ),
        interrupt.signal,
      );
      template = templateCandidates.find((candidate) => supported.includes(candidate.rel)) ?? null;
    }
    let snippet = null;
    const snippetCandidates = [];
    for (const s of editable.filter((x) => x.kind === 'content-snippet')) {
      const text = sourceText(s) ?? '';
      if (text.includes('\n') || text.includes('<') || text.includes('"') || text.includes("'")) continue;
      const line = findAnchorLine(text, rawHtml, () => true, false);
      if (line >= 0) snippetCandidates.push({ ...s, text });
    }
    if (snippetCandidates.length) {
      // Plain-text snippets can also be configuration values inside scripts or attributes.
      // Verification may edit only visible text nodes, never telemetry keys or other settings.
      const visible = await untilInterrupted(
        page.evaluate(
          ({ candidates, html }) => /* NOSONAR: single-pass routine, splitting it would change shared state */ {
            const found = new Set();
            const excluded =
              'script,style,textarea,title,template,noscript,iframe,xmp,noembed,noframes,[hidden],[aria-hidden="true"]';
            // A configuration value may be copied into visible DOM by another script. Confirm the
            // unique occurrence we would patch is itself a text node in the original response.
            const original = new DOMParser().parseFromString(html, 'text/html');
            const literalText = new Set();
            const originals = original.createTreeWalker(original.body, NodeFilter.SHOW_TEXT);
            while (originals.nextNode()) {
              const node = originals.currentNode;
              if (!node.parentElement || node.parentElement.closest(excluded)) continue;
              for (const candidate of candidates)
                if (node.textContent.includes(candidate.text)) literalText.add(candidate.rel);
            }
            const allowed = new WeakMap();
            const visibleElement = (element) => {
              if (!element) return false;
              if (allowed.has(element)) return allowed.get(element);
              let result = !element.closest(excluded);
              if (result) {
                const style = getComputedStyle(element);
                result =
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.visibility !== 'collapse' &&
                  style.opacity !== '0' &&
                  element.getClientRects().length > 0;
              }
              if (result && element.parentElement) result = visibleElement(element.parentElement);
              allowed.set(element, result);
              return result;
            };
            if (!document.body) return [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (!visibleElement(node.parentElement)) continue;
              for (const candidate of candidates)
                if (literalText.has(candidate.rel) && node.textContent.includes(candidate.text))
                  found.add(candidate.rel);
            }
            return [...found];
          },
          { candidates: snippetCandidates.map(({ rel, text }) => ({ rel, text })), html: rawHtml },
        ),
        interrupt.signal,
      );
      snippet = snippetCandidates.find((candidate) => visible.includes(candidate.rel)) ?? null;
    }

    // Edit sources and verify that the watcher updates the browser.
    log('editing the copy; waiting for the browser to follow ...');
    hits.length = 0;
    if (cssFile) fs.appendFileSync(cssFile.file, `\nhtml{--paqvilo-verify-css:"${token}"}\n`);
    if (jsFile) fs.appendFileSync(jsFile.file, `\n;window.__paqviloVerifyJs="${token}";\n`);
    if (imgFile) {
      // trailing bytes keep the image decodable while making the file differ from the online one
      fs.appendFileSync(imgFile.file, /\.svg$/i.test(imgFile.url) ? `\n<!-- ${token} -->\n` : Buffer.from(token));
    }
    if (cssBlock)
      editSource(cssBlock, () => (workingText(cssBlock) ?? '') + `\nhtml{--paqvilo-verify-inline-css:"${token}"}\n`);
    if (jsBlock)
      editSource(jsBlock, () => (workingText(jsBlock) ?? '') + `\n;window.__paqviloVerifyInlineJs="${token}";\n`);
    else if (jsEmpty) editSource(jsEmpty, () => `window.__paqviloVerifyInlineJs="${token}";\n`);
    for (const form of formScripts)
      editSource(
        form,
        () =>
          (workingText(form) ?? '') +
          `\n;window.__paqviloVerifyFormJs=window.__paqviloVerifyFormJs||{};window.__paqviloVerifyFormJs[${JSON.stringify(form.kind)}]="${token}";\n`,
      );
    if (template) {
      const lines = template.text.split('\n');
      lines.splice(template.line + 1, 0, `<!--paqvilo-verify-template:${token}-->`);
      editSource(template, () => lines.join('\n'));
    }
    if (snippet) editSource(snippet, () => `${snippet.text} [${token}]`);

    const cssVar = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n), name);
    const servedBy = (url) => hits.find((h) => h.type === 'file' && urlKey(h.url) === urlKey(url));
    const htmlHit = (rel) => hits.flatMap((h) => (h.type === 'html' ? h.sources : [])).find((s) => s.rel === rel);

    if (cssFile) {
      const ok = await until(
        async () => (await cssVar('--paqvilo-verify-css')).includes(token),
        undefined,
        interrupt.signal,
      );
      check(
        `web file (CSS)  ${cssFile.url}  <-  ${session.rel(cssFile.file)}`,
        ok && servedBy(cssFile.url),
        'edited rule is active in the page after automatic reload',
      );
    } else skip('web file (CSS)', 'the page loads no CSS web file');

    if (jsFile) {
      const ok = await until(
        () => page.evaluate((t) => globalThis.__paqviloVerifyJs === t, token),
        undefined,
        interrupt.signal,
      );
      check(
        `web file (JS)   ${jsFile.url}  <-  ${session.rel(jsFile.file)}`,
        ok && servedBy(jsFile.url),
        'edited script ran in the page',
      );
    } else skip('web file (JS)', 'the page loads no JS web file');

    if (imgFile) {
      const expected = sha(fs.readFileSync(imgFile.file));
      const got = await until(
        async () => {
          const value = await page.evaluate(
            async (u) => {
              const r = await fetch(u, { cache: 'no-store' });
              const d = await crypto.subtle.digest('SHA-256', await r.arrayBuffer());
              return {
                hash: [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''),
                local: r.headers.get('x-paqvilo'),
              };
            },
            portalResourceUrl(cfg.origin, imgFile.url),
          );
          return value.hash === expected && value.local ? value : null;
        },
        undefined,
        interrupt.signal,
      );
      check(
        `web file (image) ${imgFile.url}  <-  ${session.rel(imgFile.file)}`,
        got?.hash === expected && got.local,
        'bytes in the browser equal the local file',
      );
    } else skip('web file (image)', 'the page loads no image web file');

    if (cssBlock) {
      // looked up in the <style> text, not as a computed value: the existing CSS may not be well formed
      const ok = await until(
        () =>
          page.evaluate((t) => [...document.querySelectorAll('style')].some((s) => s.textContent.includes(t)), token),
        undefined,
        interrupt.signal,
      );
      check(
        `page custom CSS  <-  ${cssBlock.rel}`,
        ok && htmlHit(cssBlock.rel),
        htmlHit(cssBlock.rel)?.action ?? 'inline <style> not replaced',
      );
    } else skip('page custom CSS', 'this page has no custom CSS');

    const inlineJs = jsBlock ?? jsEmpty;
    if (inlineJs) {
      const ok = await until(
        () => page.evaluate((t) => globalThis.__paqviloVerifyInlineJs === t, token),
        undefined,
        interrupt.signal,
      );
      check(
        `page custom JS   <-  ${inlineJs.rel}`,
        ok && htmlHit(inlineJs.rel),
        htmlHit(inlineJs.rel)?.action ?? 'inline <script> not replaced',
      );
    } else skip('page custom JS', 'this page has no custom JS file');

    for (const form of formScripts) {
      const ok = await until(
        () =>
          page.evaluate(({ kind, token }) => globalThis.__paqviloVerifyFormJs?.[kind] === token, {
            kind: form.kind,
            token,
          }),
        undefined,
        interrupt.signal,
      );
      check(
        `${form.kind}  <-  ${form.rel}`,
        ok && htmlHit(form.rel),
        htmlHit(form.rel)?.action ?? 'inline <script> not replaced',
      );
    }
    if (!formScripts.length)
      skip('form / list custom JS', 'this page renders no basic form, advanced form step or list with custom JS');

    if (template) {
      const ok = await until(
        async () => (await page.content()).includes(`paqvilo-verify-template:${token}`),
        undefined,
        interrupt.signal,
      );
      check(
        `web template literal patch  <-  ${template.rel}`,
        ok && htmlHit(template.rel),
        `${htmlHit(template.rel)?.action ?? 'not patched'}; unique visible static markup matched; server-side template execution is not inferred`,
      );
    } else
      skip(
        'web template',
        'no unique visible static text element could safely identify a template literal patch; generic containers do not prove template usage',
      );

    if (snippet) {
      const ok = await until(async () => (await page.content()).includes(`[${token}]`), undefined, interrupt.signal);
      check(
        `content snippet  <-  ${snippet.rel}`,
        ok && htmlHit(snippet.rel),
        htmlHit(snippet.rel)?.action ?? 'not patched',
      );
    } else skip('content snippet', 'no unique plain-text snippet in visible markup text could be picked safely');

    // everything else must still be the real site
    const stillOnline = await untilInterrupted(
      page.evaluate(async () => {
        const r = await fetch(location.href, { cache: 'no-store' });
        return { status: r.status, local: r.headers.get('x-paqvilo') };
      }),
      interrupt.signal,
    );
    check('the rest of the page still comes from the online site', stillOnline.status === 200 && !stillOnline.local);

    // Verify that a stylesheet swap preserves the current document.
    if (cssFile) {
      await watcher.whenIdle();
      await page.evaluate(() => (globalThis.__paqviloNoReload = true));
      fs.appendFileSync(cssFile.file, `\nhtml{--paqvilo-verify-css:"${token2}"}\n`);
      const ok = await until(
        async () => (await cssVar('--paqvilo-verify-css')).includes(token2),
        undefined,
        interrupt.signal,
      );
      const kept = await page.evaluate(() => globalThis.__paqviloNoReload === true).catch(() => false);
      check('second CSS edit is hot-swapped without a page reload', ok && kept);
    }
    if (jsFile) {
      fs.appendFileSync(jsFile.file, `\n;window.__paqviloVerifyJs="${token2}";\n`);
      const ok = await until(
        () => page.evaluate((t) => globalThis.__paqviloVerifyJs === t, token2),
        undefined,
        interrupt.signal,
      );
      check('second JS edit reloads the page and runs', ok);
    }

    const panelState = await until(
      () =>
        page.evaluate(() => {
          const host = document.getElementById('paqvilo-panel');
          if (!host || !Number(host.dataset.overrides)) return null;
          host.shadowRoot.querySelector('.pill').click();
          return {
            label: host.dataset.label,
            overrides: Number(host.dataset.overrides),
            rows: host.shadowRoot.querySelectorAll('.body .row').length,
          };
        }),
      undefined,
      interrupt.signal,
    );
    check(
      'the dev panel lists the overrides',
      panelState?.rows > 0,
      panelState ? `${panelState.label}: ${panelState.overrides} overrides` : 'no panel on the page',
    );

    fs.mkdirSync(outDir, { recursive: true });
    // The diagnostics describe the page only after the watcher has applied the edits: whenIdle resolves once no
    // refresh is in flight, and a refresh applies the saved changes to the open pages before it finishes.
    await untilInterrupted(watcher.whenIdle(), interrupt.signal);
    captureDiagnostics('afterEdits');
    await untilInterrupted(page.screenshot({ path: path.join(outDir, `${stamp}.png`) }), interrupt.signal);
    const assessment = assessVerification(checks, diagnostics, Boolean(args.strict));
    report = {
      schemaVersion: 1,
      site: cfg.siteName,
      environment: cfg.envName,
      url: cfg.origin + startPath,
      token,
      checks,
      diagnostics,
      inlineBaseline,
      ...assessment,
      evidence: { report: path.join(outDir, `${stamp}.json`), screenshot: path.join(outDir, `${stamp}.png`) },
    };
    log(
      `\n${assessment.counts.passed} passed, ${assessment.counts.failed} failed, ${assessment.counts.skipped} skipped`,
    );
    log(`evidence: ${path.join(outDir, stamp)}.png / .json`);
    const observed = diagnostics.afterEdits.counts;
    log(
      `diagnostics: ${observed.problems} runtime/request problems, ${observed.notes} patch notes, ${observed.needsDeploy} source/deployment limitations; ${diagnostics.comparison.problems.newObservations.length} runtime/request problems not observed before edits`,
    );
    if (!assessment.exercised) log('No editable resources were exercised; verification is inconclusive.');
    if (args.strict && !report.passed)
      log('Strict verification failed; inspect checks and diagnostic differences in the report.');
  } catch (err) {
    try {
      captureDiagnostics('afterEdits');
    } catch {
      /* preserve the original failure */
    }
    fs.mkdirSync(outDir, { recursive: true });
    let screenshot = null;
    if (page && !page.isClosed())
      await page
        .screenshot({ path: path.join(outDir, `${stamp}.png`), timeout: 10_000 })
        .then(() => {
          screenshot = path.join(outDir, `${stamp}.png`);
        })
        .catch(() => {});
    report = {
      schemaVersion: 1,
      site: cfg.siteName,
      environment: cfg.envName,
      url: cfg.origin + startPath,
      token,
      checks,
      diagnostics,
      inlineBaseline,
      ...assessVerification(checks, diagnostics, Boolean(args.strict)),
      coverage: 'incomplete',
      passed: false,
      error: err.message,
      errorCode: interrupt.signal.aborted ? 'VERIFY_INTERRUPTED' : 'VERIFY_FAILED',
      evidence: { report: path.join(outDir, `${stamp}.json`), screenshot },
    };
    failure = err;
  } finally {
    const errors = [];
    const cleanup = async (name, action) => {
      try {
        await action();
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    };
    await cleanup('source watcher', () => watcher?.close());
    await cleanup('dev panel', () => panel?.dispose());
    await cleanup('interception', () => detach?.());
    await cleanup('browser', () => close?.());
    const kept = Boolean(process.env.PAQVILO_KEEP_TEMP);
    // Windows can keep files of an exited browser busy for seconds (observed ~5 s under load:
    // chrome_debug.log of the headless shell). Retry without blocking the event loop; the
    // linear backoff waits up to 11 s before the cleanup is reported incomplete.
    if (!kept)
      await cleanup('temporary sources', () =>
        fs.promises.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
      );
    if (report) {
      report.cleanup = {
        kept,
        temporarySourceRemoved: !fs.existsSync(work),
        temporaryDirectory: fs.existsSync(work) ? work : null,
        errors,
      };
      if (errors.length) {
        report.passed = false;
        report.errorCode = report.errorCode ?? 'CLEANUP_FAILED';
        report.error = [report.error, `Cleanup incomplete: ${errors.join('; ')}`].filter(Boolean).join('\n');
        failure = new Error(report.error, failure ? { cause: failure } : undefined);
      }
    }
    stopInterruptListeners();
  }
  // Print one final JSON object only after teardown has determined the actual outcome.
  // Otherwise a cleanup exception could append a second CLI error object to a successful report.
  report.writesFiles = [report.evidence.report, report.evidence.screenshot].filter(
    (file) => file && (file === report.evidence.report || fs.existsSync(file)),
  );
  try {
    fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(report, null, 2));
  } catch (err) {
    report.passed = false;
    report.errorCode = report.errorCode ?? 'REPORT_WRITE_FAILED';
    report.error = [report.error, `Cannot write verification report: ${err.message}`].filter(Boolean).join('\n');
    failure = new Error(report.error, { cause: err });
    report.writesFiles = report.writesFiles.filter((file) => fs.existsSync(file));
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (failure) {
    const reportFile = path.join(outDir, `${stamp}.json`);
    throw new Error(`${failure.message}\nVerification report: ${reportFile}`, {
      cause: failure,
    });
  }
  return report.passed ? 0 : 1;
}
