import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const FORMAT = 2;

/** Run an async mapper with bounded concurrency while preserving input order. */
export async function mapLimit(items, limit, mapper) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next++;
      results[index] = await mapper(list[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker),
  );
  return results;
}

const DIGEST_SKIP = new Set([".git", ".portalconfig", "node_modules", ".paqvilo"]);
const digestCache = new Map();

/**
 * The same SHA-256 as evidence.mjs `sourceFingerprint(dir)` (relative path, NUL, bytes,
 * NUL for every file in sorted depth-first order; symlinks and .git/.portalconfig/
 * node_modules/.paqvilo skipped), with directories and files read concurrently. The
 * digest is recomputed only when a file's size, mtime, ctime or identity changed.
 */
export async function sourceDirectoryDigest(dir) {
  const root = path.resolve(dir);
  const children = new Map();
  let level = [root];
  while (level.length) {
    const next = [];
    await mapLimit(level, 32, async (current) => {
      const entries = (await fs.readdir(current, { withFileTypes: true }))
        .filter((entry) => !entry.isSymbolicLink() && !DIGEST_SKIP.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      children.set(current, entries);
      for (const entry of entries) if (entry.isDirectory()) next.push(path.join(current, entry.name));
    });
    level = next;
  }
  const files = [];
  const flatten = (current) => {
    for (const entry of children.get(current) ?? []) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) flatten(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  flatten(root);
  const stamps = await mapLimit(files, 64, async (file) => {
    const stat = await fs.stat(file, { bigint: true });
    return `${path.relative(root, file)}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0${stat.ino}`;
  });
  const signature = createHash("sha256").update(stamps.join("\n")).digest("hex");
  const cached = digestCache.get(root);
  if (cached?.signature === signature) return cached.digest;
  const hash = createHash("sha256");
  const window = 256;
  for (let start = 0; start < files.length; start += window) {
    const slice = files.slice(start, start + window);
    const contents = await mapLimit(slice, 32, (file) => fs.readFile(file));
    slice.forEach((file, index) => {
      hash.update(path.relative(root, file).replaceAll("\\", "/"));
      hash.update("\0");
      hash.update(contents[index]);
      hash.update("\0");
    });
  }
  const digest = hash.digest("hex");
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

/** File identity used to reuse parsed results: size, modification/change time and inode. */
export async function fileStamp(file) {
  const stat = await fs.stat(file, { bigint: true });
  return {
    stamp: `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`,
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
    this.file = file ? path.resolve(file) : null;
    this.entries = new Map();
    this.used = new Set();
    this.dirty = false;
    this.stats = { hits: 0, misses: 0 };
    // Hits served from another cache of this process (shareSolutionParses).
    this.processHits = 0;
  }
  static async open(file) {
    const cache = new SolutionFileCache(file);
    if (!cache.file) return cache;
    try {
      const raw = JSON.parse(await fs.readFile(cache.file, "utf8"));
      if (raw?.format === FORMAT && raw.entries && typeof raw.entries === "object")
        for (const [name, entry] of Object.entries(raw.entries))
          if (entry && typeof entry.stamp === "string" && entry.results)
            cache.entries.set(name, entry);
    } catch {
      // A missing or unreadable cache is rebuilt from sources.
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
      if (processEntries && (shared?.stamp !== stamp || !Object.hasOwn(shared.results, parserId))) shareEntry(file, entry, parserId);
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
    const hash = createHash("sha256").update(bytes).digest("hex");
    const value = await parser(binary ? bytes : bytes.toString("utf8"), file);
    const next =
      entry?.stamp === stamp && entry.hash === hash
        ? { ...entry, results: { ...entry.results, [parserId]: value } }
        : { stamp, hash, results: { [parserId]: value } };
    this.entries.set(file, next);
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
      hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
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
    hash ??= createHash("sha256").update(await fs.readFile(file)).digest("hex");
    const results = entry && entry.hash === hash ? { ...entry.results } : {};
    results[resultId] = { key, value };
    this.entries.set(file, { stamp, hash, results });
    this.dirty = true;
    return value;
  }
  /**
   * Persist the cache; failures leave sources authoritative. With `prune` (default)
   * only entries used in this session are kept, so deleted files leave the cache;
   * partial readers (for example root discovery) keep the other entries.
   */
  async save({ prune = true } = {}) {
    if (!this.file) return false;
    const pruned = prune && [...this.entries.keys()].some((key) => !this.used.has(key));
    if (!this.dirty && !pruned) return false;
    const entries = {};
    for (const key of [...(prune ? this.used : this.entries.keys())].sort())
      if (this.entries.has(key)) entries[key] = this.entries.get(key);
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ format: FORMAT, entries }));
      await fs.rename(temp, this.file);
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }
}
