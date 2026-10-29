// Immutable compressed pages; existing published prefixes are
// never edited. Restored files are read-only, so independent runtimes cannot
// race while appending to a shared data file. A prefix descriptor (format 2)
// names the digest of the magic and every page header; each header carries the
// digest of its payload, which every read verifies. Format 1 descriptors name a
// digest of the complete prefix and are verified in full when opened.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openRecordReader } from './record-file-lease.mjs';

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

const readAt = (io, fd, bytes, offset, length, position) =>
  new Promise((resolve, reject) =>
    io.read(fd, bytes, offset, length, position, (error, read) => (error ? reject(error) : resolve(read))),
  );
async function readExactlyAsync(io, fd, size, position) {
  const bytes = Buffer.allocUnsafe(size);
  let done = 0;
  while (done < size) {
    const count = await readAt(io, fd, bytes, done, size - done, position + done);
    if (!count) throw damaged('Published record page prefix is truncated');
    done += count;
  }
  return bytes;
}

async function* prefixChunks(fd, length, io = fs) {
  const bytes = Buffer.allocUnsafe(Math.min(1024 * 1024, length));
  let position = 0;
  while (position < length) {
    const count = await readAt(io, fd, bytes, 0, Math.min(bytes.length, length - position), position);
    if (!count) throw damaged('Published record page prefix is truncated');
    yield bytes.subarray(0, count);
    position += count;
  }
}

/** Page headers in typed columns: a file of millions of pages keeps 53 bytes per page instead of an object and a
 * digest buffer. Index 0 is the unused slot before the first page; at(id) returns a fresh header view. */
class PageInventory {
  constructor() {
    this.length = 1;
    this.grow(1024);
  }
  grow(capacity) {
    const copy = (Type, old, width = 1) => {
      const next = new Type(capacity * width);
      if (old) next.set(old);
      return next;
    };
    this.kinds = copy(Uint8Array, this.kinds);
    this.counts = copy(Uint32Array, this.counts);
    this.offsets = copy(Float64Array, this.offsets);
    this.lengths = copy(Uint32Array, this.lengths);
    this.rawLengths = copy(Uint32Array, this.rawLengths);
    this.digests = copy(Uint8Array, this.digests, 32);
    this.capacity = capacity;
  }
  push({ kind, count, offset, length, rawLength, digest }) {
    if (this.length === this.capacity) this.grow(this.capacity * 2);
    const id = this.length++;
    this.kinds[id] = kind;
    this.counts[id] = count;
    this.offsets[id] = offset;
    this.lengths[id] = length;
    this.rawLengths[id] = rawLength;
    this.digests.set(digest, id * 32);
    return id;
  }
  at(id) {
    if (!Number.isSafeInteger(id) || id < 1 || id >= this.length) return undefined;
    return {
      kind: this.kinds[id],
      count: this.counts[id],
      offset: this.offsets[id],
      length: this.lengths[id],
      rawLength: this.rawLengths[id],
      digest: Buffer.from(this.digests.buffer, this.digests.byteOffset + id * 32, 32),
    };
  }
  *[Symbol.iterator]() {
    yield null;
    for (let id = 1; id < this.length; id++) yield this.at(id);
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
    this.synced = 0;
    this.entries = new PageInventory();
    this.headers = createHash('sha256');
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
      result.headers.update(MAGIC);
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
      const digest = prefix?.format === 1 ? prefix.sha256 : prefix?.format === 2 ? prefix.headers : undefined;
      if (
        !/^[a-f0-9]{64}$/.test(digest ?? '') ||
        !Number.isSafeInteger(prefix.bytes) ||
        prefix.bytes < MAGIC.length ||
        !Number.isSafeInteger(prefix.pages) ||
        prefix.pages < 0 ||
        prefix.bytes > descriptor.bytes
      )
        throw damaged('Invalid record page prefix descriptor');
      const key = prefix.format + ':' + prefix.bytes,
        previous = requested.get(key);
      if (previous && (previous.digest !== digest || previous.pages !== prefix.pages))
        throw damaged('Contradictory record page prefix descriptors');
      requested.set(key, { format: prefix.format, bytes: prefix.bytes, pages: prefix.pages, digest });
    }
    const prefixes = [...requested.values()].sort((a, b) => a.bytes - b.bytes);
    const io = options.io ?? fs;
    const fd = openRecordReader(file);
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (before.size < BigInt(descriptor.bytes)) throw damaged('Published record page prefix is missing');
      const result = new RecordPageFile(file, fd, { ...options, writable: false });
      let position = 0,
        prefixIndex = 0;
      // Every requested prefix ends at a page boundary with its inventory and digest.
      const boundary = (full) => {
        while (prefixIndex < prefixes.length && prefixes[prefixIndex].bytes <= position) {
          const expected = prefixes[prefixIndex++],
            digest = (expected.format === 1 ? full : result.headers)?.copy().digest('hex');
          if (expected.bytes !== position || result.entries.length - 1 !== expected.pages || digest !== expected.digest)
            throw damaged('Record page prefix checksum or inventory mismatch');
        }
      };
      const admit = (header) => {
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
        result.headers.update(header);
        result.entries.push({
          kind,
          count,
          offset: position,
          length,
          rawLength,
          digest: Buffer.from(header.subarray(16)),
        });
        return length;
      };
      if (prefixes.every((prefix) => prefix.format === 2)) {
        // Read the magic and the header chain only.
        if (!(await readExactlyAsync(io, fd, MAGIC.length, 0)).equals(MAGIC))
          throw damaged('Invalid record page file header');
        result.headers.update(MAGIC);
        position = MAGIC.length;
        boundary();
        while (position < descriptor.bytes) {
          if (position + HEADER > descriptor.bytes) throw damaged('Invalid record page bounds');
          const header = await readExactlyAsync(io, fd, HEADER, position);
          position += HEADER;
          position += admit(header);
          boundary();
        }
      } else {
        // Parse headers from the same bytes that advance the prefix hash. A
        // second header-reading pass could admit a changed header after hashing.
        const full = createHash('sha256');
        let magicRead = 0,
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
              if (magicRead === MAGIC.length) result.headers.update(MAGIC);
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
              payloadRemaining = admit(header);
              headerUsed = 0;
              header = Buffer.alloc(HEADER);
            }
          }
        };
        for await (const chunk of prefixChunks(fd, descriptor.bytes, io)) {
          let cursor = 0;
          while (cursor < chunk.length) {
            const length = Math.min(chunk.length - cursor, prefixes[prefixIndex].bytes - position);
            const part = chunk.subarray(cursor, cursor + length);
            full.update(part);
            consume(part);
            cursor += length;
            if (position === prefixes[prefixIndex].bytes) {
              if (magicRead !== MAGIC.length || payloadRemaining || headerUsed)
                throw damaged('Record page prefix checksum or inventory mismatch');
              boundary(full);
            }
          }
        }
        if (magicRead !== MAGIC.length || payloadRemaining || headerUsed)
          throw damaged('Incomplete record page prefix');
      }
      if (position !== descriptor.bytes || prefixIndex !== prefixes.length)
        throw damaged('Incomplete record page prefix');
      if (result.entries.length - 1 !== descriptor.pages) throw damaged('Record page inventory mismatch');
      const after = fs.fstatSync(fd, { bigint: true });
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size < before.size ||
        (after.size === before.size && signature(before) !== signature(after))
      )
        throw damaged('Record page file changed during verification');
      result.bytes = result.synced = descriptor.bytes;
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
    const previousBytes = this.bytes;
    try {
      this.write(header);
      this.write(compressed);
    } catch (error) {
      try {
        this.io.ftruncateSync(this.fd, previousBytes);
      } catch (rollback) {
        this.failure = new AggregateError([error, rollback], 'Record page append and rollback failed');
        throw this.failure;
      }
      this.bytes = previousBytes;
      throw error;
    }
    this.headers.update(header);
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
    const entry = this.entries.at(id);
    if (!entry) throw damaged('Unknown record page');
    return entry;
  }
  read(id, { copy = true } = {}) {
    if (this.closed) throw Error('Record page file is closed');
    if (this.fd === null) {
      const fd = openRecordReader(this.file);
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
    // Several tables published from one writer by one commit sync it once.
    if (this.writable && this.synced !== this.bytes) {
      this.io.fsyncSync(this.fd);
      this.synced = this.bytes;
    }
    return Object.freeze({
      format: 2,
      bytes: this.bytes,
      pages: this.entries.length - 1,
      headers: this.headers.copy().digest('hex'),
    });
  }
  /** End appends: the pages become durable and the file reopens on demand like a reader. */
  seal() {
    this.descriptor();
    this.writable = false;
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
