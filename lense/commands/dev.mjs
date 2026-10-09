// `paqvilo dev`: the development loop.
import path from 'node:path';
import chokidar from 'chokidar';
import { openBrowser, refreshPages } from '../browser.mjs';
import { loadDevTargets } from '../config.mjs';
import { urlKey } from '../portal-model.mjs';
import { compareWebFile } from '../online.mjs';
import { gitDirectories } from '../git.mjs';

const time = () => new Date().toLocaleTimeString('en-GB');
/** Lines of every activated portal share one terminal: say which one they belong to. */
const tag = (session) => `${session.cfg.siteName ?? 'portal'}@${session.cfg.envName ?? 'env'}`;
const short = (commit) => (typeof commit === 'string' ? commit.slice(0, 7) : null);

/**
 * Compare only resources the developer actually visits, with a bounded queue and stale-result
 * protection. A result stays good for a while: the online copy only changes with a deployment,
 * and a local save re-queues its own file anyway.
 */
export function trackOnlineState(session, { compare = compareWebFile, concurrency = 4, maxEntries = 512, maxAgeMs = 300_000 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Comparison concurrency must be a positive integer');
  if (!Number.isInteger(maxEntries) || maxEntries < concurrency) throw new Error('Comparison history limit must be at least the concurrency');
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('Comparison max age must be non-negative');
  const known = new Map();
  const pending = new Map();
  const active = new Map();
  let running = 0;
  let closed = false;
  const discard = (key) => {
    known.delete(key);
    pending.delete(key);
    session.onlineState.delete(key);
    active.get(key)?.controller.abort();
  };
  const pump = () => {
    while (!closed && running < concurrency && pending.size) {
      // A save supersedes a comparison, but waits for its aborted request to finish before
      // starting the replacement. Repeated saves never occupy every network slot for one file.
      const next = [...pending].find(([key]) => !active.has(key));
      if (!next) break;
      const [key, entry] = next;
      pending.delete(key);
      const job = { entry, target: { url: entry.url, file: entry.file }, version: entry.version, controller: new AbortController() };
      active.set(key, job);
      running++;
      Promise.resolve()
        .then(() => compare(session.cfg.origin, job.target, { signal: job.controller.signal }))
        .then(({ state }) => {
          if (closed || job.controller.signal.aborted || known.get(key) !== entry || entry.version !== job.version) return;
          session.onlineState.set(key, state);
          entry.checkedAt = Date.now();
          session.emit('online-state');
        })
        .catch(() => {})
        .finally(() => { if (active.get(key) === job) active.delete(key); running--; pump(); });
    }
  };
  const queue = (key, entry) => {
    entry.version++;
    session.onlineState.delete(key);
    active.get(key)?.controller.abort();
    pending.set(key, entry);
  };
  const hit = (event) => {
    if (closed || event.type !== 'file' || !event.sources?.[0]?.rel) return;
    const key = urlKey(event.url);
    const file = path.resolve(session.cfg.sourceDir, event.sources[0].rel);
    const previous = known.get(key);
    if (previous) {
      known.delete(key);
      known.set(key, previous);
      if (previous.file === file && (active.has(key) || pending.has(key) || Date.now() - previous.checkedAt < maxAgeMs)) return;
      previous.file = file;
      queue(key, previous);
      pump();
      return;
    }
    while (known.size >= maxEntries) discard(known.keys().next().value);
    const entry = { url: event.url, file, version: 0, checkedAt: 0 };
    known.set(key, entry);
    pending.set(key, entry);
    pump();
  };
  const refreshed = ({ files = [], baselineChanged = false } = {}) => {
    const changed = new Set(files.map((file) => path.resolve(file)));
    for (const [key, entry] of known) {
      const resolved = session.resolver?.resolve(entry.url);
      if (session.resolver && !resolved) { discard(key); continue; }
      const nextFile = resolved ? path.resolve(resolved.file) : entry.file;
      if (!changed.has(entry.file) && nextFile === entry.file && !baselineChanged) continue;
      entry.file = nextFile;
      queue(key, entry);
    }
    pump();
  };
  session.on('hit', hit);
  session.on('refreshed', refreshed);
  return () => {
    closed = true;
    for (const job of active.values()) job.controller.abort();
    pending.clear();
    for (const key of known.keys()) session.onlineState.delete(key);
    known.clear();
    session.off('hit', hit);
    session.off('refreshed', refreshed);
  };
}

/**
 * What the overlay served, on the terminal. A page load produces dozens of file hits; they are
 * folded into one line per navigation so warnings and saves stay visible all day. PAQVILO_DEBUG
 * (or `verbose`) prints every file. Warnings and faults are printed as they happen.
 */
export function logHits(session, log = console.log, { verbose = Boolean(process.env.PAQVILO_DEBUG), settleMs = 700 } = {}) {
  const label = tag(session);
  const tallies = new Map();
  const pageUrls = new WeakMap();
  const plural = (n, word, suffix = 's') => `${n} ${word}${n === 1 ? '' : suffix}`;
  const flush = (page) => {
    const tally = tallies.get(page);
    if (!tally) return;
    clearTimeout(tally.timer);
    tallies.delete(page);
    const parts = [];
    if (tally.files) parts.push(plural(tally.files, 'local file'));
    if (tally.blocks) parts.push(plural(tally.blocks, 'inline block'));
    if (tally.patches) parts.push(plural(tally.patches, 'patch', 'es'));
    log(`${time()}  ${label}  page   ${tally.url}  ${tally.late ? 'later: ' : ''}${parts.length ? parts.join(', ') : 'nothing from local sources'}`);
  };
  const onHit = (hit) => {
    for (const n of hit.notes ?? []) log(`${time()}  ${label}  WARN   ${hit.url}  ${n.rel}: ${n.reason}`);
    if (verbose || !hit.page) {
      if (hit.type === 'file') log(`${time()}  ${label}  local  ${hit.url}  <-  ${hit.sources[0].rel}`);
      else for (const s of hit.sources ?? []) log(`${time()}  ${label}  html   ${hit.url}  ${s.action}  <-  ${s.rel}`);
      return;
    }
    if (hit.navigation) {
      flush(hit.page);
      pageUrls.set(hit.page, hit.url);
      tallies.set(hit.page, { url: hit.url, files: 0, blocks: 0, patches: 0, late: false, timer: null });
    } else if (!tallies.has(hit.page)) {
      // sources requested after the summary of this page was printed (lazy loads, polling)
      if (!hit.sources?.length) return;
      tallies.set(hit.page, { url: pageUrls.get(hit.page) ?? hit.url, files: 0, blocks: 0, patches: 0, late: true, timer: null });
    }
    const tally = tallies.get(hit.page);
    if (hit.type === 'file') tally.files++;
    else for (const s of hit.sources ?? []) {
      if (/^patched/.test(s.action)) tally.patches++;
      else tally.blocks++;
    }
    clearTimeout(tally.timer);
    tally.timer = setTimeout(() => flush(hit.page), settleMs);
    tally.timer.unref?.();
  };
  const onFault = (err, url) => log(`${time()}  ${label}  ERROR  overlay could not apply to ${url}: ${err.message.split('\n')[0]}`);
  session.on('hit', onHit);
  session.on('fault', onFault);
  return () => {
    session.off('hit', onHit);
    session.off('fault', onFault);
    for (const tally of tallies.values()) clearTimeout(tally.timer);
    tallies.clear();
  };
}

export function printSummary(session, log = console.log) {
  const { cfg, model, rewriter } = session;
  log(`site        ${cfg.siteName} @ ${cfg.envName}  ${cfg.origin}`);
  if (cfg.chosen) log(`            (site from ${cfg.chosen.site}, environment from ${cfg.chosen.env}; "npm run list" shows the choices)`);
  for (const note of cfg.notes ?? []) log(`  note: ${note}`);
  if (cfg.caution) log(`  CAUTION: ${cfg.envName} holds real data. Nothing is uploaded, but what you do in the browser there is real.`);
  log(`sources     ${cfg.sourceDir}${model.format === 'enhanced' ? '   (enhanced data model: page JS/CSS, templates and snippets are fields of the component XML)' : ''}`);
  if (cfg.mirage) {
    log('runtime     Mirage renders local sources and owns page reloads; the toolkit panel remains available for inspection and editing');
    log(`source map  ${model.webFileByUrl.size} web-file URLs, ${model.inlineSources.length} inline sources`);
    return;
  }
  const requested = cfg.site.markup.requestedBaseline ?? cfg.site.markup.baseline;
  const pinned = session.baseline.available ? requested !== session.baseline.spec ? ` (pinned at ${short(session.baseline.commit)})` : ` @ ${short(session.baseline.commit)}` : ' (unavailable)';
  log(`scope       ${cfg.site.scope}, baseline ${requested}${pinned}`);
  if (session.head) {
    const drift = session.baseline.available && session.head.commit !== session.baseline.commit ? `   (HEAD differs from the baseline${requested === 'HEAD' ? '; Pin HEAD in the panel to update it' : ''})` : '';
    log(`git         ${session.head.branch ? `branch ${session.head.branch}` : 'detached HEAD'} @ ${short(session.head.commit)}${drift}`);
  }
  log(`web files   ${model.webFileByUrl.size} URLs mapped to local files`);
  log(`inline      ${rewriter.activeBlocks} custom JS/CSS blocks (pages, forms, lists)`);
  log(`markup      ${rewriter.patches.length} changed templates/snippets/page copies patched into pages`);
  if (!session.baseline.available) {
    log(`  WARNING: "${cfg.site.markup.baseline}" is not a git ref here, so there is no baseline: template/snippet changes cannot be shown${cfg.site.scope === 'changed' ? " and scope 'changed' overrides nothing" : ''}`);
  }
  for (const w of model.warnings.slice(0, 3)) log(`  note: ${w}`);
  for (const u of rewriter.unsupported.slice(0, 3)) log(`  NEEDS DEPLOY: ${u.rel} - ${u.reason}`);
  if (model.warnings.length > 3 || rewriter.unsupported.length > 3) log(`diagnostics ${model.warnings.length} source warnings, ${rewriter.unsupported.length} deployment-only sources; full details in the panel or "paqvilo doctor"`);
}

/**
 * Watches the sources and keeps session + open tabs up to date. Returns the watcher.
 * `baselinePollMs`: fallback interval for Git ref checks (default 15 s with the repository
 * watcher, 2 s without one). `gitWatch: false` disables the repository watcher.
 */
export function watchSources(session, context, { reload = true, log = console.log, baselinePollMs, gitWatch = true } = {}) {
  const { cfg } = session;
  const label = tag(session);
  const dirs = [cfg.sourceDir];
  for (const rule of cfg.site.routes ?? []) {
    if (rule.dir) dirs.push(path.resolve(cfg.sourceDir, rule.dir));
    if (rule.file) dirs.push(path.resolve(cfg.sourceDir, rule.file));
  }
  const watchRoots = [...new Set(dirs.map((dir) => path.resolve(dir)))];
  const watcher = chokidar.watch(watchRoots, {
    ignoreInitial: true,
    ignored: (p) => {
      // An explicitly selected checkout/route can itself live below an ignored directory.
      // Ignore generated children relative to watched roots, never their parent directories.
      const relatives = watchRoots.map((root) => path.relative(root, path.resolve(p)))
        .filter((rel) => rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
      return relatives.length > 0 && relatives.every((rel) => /(?:^|[\\/])(?:\.git|node_modules|\.portalconfig|\.paqvilo)(?:[\\/]|$)/.test(rel));
    },
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  });
  let pending = new Set();
  let timer = null;
  let busy = false;
  let closed = false;
  let flight = null;
  let baselineChanged = false;
  let baselineFlight = null;
  const refreshAbort = new AbortController();
  let lastActivity = Date.now();
  const idleWaiters = new Set();
  // Verification must not start a no-reload probe while a previous save still has a browser
  // refresh queued. Wait for completed work and a short quiet period, with a bounded deadline.
  watcher.whenIdle = (timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const waiter = { timer: null, finish: (error) => {
      clearTimeout(waiter.timer);
      idleWaiters.delete(waiter);
      if (error) reject(error); else resolve();
    } };
    const check = () => {
      if (closed) return waiter.finish();
      if (!busy && !timer && !pending.size && !baselineChanged && Date.now() - lastActivity >= 200) return waiter.finish();
      if (Date.now() >= deadline) return waiter.finish(new Error('Source refresh did not settle before the deadline'));
      waiter.timer = setTimeout(check, 50);
    };
    idleWaiters.add(waiter);
    check();
  });
  const flush = () => {
    timer = null;
    // One reload at a time. A reload asked for while the previous one is between receiving its
    // document and showing it leaves the tab dead, and saves come in bursts (save + format on save,
    // save all). What arrives meanwhile stays in `pending` and goes out as one reload afterwards.
    if (closed || busy || (!pending.size && !baselineChanged)) return;
    busy = true;
    const files = [...pending];
    pending = new Set();
    const force = baselineChanged;
    baselineChanged = false;
    flight = run(files, force);
    session.watchedRefresh = flight;
  };
  const run = async (saved, force) => {
    try {
      const unsupportedBefore = new Set((cfg.mirage ? [] : session.rewriter.unsupported).map((u) => `${u.rel}: ${u.reason}`));
      // Inline and structural saves wait for Git without blocking the requests of other tabs.
      const prepared = typeof session.refreshAsync === 'function'
        ? await session.refreshAsync(force ? [] : saved, { deferChangeTracking: !force })
        : session.refresh(force ? [] : saved, { deferChangeTracking: !force });
      if (closed) return;
      // A scratch file or a note in the extract is nothing the browser could show.
      if (prepared?.ignored) {
        if (process.env.PAQVILO_DEBUG) log(`${time()}  ${label}  ignored  ${saved.slice(0, 3).map((f) => session.rel(f)).join(', ')}${saved.length > 3 ? ` (+${saved.length - 3})` : ''}`);
        return;
      }
      const files = prepared?.files ?? saved;
      force ||= Boolean(prepared?.baselineChanged);
      // Web-only saves in scope 'all' do not need a Git result before serving fresh bytes.
      // Let the browser request those bytes while the badge comparison runs asynchronously.
      const pageResults = new Map();
      let how = reload && session.liveReload !== false ? await refreshPages(context, session, files, { force, outcomes: pageResults, signal: refreshAbort.signal }) : 'none';
      if (prepared?.changeTrackingDeferred) {
        const tracked = await session.refreshChangeTracking(files);
        if (tracked.baselineChanged) {
          force = true;
          if (!closed && reload && session.liveReload !== false) how = await refreshPages(context, session, files, { force: true, outcomes: pageResults, signal: refreshAbort.signal });
        }
      }
      if (closed) return;
      if (force && session.baseline.available === false) log(`${time()}  ${label}  WARN   ${session.baseline.error ?? 'Git baseline is unavailable; baseline-dependent overrides are disabled'}`);
      for (const u of cfg.mirage ? [] : session.rewriter.unsupported) {
        const key = `${u.rel}: ${u.reason}`;
        if (!unsupportedBefore.has(key)) log(`${time()}  ${label}  NEEDS DEPLOY  ${key}`);
      }
      const names = (force ? `baseline ${session.baseline.spec}${files.length ? ', ' : ''}` : '') + files.slice(0, 3).map((f) => session.rel(f)).join(', ') + (files.length > 3 ? ` (+${files.length - 3})` : '');
      const outcome = cfg.mirage ? '  (Mirage owns page reloads)' : { css: '  -> styles swapped', reload: '  -> reloaded', skipped: '  -> no open tab shows that page', none: reload && session.liveReload === false ? '  (live reload is off)' : '' }[how] ?? '';
      log(`${time()}  ${label}  changed  ${names}${outcome}`);
      session.emit('refreshed', { files, how, baselineChanged: force, pageResults });
    } catch (err) {
      log(`${time()}  ${label}  ERROR  ${err.message}`);
    } finally {
      busy = false;
      lastActivity = Date.now();
      if (!closed && (pending.size || baselineChanged) && !timer) timer = setTimeout(flush, 120);
    }
  };
  watcher.on('all', (_event, file) => {
    if (closed) return;
    lastActivity = Date.now();
    pending.add(path.resolve(file));
    clearTimeout(timer);
    timer = setTimeout(flush, 120);
  });
  // Initial watch enumeration ignores existing files; reconcile once it has established the
  // watch so edits during async startup/browser launch cannot disappear into that gap.
  watcher.ready = new Promise((resolve, reject) => {
    watcher.once('ready', () => {
      if (closed) { resolve(); return; }
      try { session.reconcile?.(); resolve(); } catch (err) { reject(err); }
    });
    watcher.once('error', reject);
  });
  // Keep legacy callers that only listen to Chokidar's ready event safe from unhandled rejects.
  watcher.ready.catch(() => {});
  // Commit/ref changes can occur without a source save (also in linked Git worktrees). The
  // repository's HEAD and refs are watched so a checkout, commit or fetch is noticed at once;
  // a slow poll stays as a fallback. Only the requested ref is resolved, never the whole extract.
  // A session pinned to a full commit cannot move: it only keeps its HEAD awareness current.
  const immutableBaseline = session.baseline?.available && session.baseline.spec === session.baseline.commit;
  const tracksBaseline = !immutableBaseline && typeof session.baseline?.checkForUpdate === 'function';
  let tracksHead = typeof session.refreshHead === 'function';
  let repository = null;
  let repositoryTimer = null;
  let baselineTimer = null;
  const checkRepository = () => {
    if (closed || baselineFlight) return;
    baselineFlight = (async () => {
      if (tracksHead) await session.refreshHead().catch(() => null);
      if (!tracksBaseline) return;
      const changed = await session.baseline.checkForUpdate();
      if (!changed || closed) return;
      baselineChanged = true;
      lastActivity = Date.now();
      if (!timer) timer = setTimeout(flush, 120);
    })().catch((err) => log(`${time()}  ${label}  ERROR  baseline watcher: ${err.message}`)).finally(() => { baselineFlight = null; });
  };
  const repositoryReady = (async () => {
    if (!tracksBaseline && !tracksHead) return;
    const directories = await gitDirectories(cfg.sourceDir);
    if (closed) return;
    // Outside a repository there is no HEAD to follow; do not spawn Git for it on every poll.
    if (!directories) tracksHead = false;
    if (directories && gitWatch) {
      try {
        const roots = new Set([directories.gitDir, directories.commonDir].map((dir) => path.resolve(dir)));
        const refs = path.join(directories.commonDir, 'refs');
        // Only HEAD, packed-refs and refs/ matter; objects/ and the index must not be traversed.
        const interesting = (p) => {
          const resolved = path.resolve(p);
          if (roots.has(resolved) || resolved === refs || resolved.startsWith(refs + path.sep)) return true;
          return roots.has(path.dirname(resolved)) && /^(?:HEAD|packed-refs)$/.test(path.basename(resolved));
        };
        repository = chokidar.watch([...roots], { ignoreInitial: true, ignored: (p) => !interesting(p) });
        repository.on('all', () => {
          if (closed) return;
          clearTimeout(repositoryTimer);
          repositoryTimer = setTimeout(checkRepository, 300);
        });
        repository.on('error', (err) => log(`${time()}  ${label}  ERROR  repository watcher: ${err.message}`));
        // Cover ref changes between initial session setup and repository enumeration.
        repository.once('ready', checkRepository);
        if (closed) { await repository.close(); repository = null; return; }
      } catch (err) {
        log(`${time()}  ${label}  WARN   repository watcher unavailable, polling instead: ${err.message}`);
        repository = null;
      }
    }
    if (!tracksBaseline && !tracksHead) return;
    baselineTimer = setInterval(checkRepository, baselinePollMs ?? (repository ? 15_000 : 2000));
    baselineTimer.unref();
  })().catch((err) => log(`${time()}  ${label}  ERROR  repository watcher: ${err.message}`));
  watcher.on('error', (err) => log(`${time()}  ${label}  ERROR  source watcher: ${err.message}`));
  const closeWatcher = watcher.close.bind(watcher);
  let closing;
  watcher.close = () => {
    if (closing) return closing;
    closed = true;
    refreshAbort.abort();
    for (const waiter of idleWaiters) waiter.finish();
    clearTimeout(timer);
    clearTimeout(repositoryTimer);
    clearInterval(baselineTimer);
    pending.clear();
    closing = (async () => {
      await closeWatcher();
      await repositoryReady;
      clearInterval(baselineTimer);
      await repository?.close();
      await flight;
      await baselineFlight;
    })();
    return closing;
  };
  return watcher;
}

export default async function dev(cfg, args) {
  // `mirage dev` hands over a prepared selection (local Mirage origins plus live targets).
  const selection = args.devSelection
    ?? (args.mirageTarget
      ? { mode: 'selected', initial: args.mirageTarget, targets: [args.mirageTarget] }
      : await loadDevTargets(args));
  cfg = selection.initial;
  const { startDevSessions } = await import('../dev-sessions.mjs');
  if (selection.mode === 'all') {
    console.log(`portals     all ${selection.targets.length} configured origins; activated on visit. Use the panel to switch, "paqvilo list" to inspect.`);
  }
  const wantedPort = cfg.browser.debugPort;
  const { context, attached, close, debugPort, profile } = await openBrowser(cfg, { debugPort: wantedPort });
  console.log(`browser     ${attached ? 'attached browser' : cfg.browser.channel}; ${profile.kind === 'legacy' || profile.kind === 'named' ? 'toolkit' : profile.kind}${profile.name ? ` profile ${profile.name}` : ''}${profile.profileDirectory && profile.kind === 'external' ? ` (${profile.profileDirectory})` : ''}`);
  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  const browser = context.browser();
  context.once('close', stop);
  browser?.once('disconnected', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let runtime;
  try {
    if (debugPort) console.log(`debugger    port ${debugPort} (VS Code: "paqvilo: attach to running dev browser"${debugPort === 9222 ? '' : `; set its port to ${debugPort}`})`);
    runtime = await startDevSessions(context, selection, { args, attached, stop, debugPort });
    if (cfg.panel) {
      const panel = runtime.active.get(cfg.origin).panel;
      const { keys } = panel;
      console.log(`dev panel   on the page: ${keys.panel} opens it, ${keys.hide} hides or shows it, ${keys.mode} switches local / online`);
    }
    const startUrl = cfg.origin + (cfg.site.startPath ?? '/');
    const page = attached ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
    console.log(`\nopening ${startUrl}\nedit a file under the sources and the browser follows. Browse pages and open tabs without restarting. Ctrl+C or close the browser to stop.${process.env.PAQVILO_DEBUG ? '' : ' (PAQVILO_DEBUG=1 lists every served file.)'}\n`);
    await Promise.race([stopped, page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch((err) => console.log(`could not open ${startUrl}: ${err.message}`))]);

    await stopped;
  } finally {
    context.off('close', stop);
    browser?.off('disconnected', stop);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { await runtime?.close(); } finally {
      await close().catch(() => {});
    }
  }
  return runtime?.failure ? 1 : 0;
}
