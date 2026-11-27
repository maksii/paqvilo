// Which version of the sources the portal serves, as far as the pages opened show it.
//
// Lense lays over a page the difference between a Git baseline and the working copy, and takes the baseline for what
// the portal has. A checkout can be ahead of the portal (a branch whose commits are not deployed) or behind it (an
// older branch or release against a newer portal). The rewriter then finds served pages that the baseline does not
// explain (html-rewriter.mjs `drift`). This module collects those findings per file, and asks Git which versions of
// the files do explain the pages: a commit of the file's history, and the branches and tags that hold such a version
// of every file that differs. It compares only what the opened pages show of those files and names no deployment.

import { fileVersions, blobText, refVersions } from './git.mjs';

const SAMPLE_PAGES = 6;
const SAMPLE_PAGES_MOST = 16;
const SAMPLE_BYTES = 3 * 1024 * 1024;
const SEARCH_FILES = 12;
const SEARCH_VERSIONS = 40;
const PAGES_PER_FILE = 3;
const LISTED_PAGES = 20;

const pause = () => new Promise((resolve) => setImmediate(resolve));

function compareText(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export class ServedVersions {
  /**
   * @param {object} options
   * @param {string} options.sourceDir
   * @param {() => object} options.rewriter the session's current HtmlRewriter (`servedFits`, `versionText`)
   * @param {() => {spec: string, commit?: string, available?: boolean}} options.baseline
   * @param {(snapshot: object) => void} [options.onChange] called when the set of differing files or the search changes
   * @param {object} [options.git] `fileVersions`, `blobText`, `refVersions` (replaced in tests)
   */
  constructor({ sourceDir, rewriter, baseline, onChange = null, git = null }) {
    this.sourceDir = sourceDir;
    this.rewriter = rewriter;
    this.baseline = baseline;
    this.onChange = onChange;
    this.git = git ?? { fileVersions, blobText, refVersions };
    /** rel → { rel, kind, name, sourceRefId, file, changed, deployed, pages: Map<url, {count, places}> } */
    this.files = new Map();
    /** url → { body, sourceIndex } of pages that differ, for asking Git which version explains them */
    this.samples = new Map();
    this.search = null;
    this.generation = 0;
    this.pending = null;
    /** true in front of a runtime that renders the working copy itself: nothing is recorded */
    this.suppressed = false;
    /** what Git answered for a file's history and for a blob, until the next reset */
    this.versionCache = new Map();
    this.blobCache = new Map();
  }

  /** Forgets everything: the baseline moved, or the sources were read again. */
  reset() {
    const had = this.files.size > 0;
    this.files.clear();
    this.samples.clear();
    this.versionCache.clear();
    this.blobCache.clear();
    this.search = null;
    this.pending = null;
    this.generation++;
    if (had) this.#changed();
  }

  // A listener's failure is the listener's: it never ends a search or a response.
  #changed() {
    try {
      this.onChange?.(this.snapshot());
    } catch {
      /* reported by the listener's own side */
    }
  }

  /**
   * Records what one response showed.
   * @param {string} url pathname of the page
   * @param {{files: object[], places: object[], seen: string[], truncated: boolean}} drift html-rewriter's finding
   * @param {string} body the response as the portal sent it
   * @param {object} sourceIndex the export's index the response was compared with
   */
  note(url, drift, body, sourceIndex) {
    if (!drift || this.suppressed) return;
    const before = this.#key();
    const differing = new Set(drift.files.map((file) => file.rel));
    // A file this page shows without a difference no longer differs here.
    for (const rel of drift.seen)
      if (!differing.has(rel)) {
        const known = this.files.get(rel);
        if (known?.pages.delete(url) && !known.pages.size) this.files.delete(rel);
      }
    for (const file of drift.files) this.#record(url, file, drift, sourceIndex);
    if (drift.files.some((file) => !file.deployed) && typeof body === 'string' && body.length <= SAMPLE_BYTES) {
      this.samples.delete(url);
      this.samples.set(url, { body, sourceIndex });
      this.#trimSamples();
    } else this.samples.delete(url);
    if (this.#key() === before) return;
    this.generation++;
    this.search = null;
    this.pending = null;
    this.#changed();
    this.#schedule();
  }

  // One differing file as one page showed it.
  #record(url, file, drift, sourceIndex) {
    let known = this.files.get(file.rel);
    if (!known) {
      known = { rel: file.rel, kind: file.kind, name: file.name, pages: new Map() };
      this.files.set(file.rel, known);
    }
    known.sourceRefId = file.sourceRefId;
    known.file = sourceIndex?.sources?.get(file.sourceRefId)?.file ?? null;
    known.changed = Boolean(file.changed);
    known.deployed = Boolean(file.deployed);
    known.pages.delete(url);
    known.pages.set(url, {
      count: file.places,
      places: drift.places.filter((place) => place.rel === file.rel).map(({ rel: _rel, ...place }) => place),
    });
    while (known.pages.size > LISTED_PAGES) known.pages.delete(known.pages.keys().next().value);
  }

  // Keeps a page of every differing file: the oldest page goes first whose files all have another page kept.
  #trimSamples() {
    while (this.samples.size > SAMPLE_PAGES) {
      let drop = null;
      for (const url of this.samples.keys()) {
        const sole = [...this.files.values()].some(
          (file) =>
            file.pages.has(url) && ![...file.pages.keys()].some((other) => other !== url && this.samples.has(other)),
        );
        if (!sole) {
          drop = url;
          break;
        }
      }
      if (drop === null) {
        if (this.samples.size <= SAMPLE_PAGES_MOST) return;
        drop = this.samples.keys().next().value;
      }
      this.samples.delete(drop);
    }
  }

  #key() {
    return [...this.files.values()]
      .map((file) => file.rel + (file.deployed ? ':deployed' : '') + ':' + [...file.pages.keys()].join(','))
      .sort(compareText)
      .join('|');
  }

  /** Files that differ from the baseline on the pages opened, with the places, and what Git says explains them. */
  snapshot() {
    const baseline = this.baseline?.() ?? {};
    const files = [...this.files.values()].map((file) => ({
      rel: file.rel,
      kind: file.kind,
      name: file.name,
      sourceRefId: file.sourceRefId,
      // 'deployed': the portal already serves the working copy. 'baseline': the portal serves neither the baseline
      // nor (for a changed file) the working copy.
      state: file.deployed ? 'deployed' : 'differs',
      changed: file.changed,
      places: [...file.pages.values()].reduce((sum, page) => sum + page.count, 0),
      pages: [...file.pages].map(([url, page]) => ({ url, count: page.count, places: page.places })),
      ...(this.search?.files?.[file.rel] ? { versions: this.search.files[file.rel] } : {}),
    }));
    return {
      baseline: { spec: baseline.spec ?? null, commit: baseline.commit ?? null },
      differs: files.filter((file) => file.state === 'differs').length,
      deployed: files.filter((file) => file.state === 'deployed').length,
      files,
      ...(this.search
        ? {
            search: {
              state: this.search.state,
              refs: this.search.refs ?? [],
              ...(this.search.limited ? { limited: true } : {}),
            },
          }
        : {}),
    };
  }

  #schedule() {
    if (![...this.files.values()].some((file) => !file.deployed)) return;
    const generation = this.generation;
    this.search = { state: 'searching', refs: [], files: {} };
    // The promise of this search exists from now on, so a caller that waits for it waits for this one.
    this.pending = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (generation !== this.generation) return resolve();
        this.#search(generation)
          .catch(() => {
            // Git could not be asked (not installed, no answer): said as that, never as "no version holds it".
            if (generation === this.generation) this.search = { state: 'unavailable', refs: [], files: {} };
          })
          .then(() => {
            if (generation === this.generation) this.#changed();
            resolve();
          })
          .catch(() => resolve());
        return undefined;
      }, 250);
      timer.unref?.();
    });
  }

  /** Resolves when the search for the current findings has ended (for callers that report once). */
  async settled() {
    // The search's own timer does not keep the process alive; a caller that waits for the search does.
    const waiting = setInterval(() => {}, 1000);
    try {
      for (let turn = 0; turn < 50 && this.search?.state === 'searching' && this.pending; turn++) await this.pending;
    } finally {
      clearInterval(waiting);
    }
    return this.snapshot();
  }

  async #versionsOf(file) {
    if (!this.versionCache.has(file))
      this.versionCache.set(file, await this.git.fileVersions(this.sourceDir, file, { limit: SEARCH_VERSIONS }));
    return this.versionCache.get(file);
  }

  async #blob(id) {
    if (!this.blobCache.has(id)) {
      if (this.blobCache.size >= 256) this.blobCache.delete(this.blobCache.keys().next().value);
      this.blobCache.set(id, await this.git.blobText(this.sourceDir, id));
    }
    return this.blobCache.get(id);
  }

  async #search(generation) {
    const rewriter = this.rewriter();
    const current = () => generation === this.generation;
    const differing = [...this.files.values()].filter((file) => !file.deployed && file.file).slice(0, SEARCH_FILES);
    const perFile = {};
    let limited = false;
    /** rel → blobs of the file that explain every sampled page it differs on */
    const fitting = new Map();
    for (const file of differing) {
      const found = await this.#searchFile(file, rewriter, current);
      if (!found) return;
      if (found.skip) continue;
      if (found.limited) limited = true;
      fitting.set(file.rel, new Set(found.fits.map((version) => version.blob)));
      perFile[file.rel] = found.summary;
    }
    // A file no version of the repository explains (rendered by the portal from its own copy, edited in the studio)
    // says nothing about which ref the other files are served from: it is left out of that question.
    const compared = differing.filter((file) => fitting.get(file.rel)?.size);
    let refs = [];
    if (compared.length) {
      const found = await this.#refsOf(compared, fitting, current);
      if (!found) return;
      if (found.limited) limited = true;
      refs = found.refs;
    }
    if (!current()) return;
    this.search = { state: 'done', refs, files: perFile, ...(limited ? { limited: true } : {}) };
  }

  /** What the search finds for one file: `{skip}` without a sampled page; null when the findings moved on. */
  async #searchFile(file, rewriter, current) {
    const pages = this.#sampledPages(file);
    if (!pages.length) return { skip: true };
    const versions = await this.#versionsOf(file.file);
    if (!current()) return null;
    const fits = await this.#fittingVersions(file, versions, pages, rewriter, current);
    if (!fits) return null;
    return {
      fits,
      limited: Boolean(versions.limited),
      summary: {
        searched: versions.length,
        // the file has more versions than were compared: "none fits" then means none of these
        ...(versions.limited ? { limited: true } : {}),
        fits: fits.slice(0, 5).map((version) => ({ commit: version.commit, date: version.date })),
      },
    };
  }

  /** The refs that hold a fitting version of every compared file; null when the findings moved on. */
  async #refsOf(compared, fitting, current) {
    const tips = await this.git.refVersions(
      this.sourceDir,
      compared.map((file) => file.file),
    );
    if (!current()) return null;
    return { refs: refsHolding(tips, compared, fitting), limited: Boolean(tips.limited) };
  }

  /** The last pages of a file that have a sample kept: [url, sample]. */
  #sampledPages(file) {
    return [...file.pages.keys()]
      .map((url) => [url, this.samples.get(url)])
      .filter(([, sample]) => sample)
      .slice(-PAGES_PER_FILE);
  }

  /** The versions of one file that explain every sampled page it differs on; null when the findings moved on. */
  async #fittingVersions(file, versions, pages, rewriter, current) {
    const fits = [];
    for (const version of versions) {
      const raw = await this.#blob(version.blob);
      if (!current()) return null;
      if (raw == null) continue;
      const explains = await this.#explainsPages(raw, file, pages, rewriter, current);
      if (explains === null) return null;
      if (explains) fits.push(version);
      await pause();
      if (!current()) return null;
    }
    return fits;
  }

  /** Whether one version of a file (its text) explains every sampled page; null when the findings moved on. */
  async #explainsPages(raw, file, pages, rewriter, current) {
    for (const [url, sample] of pages) {
      const text = rewriter.versionText(sample.sourceIndex, file.sourceRefId, () => raw);
      const result =
        text == null ? null : rewriter.servedFits(sample.body, url, sample.sourceIndex, file.sourceRefId, text);
      if (!result?.fits) return false;
      // One comparison of a large page takes a while: other work (the browser's requests) goes first.
      await pause();
      if (!current()) return null;
    }
    return true;
  }
}

/** The refs (at most 8) whose blobs are among the ones that explain every compared file. */
function refsHolding(tips, compared, fitting) {
  // Two refs can share a short name (a branch and a tag): the full name is what names one of them.
  const shortNames = new Map();
  for (const tip of tips) shortNames.set(tip.name, (shortNames.get(tip.name) ?? 0) + 1);
  return tips
    .filter((tip) => compared.every((file) => fitting.get(file.rel).has(tip.blobs.get(file.file))))
    .slice(0, 8)
    .map((tip) => ({
      name: tip.name,
      ref: tip.ref,
      commit: tip.commit,
      date: tip.date,
      ...(shortNames.get(tip.name) > 1 ? { ambiguous: true } : {}),
    }));
}
