// The overlay: a browser whose requests to the online portal are answered from local sources.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PortalModel, mimeFor, inlineKindOf, isSourceFile, isPortalMetadata } from './portal-model.mjs';
import { Resolver, globToRegExp } from './resolver.mjs';
import { HtmlRewriter, pageKey, INLINE_PREFIX, LOCAL_PREFIX, API_PREFIX } from './html-rewriter.mjs';
import { GitBaseline, gitHead } from './git.mjs';
import { withFileSourceMap } from './source-map.mjs';
import { FileBodyCache } from './file-cache.mjs';

// Editors and tools leave scratch files next to the sources (safe-write temporaries, swap and
// backup files). They are never portal sources, so they must not rebuild the index or reload tabs.
const SCRATCH_FILE = /(?:~|\.swp|\.swx|\.swo|\.tmp|\.temp|\.bak|\.orig|\.rej|\.crswap|___jb_tmp___|___jb_old___)$|(?:^|[\\/])(?:\.#[^\\/]*|~\$[^\\/]*|4913|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

// Sign-in and token endpoints are never touched, so authentication behaves exactly as online.
// Matched against the path without its language segment (/en-US/signin is /signin).
const NEVER_REWRITE = ['/signin**', '/account', '/account/**', '/_services/auth', '/_services/auth/**', '/.auth', '/.auth/**', '/_layout/tokenhtml**', '/externalauthenticationcallback**'].map(globToRegExp);

const TEXT_TYPES = /^(?:text\/|application\/(?:json|javascript|xml|xhtml))/i;
const MAX_PAGE_SOURCE_BYTES = 8 * 1024 * 1024;

export class OverlaySession extends EventEmitter {
  /** Prepare disk-heavy indexes without serial synchronous reads blocking startup. */
  static async create(cfg) {
    const model = await PortalModel.create(cfg.sourceDir);
    const baseline = new GitBaseline(cfg.sourceDir, cfg.site.markup?.baseline ?? 'HEAD');
    const changedFiles = baseline.changedFiles({ refreshRef: false });
    const disabled = new Set();
    const rewriter = await HtmlRewriter.create({ model, site: cfg.site, baseline, changedFiles, sourceMaps: Boolean(cfg.sourceMaps), disabled });
    const session = new OverlaySession(cfg, { model, baseline, changedFiles, disabled, rewriter });
    // Sources and HEAD can change while the bounded asynchronous reads are in flight.
    // Reconcile their final metadata/working-tree snapshot before exposing the session.
    session.reconcile();
    await session.refreshHead();
    return session;
  }

  /** @param {Awaited<ReturnType<import('./config.mjs').loadConfig>>} cfg */
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
    this.refreshQueue = Promise.resolve();
    this.rewriter = prepared.rewriter ?? new HtmlRewriter({ model: this.model, site: cfg.site, baseline: this.baseline, changedFiles: this.changedFiles, sourceMaps: Boolean(cfg.sourceMaps), disabled: this.disabled });
    this.knownFiles = new Set([...this.model.inlineSources, ...this.model.webFiles, ...(this.model.inactiveSources ?? [])].map((s) => s.file).filter(Boolean));
    this.#buildResolver();
    /** @type {WeakMap<object, Array<object>>} hits per page since its last navigation */
    this.pageHits = new WeakMap();
    this.pageHitBytes = new WeakMap();
    this.hitBytes = new WeakMap();
    this.route = this.route.bind(this);
  }

  #buildResolver() {
    const changed = this.cfg.site.scope === 'changed' ? this.changedFiles : null;
    this.resolver = new Resolver(this.model, this.cfg.site, { changed });
  }

  rel(file) {
    return path.relative(this.cfg.sourceDir, file).replace(/\\/g, '/');
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
    this.knownFiles = new Set([...this.model.inlineSources, ...this.model.webFiles, ...(this.model.inactiveSources ?? [])].map((s) => s.file).filter(Boolean));
    const baselineChanged = this.#acceptChanges(this.baseline.changedFiles());
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
      this.knownFiles = new Set([...this.model.inlineSources, ...this.model.webFiles, ...(this.model.inactiveSources ?? [])].map((s) => s.file).filter(Boolean));
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
    const routeRoots = (this.cfg.site.routes ?? []).map((rule) => rule.dir ?? rule.file).filter(Boolean).map((target) => path.resolve(sourceDir, target));
    const relevant = [];
    const ignored = [];
    let structural = false;
    for (const file of files.map((file) => path.resolve(file))) {
      const rel = path.relative(sourceDir, file).replace(/\\/g, '/');
      const inExtract = rel !== '' && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel);
      let exists = true;
      let directory = false;
      try { directory = fs.statSync(file).isDirectory(); } catch { exists = false; }
      if (this.knownFiles.has(file)) {
        relevant.push(file);
        if (!exists || isPortalMetadata(rel)) structural = true;
        continue;
      }
      // children report their own events; a removed folder may have held indexed sources
      if (directory) { ignored.push(file); continue; }
      if (!exists && [...this.knownFiles].some((known) => known.startsWith(file + path.sep))) { relevant.push(file); structural = true; continue; }
      if (routeRoots.some((root) => file === root || file.startsWith(root + path.sep))) { relevant.push(file); continue; }
      if (!inExtract || SCRATCH_FILE.test(file)) { ignored.push(file); continue; }
      const assetLocation = /^web-files\/[^/]+$/i.test(rel) || /^powerpagecomponents\/[^/]+\/filecontent\//i.test(rel);
      if (isPortalMetadata(rel) || inlineKindOf(file) || assetLocation) { relevant.push(file); structural = true; continue; }
      ignored.push(file);
    }
    return { relevant, ignored, structural };
  }

  #applyRefresh(files, { structural, inlineChanged, baselineChanged }) {
    if (structural) {
      this.fileBodies.clear();
      this.model.load();
      this.knownFiles = new Set([...this.model.inlineSources, ...this.model.webFiles, ...(this.model.inactiveSources ?? [])].map((s) => s.file).filter(Boolean));
    } else this.fileBodies.invalidate(files);
    if (structural || this.cfg.site.scope === 'changed') this.#buildResolver();
    // A ref transition affects every source, including a patch unrelated to the saved file.
    // Compare against the last applied ref because the async watcher may already have moved it.
    if (structural || baselineChanged) this.rewriter.refresh();
    else if (inlineChanged) this.rewriter.refresh(files);
  }

  /** Re-reads sources after saves. Watchers may defer Git for web-only saves in scope 'all'. */
  refresh(files = [], { deferChangeTracking = false } = {}) {
    const full = !files.length;
    const { relevant, structural: rebuild } = full ? { relevant: [], structural: true } : this.classifyChanges(files);
    if (!full && !relevant.length) return { ignored: true, files: [], changeTrackingDeferred: false, baselineChanged: false };
    files = relevant;
    const structural = full || rebuild;
    const inlineChanged = files.some((file) => inlineKindOf(file));
    const changeTrackingDeferred = deferChangeTracking && !structural && !inlineChanged && this.cfg.site.scope !== 'changed';
    const baselineChanged = !changeTrackingDeferred && this.#acceptChanges(this.baseline.changedFiles(structural ? undefined : { files }));
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
    if (!full && !relevant.length) return { ignored: true, files: [], changeTrackingDeferred: false, baselineChanged: false };
    const structural = full || rebuild;
    const inlineChanged = relevant.some((file) => inlineKindOf(file));
    // Web-only saves keep their fast path: fresh bytes first, badge tracking afterwards.
    if (!structural && !inlineChanged && options.deferChangeTracking && this.cfg.site.scope !== 'changed') return this.refresh(relevant, options);
    const changed = await this.baseline.changedFilesAsync(structural ? undefined : { files: relevant });
    const baselineChanged = this.#acceptChanges(changed);
    this.#applyRefresh(relevant, { structural, inlineChanged, baselineChanged });
    return { files: relevant, changeTrackingDeferred: false, baselineChanged };
  }

  /** Re-reads where HEAD points; emits 'head' when the commit or branch moved. */
  async refreshHead() {
    const head = await gitHead(this.cfg.sourceDir);
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
    if ((this.cfg.site.markup?.requestedBaseline ?? this.cfg.site.markup?.baseline) !== 'HEAD') throw new Error('Only a HEAD baseline can be pinned again; explicit baseline refs are preserved');
    const head = await this.refreshHead();
    if (!head?.commit) throw new Error('Git HEAD of the checkout is not available');
    const baseline = new GitBaseline(this.cfg.sourceDir, head.commit);
    if (!baseline.available) throw new Error(baseline.error ?? 'Cannot read the current HEAD commit');
    const changed = await baseline.changedFilesAsync({ refreshRef: false });
    this.baseline = baseline;
    this.rewriter.baseline = baseline;
    this.cfg.site.markup.baseline = head.commit;
    this.cfg.site.markup.requestedBaseline = 'HEAD';
    this.appliedBaselineCommit = null;
    this.#acceptChanges(changed);
    this.#applyRefresh([], { structural: true, inlineChanged: false, baselineChanged: true });
    return head;
  }

  #record(route, hit) {
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
      }
      const list = this.pageHits.get(page) ?? [];
      let bytes = this.pageHitBytes.get(page) ?? 0;
      if (hit.sources?.length || hit.type === 'file' || hit.matched?.length) {
        const repeated = hit.type === 'file' && list.find((previous) => previous.type === 'file' && previous.url === hit.url && previous.sources?.[0]?.rel === hit.sources?.[0]?.rel);
        if (repeated) repeated.count = (repeated.count ?? 1) + 1;
        else {
          // Inline text supports panel comparisons, but polling responses must not retain
          // hundreds of complete copies. Keep the latest response per background URL.
          let keptBytes = 0;
          const kept = { ...hit, matched: hit.matched?.map((match) => {
            const size = typeof match.online === 'string' ? Buffer.byteLength(match.online) : 0;
            if (keptBytes + size > MAX_PAGE_SOURCE_BYTES) {
              const { online: _omitted, ...metadata } = match;
              return { ...metadata, onlineOmitted: true };
            }
            keptBytes += size;
            return match;
          }) };
          this.hitBytes.set(kept, keptBytes);
          const previous = !hit.navigation && hit.type === 'html' ? list.findIndex((entry) => !entry.navigation && entry.type === 'html' && entry.url === hit.url) : -1;
          if (previous >= 0) {
            kept.count = (list[previous].count ?? 1) + 1;
            bytes -= this.hitBytes.get(list[previous]) ?? 0;
            list.splice(previous, 1);
          }
          list.push(kept);
          bytes += keptBytes;
        }
        // Preserve the latest top-level document and bound both history and retained source bytes.
        while (list.length > 500 || bytes > MAX_PAGE_SOURCE_BYTES) {
          const [removed] = list.splice(list[0]?.navigation ? 1 : 0, 1);
          if (!removed) break;
          bytes -= this.hitBytes.get(removed) ?? 0;
        }
      }
      this.pageHits.set(page, list);
      this.pageHitBytes.set(page, bytes);
    }
    this.emit('hit', { ...hit, page });
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
      try { local = new URL(request.url()).pathname.startsWith(LOCAL_PREFIX); } catch { /* malformed URL */ }
      await (local || !['GET', 'HEAD'].includes(request.method()) ? route.abort() : route.fallback()).catch(() => {});
    }
  }

  async #handle(route) {
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
        return route.fulfill({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'paqvilo: no Mirage panel resource at this address' }).catch(() => {});
      }
      const isDocument = type === 'document' && (method === 'GET' || (method === 'POST' && /^application\/x-www-form-urlencoded/i.test(request.headers()['content-type'] ?? '')));
      if (isDocument) {
        let navigation = false;
        try { navigation = request.isNavigationRequest() && request.frame().parentFrame() === null; }
        catch { navigation = true; }
        if (navigation) this.#record(route, { type: 'html', url: url.pathname, sources: [], navigation: true });
      }
      return route.fallback();
    }

    // 0. addresses of the overlay itself; whatever happens, they are never sent to the portal
    if (url.pathname.startsWith(LOCAL_PREFIX)) {
      // the dev panel on the page talking to this process
      if (url.pathname.startsWith(API_PREFIX) && this.api) return this.api(route, url.pathname.slice(API_PREFIX.length));
      // inline scripts the rewriter turned into <script src> so they can be debugged
      let rel = null;
      try {
        if (method === 'GET' && url.pathname.startsWith(INLINE_PREFIX)) rel = decodeURIComponent(url.pathname.slice(INLINE_PREFIX.length));
      } catch {
        /* malformed escape */
      }
      // only files the model lists as inline scripts are served, nothing else under the sources
      const src = this.model.inlineSources.find((s) => s.rel === rel && s.tag === 'script' && !s.extract);
      let body = null;
      try {
        body = src && isSourceFile(this.cfg.sourceDir, src.file) ? this.fileBodies.read(src.file, 'source-map', (bytes) => withFileSourceMap(bytes, src.file)) : null;
      } catch {
        /* deleted meanwhile */
      }
      await route
        .fulfill(
          body
            ? {
                status: 200,
                headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-paqvilo': encodeURI(src.rel) },
                body,
              }
            : { status: 404, headers: { 'content-type': 'text/plain' }, body: 'paqvilo: nothing at this address' },
        )
        .catch(() => {});
      return;
    }

    if (this.bypass) {
      let navigation = false;
      try {
        navigation = type === 'document' && request.frame().parentFrame() === null;
      } catch {
        /* no frame yet */
      }
      if (navigation) this.#record(route, { type: 'html', url: url.pathname, sources: [], navigation });
      return route.fallback();
    }

    const path = pageKey(url.pathname);
    if (NEVER_REWRITE.some((re) => re.test(path))) return route.fallback();

    // 1. web files and explicit routes: answered from disk, the online site is not asked at all
    if (method === 'GET' || method === 'HEAD') {
      const found = this.resolver.resolve(url.pathname);
      const hit = found && !this.disabled.has(this.rel(found.file)) ? found : null;
      if (hit) {
        let body;
        try {
          // HEAD needs existence/type metadata, not the entire asset or generated source map.
          body = method === 'HEAD'
            ? (fs.statSync(hit.file).isFile() ? Buffer.alloc(0) : null)
            : this.fileBodies.read(hit.file, this.cfg.sourceMaps && /\.m?js$/i.test(url.pathname) ? 'source-map' : '', (bytes) =>
              this.cfg.sourceMaps && /\.m?js$/i.test(url.pathname) ? withFileSourceMap(bytes, hit.file) : bytes);
        } catch {
          body = null;
        }
        if (body) {
          const rel = this.rel(hit.file);
          this.#record(route, { type: 'file', url: url.pathname, sources: [{ rel, action: hit.via, kind: 'web-file' }] });
          // the tab may be gone by now; that is not an error
          await route
            .fulfill({
              status: 200,
              headers: {
                // by the name on disk, else by the name in the URL, else what the metadata says
                'content-type': mimeFor(hit.file, mimeFor(url.pathname, this.model.findWebFile(url.pathname)?.mimeType)),
                'cache-control': 'no-store',
                'x-paqvilo': encodeURI(rel),
              },
              body: method === 'HEAD' ? '' : body,
            })
            .catch(() => {});
          return;
        }
      }
    }

    // 2. pages: fetched online, then local inline blocks / markup changes are laid over the HTML
    // A form post is re-sent by route.fetch from the bytes the browser hands over, and it does not
    // hand over uploaded files: multipart posts are left alone.
    const isDocument =
      type === 'document' &&
      (method === 'GET' || (method === 'POST' && /^application\/x-www-form-urlencoded/i.test(request.headers()['content-type'] ?? '')));
    // Fetch/XHR can return HTML fragments as well as JSON. Their response type is not known
    // yet, so snippet-only changes must still get a chance to patch returned HTML.
    const isDataRequest = (type === 'xhr' || type === 'fetch') && method === 'GET' && this.rewriter.patches.length > 0;
    if (isDocument || isDataRequest) {
      let navigation = false;
      try {
        navigation = isDocument && request.isNavigationRequest() && request.frame().parentFrame() === null;
      } catch {
        /* a popup's first navigation has no frame yet */
        navigation = isDocument;
      }
      let response;
      try {
        // Bound stalled upstream work. A failed POST is aborted below and is never submitted twice.
        response = await route.fetch({ maxRedirects: 0, timeout: 120_000 });
      } catch {
        // The navigation was cancelled or the network failed. A GET can safely go again through
        // the browser; anything else must not be repeated.
        return (method === 'GET' ? route.fallback() : route.abort()).catch(() => {});
      }
      const contentType = response.headers()['content-type'] ?? '';
      const isHtml = /text\/html/i.test(contentType);
      const isDownload = /attachment/i.test(response.headers()['content-disposition'] ?? '');
      const rewritable = response.status() === 200 && !isDownload && (isDocument ? isHtml : TEXT_TYPES.test(contentType));
      if (!rewritable) {
        if (navigation) this.#record(route, { type: 'html', url: url.pathname, sources: [], navigation });
        return route.fulfill({ response }).catch(() => {});
      }
      let original;
      let result;
      try {
        original = await response.text();
        result = this.rewriter.rewrite(original, url.pathname, { html: isHtml });
      } catch (err) {
        this.emit('fault', err, request.url());
        // Preserve the response already received, especially after a successful form save.
        // If it cannot be read, abort instead of repeating the request.
        return route.fulfill({ response }).catch(() => route.abort().catch(() => {}));
      }
      this.#record(route, {
        type: 'html',
        url: url.pathname,
        navigation,
        sources: result.applied.map((a) => ({ rel: a.rel, action: a.action, kind: a.kind })),
        notes: result.notes,
        // every local inline source recognised in the page, overridden or not
        matched: result.matched,
      });
      if (result.html === original) return route.fulfill({ response }).catch(() => {});
      return route.fulfill({ response, body: result.html }).catch(() => {});
    }

    return route.fallback();
  }
}
