import fs from 'node:fs';
import path from 'node:path';

// File times advance in ticks (Linux coarse clocks, Windows timer ticks, FAT 2 s), so a second same-size write in the
// tick of the first keeps every stat field. As in Git's racy-entry rule, a stat whose modification or change time is
// within this window of now cannot prove that bytes read after it are still current.
const RACY_WINDOW_MS = 2000;
/** True while `stat` (number or bigint fields) is too recent to identify the file's content. */
export const racyStat = (stat, now = Date.now()) =>
  Number(stat.mtimeMs > stat.ctimeMs ? stat.mtimeMs : stat.ctimeMs) > now - RACY_WINDOW_MS;
let racyStamps = 0;
/**
 * The stamp to keep beside content read after `stat`: `value`, or while the stat is racy a value
 * no later stamp equals, so the entry is read again once instead of hiding a same-tick rewrite.
 */
export const recordedStamp = (stat, value) => (racyStat(stat) ? `racy:${++racyStamps}` : value);

const stamp = (stat) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].join(':');

/** Bounded LRU for bytes served locally. Every hit still checks the current file identity. */
export class FileBodyCache {
  constructor({ maxBytes = 32 * 1024 * 1024, maxEntryBytes = 8 * 1024 * 1024, maxEntries = 512 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.bytes = 0;
  }

  #remove(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.body.length;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  invalidate(files) {
    const changed = new Set(files.map((file) => path.resolve(file)));
    for (const [key, entry] of this.entries) if (changed.has(entry.file)) this.#remove(key);
  }

  read(file, variant = '', transform = (body) => body) {
    file = path.resolve(file);
    const key = JSON.stringify([file, variant]);
    // One descriptor supplies the stamp, the bytes and the after-check, so they describe the same file even when the
    // path is replaced meanwhile. Non-blocking: a FIFO in the source tree is refused below instead of waiting for a writer.
    let fd, before;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
      before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile()) throw new Error('Local source is not a regular file');
    } catch (err) {
      if (fd !== undefined) fs.closeSync(fd);
      this.invalidate([file]);
      throw err;
    }
    let body, after;
    const version = stamp(before);
    try {
      const cached = this.entries.get(key);
      if (cached?.stamp === version) {
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.body;
      }
      this.#remove(key);
      body = transform(fs.readFileSync(fd));
      // A write racing this read, or landing in the same file-time tick after it, must not leave a stale cached version.
      after = fs.fstatSync(fd, { bigint: true });
    } finally {
      fs.closeSync(fd);
    }
    if (
      stamp(after) === version &&
      !racyStat(after) &&
      body.length <= this.maxEntryBytes &&
      body.length <= this.maxBytes &&
      this.maxEntries > 0
    ) {
      while (this.entries.size && (this.bytes + body.length > this.maxBytes || this.entries.size >= this.maxEntries))
        this.#remove(this.entries.keys().next().value);
      this.entries.set(key, { file, stamp: version, body });
      this.bytes += body.length;
    }
    return body;
  }
}
