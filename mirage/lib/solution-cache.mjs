import { createJsonTextCoalescer } from './json-text.mjs';
import { orderedMap } from '../../lense/async-map.mjs';
import { directoryFiles } from '../../lense/directory-files.mjs';
import { recordedStamp } from '../../lense/file-cache.mjs';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertProjectOutput } from './project-output.mjs';
import { types } from 'node:util';

// One header line, then one line per entry: `[file, entry]` JSON, or `D<key>\t<json>` for one
// part of a derived value (kept as text until it is read). Every line is parsed natively and
// independently, so loading never builds the complete document in one string.
const FORMAT = 3;
const HEADER = JSON.stringify({ format: FORMAT });
const DERIVED = 'D';

/** The lines of a cache file; nothing when it does not start with this format's header. */
async function* cacheLines(file) {
  let rest = null;
  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 1024 * 1024 })) {
    let start = 0,
      end;
    const text = rest === null ? chunk : rest + chunk;
    if (rest === null) {
      if (!text.startsWith(HEADER + '\n')) return;
      start = HEADER.length + 1;
    }
    while ((end = text.indexOf('\n', start)) !== -1) {
      if (end > start) yield text.slice(start, end);
      start = end + 1;
    }
    rest = text.slice(start);
  }
  if (rest) yield rest;
}

// Different readers of one source file retain independent result objects, but
// often contain identical form XML. Share only immutable string values within
// that file; the pool itself dies immediately and never retains other sources.
function coalesceSourceText(results) {
  const strings = new Map(),
    visited = new WeakSet(),
    pending = [results];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || types.isProxy(item) || visited.has(item)) continue;
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) continue;
    visited.add(item);
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
      const value = descriptor.value;
      if (typeof value === 'string' && value.length >= 256) {
        if (!strings.has(value)) strings.set(value, value);
        else if (descriptor.writable) Object.defineProperty(item, key, { ...descriptor, value: strings.get(value) });
      } else if (value && typeof value === 'object') pending.push(value);
    }
  }
}

/** Run an async mapper with bounded concurrency while preserving input order. */
export async function mapLimit(items, limit, mapper) {
  const list = [...items];
  // This legacy adapter clamps non-positive/fractional limits and accepts numeric strings.
  const workers = Math.floor(Math.min(Math.max(1, limit), list.length));
  if (!workers) return new Array(list.length);
  return orderedMap(list, workers, mapper);
}

const DIGEST_SKIP = new Set(['.git', '.portalconfig', 'node_modules', '.paqvilo']);
const digestCache = new Map();

/**
 * The same SHA-256 as evidence.mjs `sourceFingerprint(dir)` (relative path, NUL, bytes,
 * NUL for every file in sorted depth-first order; symlinks and .git/.portalconfig/
 * node_modules/.paqvilo skipped), with directories and files read concurrently. The
 * digest is recomputed only when a file's size, mtime, ctime or identity changed, or
 * when a file changed too recently for its stat to prove it unchanged (recordedStamp).
 */
export async function sourceDirectoryDigest(dir) {
  const root = path.resolve(dir);
  const files = await directoryFiles(root, {
    skip: DIGEST_SKIP,
    sort: (a, b) => a.name.localeCompare(b.name),
    concurrency: 32,
  });
  const stamps = await mapLimit(files, 64, async (file) => {
    const stat = await fs.stat(file, { bigint: true });
    return recordedStamp(
      stat,
      `${path.relative(root, file)}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0${stat.ino}`,
    );
  });
  const signature = createHash('sha256').update(stamps.join('\n')).digest('hex');
  const cached = digestCache.get(root);
  if (cached?.signature === signature) return cached.digest;
  const hash = createHash('sha256');
  const window = 256;
  for (let start = 0; start < files.length; start += window) {
    const slice = files.slice(start, start + window);
    const contents = await mapLimit(slice, 32, (file) => fs.readFile(file));
    slice.forEach((file, index) => {
      hash.update(path.relative(root, file).replaceAll('\\', '/'));
      hash.update('\0');
      hash.update(contents[index]);
      hash.update('\0');
    });
  }
  const digest = hash.digest('hex');
  digestCache.set(root, { signature, digest });
  return digest;
}

// Parsed results shared by every SolutionFileCache of this process while a share is open
// (shareSolutionParses): the runtimes `serve --project` starts parse a common Solution file
// once. Entries are keyed by file and stamp; results are stored and handed out as copies.
let processEntries = null;

/**
 * Share parsed results between caches until `close()`; nested shares use the outer one.
 * Outside a share every cache parses for itself, so no parsed copy outlives startup.
 */
export function shareSolutionParses() {
  const opened = !processEntries;
  if (opened) processEntries = new Map();
  return {
    close() {
      if (opened) processEntries = null;
    },
  };
}

function shareEntry(file, entry, parserId) {
  if (!processEntries) return;
  const current = processEntries.get(file);
  const value = structuredClone(entry.results[parserId]);
  processEntries.set(
    file,
    current?.stamp === entry.stamp && current.hash === entry.hash
      ? { ...current, results: { ...current.results, [parserId]: value } }
      : { stamp: entry.stamp, hash: entry.hash, results: { [parserId]: value } },
  );
}

/**
 * File identity used to reuse parsed results: size, modification/change time and inode. A file
 * changed too recently for its stat to prove it unchanged gets a stamp that matches nothing.
 */
export async function fileStamp(file) {
  const stat = await fs.stat(file, { bigint: true });
  return {
    stamp: recordedStamp(stat, `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`),
    size: Number(stat.size),
    isFile: stat.isFile(),
  };
}

/**
 * Parsed-file cache for solution sources. An entry is reused only when the file's
 * size, mtime, ctime and inode are unchanged and the parser identifier matches,
 * so a changed file is always read and parsed again. Without a cache file the
 * same API reads every file (memoized for the lifetime of the object only).
 */
export class SolutionFileCache {
  constructor(file = null) {
    assertProjectOutput(file);
    this.file = file ? path.resolve(file) : null;
    this.entries = new Map();
    this.used = new Set();
    // Derived values (deriveValue): key -> JSON text parts.
    this.derived = new Map();
    this.usedDerived = new Set();
    this.dirty = false;
    this.stats = { hits: 0, misses: 0 };
    // Hits served from another cache of this process (shareSolutionParses).
    this.processHits = 0;
  }
  static async open(file) {
    const cache = new SolutionFileCache(file);
    if (!cache.file) return cache;
    try {
      const retainText = createJsonTextCoalescer();
      for await (const line of cacheLines(cache.file)) {
        if (line.startsWith(DERIVED)) {
          const tab = line.indexOf('\t');
          if (tab < 0) throw new SyntaxError('Invalid derived cache line');
          const key = line.slice(DERIVED.length, tab);
          if (!cache.derived.has(key)) cache.derived.set(key, []);
          cache.derived.get(key).push(line.slice(tab + 1));
          continue;
        }
        const [name, entry] = JSON.parse(line);
        if (typeof name === 'string' && entry && typeof entry.stamp === 'string' && entry.results) {
          retainText(entry);
          coalesceSourceText(entry.results);
          cache.entries.set(name, entry);
        }
      }
    } catch {
      // A missing, unreadable or older-format cache is rebuilt from sources.
      cache.entries.clear();
      cache.derived.clear();
    }
    return cache;
  }
  /**
   * Parse `file` with `parser(text, file)` unless an identical stamp is cached, in this
   * cache or, while a share is open (shareSolutionParses), in another cache of this process:
   * the portals of `serve --project` parse a common file once. A shared result is handed
   * out as a copy, so no consumer sees another's changes. Returns { value, hash, cached }.
   * The SHA-256 covers the file bytes.
   */
  async parse(file, parserId, parser, known, { binary = false } = {}) {
    const { stamp } = known?.stamp ? known : await fileStamp(file);
    this.used.add(file);
    const entry = this.entries.get(file);
    if (entry?.stamp === stamp && Object.hasOwn(entry.results, parserId)) {
      this.stats.hits++;
      const shared = processEntries?.get(file);
      if (processEntries && (shared?.stamp !== stamp || !Object.hasOwn(shared.results, parserId)))
        shareEntry(file, entry, parserId);
      return { value: entry.results[parserId], hash: entry.hash, cached: true };
    }
    const shared = processEntries?.get(file);
    if (shared?.stamp === stamp && Object.hasOwn(shared.results, parserId)) {
      this.stats.hits++;
      this.processHits++;
      const value = structuredClone(shared.results[parserId]);
      this.entries.set(
        file,
        entry?.stamp === stamp && entry.hash === shared.hash
          ? { ...entry, results: { ...entry.results, [parserId]: value } }
          : { stamp, hash: shared.hash, results: { [parserId]: value } },
      );
      this.dirty = true;
      return { value, hash: shared.hash, cached: true };
    }
    this.stats.misses++;
    const bytes = await fs.readFile(file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const value = await parser(binary ? bytes : bytes.toString('utf8'), file);
    const next =
      entry?.stamp === stamp && entry.hash === hash
        ? { ...entry, results: { ...entry.results, [parserId]: value } }
        : { stamp, hash, results: { [parserId]: value } };
    this.entries.set(file, next);
    coalesceSourceText(next.results);
    shareEntry(file, next, parserId);
    this.dirty = true;
    return { value, hash, cached: false };
  }
  /**
   * A value derived from `file` by `compute()` (for example its last commit time), cached
   * by file path and content: reused while the file's stamp is unchanged, or after a stamp
   * change when the content hash is the same, and only while `key` matches (for example the
   * repository HEAD). Returns the value.
   */
  async remember(file, resultId, key, compute) {
    const { stamp } = await fileStamp(file);
    this.used.add(file);
    const entry = this.entries.get(file);
    let cached = entry?.stamp === stamp ? entry.results[resultId] : undefined;
    let hash = entry?.stamp === stamp ? entry.hash : null;
    if (!cached && entry) {
      hash = createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');
      if (hash === entry.hash) cached = entry.results[resultId];
    }
    if (cached && cached.key === key) {
      this.stats.hits++;
      if (entry.stamp !== stamp) {
        this.entries.set(file, { ...entry, stamp });
        this.dirty = true;
      }
      return cached.value;
    }
    this.stats.misses++;
    const value = await compute();
    hash ??= createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex');
    const results = entry && entry.hash === hash ? { ...entry.results } : {};
    results[resultId] = { key, value };
    this.entries.set(file, { stamp, hash, results });
    this.dirty = true;
    return value;
  }
  /**
   * The SHA-256 of `file`'s bytes, reused while its `stamp` (fileStamp) is unchanged;
   * otherwise `compute()` hashes the file. Synchronous, for synchronous fingerprints.
   */
  knownHash(file, stamp, compute) {
    this.used.add(file);
    const entry = this.entries.get(file);
    if (entry?.stamp === stamp && typeof entry.hash === 'string') return entry.hash;
    const hash = compute();
    this.entries.set(file, entry?.hash === hash ? { ...entry, stamp } : { stamp, hash, results: {} });
    this.dirty = true;
    return hash;
  }
  /**
   * A plain-JSON value derived from `file` (`resultId`), reused while its stamp is unchanged.
   * Synchronous; other results of the same stamp are kept.
   */
  knownResult(file, stamp, resultId, compute) {
    this.used.add(file);
    const entry = this.entries.get(file);
    if (entry?.stamp === stamp && Object.hasOwn(entry.results, resultId)) return entry.results[resultId];
    const value = compute();
    this.entries.set(
      file,
      entry?.stamp === stamp
        ? { ...entry, results: { ...entry.results, [resultId]: value } }
        : { stamp, hash: null, results: { [resultId]: value } },
    );
    this.dirty = true;
    return value;
  }
  /**
   * A plain-JSON value computed from inputs that `key` identifies completely (a content
   * fingerprint). It is stored as the JSON text of `split(value)` parts and rebuilt by
   * `join(parts)`, so no single string holds the whole value; every call returns its own value.
   */
  deriveValue(key, compute, { split = (value) => [value], join = ([value]) => value } = {}) {
    if (/[\t\n]/.test(key)) throw new TypeError('A derived cache key is one line without tabs.');
    this.usedDerived.add(key);
    const parts = this.derived.get(key);
    if (parts) return join(parts.map((part) => JSON.parse(part)));
    const value = compute();
    if (this.file) {
      this.derived.set(
        key,
        split(value).map((part) => JSON.stringify(part)),
      );
      this.dirty = true;
    }
    return value;
  }
  /**
   * Drop every parsed and derived result once a load has saved them. A scan keeps its cache for later reads, so an
   * unreleased cache would hold every source file's parse for the life of the runtime. Later reads parse again, and a
   * released cache is never saved, so it cannot overwrite the complete file with the few entries read afterwards.
   */
  release() {
    this.released = true;
    this.entries.clear();
    this.used.clear();
    this.derived.clear();
    this.usedDerived.clear();
  }
  /**
   * Persist the cache; failures leave sources authoritative. With `prune` (default)
   * only entries used in this session are kept, so deleted files leave the cache;
   * partial readers (for example root discovery) keep the other entries.
   */
  async save({ prune = true } = {}) {
    if (!this.file || this.released) return false;
    const pruned =
      prune &&
      ([...this.entries.keys()].some((key) => !this.used.has(key)) ||
        [...this.derived.keys()].some((key) => !this.usedDerived.has(key)));
    if (!this.dirty && !pruned) return false;
    const names = [...(prune ? this.used : this.entries.keys())].filter((key) => this.entries.has(key)).sort();
    const derived = [...(prune ? this.usedDerived : this.derived.keys())].filter((key) => this.derived.has(key)).sort();
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let handle;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      handle = await fs.open(temp, 'wx', 0o600);
      let batch = HEADER + '\n';
      const flush = async (limit) => {
        if (batch.length < limit) return;
        await handle.writeFile(batch);
        batch = '';
      };
      for (const name of names) {
        batch += JSON.stringify([name, this.entries.get(name)]) + '\n';
        await flush(1024 * 1024);
      }
      for (const key of derived)
        for (const part of this.derived.get(key)) {
          batch += DERIVED + key + '\t' + part + '\n';
          await flush(1024 * 1024);
        }
      await flush(0);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, this.file);
      this.dirty = false;
      return true;
    } catch {
      await handle?.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
      return false;
    }
  }
}
