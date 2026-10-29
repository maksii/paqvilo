// Immutable compressed pages; existing published prefixes are
// never edited. Restored files are read-only, so independent runtimes cannot
// race while appending to a shared data file.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const MAGIC = Buffer.from('PAQVILO-RECORD-PAGES-1\n');
const HEADER = 48;
const MAX_BYTES = 512 * 1024 * 1024;
const validCount = (kind, count) => Number.isSafeInteger(count) && count > 0 && count <= (kind === 1 ? 512 : 4096);
const signature = (info) => [info.dev, info.ino, info.size, info.mtimeNs].join(':');
const damaged = (message) => Object.assign(Error(message), { code: 'StateIntegrity' });
const hashOf = (bytes) => createHash('sha256').update(bytes).digest();

function readExactly(fd, size, position) {
  const bytes = Buffer.allocUnsafe(size);
  let done = 0;
  while (done < size) {
    const count = fs.readSync(fd, bytes, done, size - done, position + done);
    if (!count) throw damaged('Record page file is truncated');
    done += count;
  }
  return bytes;
}

async function* prefixChunks(fd, length, io = fs) {
  const bytes = Buffer.allocUnsafe(Math.min(1024 * 1024, length));
  let position = 0;
  while (position < length) {
    const count = await new Promise((resolve, reject) =>
      io.read(fd, bytes, 0, Math.min(bytes.length, length - position), position, (error, read) =>
        error ? reject(error) : resolve(read),
      ),
    );
    if (!count) throw damaged('Published record page prefix is truncated');
    yield bytes.subarray(0, count);
    position += count;
  }
}

export class RecordPageFile {
  constructor(file, fd, { writable = false, cacheBytes = 4 * 1024 * 1024, io = fs } = {}) {
    if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw TypeError('Invalid record page cache budget');
    this.file = file;
    this.fd = fd;
    const info = fs.fstatSync(fd, { bigint: true });
    this.identity = [info.dev, info.ino].join(':');
    this.closed = false;
    this.writable = writable;
    this.io = io;
    this.bytes = 0;
    this.entries = [null];
    this.hash = createHash('sha256');
    this.cache = new Map();
    this.cacheLimit = cacheBytes;
    this.cacheSize = 0;
    this.hits = 0;
    this.misses = 0;
  }
  static create(file, options = {}) {
    // wx never overwrites or follows an existing file/symlink.
    const fd = fs.openSync(file, 'wx+', 0o600);
    let result;
    try {
      result = new RecordPageFile(file, fd, { ...options, writable: true });
      result.write(MAGIC);
      result.hash.update(MAGIC);
      return result;
    } catch (error) {
      fs.closeSync(fd);
      fs.unlinkSync(file);
      throw error;
    }
  }
  static async open(file, descriptor, options = {}) {
    const requested = new Map();
    for (const prefix of [descriptor, ...(options.prefixes ?? [])]) {
      if (
        prefix?.format !== 1 ||
        !Number.isSafeInteger(prefix.bytes) ||
        prefix.bytes < MAGIC.length ||
        !Number.isSafeInteger(prefix.pages) ||
        prefix.pages < 0 ||
        !/^[a-f0-9]{64}$/.test(prefix.sha256 ?? '') ||
        prefix.bytes > descriptor.bytes
      )
        throw damaged('Invalid record page prefix descriptor');
      const previous = requested.get(prefix.bytes);
      if (previous && (previous.sha256 !== prefix.sha256 || previous.pages !== prefix.pages))
        throw damaged('Contradictory record page prefix descriptors');
      requested.set(prefix.bytes, prefix);
    }
    const prefixes = [...requested.values()].sort((a, b) => a.bytes - b.bytes);
    if (fs.lstatSync(file).isSymbolicLink()) throw damaged('Record page files cannot be symlinks');
    const fd = fs.openSync(file, 'r');
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (before.size < BigInt(descriptor.bytes)) throw damaged('Published record page prefix is missing');
      const result = new RecordPageFile(file, fd, { ...options, writable: false });
      // Parse headers from the same bytes that advance the prefix hash. A
      // second header-reading pass could admit a changed header after hashing.
      let position = 0,
        magicRead = 0,
        headerUsed = 0,
        payloadRemaining = 0;
      let header = Buffer.alloc(HEADER);
      const consume = (chunk) => {
        let cursor = 0;
        while (cursor < chunk.length) {
          if (magicRead < MAGIC.length) {
            const length = Math.min(MAGIC.length - magicRead, chunk.length - cursor);
            if (!chunk.subarray(cursor, cursor + length).equals(MAGIC.subarray(magicRead, magicRead + length)))
              throw damaged('Invalid record page file header');
            magicRead += length;
            cursor += length;
            position += length;
          } else if (payloadRemaining) {
            const length = Math.min(payloadRemaining, chunk.length - cursor);
            payloadRemaining -= length;
            cursor += length;
            position += length;
          } else {
            const copied = Math.min(HEADER - headerUsed, chunk.length - cursor);
            chunk.copy(header, headerUsed, cursor, cursor + copied);
            headerUsed += copied;
            cursor += copied;
            position += copied;
            if (headerUsed !== HEADER) continue;
            const kind = header.readUInt32LE(0),
              count = header.readUInt32LE(4),
              rawLength = header.readUInt32LE(8),
              length = header.readUInt32LE(12);
            if (
              ![1, 2, 3, 4, 5].includes(kind) ||
              !validCount(kind, count) ||
              !rawLength ||
              rawLength > MAX_BYTES ||
              !length ||
              length > MAX_BYTES ||
              position + length > descriptor.bytes
            )
              throw damaged('Invalid record page bounds');
            if ([2, 3].includes(kind) && rawLength !== count * (kind === 2 ? 4 : 8))
              throw damaged('Invalid record index page size');
            result.entries.push({
              kind,
              count,
              offset: position,
              length,
              rawLength,
              digest: Buffer.from(header.subarray(16)),
            });
            payloadRemaining = length;
            headerUsed = 0;
            header = Buffer.alloc(HEADER);
          }
        }
      };
      let prefixIndex = 0;
      for await (const chunk of prefixChunks(fd, descriptor.bytes, options.io ?? fs)) {
        let cursor = 0;
        while (cursor < chunk.length) {
          const expected = prefixes[prefixIndex];
          const length = Math.min(chunk.length - cursor, expected.bytes - position);
          const part = chunk.subarray(cursor, cursor + length);
          result.hash.update(part);
          consume(part);
          cursor += length;
          if (position === expected.bytes) {
            if (
              magicRead !== MAGIC.length ||
              payloadRemaining ||
              headerUsed ||
              result.entries.length - 1 !== expected.pages ||
              result.hash.copy().digest('hex') !== expected.sha256
            )
              throw damaged('Record page prefix checksum or inventory mismatch');
            prefixIndex++;
          }
        }
      }
      if (position !== descriptor.bytes || magicRead !== MAGIC.length || payloadRemaining || headerUsed)
        throw damaged('Incomplete record page prefix');
      if (result.hash.copy().digest('hex') !== descriptor.sha256) throw damaged('Record page prefix checksum mismatch');
      if (result.entries.length - 1 !== descriptor.pages) throw damaged('Record page inventory mismatch');
      const after = fs.fstatSync(fd, { bigint: true });
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size < before.size ||
        (after.size === before.size && signature(before) !== signature(after))
      )
        throw damaged('Record page file changed during verification');
      result.bytes = descriptor.bytes;
      return result;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  write(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const count = this.io.writeSync(this.fd, bytes, offset, bytes.length - offset, this.bytes);
      if (!count) throw Error('Record page write made no progress');
      offset += count;
      this.bytes += count;
    }
  }
  append(kind, raw, count) {
    if (this.failure) throw this.failure;
    if (this.fd === null || !this.writable) throw Error('Record page file is not writable');
    if (
      !Buffer.isBuffer(raw) ||
      ![1, 2, 3, 4, 5].includes(kind) ||
      !validCount(kind, count) ||
      !raw.length ||
      raw.length > MAX_BYTES ||
      ([2, 3].includes(kind) && raw.length !== count * (kind === 2 ? 4 : 8))
    )
      throw TypeError('Invalid record page');
    const compressed = gzipSync(raw, { level: 1 });
    if (compressed.length > MAX_BYTES) throw RangeError('Compressed record page exceeds its bound');
    const digest = hashOf(compressed),
      header = Buffer.alloc(HEADER);
    header.writeUInt32LE(kind, 0);
    header.writeUInt32LE(count, 4);
    header.writeUInt32LE(raw.length, 8);
    header.writeUInt32LE(compressed.length, 12);
    digest.copy(header, 16);
    const previousBytes = this.bytes,
      previousHash = this.hash.copy();
    try {
      this.write(header);
      this.write(compressed);
      this.hash.update(header).update(compressed);
    } catch (error) {
      try {
        this.io.ftruncateSync(this.fd, previousBytes);
      } catch (rollback) {
        this.failure = new AggregateError([error, rollback], 'Record page append and rollback failed');
        throw this.failure;
      }
      this.bytes = previousBytes;
      this.hash = previousHash;
      throw error;
    }
    this.entries.push({
      kind,
      count,
      offset: previousBytes + HEADER,
      length: compressed.length,
      rawLength: raw.length,
      digest,
    });
    return this.entries.length - 1;
  }
  page(id) {
    if (!Number.isSafeInteger(id) || id < 1 || !this.entries[id]) throw damaged('Unknown record page');
    return this.entries[id];
  }
  read(id, { copy = true } = {}) {
    if (this.closed) throw Error('Record page file is closed');
    if (this.fd === null) {
      if (fs.lstatSync(this.file).isSymbolicLink()) throw damaged('Record page files cannot be symlinks');
      const fd = fs.openSync(this.file, 'r');
      try {
        const info = fs.fstatSync(fd, { bigint: true });
        if ([info.dev, info.ino].join(':') !== this.identity || info.size < BigInt(this.bytes))
          throw damaged('Published record file was replaced or truncated');
        this.fd = fd;
      } catch (error) {
        fs.closeSync(fd);
        throw error;
      }
    }
    const entry = this.page(id);
    let raw = this.cache.get(id);
    if (raw) {
      this.hits++;
      this.cache.delete(id);
      this.cache.set(id, raw);
    } else {
      this.misses++;
      const compressed = readExactly(this.fd, entry.length, entry.offset);
      if (!hashOf(compressed).equals(entry.digest)) throw damaged('Record page checksum mismatch');
      try {
        raw = gunzipSync(compressed, { maxOutputLength: entry.rawLength });
      } catch (cause) {
        throw Object.assign(damaged('Invalid compressed record page'), { cause });
      }
      if (raw.length !== entry.rawLength) throw damaged('Record page length mismatch');
      if (raw.length <= this.cacheLimit) {
        while (this.cacheSize + raw.length > this.cacheLimit) {
          const oldest = this.cache.keys().next().value;
          this.cacheSize -= this.cache.get(oldest).length;
          this.cache.delete(oldest);
        }
        this.cache.set(id, raw);
        this.cacheSize += raw.length;
      }
    }
    // Decoders own their bytes. Mutating a returned buffer cannot alter cached
    // content or turn a later checksum-verified read into silently changed data.
    return copy ? Buffer.from(raw) : raw;
  }
  descriptor() {
    if (this.failure) throw this.failure;
    if (this.closed) throw Error('Record page file is closed');
    if (this.writable) this.io.fsyncSync(this.fd);
    return Object.freeze({
      format: 1,
      bytes: this.bytes,
      pages: this.entries.length - 1,
      sha256: this.hash.copy().digest('hex'),
    });
  }
  cacheInfo() {
    return { bytes: this.cacheSize, entries: this.cache.size, hits: this.hits, misses: this.misses };
  }
  suspend() {
    if (this.writable) throw Error('Cannot suspend the owned record writer');
    if (this.fd !== null) this.io.closeSync(this.fd);
    this.fd = null;
  }
  close() {
    if (this.closed) return;
    if (this.fd !== null) {
      let info;
      try {
        info = fs.fstatSync(this.fd, { bigint: true });
      } catch (error) {
        if (error.code !== 'EBADF') throw error;
      }
      // A prior uncertain close must never close an unrelated reused descriptor.
      if (info && [info.dev, info.ino].join(':') === this.identity) this.io.closeSync(this.fd);
    }
    this.fd = null;
    this.closed = true;
    this.cache.clear();
    this.cacheSize = 0;
  }
}
