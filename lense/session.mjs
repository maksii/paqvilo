// The overlay: a browser whose requests to the online portal are answered from local sources.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PortalModel, mimeFor, inlineKindOf, isSourceFile, isPortalMetadata, urlKey } from './portal-model.mjs';
import { Resolver, globToRegExp } from './resolver.mjs';
import { HtmlRewriter, pageKey, INLINE_PREFIX, LOCAL_PREFIX, API_PREFIX } from './html-rewriter.mjs';
import { GitBaseline, gitHead, gitHeadState } from './git.mjs';
import { FileBodyCache } from './file-cache.mjs';
import { scriptSourceBody, scriptResourceProof } from './script-source-evidence.mjs';
import { createSourceInspector } from './source-inspection.mjs';
import { ServedVersions } from './served-version.mjs';
import { RequestLedger, ledgerUrl, platformRule } from './request-classes.mjs';
import {
  SolutionResourceIndex,
  acceptsPcfResx,
  pcfDeclarations,
  PCF_RESOURCE_PATH,
  WEB_RESOURCE_PATH,
} from './pcf-resources.mjs';
import { siteHeaders, webFileDisposition, rfc5987 } from '../mirage/lib/response-headers.mjs';

// Editors and tools leave scratch files next to the sources (safe-write temporaries, swap and
// backup files). They are never portal sources, so they must not rebuild the index or reload tabs.
const SCRATCH_FILE =
  /(?:~|\.swp|\.swx|\.swo|\.tmp|\.temp|\.bak|\.orig|\.rej|\.crswap|___jb_tmp___|___jb_old___)$|(?:^|[\\/])(?:\.#[^\\/]*|~\$[^\\/]*|4913|\.DS_Store|Thumbs\.db|desktop\.ini)$/i; // NOSONAR: regex kept: a rewrite would change matches or captures

// Sign-in and token endpoints are never touched, so authentication behaves exactly as online.
// Matched against the path without its language segment (/en-US/signin is /signin).
const NEVER_REWRITE = [
  '/signin**',
  '/account',
  '/account/**',
  '/_services/auth',
  '/_services/auth/**',
  '/.auth',
  '/.auth/**',
  '/_layout/tokenhtml**',
  '/externalauthenticationcallback**',
].map(globToRegExp); // NOSONAR: preserve callback identity and iteration arguments

const TEXT_TYPES = /^(?:text\/|application\/(?:json|javascript|xml|xhtml))/i;
const MAX_PAGE_SOURCE_BYTES = 8 * 1024 * 1024;
// A ledger entry names at most this many applied and matched sources of one document.
const MAX_LEDGER_SOURCES = 30;
const MAX_INTEGRITY_URLS = 500;
const SRI_ALGORITHMS = ['sha256', 'sha384', 'sha512'];

/**
 * The byte range a Range header asks of a body of `size` bytes: {start, end}; false when it cannot be satisfied (416);
 * null when there is none or it is not one bytes range (the whole body is sent, as RFC 9110 allows).
 */
export function byteRange(header, size) /* NOSONAR: a range, false and null are its documented answers */ {
  // The digits before the dash are optional with their trailing blanks, so no blank run can be split two ways.
  const match = /^bytes\s*=\s*(?:(\d+)\s*)?-\s*(\d*)$/i.exec(String(header ?? '').trim());
  const first = match?.[1] ?? '';
  const last = match?.[2] ?? '';
  if (!match || (first === '' && last === '')) return null;
  let start;
  let end;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
    if (last !== '' && Number(last) < start) return null;
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return false;
  return { start, end };
}

/** The status and payload of the answer to a range (`byteRange`'s result); sets the content-range header. */
function rangeAnswer(range, body, headers) {
  if (range === false) {
    headers['content-range'] = `bytes */${body.length}`;
    return { status: 416, payload: Buffer.alloc(0) };
  }
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${body.length}`;
    return { status: 206, payload: body.subarray(range.start, range.end + 1) };
  }
  return { status: 200, payload: body };
}

/** What the ledger and the hit say about a pinned file: the integrity check's outcome in words. */
function integrityNote(check) {
  return check.match
    ? 'The page pins this file with an integrity hash: it is served byte for byte, without a source map, and matches.'
    : 'The page pins this file with an integrity hash that the local bytes do not match: the browser refuses the file until the integrity attribute is updated or removed.';
}

/** Same-origin script and stylesheet URLs (by URL key) the HTML pins with an integrity attribute, and its value. */
export function integrityUrls(html, documentUrl, origin) {
  const found = new Map();
  if (typeof html !== 'string' || html.length > MAX_PAGE_SOURCE_BYTES || !/\bintegrity\s*=/i.test(html)) return found;
  for (const tag of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attributes = {};
    for (const attribute of tag[2].matchAll(/(?<![\w:-])([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g))
      attributes[attribute[1].toLowerCase()] ??= attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
    const address = tag[1].toLowerCase() === 'script' ? attributes.src : attributes.href;
    if (!address || !attributes.integrity?.trim()) continue;
    let url;
    try {
      url = new URL(address.replaceAll('&amp;', '&'), documentUrl);
    } catch {
      continue;
    }
    if (url.origin === origin) found.set(urlKey(url.pathname), attributes.integrity.trim());
    if (found.size >= MAX_INTEGRITY_URLS) break;
  }
  return found;
}

/** Whether `body` satisfies an integrity value as a browser checks it (the strongest listed algorithm); null: none usable. */
export function integrityCheck(integrity, body) {
  const hashes = String(integrity)
    .split(/\s+/)
    .map((token) => /^(sha256|sha384|sha512)-([A-Z0-9+/=_-]+)(?:\?.*)?$/i.exec(token))
    .filter(Boolean)
    .map(([, algorithm, value]) => ({ algorithm: algorithm.toLowerCase(), value }));
  if (!hashes.length) return null;
  const strongest = SRI_ALGORITHMS.findLast((algorithm) => hashes.some((hash) => hash.algorithm === algorithm));
  const digest = crypto.createHash(strongest).update(body).digest('base64');
  const normal = (value) => {
    let text = value.replaceAll('-', '+').replaceAll('_', '/');
    while (text.endsWith('=')) text = text.slice(0, -1);
    return text;
  };
  return {
    match: hashes.some((hash) => hash.algorithm === strongest && normal(hash.value) === normal(digest)),
    algorithm: strongest,
  };
}

function classifyChange(file, sourceDir, knownFiles, routeRoots) {
  const rel = path.relative(sourceDir, file).replaceAll('\\', '/');
  const inExtract = rel !== '' && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel);
  let exists = true;
  let directory = false;
  try {
    directory = fs.statSync(file).isDirectory();
  } catch {
    exists = false;
  }
  if (knownFiles.has(file)) return { relevant: true, structural: !exists || isPortalMetadata(rel) };
  if (directory) return { relevant: false, structural: false };
  if (!exists && [...knownFiles].some((known) => known.startsWith(file + path.sep)))
    return { relevant: true, structural: true };
  if (routeRoots.some((root) => file === root || file.startsWith(root + path.sep)))
    return { relevant: true, structural: false };
  if (!inExtract || SCRATCH_FILE.test(file)) return { relevant: false, structural: false };
  const assetLocation = /^web-files\/[^/]+$/i.test(rel) || /^powerpagecomponents\/[^/]+\/filecontent\//i.test(rel);
  if (isPortalMetadata(rel) || inlineKindOf(file) || assetLocation) return { relevant: true, structural: true };
  return { relevant: false, structural: false };
}
const hasRecordedSources = (hit) => hit.sources?.length || hit.type === 'file' || hit.matched?.length;
function repeatedPageFileHit(hit, list) {
  return list.find(
    (previous) =>
      previous.type === 'file' && previous.url === hit.url && previous.sources?.[0]?.rel === hit.sources?.[0]?.rel,
  );
}

export class OverlaySession extends EventEmitter {
  /** Prepare disk-heavy indexes without serial synchronous reads blocking startup. */
  static async create(cfg) {
    // Git runs while the metadata is read; each phase keeps at most two Git processes.
    const [model, { baseline, changedFiles }] = await Promise.all([
      PortalModel.create(cfg.sourceDir),
      GitBaseline.create(cfg.sourceDir, cfg.site.markup?.baseline ?? 'HEAD').then(async (baseline) => ({
        baseline,
        changedFiles: await baseline.changedFilesAsync({ refreshRef: false }),
      })),
    ]);
    const disabled = new Set();
    const [rewriter, head] = await Promise.all([
      HtmlRewriter.create({
        model,
        site: cfg.site,
        baseline,
        changedFiles,
        sourceMaps: Boolean(cfg.sourceMaps),
        disabled,
      }),
      // HEAD is shown, never used to serve sources: a Git that does not answer leaves it unknown (null) and the
      // source watcher's next HEAD check fills it in once Git answers. The baseline keeps its own state.
      gitHead(cfg.sourceDir).catch(() => null),
    ]);
    const session = new OverlaySession(cfg, { model, baseline, changedFiles, disabled, rewriter });
    // Nothing can listen yet, so the first HEAD needs no 'head' event.
    session.head = head;
    // Sources and HEAD can change while the bounded asynchronous reads are in flight.
    // Reconcile their final metadata/working-tree snapshot before exposing the session.
    session.model.load();
    session.#reconcileChanges(await baseline.changedFilesAsync());
    return session;
  }

  /** @param {Awaited<ReturnType<typeof import('./config.mjs').loadConfig>>} cfg */
  constructor(cfg, prepared = {}) {
    super();
    this.cfg = cfg;
    this.fileBodies = new FileBodyCache();
    this.model = prepared.model ?? new PortalModel(cfg.sourceDir);
    this.baseline = prepared.baseline ?? new GitBaseline(cfg.sourceDir, cfg.site.markup?.baseline ?? 'HEAD');
    // Shared by the resolver, rewriter and panel, instead of independently scanning Git.
    this.changedFiles = prepared.changedFiles ?? this.baseline.changedFiles({ refreshRef: false });
    this.appliedBaselineCommit = this.baseline.available ? this.baseline.commit : null;
    /** sources (by their path relative to the extract) the developer switched off for now */
    this.disabled = prepared.disabled ?? new Set();
    /** true = override nothing: the site as it is online, for a quick comparison */
    this.bypass = false;
    /** false = saving a file does not reload the tabs */
    this.liveReload = true;
    /** how each web file compares with the environment: URL key -> 'same' | 'different' | ... */
    this.onlineState = new Map();
    /** answers the requests of the dev panel (see panel.mjs); `(route, name) => Promise` */
    this.api = null;
    /** where Git HEAD of the checkout points: {commit, branch, detached}; null until read or outside Git */
    this.head = null;
    /** where the repository keeps HEAD and its refs (gitDirectories()); null until the source watcher has asked Git */
    this.repository = null;
    /** the repository state `head` was read in; null while files cannot show whether HEAD moved */
    this.headState = null;
    this.refreshQueue = Promise.resolve(); // NOSONAR: constructor timing must not change
    this.rewriter =
      prepared.rewriter ??
      new HtmlRewriter({
        model: this.model,
        site: cfg.site,
        baseline: this.baseline,
        changedFiles: this.changedFiles,
        sourceMaps: Boolean(cfg.sourceMaps),
        disabled: this.disabled,
      });
    this.knownFiles = new Set(
      [...this.model.inlineSources, ...this.model.webFiles, ...(this.model.inactiveSources ?? [])]
        .map((s) => s.file)
        .filter(Boolean),
    );
    this.#buildResolver();
    /** @type {WeakMap<object, Array<object>>} hits per page since its last navigation */
    this.pageHits = new WeakMap();
    this.pageHitBytes = new WeakMap();
    this.hitBytes = new WeakMap();
    /** @type {WeakMap<object, number>} hits of the page's current document dropped by the 500-hit bound */
    this.pageHitsTrimmed = new WeakMap();
    /** @type {WeakMap<object, RequestLedger>} every request of each page's current document (request-classes.mjs) */
    this.requestLedgers = new WeakMap();
    /** @type {WeakMap<object, Map<string, string>>} integrity values the page's documents declare, per URL key */
    this.pageIntegrity = new WeakMap();
    /** browser contexts whose page requests fill the ledgers: context -> {refs, remove} */
    this.requestObservers = new Map();
    this.observedRequests = new WeakMap();
    /**
     * Files the portal serves in another version than the comparison baseline, as far as the pages opened show it
     * (served-version.mjs): the checkout is ahead of what is deployed, or behind it.
     */
    this.served = new ServedVersions({
      sourceDir: cfg.sourceDir,
      rewriter: () => this.rewriter,
      baseline: () => ({
        spec: this.cfg.site.markup?.requestedBaseline ?? this.baseline.spec,
        commit: this.baseline.available ? this.baseline.commit : null,
      }),
      onChange: (snapshot) => this.emit('served', snapshot),
    });
    /** Solution files that answer portal addresses: code component resources, Solution web resources (pcf-resources.mjs) */
    this.solutionResources = new SolutionResourceIndex();
    /** @type {WeakMap<object, Set<string>>} code component addresses the page's current documents declare */
    this.pagePcf = new WeakMap();
    /** the last code component catalogue and Solution roots the inspector gave: {catalogue, roots, sourceDir} */
    this.pcfSources = null;
    /** Solution root -> Promise of the files Git reports as changed there (null: no Git baseline) */
    this.solutionChanges = new Map();
    this.settledSolutionChanges = new Map();
    this.route = this.route.bind(this);
  }

  #buildResolver() {
    const changed = this.cfg.site.scope === 'changed' ? this.changedFiles : null;
    this.resolver = new Resolver(this.model, this.cfg.site, { changed });
  }

  rel(file) {
    // A Solution file mapped to a portal address is named as the inspection report names it (@<root>/<path>).
    return this.solutionResources.refOf(file) ?? path.relative(this.cfg.sourceDir, file).replaceAll('\\', '/');
  }

  /** The mapped Solution file a display reference names: {file, rel, url, kind, control, ...}; null when none. */
  solutionSource(rel) {
    const entry = typeof rel === 'string' ? this.solutionResources.source(rel) : null;
    return entry?.file ? entry : null;
  }

  /** The mapped Solution file of a portal address, or null. */
  solutionSourceForUrl(pathname) {
    const entry = this.solutionResources.lookup(pathname);
    return entry?.file ? entry : null;
  }

  /** Whether Git reports the mapped Solution file as changed: true/false, or undefined while unknown or without Git. */
  solutionEdited(rel) {
    const entry = this.solutionSource(rel);
    const changed = entry ? this.settledSolutionChanges.get(entry.solutionRoot) : null;
    return changed ? changed.has(entry.file) : undefined;
  }

  /**
   * What the inspection report needs of the page's code components: per declared address, the control, the resource
   * kind and its manifest path, or why it is not mapped (lense/source-inspection.mjs appendCodeComponentAssets).
   */
  pcfResourcesFor(page) {
    return [...(this.pagePcf.get(page) ?? [])]
      .map((url) => this.solutionResources.lookup(url))
      .filter(Boolean)
      .map((entry) =>
        entry.refused
          ? { url: entry.url, control: entry.control, refused: entry.refused }
          : { url: entry.url, control: entry.control, kind: entry.resourceKind, path: entry.path },
      );
  }

  /** The files Git reports as changed in a Solution root (cached per root); null when the root has no Git baseline. */
  #solutionChanges(root) {
    let pending = this.solutionChanges.get(root);
    if (!pending) {
      pending = GitBaseline.create(root, 'HEAD')
        .then((baseline) => (baseline.available ? baseline.changedFilesAsync({ refreshRef: false }) : null))
        .catch(() => null)
        .then((changed) => {
          if (this.solutionChanges.get(root) === pending)
            this.settledSolutionChanges.set(
              root,
              changed ? new Set([...changed].map((file) => path.resolve(file))) : null,
            );
          return this.settledSolutionChanges.get(root) ?? null;
        });
      this.solutionChanges.set(root, pending);
    }
    return pending;
  }

  /**
   * Whether scope lets a mapped Solution file be served: scope "all", or a file Git reports as changed in its own
   * repository. A Solution root without a Git baseline has nothing to compare with: it is served as in scope "all".
   */
  async #solutionInScope(entry) {
    if (this.cfg.site.scope !== 'changed') return true;
    const changed = await this.#solutionChanges(entry.solutionRoot);
    return changed ? changed.has(entry.file) : true;
  }

  /** The inspector's code component catalogue for a page, remembered for addresses classified without waiting. */
  async #solutionSources(pathname) {
    const inspector = this.sourceInspector ?? this.#inspector();
    if (typeof inspector?.codeComponents !== 'function') return null;
    this.pcfSources = await inspector.codeComponents(pathname);
    return this.pcfSources;
  }

  /**
   * Reads the code components a portal document (or fragment) declares and maps their resource addresses to the
   * Solution files, before the browser requests them. A navigation starts the page's list again.
   */
  async #notePcf(route, html, pathname, navigation) {
    const page = this.#pageOf(route);
    if (navigation && page) this.pagePcf.delete(page);
    if (typeof html !== 'string' || html.length > MAX_PAGE_SOURCE_BYTES) return;
    const declarations = pcfDeclarations(html);
    if (!declarations.length) return;
    let sources = null;
    try {
      sources = await this.#solutionSources(pathname);
    } catch (error) {
      this.emit('fault', error, pathname);
    }
    const folders = new Set(this.solutionResources.folders);
    const entries = this.solutionResources.notePcf(declarations, sources);
    if (page) {
      const declared = this.pagePcf.get(page) ?? new Set();
      for (const entry of entries) declared.add(entry.url);
      this.pagePcf.set(page, declared);
    }
    this.#announceFolders(folders);
  }

  /** Tells the source watcher about Solution folders that hold newly mapped files ('watch' event, `watchPaths`). */
  #announceFolders(before) {
    const added = [...this.solutionResources.folders].filter((folder) => !before.has(folder));
    if (added.length) this.emit('watch', added);
  }

  /** Solution folders whose files answer portal addresses: a source watcher watches them beside the export. */
  get watchPaths() {
    return [...this.solutionResources.folders];
  }

  #acceptChanges(changed) {
    const commit = this.baseline.available ? this.baseline.commit : null;
    const baselineChanged = commit !== this.appliedBaselineCommit;
    this.appliedBaselineCommit = commit;
    this.changedFiles.clear();
    for (const file of changed) this.changedFiles.add(file);
    return baselineChanged;
  }

  /** Reconcile saves made before the watcher was ready, reusing unchanged stamped source bytes. */
  reconcile() {
    this.model.load();
    return this.#reconcileChanges(this.baseline.changedFiles());
  }

  /** The rest of reconcile() once the model is reloaded and Git has listed the changed files. */
  #reconcileChanges(changed) {
    this.knownFiles = new Set(
      [...this.model.inlineSources, ...this.model.webFiles, ...(this.model.inactiveSources ?? [])]
        .map((s) => s.file)
        .filter(Boolean),
    );
    const baselineChanged = this.#acceptChanges(changed);
    this.fileBodies.clear();
    this.#buildResolver();
    this.rewriter.refresh([], { revalidate: true });
    return { baselineChanged };
  }

  /** Complete deferred Git badges without blocking browser requests for a saved web file. */
  refreshChangeTracking(files) {
    return this.#enqueueRefresh(() => this.#refreshChangeTracking(files));
  }

  #enqueueRefresh(operation) {
    const result = this.refreshQueue.then(operation);
    this.refreshQueue = result.catch(() => {});
    return result;
  }

  async #refreshChangeTracking(files) {
    const changed = await this.baseline.changedFilesAsync({ files });
    const baselineChanged = this.#acceptChanges(changed);
    if (baselineChanged) {
      this.model.load();
      this.knownFiles = new Set(
        [...this.model.inlineSources, ...this.model.webFiles, ...(this.model.inactiveSources ?? [])]
          .map((s) => s.file)
          .filter(Boolean),
      );
      this.#buildResolver();
      this.rewriter.refresh();
    } else if (this.cfg.site.scope === 'changed') this.#buildResolver();
    return { baselineChanged };
  }

  /**
   * Sorts saved paths into what the overlay serves (`relevant`) and what it can ignore, and says
   * whether the index must be rebuilt. Metadata (classic .yml, enhanced .xml) can move URLs around;
   * so can added or removed sources (a file the model has not seen can be the first custom JS of a
   * page, or a web file payload saved after its metadata). Anything else in the extract, such as an
   * editor's scratch file or a note, changes nothing the browser could show.
   */
  classifyChanges(files) {
    const sourceDir = this.cfg.sourceDir;
    const routeRoots = (this.cfg.site.routes ?? [])
      .map((rule) => rule.dir ?? rule.file)
      .filter(Boolean)
      .map((target) => path.resolve(sourceDir, target));
    const relevant = [];
    const ignored = [];
    let structural = false;
    for (const file of files.map((file) => path.resolve(file))) {
      // A save in a Solution folder whose files answer portal addresses (a code component's bundle or styles).
      if (!SCRATCH_FILE.test(file) && this.solutionResources.covers(file)) {
        relevant.push(file);
        continue;
      }
      const decision = classifyChange(file, sourceDir, this.knownFiles, routeRoots);
      if (decision.relevant) relevant.push(file);
      else ignored.push(file);
      if (decision.structural) structural = true;
    }
    return { relevant, ignored, structural };
  }

  #applyRefresh(files, { structural, inlineChanged, baselineChanged }) {
    if (structural) {
      this.fileBodies.clear();
      this.model.load();
      this.knownFiles = new Set(
        [...this.model.inlineSources, ...this.model.webFiles, ...(this.model.inactiveSources ?? [])]
          .map((s) => s.file)
          .filter(Boolean),
      );
    } else this.fileBodies.invalidate(files);
    this.#forgetSolutionChanges(files);
    if (structural || this.cfg.site.scope === 'changed') this.#buildResolver();
    // A ref transition affects every source, including a patch unrelated to the saved file.
    // Compare against the last applied ref because the async watcher may already have moved it.
    if (structural || baselineChanged) this.rewriter.refresh();
    else if (inlineChanged) this.rewriter.refresh(files);
    // What the pages showed was compared with the previous baseline or the previous set of sources.
    if (structural || baselineChanged) this.served.reset();
  }

  /** Asks Git again which Solution files changed, in the Solution roots that hold saved files. */
  #forgetSolutionChanges(files) {
    const within = (root, file) => {
      const relative = path.relative(root, path.resolve(file));
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const roots = [...this.solutionChanges.keys()].filter((root) => files.some((file) => within(root, file)));
    for (const root of roots) {
      this.solutionChanges.delete(root);
      void this.#solutionChanges(root);
    }
  }

  /** Re-reads sources after saves. Watchers may defer Git for web-only saves in scope 'all'. */
  /**
   * The export's own view of a page (lense/source-inspection.mjs). The panel shares its inspector with the session;
   * a session without a panel keeps one of its own, made when the first page asks for it.
   */
  #inspector() {
    if (this.sourceInspector) return this.sourceInspector;
    if (this.ownInspector === undefined) {
      try {
        this.ownInspector = this.cfg?.sourceDir && !this.cfg.mirage ? createSourceInspector(this.cfg) : null;
      } catch {
        this.ownInspector = null;
      }
    }
    return this.ownInspector;
  }

  refresh(files = [], { deferChangeTracking = false } = {}) {
    // The export changed: the session's own view of it is read again (the panel refreshes the inspector it shares).
    this.ownInspector?.invalidate();
    const full = !files.length;
    const { relevant, structural: rebuild } = full ? { relevant: [], structural: true } : this.classifyChanges(files);
    if (!full && !relevant.length)
      return { ignored: true, files: [], changeTrackingDeferred: false, baselineChanged: false };
    files = relevant;
    const structural = full || rebuild;
    const inlineChanged = files.some((file) => inlineKindOf(file));
    const changeTrackingDeferred =
      deferChangeTracking && !structural && !inlineChanged && this.cfg.site.scope !== 'changed';
    const baselineChanged =
      !changeTrackingDeferred && this.#acceptChanges(this.baseline.changedFiles(structural ? undefined : { files }));
    this.#applyRefresh(files, { structural, inlineChanged, baselineChanged });
    return { files, changeTrackingDeferred, baselineChanged };
  }

  /**
   * Like refresh(), but inline and structural saves wait for Git asynchronously instead of
   * blocking every browser request of every portal while two Git processes run.
   */
  refreshAsync(files = [], options = {}) {
    return this.#enqueueRefresh(() => this.#refreshAsync(files, options));
  }

  async #refreshAsync(files, options) {
    const full = !files.length;
    const { relevant, structural: rebuild } = full ? { relevant: [], structural: true } : this.classifyChanges(files);
    if (!full && !relevant.length)
      return { ignored: true, files: [], changeTrackingDeferred: false, baselineChanged: false };
    const structural = full || rebuild;
    const inlineChanged = relevant.some((file) => inlineKindOf(file));
    // Web-only saves keep their fast path: fresh bytes first, badge tracking afterwards.
    if (!structural && !inlineChanged && options.deferChangeTracking && this.cfg.site.scope !== 'changed')
      return this.refresh(relevant, options);
    const changed = await this.baseline.changedFilesAsync(structural ? undefined : { files: relevant });
    const baselineChanged = this.#acceptChanges(changed);
    this.#applyRefresh(relevant, { structural, inlineChanged, baselineChanged });
    return { files: relevant, changeTrackingDeferred: false, baselineChanged };
  }

  /**
   * Lets HEAD and baseline checks read the repository's ref files: Git is then asked only when the files that
   * decide the answer differ from the state it last answered for (see repositoryRefState in git.mjs).
   */
  followRepository(directories) {
    this.repository = directories ?? null;
    this.headState = null;
    this.baseline.followRepository?.(directories);
  }

  /** Re-reads where HEAD points; emits 'head' when the commit or branch moved. */
  async refreshHead() {
    const before = gitHeadState(this.repository);
    if (before !== null && before === this.headState) return this.head;
    const head = await gitHead(this.cfg.sourceDir);
    this.headState = before !== null && before === gitHeadState(this.repository) ? before : null;
    const previous = this.head;
    if (previous?.commit === head?.commit && previous?.branch === head?.branch) return head;
    this.head = head;
    this.emit('head', head);
    return head;
  }

  /**
   * Pins the comparison baseline at the current HEAD again, as a restart would. Only sensible
   * when the configured baseline is HEAD; explicit refs keep tracking their own commits.
   */
  repinBaseline() {
    // The watcher's save includes browser work and its final panel event. Finish that first so
    // an older reload cannot clear the new baseline banner after the pin operation.
    return Promise.resolve(this.watchedRefresh).then(() => this.#enqueueRefresh(() => this.#repinBaseline()));
  }

  async #repinBaseline() {
    if ((this.cfg.site.markup?.requestedBaseline ?? this.cfg.site.markup?.baseline) !== 'HEAD')
      throw new Error('Only a HEAD baseline can be pinned again; explicit baseline refs are preserved');
    const head = await this.refreshHead();
    if (!head?.commit) throw new Error('Git HEAD of the checkout is not available');
    const baseline = new GitBaseline(this.cfg.sourceDir, head.commit);
    if (!baseline.available) throw new Error(baseline.error ?? 'Cannot read the current HEAD commit');
    const changed = await baseline.changedFilesAsync({ refreshRef: false });
    if (this.repository) baseline.followRepository(this.repository);
    this.baseline = baseline;
    this.rewriter.baseline = baseline;
    this.cfg.site.markup.baseline = head.commit;
    this.cfg.site.markup.requestedBaseline = 'HEAD';
    this.appliedBaselineCommit = null;
    this.#acceptChanges(changed);
    this.#applyRefresh([], { structural: true, inlineChanged: false, baselineChanged: true });
    return head;
  }

  /**
   * Compares with another Git ref from now on, as a restart with `--baseline <ref>` would: the ref that holds what
   * the portal serves, when the checkout is ahead of the deployment or behind it.
   * @returns {Promise<{spec: string, commit: string}>}
   */
  useBaseline(ref) {
    return Promise.resolve(this.watchedRefresh).then(() => this.#enqueueRefresh(() => this.#useBaseline(ref)));
  }

  async #useBaseline(ref) {
    const baseline = await GitBaseline.create(this.cfg.sourceDir, ref);
    if (!baseline.available) throw new Error(baseline.error ?? `Cannot read baseline ${ref}`);
    const changed = await baseline.changedFilesAsync({ refreshRef: false });
    if (this.repository) baseline.followRepository(this.repository);
    this.baseline = baseline;
    this.rewriter.baseline = baseline;
    this.cfg.site.markup.baseline = ref;
    this.cfg.site.markup.requestedBaseline = ref;
    this.appliedBaselineCommit = null;
    this.#acceptChanges(changed);
    this.#applyRefresh([], { structural: true, inlineChanged: false, baselineChanged: true });
    return { spec: ref, commit: baseline.commit };
  }

  /** Records a hit of the overlay; `ledger` also names the request's answer in the page's ledger. */
  #record(route, hit, ledger = null) {
    let page = null;
    try {
      page = route.request().frame().page();
    } catch {
      /* request without a frame (service worker, closed page) */
    }
    if (page) {
      if (hit.navigation) {
        this.pageHits.set(page, []);
        this.pageHitBytes.set(page, 0);
        this.pageHitsTrimmed.delete(page);
        this.pageIntegrity.delete(page);
      }
      if (ledger) this.#ledger(route, ledger, { navigation: hit.navigation });
      const list = this.pageHits.get(page) ?? [];
      let bytes = this.pageHitBytes.get(page) ?? 0;
      if (hasRecordedSources(hit)) bytes = this.#keepHit(page, hit, list, bytes);
      this.pageHits.set(page, list);
      this.pageHitBytes.set(page, bytes);
    }
    this.emit('hit', { ...hit, page });
  }

  /** Adds a hit that names sources to the page's list and trims the list; the retained bytes after it. */
  #keepHit(page, hit, list, bytes) {
    const repeated = hit.type === 'file' && repeatedPageFileHit(hit, list);
    if (repeated) repeated.count = (repeated.count ?? 1) + 1;
    else bytes = this.#appendRecordedHit(hit, list, bytes);
    // Preserve the latest top-level document and bound both history and retained source bytes.
    const kept = list.length;
    bytes = this.#trimRecordedHits(list, bytes);
    if (list.length < kept) this.pageHitsTrimmed.set(page, (this.pageHitsTrimmed.get(page) ?? 0) + kept - list.length);
    return bytes;
  }

  #appendRecordedHit(hit, list, bytes) {
    // Inline text supports panel comparisons, but polling responses must not retain
    // hundreds of complete copies. Keep the latest response per background URL.
    let keptBytes = 0;
    const kept = {
      ...hit,
      matched: hit.matched?.map((match) => {
        const size = typeof match.online === 'string' ? Buffer.byteLength(match.online) : 0;
        if (keptBytes + size > MAX_PAGE_SOURCE_BYTES) {
          const { online: _omitted, ...metadata } = match; // NOSONAR: binding is excluded from the rest object or is a placeholder
          return { ...metadata, onlineOmitted: true };
        }
        keptBytes += size;
        return match;
      }),
    };
    this.hitBytes.set(kept, keptBytes);
    const previous =
      !hit.navigation && hit.type === 'html'
        ? list.findIndex((entry) => !entry.navigation && entry.type === 'html' && entry.url === hit.url)
        : -1;
    if (previous >= 0) {
      kept.count = (list[previous].count ?? 1) + 1;
      bytes -= this.hitBytes.get(list[previous]) ?? 0;
      list.splice(previous, 1);
    }
    list.push(kept);
    return bytes + keptBytes;
  }

  #trimRecordedHits(list, bytes) {
    while (list.length > 500 || bytes > MAX_PAGE_SOURCE_BYTES) {
      const [removed] = list.splice(list[0]?.navigation ? 1 : 0, 1);
      if (!removed) break;
      bytes -= this.hitBytes.get(removed) ?? 0;
    }
    return bytes;
  }

  /** Handler for one request to the portal; `route` is what intercept.mjs hands over (the shape of a Playwright Route). */
  async route(route) {
    // Keep overlay faults local. Safe requests can fall back; form submissions and internal
    // endpoints are aborted if their outcome cannot be preserved without repeating them.
    try {
      await this.#handle(route);
    } catch (err) {
      this.emit('fault', err, route.request().url());
      const request = route.request();
      // Internal panel requests must never escape to the portal, and a failed form submission
      // must never be sent a second time after it may already have reached the server.
      let local = false;
      try {
        local = new URL(request.url()).pathname.startsWith(LOCAL_PREFIX);
      } catch {
        /* malformed URL */
      }
      await (local || !['GET', 'HEAD'].includes(request.method()) ? route.abort() : route.fallback()).catch(() => {});
    }
  }

  #readLocalInlineBody(src) {
    try {
      return src && isSourceFile(this.cfg.sourceDir, src.file)
        ? this.fileBodies.read(src.file, 'source-map', (bytes) => scriptSourceBody(bytes, src.file))
        : null;
    } catch {
      /* deleted meanwhile */
      return null;
    }
  }

  /* NOSONAR: preserve route completion, fault delivery and lifecycle ordering */ async #handle(route) {
    const request = route.request();
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return route.fallback();
    }
    if (url.origin !== this.cfg.origin) return route.fallback();
    const method = request.method();
    const type = request.resourceType();

    // Mirage already rendered its current Liquid, markup, forms and source assets. Keep the
    // toolkit panel API, but never apply the remote-portal overlay a second time to this response.
    if (this.cfg.mirage) {
      if (url.pathname.startsWith(LOCAL_PREFIX)) {
        if (url.pathname.startsWith(API_PREFIX) && this.api)
          return this.api(route, url.pathname.slice(API_PREFIX.length));
        return route
          .fulfill({
            status: 404,
            headers: { 'content-type': 'text/plain' },
            body: 'paqvilo: no Mirage panel resource at this address',
          })
          .catch(() => {});
      }
      // Catalogue routes map URLs to local files in front of the portal: the same files answer in front of Mirage.
      const routed = method === 'GET' || method === 'HEAD' ? this.#explain(url, { routesOnly: true }) : null;
      if (routed?.via && !this.disabled.has(this.rel(routed.file))) {
        const served = await this.#serveLocal(route, request, url, method, routed);
        if (served === true) return;
      }
      if (type === 'document') {
        const navigation = this.#mainFrame(request, true, true);
        // Mirage serves the page's code components from the Solution sources at its own addresses: the catalogue
        // names their files for the ledger (the panel's inspector; without a panel nothing reads the ledger's names).
        if (this.sourceInspector && method === 'GET')
          await this.#solutionSources(url.pathname).catch((error) => this.emit('fault', error, request.url()));
        const fields = { class: 'document', reason: 'mirage' };
        if (navigation) this.#record(route, { type: 'html', url: url.pathname, sources: [], navigation: true }, fields);
        else this.#ledger(route, fields);
      } else this.#ledger(route, this.#classify(url, method, type, { servedReason: 'mirage' }));
      return route.fallback();
    }

    // 0. addresses of the overlay itself; whatever happens, they are never sent to the portal
    if (url.pathname.startsWith(LOCAL_PREFIX)) {
      // the dev panel on the page talking to this process
      if (url.pathname.startsWith(API_PREFIX) && this.api)
        return this.api(route, url.pathname.slice(API_PREFIX.length));
      // inline scripts the rewriter turned into <script src> so they can be debugged
      let rel = null;
      try {
        if (method === 'GET' && url.pathname.startsWith(INLINE_PREFIX))
          rel = decodeURIComponent(url.pathname.slice(INLINE_PREFIX.length));
      } catch {
        /* malformed escape */
      }
      // only files the model lists as inline scripts are served, nothing else under the sources
      const src = this.model.inlineSources.find((s) => s.rel === rel && s.tag === 'script' && !s.extract),
        body = this.#readLocalInlineBody(src);
      let proof = null;
      try {
        proof = body
          ? await scriptResourceProof(
              this.sourceInspector,
              src.file,
              body,
              new URL(request.frame().page().url()).pathname,
            ).catch(() => null)
          : null;
      } catch {
        /* Navigation may have ended while this script was read. */
      }
      this.#ledger(
        route,
        body
          ? { class: 'local', rel: src.rel, kind: src.kind, status: 200 }
          : { class: 'unidentified', reason: 'not-found', status: 404 },
      );
      await route
        .fulfill(
          body
            ? {
                status: 200,
                headers: {
                  'content-type': 'application/javascript; charset=utf-8',
                  'cache-control': 'no-store',
                  'x-paqvilo': encodeURI(src.rel),
                },
                body,
                ...(proof ? { provenance: proof } : {}),
              }
            : { status: 404, headers: { 'content-type': 'text/plain' }, body: 'paqvilo: nothing at this address' },
        )
        .catch(() => {});
      return;
    }

    if (this.bypass || this.model.ambiguousSite) {
      let navigation = false;
      try {
        navigation = type === 'document' && request.frame().parentFrame() === null;
      } catch {
        /* no frame yet */
      }
      const fields = this.#classify(url, method, type, {
        servedReason: this.model.ambiguousSite ? 'ambiguous-site' : 'bypass',
      });
      if (navigation) this.#record(route, { type: 'html', url: url.pathname, sources: [], navigation }, fields);
      else this.#ledger(route, fields);
      return route.fallback();
    }

    const path = pageKey(url.pathname, this.model);
    if (NEVER_REWRITE.some((re) => re.test(path))) {
      const fields = this.#classify(url, method, type);
      if (this.#mainFrame(request, type === 'document', false))
        this.#record(route, { type: 'html', url: url.pathname, sources: [], navigation: true }, fields);
      else this.#ledger(route, fields);
      return route.fallback();
    }

    // 1. web files and explicit routes: answered from disk, the online site is not asked at all
    let readFailed = null;
    let solutionReason = null;
    // Code component resources the page declared and Solution web resources: answered from the Solution file.
    if (method === 'GET' || method === 'HEAD') {
      const solution = await this.#solutionEntry(url);
      if (solution && !this.disabled.has(solution.rel)) {
        if (solution.resourceKind === 'resx' && !acceptsPcfResx(request.headers().accept))
          solutionReason = 'pcf-transport-unverified';
        else if (!(await this.#solutionInScope(solution))) solutionReason = 'out-of-scope';
        else if (!isSourceFile(solution.folder, solution.file) || !isSourceFile(solution.solutionRoot, solution.file))
          readFailed = solution.rel;
        else {
          const served = await this.#serveLocal(route, request, url, method, {
            file: solution.file,
            via: solution.kind,
            rel: solution.rel,
            kind: solution.kind,
            ...(solution.control ? { control: solution.control } : {}),
          });
          if (served === true) return;
          readFailed = served;
        }
      }
    }
    if (method === 'GET' || method === 'HEAD') {
      const found = this.resolver.explain(url.pathname, { document: type === 'document' });
      if (found?.via && !this.disabled.has(this.rel(found.file))) {
        const served = await this.#serveLocal(route, request, url, method, found);
        if (served === true) return;
        readFailed = served;
      }
    }

    // 2. pages: what the portal answers, with local inline blocks / markup changes laid over the HTML
    // A GET or a plain form post is asked from the portal through route.fetch, from the bytes the browser hands
    // over. The browser does not hand over uploaded files, and a request that is not a plain form must not be sent
    // again: such a request (a multipart post, a POST from a script) is sent once by the browser itself and only its
    // response is paused and read (route.response).
    const replayable =
      method === 'GET' ||
      (method === 'POST' && /^application\/x-www-form-urlencoded/i.test(request.headers()['content-type'] ?? ''));
    const isDocument = type === 'document' && (replayable || method === 'POST');
    // Fetch/XHR can return HTML fragments as well as JSON (a form step that arrives without a page load). Their
    // response type is not known yet, so the browser sends such a request itself and its response is paused: text
    // gets its chance for a changed snippet or template and for a form's or list's custom code, anything else goes
    // on untouched. An endpoint of the portal's own data services never returns a page fragment.
    const isDataRequest =
      (type === 'xhr' || type === 'fetch') &&
      (method === 'GET' || method === 'POST') &&
      (this.rewriter.patches.length > 0 || this.rewriter.blocks.length > 0) &&
      !['portal-data', 'platform-asset'].includes(this.#classify(url, method, type).class);
    if (isDocument || isDataRequest) {
      let navigation;
      try {
        navigation = isDocument && request.isNavigationRequest() && request.frame().parentFrame() === null;
      } catch {
        /* a popup's first navigation has no frame yet */
        navigation = isDocument;
      }
      // How the ledger names this answer: a document of the portal, or the class of a data request's address.
      const answered = (fields) =>
        isDocument ? { class: 'document', ...fields } : { ...this.#classify(url, method, type), ...fields };
      let response;
      try {
        // Bound stalled upstream work. A failed POST is aborted below and is never submitted twice.
        response =
          isDocument && replayable
            ? await route.fetch({ maxRedirects: 0, timeout: 120_000 })
            : await route.response({ timeout: 120_000 });
      } catch {
        // The navigation was cancelled or the network failed. A GET can safely go again through
        // the browser; anything else must not be repeated.
        if (!(isDocument && replayable)) {
          // Sent once by the browser: nothing to repeat and nothing to abort; an unanswered pause is released.
          if (navigation)
            this.#record(
              route,
              { type: 'html', url: url.pathname, sources: [], navigation },
              answered({ reason: 'fetch-failed' }),
            );
          else this.#ledger(route, answered({ reason: 'fetch-failed' }));
          return route.fallback().catch(() => {});
        }
        if (navigation && method === 'GET')
          this.#record(
            route,
            { type: 'html', url: url.pathname, sources: [], navigation },
            answered({ reason: 'fetch-failed' }),
          );
        else this.#ledger(route, answered({ reason: 'fetch-failed' }));
        return (method === 'GET' ? route.fallback() : route.abort()).catch(() => {});
      }
      const contentType = response.headers()['content-type'] ?? '';
      const isHtml = /text\/html/i.test(contentType);
      const isDownload = /attachment/i.test(response.headers()['content-disposition'] ?? '');
      // A document the portal answers with an error status is still a page of the site (Page Not Found, Access
      // Denied): its templates and custom code are the export's, so it is overlaid and identified like any page.
      const status = response.status();
      const pageStatus = status === 200 || (isDocument && status >= 400 && status < 600);
      const rewritable =
        !response.error &&
        pageStatus &&
        !isDownload &&
        (isDocument ? isHtml : status === 200 && TEXT_TYPES.test(contentType));
      if (!rewritable) {
        let reason = 'not-text';
        if (response.error) reason = 'fetch-failed';
        else if (!pageStatus || status !== 200) reason = 'not-200';
        else if (isDownload) reason = 'download';
        else if (isDocument) reason = 'not-html';
        const fields = answered({ status: response.status(), ...(isDocument ? { reason } : {}) });
        if (navigation) this.#record(route, { type: 'html', url: url.pathname, sources: [], navigation }, fields);
        else this.#ledger(route, fields);
        // A response the browser already holds goes on as it is; one fetched for it is handed over.
        return (response.staged ? route.fallback() : route.fulfill({ response })).catch(() => {});
      }
      let original;
      let result;
      let sourceIndex;
      try {
        original = await response.text();
        // The code components the page declares are mapped before the browser requests their resources.
        if (isHtml)
          await this.#notePcf(route, original, url.pathname, navigation).catch((error) =>
            this.emit('fault', error, request.url()),
          );
        // The export's view of the page: for a document it names every element; for a fragment it only decides
        // where a changed source may be laid.
        const inspector = isHtml ? this.#inspector() : null;
        if (inspector) {
          try {
            sourceIndex = await inspector.sourceIndexFor(url.pathname);
          } catch (error) {
            this.emit('fault', error, request.url());
          }
        }
        result = this.rewriter.rewrite(original, url.pathname, {
          html: isHtml,
          isDocument,
          sourceIndex,
          // Elements are named for the panel and X-ray. A session without them still asks the export where a
          // local change may be laid, and leaves the document unmarked.
          provenance: Boolean(this.sourceInspector),
        });
      } catch (err) {
        this.emit('fault', err, request.url());
        const fields = answered({ status: response.status(), reason: 'rewrite-failed' });
        if (navigation) this.#record(route, { type: 'html', url: url.pathname, sources: [], navigation }, fields);
        else this.#ledger(route, fields);
        // Preserve the response already received, especially after a successful form save.
        // If it cannot be read, abort instead of repeating the request.
        if (response.staged) return route.fallback().catch(() => {});
        return route.fulfill({ response }).catch(() => route.abort().catch(() => {}));
      }
      const sources = result.applied.map((a) => ({ rel: a.rel, action: a.action, kind: a.kind }));
      this.#record(
        route,
        {
          type: 'html',
          url: url.pathname,
          navigation,
          ...(isDocument && !navigation ? { frame: true } : {}),
          sources,
          notes: result.notes,
          // every local inline source recognised in the page, overridden or not
          matched: result.matched,
          // page fields with local text the served page does not carry, and how much of the document the export
          // explains (counts per kind of answer, and per source how many of its tags were found)
          ...(result.absent?.length ? { absent: result.absent } : {}),
          ...(result.alignment ? { alignment: result.alignment } : {}),
          // files this document shows in another version than the comparison baseline holds
          ...(result.drift?.files.length ? { drift: result.drift.files } : {}),
        },
        answered({
          status: response.status(),
          ...(sources.length ? { sources: sources.slice(0, MAX_LEDGER_SOURCES) } : {}),
          ...(isDocument && result.matched?.length
            ? {
                matched: result.matched
                  .slice(0, MAX_LEDGER_SOURCES)
                  .map(({ rel, kind, identical, active }) => ({ rel, kind, identical, active })),
              }
            : {}),
        }),
      );
      if (isDocument && isHtml && result.drift) this.served.note(url.pathname, result.drift, original, sourceIndex);
      // Integrity values the document declares, read from the portal's own HTML before any local change.
      if (isDocument && isHtml) this.#noteIntegrity(route, original, request.url(), navigation);
      if (response.staged && result.html === original && !result.provenance) return route.fallback().catch(() => {});
      return route
        .fulfill({
          response,
          ...(result.html === original ? {} : { body: result.html }),
          ...(result.provenance ? { provenance: result.provenance } : {}),
        })
        .catch(() => {});
    }

    const fields = this.#classify(url, method, type, { readFailed, servedReason: solutionReason });
    // A form post that is not re-sent (a multipart upload) still opens a new document: the previous one's accounting
    // must not stay, and the new one is named as not overlaid. The post itself goes to the portal once, untouched.
    if (type === 'document' && method !== 'GET' && this.#mainFrame(request, true, false)) {
      const multipart = /^multipart\//i.test(request.headers()['content-type'] ?? '');
      const reason = multipart ? 'multipart-post' : 'post-not-resent';
      this.#record(
        route,
        {
          type: 'html',
          url: url.pathname,
          sources: [],
          navigation: true,
          notes: [
            {
              kind: 'document',
              reason: `Document not overlaid: ${multipart ? 'a multipart form post (a file upload)' : 'a form post Lense does not re-send'} goes to the portal untouched, so this page shows no local sources. Reload it with GET to see them.`,
            },
          ],
        },
        { class: 'document', reason },
      );
    } else this.#ledger(route, fields);
    return route.fallback();
  }

  /**
   * The Solution file a portal address maps to: a code component resource a page of this session declared, or a
   * Solution web resource by its name. Refused joins and unmapped addresses give null.
   */
  async #solutionEntry(url) {
    if (PCF_RESOURCE_PATH.test(url.pathname)) return this.solutionSourceForUrl(url.pathname);
    if (!WEB_RESOURCE_PATH.test(url.pathname)) return null;
    let sources = this.pcfSources;
    try {
      sources ??= await this.#solutionSources(url.pathname);
    } catch {
      return null;
    }
    const folders = new Set(this.solutionResources.folders);
    const entry = this.solutionResources.noteWebResource(url.pathname, sources);
    this.#announceFolders(folders);
    return entry?.file ? entry : null;
  }

  /** The ledger class of an address a Solution file answers, when it was not answered from that file; else null. */
  #solutionClass(url, method, { servedReason, readFailed, observed }) {
    const entry =
      this.solutionResources.lookup(url.pathname) ??
      (this.cfg.mirage ? this.solutionResources.mirageAsset(url.pathname, this.pcfSources) : null);
    if (!entry) return null;
    const control = entry.control ? { control: entry.control } : {};
    if (entry.refused) {
      const fields = {
        kind: entry.kind,
        ...control,
        reason: entry.refused,
        ...(entry.manifestRel ? { rel: entry.manifestRel } : {}),
      };
      // A control that is not in the Solution sources (a platform or managed control, or one not selected) stays the
      // platform asset it is classified as without a mapping; the reason says why it is not the developer's file.
      if (entry.refused === 'pcf-control-not-in-sources')
        return { ...(platformRule(url, this.cfg.origin) ?? { class: 'platform-asset' }), ...fields };
      return { class: 'export', ...fields };
    }
    let reason;
    if (readFailed === entry.rel) reason = 'read-failed';
    else if (this.disabled.has(entry.rel)) reason = 'paused';
    else if (servedReason) reason = servedReason;
    else if (observed) reason = 'not-intercepted';
    else reason = method === 'GET' || method === 'HEAD' ? 'not-served' : 'method';
    return { class: 'export', rel: entry.rel, kind: entry.kind, ...control, reason };
  }

  /** resolver.explain, or null where the resolver cannot answer (a partial model). */
  #explain(url, options) {
    try {
      return this.resolver.explain(url.pathname, options);
    } catch {
      return null;
    }
  }

  /** True when `request` is a navigation of its page's main frame (`document` false: never). */
  #mainFrame(request, document, unknown) {
    if (!document) return false;
    try {
      return request.isNavigationRequest() && request.frame().parentFrame() === null;
    } catch {
      return unknown;
    }
  }

  /**
   * Answers a GET or HEAD from the local file `found` names (resolver.explain): the record's headers, HTTP/* site
   * settings, byte ranges. Returns true when answered, or the source's rel when it could not be read: the request then
   * continues to the portal, and the fault and the ledger say so.
   */
  async #serveLocal(route, request, url, method, found) {
    const rel = found.rel ?? this.rel(found.file);
    const contentType = mimeFor(
      found.file,
      mimeFor(url.pathname, (found.webFile ?? this.model.findWebFile(url.pathname))?.mimeType),
    );
    const isScript = /(?:javascript|ecmascript)/i.test(contentType);
    const page = this.#pageOf(route);
    // A document that pins this URL with an integrity hash gets the file byte for byte: no appended source map.
    const integrity = (page && this.pageIntegrity.get(page)?.get(urlKey(url.pathname))) ?? null;
    const sourceMaps = Boolean(this.cfg.sourceMaps) && !integrity;
    let read;
    try {
      read = this.#readLocal(found, method, isScript, sourceMaps);
    } catch (error) {
      this.emit(
        'fault',
        new Error(
          `Could not read the local file ${rel} (${error.code ?? error.message}); the portal answered ${url.pathname} instead`,
          { cause: error },
        ),
        request.url(),
      );
      return rel;
    }
    const { body, length } = read;
    const headers = this.#localHeaders(found, contentType, rel);
    const range = method === 'GET' ? byteRange(request.headers().range, body.length) : null;
    const { status, payload } = rangeAnswer(range, body, headers);
    if (method === 'HEAD' && length !== null) headers['content-length'] = String(length);
    const check = integrity && method === 'GET' ? integrityCheck(integrity, body) : null;
    const note = check ? integrityNote(check) : undefined;
    this.#recordLocal(route, url, found, { rel, status, check, note });
    const proof = method === 'GET' && isScript && status === 200 ? await this.#scriptProof(request, found, body) : null;
    // the tab may be gone by now; that is not an error
    await route
      .fulfill({
        status,
        headers,
        body: method === 'HEAD' ? '' : payload,
        ...(proof ? { provenance: proof } : {}),
      })
      .catch(() => {});
    return true;
  }

  /** Records a file answered from the local export in the page's hits and ledger. */
  #recordLocal(route, url, found, { rel, status, check, note }) {
    // A Solution file (code component resource, Solution web resource) names its own kind and control.
    const control = found.control ? { control: found.control } : {};
    this.#record(
      route,
      {
        type: 'file',
        url: url.pathname,
        sources: [{ rel, action: found.via, kind: found.kind ?? 'web-file', ...control }],
        ...(check && !check.match ? { notes: [{ rel, reason: note }] } : {}),
      },
      {
        class: 'local',
        rel,
        kind: found.kind ?? (found.route ? 'route' : 'web-file'),
        ...control,
        status,
        ...(note ? { note } : {}),
      },
    );
  }

  /** The body and the announced length of a local file; throws when it cannot be read. */
  #readLocal(found, method, isScript, sourceMaps) {
    // HEAD needs existence/type metadata, not the entire asset or generated source map. Its length is the file's
    // unless GET appends a source map, which HEAD does not generate: that length is not announced.
    if (method === 'HEAD') {
      const stat = fs.statSync(found.file);
      if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
      return { body: Buffer.alloc(0), length: isScript && sourceMaps ? null : stat.size };
    }
    let variant = '';
    if (isScript) variant = sourceMaps ? 'source-map' : 'script-source';
    const body = this.fileBodies.read(found.file, variant, (bytes) =>
      isScript ? scriptSourceBody(bytes, found.file, { sourceMaps }) : bytes,
    );
    return { body, length: body.length };
  }

  /** The provenance proof of a served script, or null for a changing or unindexed source. */
  async #scriptProof(request, found, body) {
    try {
      return await scriptResourceProof(
        this.sourceInspector,
        found.file,
        body,
        new URL(request.frame().page().url()).pathname,
      );
    } catch {
      return null;
    }
  }

  /** Headers of a local answer: as the portal sends a web file (mirage/server.mjs sendFile), never cached. */
  #localHeaders(found, contentType, rel) {
    const headers = {
      // HTTP/* site settings, as lib/response-headers.mjs siteHeaders applies them to portal responses.
      ...siteHeaders({ settings: this.model.siteSettings ?? {} }),
      // by the name on disk, else by the name in the URL, else what the metadata says
      'content-type': contentType,
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
      'x-paqvilo': encodeURI(rel),
    };
    const webFile = found.webFile;
    if (webFile) {
      const name = webFile.fileName ?? path.basename(found.file);
      const disposition = webFileDisposition({ contentdisposition: webFile.contentDisposition });
      headers['content-disposition'] = `${disposition};filename*=UTF-8''${rfc5987(name)}`;
    }
    return headers;
  }

  #pageOf(route) {
    try {
      return route.request().frame().page() ?? null;
    } catch {
      return null;
    }
  }

  #ledgerOf(page) {
    let ledger = this.requestLedgers.get(page);
    if (!ledger) {
      ledger = new RequestLedger();
      this.requestLedgers.set(page, ledger);
    }
    return ledger;
  }

  /** Records in the page's ledger how interception answered one request; a navigation starts a new ledger. */
  #ledger(route, fields, { navigation = false } = {}) {
    const page = this.#pageOf(route);
    if (!page) return;
    try {
      const request = route.request();
      const ledger = this.#ledgerOf(page);
      if (navigation) ledger.reset();
      ledger.route({
        url: ledgerUrl(request.url()),
        method: request.method(),
        type: request.resourceType(),
        ...fields,
      });
    } catch {
      /* a request without its own details: nothing to record */
    }
  }

  /**
   * The class of a same-origin request interception did not answer from local files: why a file of the export was not
   * served, or the platform rule, or a document, or unidentified. `servedReason` names why a file that would be served
   * was not (bypass, mirage); `observed` marks a class from the address alone, before interception decides.
   */
  #classify(url, method, type, options = {}) {
    // The ledger describes requests; it never decides or breaks how one is answered.
    try {
      return this.#classifyAddress(url, method, type, options);
    } catch {
      return { class: 'unidentified' };
    }
  }

  #classifyAddress(url, method, type, { servedReason = null, readFailed = null, observed = false } = {}) {
    const origin = this.cfg.origin;
    if (url.origin !== origin) return platformRule(url, origin) ?? { class: 'external' };
    const provisional = observed ? { reason: 'not-intercepted' } : {};
    if (url.pathname.startsWith(INLINE_PREFIX)) {
      let rel;
      try {
        rel = decodeURIComponent(url.pathname.slice(INLINE_PREFIX.length));
      } catch {
        /* malformed escape */
      }
      const src = this.model.inlineSources.find((s) => s.rel === rel);
      return src ? { class: 'local', rel: src.rel, kind: src.kind, ...provisional } : { class: 'unidentified' };
    }
    const found = this.#explain(url, { document: type === 'document' });
    const file = found?.file ?? found?.record;
    if (file) {
      const rel = this.rel(file);
      const reason = found.reason || this.#notServedReason(rel, method, { servedReason, readFailed, observed });
      return { class: 'export', rel, kind: found.route ? 'route' : 'web-file', reason };
    }
    const solution = this.#solutionClass(url, method, { servedReason, readFailed, observed });
    if (solution) return solution;
    const rule = platformRule(url, origin, pageKey(url.pathname, this.model));
    if (rule) return rule;
    if (type === 'document') return { class: 'document', ...(servedReason ? { reason: servedReason } : provisional) };
    return { class: 'unidentified', ...provisional };
  }

  /** Why a file of the export that nothing else explains was not answered locally. */
  #notServedReason(rel, method, { servedReason, readFailed, observed }) {
    if (readFailed === rel) return 'read-failed';
    if (this.disabled.has(rel)) return 'paused';
    if (servedReason) return servedReason;
    if (observed) return 'not-intercepted';
    return method === 'GET' || method === 'HEAD' ? 'not-served' : 'method';
  }

  /** Keeps the integrity values `html` declares for same-origin scripts and stylesheets, per URL key of this page. */
  #noteIntegrity(route, html, documentUrl, navigation) {
    const page = this.#pageOf(route);
    if (!page) return;
    const found = integrityUrls(html, documentUrl, this.cfg.origin);
    const current = navigation ? new Map() : (this.pageIntegrity.get(page) ?? new Map());
    for (const [key, value] of found) if (current.size < MAX_INTEGRITY_URLS) current.set(key, value);
    if (current.size) this.pageIntegrity.set(page, current);
    else this.pageIntegrity.delete(page);
  }

  /** `{ total, truncated, counts, items }`: every request of the page's current document and where it came from. */
  requestSummary(page, { limit } = {}) {
    return (this.requestLedgers.get(page) ?? new RequestLedger()).summary({ limit });
  }

  /**
   * Fills the page ledgers from what the browser reports, including requests interception never pauses: other
   * origins, workers, documents opened before interception. Counted per context; the returned function releases it.
   */
  observeRequests(context) {
    let observer = this.requestObservers.get(context);
    if (!observer) {
      const removers = new Set();
      const watched = new WeakSet();
      const watch = (page) => {
        if (watched.has(page)) return;
        watched.add(page);
        // Observation never throws into the page's event emitter.
        const guarded = (handle) => (value) => {
          try {
            handle(value);
          } catch {
            /* a request or response without the details the ledger reads */
          }
        };
        const onRequest = guarded((request) => this.#observeRequest(page, request));
        const onResponse = guarded((response) =>
          this.#observeAnswer(page, response.request(), { status: response.status() }),
        );
        const onFailed = guarded((request) => this.#observeAnswer(page, request, { failed: true }));
        page.on('request', onRequest);
        page.on('response', onResponse);
        page.on('requestfailed', onFailed);
        const remove = () => {
          page.off('request', onRequest);
          page.off('response', onResponse);
          page.off('requestfailed', onFailed);
          page.off('close', remove);
          removers.delete(remove);
        };
        page.once('close', remove);
        removers.add(remove);
      };
      for (const page of context.pages()) watch(page);
      context.on('page', watch);
      removers.add(() => context.off('page', watch));
      observer = { refs: 0, remove: () => [...removers].forEach((remove) => remove()) };
      this.requestObservers.set(context, observer);
    }
    observer.refs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--observer.refs > 0) return;
      observer.remove();
      if (this.requestObservers.get(context) === observer) this.requestObservers.delete(context);
    };
  }

  #observeRequest(page, request) {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    // The dev panel's own calls are the toolkit's, not the page's.
    if (url.origin === this.cfg.origin && url.pathname.startsWith(API_PREFIX)) return;
    let mainNavigation = false;
    try {
      mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      /* a popup's first request has no frame yet */
    }
    if (mainNavigation) {
      // The next document's own entry is recorded when it commits; one on another origin is not this session's.
      if (url.origin !== this.cfg.origin) this.requestLedgers.delete(page);
      else {
        const ledger = this.#ledgerOf(page);
        this.observedRequests.set(request, { ledger, generation: ledger.generation, navigation: true, url });
      }
      return;
    }
    let pageOrigin = null;
    try {
      pageOrigin = new URL(page.url()).origin;
    } catch {
      /* about:blank */
    }
    if (pageOrigin !== this.cfg.origin) return;
    const type = request.resourceType();
    const classified = this.#classify(url, request.method(), type, { observed: true });
    const fields = {
      url: ledgerUrl(request.url(), { external: classified.class === 'external' }),
      method: request.method(),
      type,
      ...classified,
    };
    const ledger = this.#ledgerOf(page);
    ledger.observe(fields);
    this.observedRequests.set(request, { ledger, generation: ledger.generation, fields });
  }

  #observeAnswer(page, request, answer) {
    const seen = this.observedRequests.get(request);
    if (!seen) return;
    this.observedRequests.delete(request);
    const { ledger } = seen;
    if (ledger !== this.requestLedgers.get(page)) return;
    if (seen.navigation) {
      if (answer.failed) return;
      const fields = {
        url: ledgerUrl(request.url()),
        method: request.method(),
        type: request.resourceType(),
        ...this.#classify(seen.url, request.method(), 'document', { observed: true }),
      };
      // Interception did not answer this navigation (it started the ledger then): the new document starts here.
      if (ledger.generation === seen.generation) {
        ledger.reset();
        this.pageHits.set(page, []);
        this.pageHitBytes.set(page, 0);
        this.pageIntegrity.delete(page);
        ledger.observe(fields);
      }
      ledger.answer(fields, answer);
      return;
    }
    if (ledger.generation === seen.generation) ledger.answer(seen.fields, answer);
  }
}
