import fs from 'node:fs';
import path from 'node:path';

const stamp = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].join(':');

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
    let before;
    try {
      before = fs.statSync(file, { bigint: true });
      if (!before.isFile()) throw new Error('Local source is not a regular file');
    } catch (err) {
      this.invalidate([file]);
      throw err;
    }
    const version = stamp(before);
    const cached = this.entries.get(key);
    if (cached?.stamp === version) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.body;
    }
    this.#remove(key);
    const body = transform(fs.readFileSync(file));
    // A write racing this read must not leave a stale cached version behind.
    const after = fs.statSync(file, { bigint: true });
    if (stamp(after) === version && body.length <= this.maxEntryBytes && body.length <= this.maxBytes && this.maxEntries > 0) {
      while (this.entries.size && (this.bytes + body.length > this.maxBytes || this.entries.size >= this.maxEntries)) this.#remove(this.entries.keys().next().value);
      this.entries.set(key, { file, stamp: version, body });
      this.bytes += body.length;
    }
    return body;
  }
}
