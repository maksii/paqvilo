// JSON record pages, bounded read caches and copy-on-write table positions.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { types } from 'node:util';
import { RecordPageFile } from './record-page-file.mjs';
import { PersistentKeyTree } from './record-key-index.mjs';
import { KeySorter } from './record-key-sort.mjs';
import { RecordFileLease, claimRecordDirectory, earlierStateOwner, stateRecordOwner } from './record-file-lease.mjs';
import { setImmediate } from 'node:timers/promises';

const FILE = 4294967296,
  SLOTS = 512,
  CHUNK = 4096;
// A record page closes at 64 KiB, so a cold single-row read verifies, inflates
// and parses at most that much. Larger pages written earlier remain readable.
const PAGE_BYTES = 64 * 1024;
const MAX_PAGE = FILE / SLOTS - 1;
// Key-tree pages written while a record page is open wait behind it, within this bound.
const STAGED_BYTES = 4 * 1024 * 1024;
const rowStates = new WeakMap(),
  tables = new WeakMap();
// True while any paged table may be alive; it clears after every table is collected.
export let recordTablesCreated = false;
let liveTables = 0;
const liveTableRegistry = new FinalizationRegistry(() => {
  if (--liveTables === 0) recordTablesCreated = false;
});
const normalizeKey = (value) =>
  value
    .replace(
      /^(?:\{([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\}|\(([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\))$/i,
      (_match, braced, parenthesized) => braced ?? parenthesized,
    )
    .toLowerCase();
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
const cleanupRows = new FinalizationRegistry((token) => {
  const owner = token.owner.deref();
  if (owner?.rows.get(token.id) === token.ref) owner.rows.delete(token.id);
});
const cleanupTables = new FinalizationRegistry((token) => token.session.deref()?.backends.delete(token.ref));
const indexOf = (key) => {
  if (typeof key !== 'string') return -1;
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === key ? n : -1;
};
const rawOf = (value) => rowStates.get(value)?.raw ?? value;
const restoreProperties = (target, before) => {
  for (const key of Reflect.ownKeys(target)) if (!Object.hasOwn(before, key)) Reflect.deleteProperty(target, key);
  for (const key of Reflect.ownKeys(before)) if (key !== 'length') Reflect.defineProperty(target, key, before[key]);
  if (Object.hasOwn(before, 'length')) Reflect.defineProperty(target, 'length', before.length);
};
const locator = (file, page, slot = 0) => {
  const value = file * FILE + page * SLOTS + slot;
  if (!Number.isSafeInteger(value) || page > MAX_PAGE) throw RangeError('Record locator exceeds its supported range');
  return value;
};
const partsOf = (value) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid record locator');
  const file = Math.floor(value / FILE),
    within = value % FILE;
  return { file, page: Math.floor(within / SLOTS), slot: within % SLOTS };
};
const fileOf = (id) => Math.floor(id / FILE);
const bufferOf = (ids) => {
  if (endianness() === 'LE') return Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength);
  const wide = ids instanceof Float64Array,
    bytes = Buffer.allocUnsafe(ids.length * (wide ? 8 : 4));
  for (let i = 0; i < ids.length; i++) wide ? bytes.writeDoubleLE(ids[i], i * 8) : bytes.writeUInt32LE(ids[i], i * 4);
  return bytes;
};
const integer = (value) => {
  const n = +value;
  return Number.isNaN(n) ? 0 : Math.trunc(n);
};
// A relative array position clamped to [0, length], as the Array methods resolve it.
const relative = (value, length, fallback) => {
  if (value === undefined) return fallback;
  const n = integer(value);
  return n < 0 ? Math.max(length + n, 0) : Math.min(n, length);
};

// Top-level values as JSON.stringify wrote them: read directly from plain data
// properties, and from the stored text otherwise (accessors, toJSON, objects).
const unread = Symbol('unread');
const plainField = (raw, name) => {
  const descriptor = Object.getOwnPropertyDescriptor(raw, name);
  if (!descriptor || !descriptor.enumerable) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) return unread;
  const value = descriptor.value;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  return unread;
};
function storedFields(raw, text, keyColumn) {
  if (raw && typeof raw === 'object' && !types.isProxy(raw) && !('toJSON' in raw)) {
    const key = keyColumn === undefined ? undefined : plainField(raw, keyColumn),
      version = plainField(raw, 'versionnumber');
    if (key !== unread && version !== unread) return { key, version };
  }
  const record = JSON.parse(typeof text === 'string' ? text : text.toString('utf8'));
  return { key: keyColumn === undefined ? undefined : record[keyColumn], version: record.versionnumber };
}

export class RecordPageSession {
  constructor(
    directory,
    {
      decodedBytes = 16 * 1024 * 1024,
      materializedRows = 4096,
      materializedBytes = 32 * 1024 * 1024,
      rawBytes = 32 * 1024 * 1024,
      keyBytes = 32 * 1024 * 1024,
      maxOpenFiles = 32,
      pagesPerFile = MAX_PAGE,
      stateOwner,
      ownerKey,
      adoptOwner = false,
    } = {},
  ) {
    if (
      !Number.isSafeInteger(decodedBytes) ||
      decodedBytes < 0 ||
      !Number.isSafeInteger(materializedRows) ||
      materializedRows < 0
    )
      throw TypeError('Invalid record cache budgets');
    if (!Number.isSafeInteger(materializedBytes) || materializedBytes < 0)
      throw TypeError('Invalid materialized record cache budget');
    if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) throw TypeError('Invalid raw record cache budget');
    if (!Number.isSafeInteger(keyBytes) || keyBytes < 0) throw TypeError('Invalid key-node cache budget');
    if (!Number.isInteger(maxOpenFiles) || maxOpenFiles < 1 || maxOpenFiles > 256)
      throw TypeError('Invalid record file handle budget');
    if (!Number.isInteger(pagesPerFile) || pagesPerFile < 1 || pagesPerFile > MAX_PAGE)
      throw TypeError('Invalid record file page budget');
    fs.mkdirSync(directory, { recursive: true });
    this.directory = fs.realpathSync.native(directory);
    const claim = claimRecordDirectory(this.directory, {
      ownerKey,
      adopt: adoptOwner,
      ...(stateOwner ? { location: stateRecordOwner(stateOwner), earlierLocation: earlierStateOwner(stateOwner) } : {}),
    });
    this.ownerKey = claim.key;
    this.ownedDirectory = claim.owned;
    // Why nothing in this directory may be collected, when it is not owned.
    this.ownership = claim.owned ? 'owned' : claim.reason;
    this.lease = new RecordFileLease(this.directory);
    this.closed = false;
    this.backends = new Set();
    this.files = [];
    this.writerIndex = null;
    this.pageLimit = pagesPerFile;
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingPage = 0;
    this.staged = [];
    this.stagedBytes = 0;
    this.stagedNodes = new Map();
    this.decoded = new Map();
    this.decodedSize = 0;
    this.decodedLimit = decodedBytes;
    this.materialized = new Map();
    this.rowLimit = materializedRows;
    this.rowByteLimit = materializedBytes;
    this.rowBytes = 0;
    this.rawPages = new Map();
    this.rawSize = 0;
    this.rawLimit = rawBytes;
    // Internal key nodes are retained in preference to leaves within one budget.
    this.keyLeaves = new Map();
    this.keyBranches = new Map();
    this.keyBytes = 0;
    this.keyLimit = keyBytes;
    this.openReaders = new Map();
    this.maxOpenFiles = maxOpenFiles;
    this.keyStore = {
      read: (id) => this.readKeyNode(id),
      write: (node) => this.putKeyNode(node),
      fileOf: (id) => partsOf(id).file,
    };
  }
  writer() {
    if (this.closed) throw Error('Record page session is closed');
    if (this.writerIndex === null) {
      while (this.openReaders.size >= this.maxOpenFiles) {
        const oldest = this.openReaders.keys().next().value;
        oldest.suspend();
        this.openReaders.delete(oldest);
      }
      const name = randomUUID() + '.pages';
      this.lease.protect([name]);
      const store = RecordPageFile.create(path.join(this.directory, name), { cacheBytes: 0 });
      this.writerIndex = this.files.length;
      this.files.push({ name, store });
    }
    return this.files[this.writerIndex].store;
  }
  /** Start a new writer file before the next page number leaves the locator range. */
  reserve() {
    const store = this.writer();
    if (store.entries.length + (this.pending.length ? 1 : 0) + this.staged.length <= this.pageLimit) return;
    this.flushRecords();
    store.seal();
    this.openReaders.set(store, true);
    this.writerIndex = null;
    this.writer();
  }
  put(row, { metadata = false } = {}) {
    row = rawOf(row);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw TypeError('A streamed record must be an object');
    // Persist typed numeric markers, matching ordinary simulator state. The
    // public wire encoder, not storage, converts them to exact JSON numbers.
    const text = JSON.stringify(row);
    if (text?.[0] !== '{' || text.at(-1) !== '}') throw TypeError('A streamed record must encode as a JSON object');
    return this.putText(text, metadata);
  }
  /** Store one record's JSON text (a string, or bytes copied from another page). */
  putText(text, metadata = false) {
    const length = typeof text === 'string' ? Buffer.byteLength(text) : text.length;
    if (this.pending.length && this.pendingBytes + length + 4 > PAGE_BYTES) this.flushRecords();
    if (!this.pending.length) {
      this.reserve();
      this.pendingPage = this.writer().entries.length;
    }
    const id = locator(this.writerIndex, this.pendingPage, this.pending.length);
    this.pending.push(text);
    this.pendingBytes += length + 4;
    if (this.pending.length === SLOTS) this.flushRecords();
    return metadata ? { id, text, bytes: (length + 1) * 3 + 2048 } : id;
  }
  flushRecords() {
    if (this.pending.length) {
      const values = this.pending.map((text) => (typeof text === 'string' ? Buffer.from(text) : text));
      const header = Buffer.allocUnsafe(values.length * 4);
      values.forEach((value, i) => header.writeUInt32LE(value.length, i * 4));
      if (this.writer().append(1, Buffer.concat([header, ...values]), values.length) !== this.pendingPage)
        throw Error('Record page numbering changed');
      this.pending = [];
      this.pendingBytes = 0;
    }
    let written = 0;
    try {
      for (const node of this.staged) {
        if (this.writer().append(node.kind, node.bytes, node.count) !== node.page)
          throw Error('Key page numbering changed');
        written++;
        this.stagedBytes -= node.bytes.length;
        this.stagedNodes.delete(node.id);
        this.cacheKeyNode(node.id, node.node, node.bytes.length * 3 + 1024, node.kind === 5);
      }
    } finally {
      this.staged.splice(0, written);
    }
  }
  putIndex(ids) {
    this.flushRecords();
    this.reserve();
    const writer = this.writer();
    return locator(this.writerIndex, writer.append(ids instanceof Float64Array ? 3 : 2, bufferOf(ids), ids.length));
  }
  readIndex(id) {
    const p = partsOf(id),
      store = this.files[p.file]?.store,
      entry = store?.page(p.page);
    if (!entry || p.slot || ![2, 3].includes(entry.kind)) throw Error('Invalid ordinal index page');
    const bytes = this.readBytes(p),
      ids = entry.kind === 2 ? new Uint32Array(entry.count) : new Float64Array(entry.count);
    for (let i = 0; i < ids.length; i++)
      ids[i] = entry.kind === 2 ? bytes.readUInt32LE(i * 4) : bytes.readDoubleLE(i * 8);
    return ids;
  }
  putKeyNode(node) {
    const kind = node.leaf ? 4 : 5,
      count = (node.leaf ? node.pairs : node.children).length,
      bytes = Buffer.from(JSON.stringify(node));
    if (
      this.pending.length &&
      (this.pendingPage + this.staged.length + 1 > this.pageLimit || this.stagedBytes + bytes.length > STAGED_BYTES)
    )
      this.flushRecords();
    if (!this.pending.length) {
      this.reserve();
      return locator(this.writerIndex, this.writer().append(kind, bytes, count));
    }
    // The open record page keeps its number; this node takes the next free one
    // and is written after it, so record pages fill instead of closing per node.
    const page = this.pendingPage + 1 + this.staged.length,
      id = locator(this.writerIndex, page);
    this.staged.push({ id, page, kind, bytes, count, node });
    this.stagedBytes += bytes.length;
    this.stagedNodes.set(id, node);
    return id;
  }
  keyStoreWithin(allowed) {
    const limits = new Map(allowed);
    return {
      read: (id) => {
        const p = partsOf(id);
        if (!limits.has(p.file) || p.page > limits.get(p.file)) throw Error('Unlisted key index child');
        return this.readKeyNode(id);
      },
      write: (node) => {
        const id = this.putKeyNode(node),
          p = partsOf(id);
        limits.set(p.file, Math.max(limits.get(p.file) ?? 0, p.page));
        return id;
      },
      fileOf: (id) => partsOf(id).file,
    };
  }
  cacheKeyNode(id, node, size, branch) {
    if (size > this.keyLimit) return;
    (branch ? this.keyBranches : this.keyLeaves).set(id, { node, size });
    this.keyBytes += size;
    while (this.keyBytes > this.keyLimit) {
      const from = this.keyLeaves.size ? this.keyLeaves : this.keyBranches,
        oldest = from.keys().next().value;
      this.keyBytes -= from.get(oldest).size;
      from.delete(oldest);
    }
  }
  readKeyNode(id) {
    const staged = this.stagedNodes.get(id);
    if (staged) return staged;
    for (const cache of [this.keyBranches, this.keyLeaves]) {
      const cached = cache.get(id);
      if (cached) {
        cache.delete(id);
        cache.set(id, cached);
        return cached.node;
      }
    }
    const p = partsOf(id),
      entry = this.files[p.file]?.store.page(p.page);
    if (p.slot || !entry || ![4, 5].includes(entry.kind)) throw Error('Invalid key index page');
    const bytes = this.readBytes(p),
      node = JSON.parse(bytes.toString('utf8'));
    if (Boolean(node.leaf) !== (entry.kind === 4) || (node.leaf ? node.pairs : node.children)?.length !== entry.count)
      throw Error('Invalid key index node');
    this.cacheKeyNode(id, node, bytes.length * 3 + 1024, entry.kind === 5);
    return node;
  }
  readBytes(p) {
    const key = p.file + '/' + p.page;
    let bytes = this.rawPages.get(key);
    if (bytes) {
      this.rawPages.delete(key);
      this.rawPages.set(key, bytes);
      return bytes;
    }
    const store = this.files[p.file].store;
    if (!store.writable) {
      this.openReaders.delete(store);
      this.openReaders.set(store, true);
      // The writer occupies one slot when active. Readers reopen by verified
      // file identity and each page still verifies its published checksum.
      const limit = Math.max(0, this.maxOpenFiles - Number(this.writerIndex !== null));
      while (this.openReaders.size > Math.max(1, limit)) {
        const oldest = this.openReaders.keys().next().value;
        oldest.suspend();
        this.openReaders.delete(oldest);
      }
    }
    bytes = store.read(p.page, { copy: false });
    if (!store.writable && this.maxOpenFiles === 1 && this.writerIndex !== null) {
      store.suspend();
      this.openReaders.delete(store);
    }
    if (bytes.length <= this.rawLimit) {
      while (this.rawSize + bytes.length > this.rawLimit) {
        const oldest = this.rawPages.keys().next().value;
        this.rawSize -= this.rawPages.get(oldest).length;
        this.rawPages.delete(oldest);
      }
      this.rawPages.set(key, bytes);
      this.rawSize += bytes.length;
    }
    return bytes;
  }
  /** One record's stored JSON: a string, or with `bytes` a Buffer view of its page. */
  recordText(id, { bytes: asBytes = false } = {}) {
    const p = partsOf(id),
      store = this.files[p.file]?.store;
    if (this.pending.length && p.file === this.writerIndex && p.page === this.pendingPage) {
      if (p.slot >= this.pending.length) throw Error('Invalid stored record locator');
      const text = this.pending[p.slot];
      return asBytes === (typeof text !== 'string') ? text : asBytes ? Buffer.from(text) : text.toString('utf8');
    }
    const entry = store?.page(p.page);
    if (!entry || entry.kind !== 1 || p.slot >= entry.count) throw Error('Invalid stored record locator');
    const key = p.file + '/' + p.page;
    let raw;
    let decoded = this.decoded.get(key);
    if (decoded) {
      this.decoded.delete(key);
      this.decoded.set(key, decoded);
    } else {
      const bytes = (raw = this.readBytes(p)),
        offsets = new Uint32Array(entry.count + 1);
      let offset = entry.count * 4;
      if (bytes.length < offset) throw Error('Invalid stored record directory');
      for (let i = 0; i < entry.count; i++) {
        offsets[i] = offset;
        offset += bytes.readUInt32LE(i * 4);
        if (offset > bytes.length) throw Error('Invalid stored record bounds');
      }
      offsets[entry.count] = offset;
      if (offset !== bytes.length) throw Error('Invalid stored record page length');
      decoded = { offsets, bytes: offsets.byteLength };
      if (decoded.bytes <= this.decodedLimit) {
        while (this.decodedSize + decoded.bytes > this.decodedLimit) {
          const oldest = this.decoded.keys().next().value;
          this.decodedSize -= this.decoded.get(oldest).bytes;
          this.decoded.delete(oldest);
        }
        this.decoded.set(key, decoded);
        this.decodedSize += decoded.bytes;
      }
    }
    raw ??= this.readBytes(p);
    const start = decoded.offsets[p.slot],
      end = decoded.offsets[p.slot + 1];
    return asBytes ? raw.subarray(start, end) : raw.toString('utf8', start, end);
  }
  readRow(id, { metadata = false } = {}) {
    const text = this.recordText(id),
      row = JSON.parse(text);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Invalid stored record');
    return metadata ? { row, bytes: Buffer.byteLength(text) * 3 + 2048 } : row;
  }
  retain(state) {
    this.rowBytes -= this.materialized.get(state) ?? 0;
    this.materialized.delete(state);
    const bytes = state.cacheBytes;
    if (bytes > this.rowByteLimit) return;
    this.materialized.set(state, bytes);
    this.rowBytes += bytes;
    while (this.materialized.size > this.rowLimit || this.rowBytes > this.rowByteLimit) {
      const oldest = this.materialized.keys().next().value;
      this.rowBytes -= this.materialized.get(oldest);
      this.materialized.delete(oldest);
    }
  }
  release(state) {
    this.rowBytes -= this.materialized.get(state) ?? 0;
    this.materialized.delete(state);
  }
  from(rows, { primaryKey, sortOptions } = {}) {
    const table = new PagedRecords(this);
    let sorter = typeof primaryKey === 'string' ? new KeySorter(this.directory, sortOptions) : null;
    let ids = [];
    try {
      for (const row of rows) {
        const raw = rawOf(row),
          stored = this.put(raw, { metadata: true }),
          fields = storedFields(raw, stored.text, sorter ? primaryKey : undefined);
        table.retainVersion(fields.version);
        if (sorter) {
          if (typeof fields.key !== 'string') {
            sorter.close();
            sorter = null;
          } else {
            table.noteKeyShape(fields.key);
            sorter.add([normalizeKey(fields.key), stored.id]);
          }
        }
        ids.push(stored.id);
        if (ids.length === CHUNK) {
          table.appendIds(ids);
          ids = [];
        }
      }
      if (ids.length) table.appendIds(ids);
      this.flushRecords();
      table.keyColumn = primaryKey;
      if (sorter) table.keyTree = PersistentKeyTree.fromSorted(this.keyStore, sorter.sorted());
      return table.proxy;
    } finally {
      sorter?.close();
    }
  }
  async copyTable(value) {
    const source = tables.get(value);
    if (!source) throw TypeError('Unknown record table');
    const table = new PagedRecords(this),
      held = new Map(),
      moved = new Map();
    for (const [id, ref] of source.rows) {
      const state = ref.deref();
      if (state) held.set(id, state);
    }
    const sorter = source.keyTree ? new KeySorter(this.directory) : null;
    let yieldedAt = performance.now(),
      operations = 0;
    const yieldWork = async () => {
      if (performance.now() - yieldedAt >= 8) {
        await setImmediate();
        yieldedAt = performance.now();
      }
    };
    // Stored JSON bytes are copied as they are; only a key column is parsed.
    const save = (oldId) => {
      const stored = this.putText(source.session.recordText(oldId, { bytes: true }), true),
        id = stored.id;
      if (held.has(oldId)) moved.set(oldId, id);
      if (sorter) {
        const key = JSON.parse(stored.text.toString('utf8'))[source.keyColumn];
        if (typeof key !== 'string') throw Error('Record key index disagrees with its records');
        table.noteKeyShape(key);
        sorter.add([normalizeKey(key), id]);
      }
      return id;
    };
    try {
      if (!source.aliases) {
        for (const chunk of [...source.chunks]) {
          const ids = new Array(chunk.count);
          for (let i = 0; i < chunk.count; i++) ids[i] = chunk.ids?.[i] ? save(chunk.ids[i]) : 0;
          table.appendIds(ids);
          await yieldWork();
        }
      } else {
        const positions = new KeySorter(this.directory);
        try {
          for (let index = 0; index < source.length; index++) {
            const id = source.id(index);
            if (id) positions.add([String(id).padStart(16, '0'), index + 1]);
            if (++operations % 512 === 0) await yieldWork();
          }
          table.resize(source.length);
          let previous, id;
          for (const [key, position] of positions.sorted()) {
            const oldId = Number(key);
            if (oldId !== previous) {
              id = save(oldId);
              previous = oldId;
            } else table.aliases = true;
            table.setId(position - 1, id, { updateIndex: false, preparedVersion: 0 });
            if (++operations % 512 === 0) await yieldWork();
          }
        } finally {
          positions.close();
        }
      }
      this.flushRecords();
      table.keyColumn = source.keyColumn;
      if (sorter)
        table.keyTree = await PersistentKeyTree.fromSortedAsync(this.keyStore, sorter.sorted(), { yieldWork });
      table.versionHighWatermark = source.maximumVersion();
      // Held removed rows remain valid for subsequent reinsertion after adoption.
      for (const [oldId, state] of held) if (!moved.has(oldId)) moved.set(oldId, this.put(state.raw));
      table.movedRows = moved;
      return table.proxy;
    } finally {
      sorter?.close();
    }
  }
  hasLiveTables() {
    for (const ref of this.backends) {
      const table = ref.deref();
      if (!table) this.backends.delete(ref);
      else if (table.session === this) return true;
    }
    return false;
  }
  describe(value) {
    const table = tables.get(value);
    if (!table || table.session !== this) throw TypeError('Unknown paged record table');
    if (table.description) return table.description;
    this.flushRecords();
    const used = new Set();
    // Only chunks changed since the last description write an ordinal page.
    const chunks = table.chunks.map((chunk) => {
      if (!chunk.ids) return { holes: chunk.count };
      for (const file of filesOf(chunk)) used.add(file);
      chunk.ref ??= this.putIndex(chunk.ids.subarray(0, chunk.count));
      used.add(fileOf(chunk.ref));
      return { ref: chunk.ref, count: chunk.count };
    });
    if (table.keyTree) for (const file of table.keyTree.files) used.add(file);
    const files = [...used]
      .sort((a, b) => a - b)
      .map((index) => {
        const { name, store } = this.files[index];
        return { index, name, prefix: store.descriptor() };
      });
    table.description = {
      format: 'paged-records-1',
      owner: this.ownerKey,
      length: table.length,
      records: table.present,
      aliases: table.aliases,
      chunks,
      files,
      versionHighWatermark: table.maximumVersion(),
      looseBraceKeys: table.looseBraceKeys,
      ...(table.keyTree
        ? { keyIndex: { column: table.keyColumn, root: table.keyTree.root, files: [...table.keyTree.files] } }
        : {}),
    };
    return table.description;
  }
  async restoreMany(descriptors) {
    if (this.files.length) throw Error('Restore requires a fresh record-page session');
    const groups = new Map(),
      names = new Map();
    const checkLength = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 4294967295;
    for (const descriptor of descriptors) {
      if (
        descriptor?.format !== 'paged-records-1' ||
        !checkLength(descriptor.length) ||
        !checkLength(descriptor.records) ||
        descriptor.records > descriptor.length ||
        !Array.isArray(descriptor.files) ||
        !Array.isArray(descriptor.chunks) ||
        descriptor.chunks.length < Math.ceil(descriptor.length / CHUNK) ||
        descriptor.chunks.length > descriptor.length ||
        (descriptor.aliases !== undefined && typeof descriptor.aliases !== 'boolean')
      )
        throw Error('Invalid paged table descriptor');
      if (descriptor.owner !== undefined && descriptor.owner !== this.ownerKey)
        throw Error('Record directory belongs to a different state');
      for (const file of descriptor.files) {
        if (
          !Number.isSafeInteger(file.index) ||
          file.index < 0 ||
          file.index >= 2097152 ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pages$/.test(file.name ?? '')
        )
          throw Error('Invalid owned record file');
        if (names.has(file.index) && names.get(file.index) !== file.name)
          throw Error('Contradictory record file slots');
        names.set(file.index, file.name);
        let group = groups.get(file.name);
        if (!group) groups.set(file.name, (group = { slots: new Set(), prefixes: [] }));
        group.slots.add(file.index);
        group.prefixes.push(file.prefix);
      }
    }
    const opened = [];
    try {
      this.lease.protect(groups.keys());
      for (const [name, group] of groups) {
        const file = path.join(this.directory, name),
          real = fs.realpathSync.native(file);
        if (path.dirname(real) !== this.directory) throw Error('Record file escapes its owned directory');
        const prefixes = group.prefixes;
        if (prefixes.some((prefix) => !prefix || !Number.isSafeInteger(prefix.bytes)))
          throw Error('Invalid record file prefix');
        const latest = prefixes.reduce((max, prefix) => (prefix.bytes > max.bytes ? prefix : max));
        const store = await RecordPageFile.open(file, latest, { prefixes, cacheBytes: 0 });
        store.suspend();
        opened.push(store);
        for (const index of group.slots) this.files[index] = { name, store };
      }
      const restored = [];
      for (const descriptor of descriptors) {
        const table = new PagedRecords(this),
          allowed = new Map(descriptor.files.map((file) => [file.index, file.prefix]));
        if (allowed.size !== descriptor.files.length) throw Error('Duplicate record file slot');
        let previous = 0,
          ascending = true,
          length = 0;
        for (const chunk of descriptor.chunks) {
          const count = chunk?.holes ?? chunk?.count;
          if (!Number.isSafeInteger(count) || count < 1 || count > CHUNK) throw Error('Invalid ordinal chunk size');
          length += count;
          if (chunk.holes !== undefined) {
            if (chunk.ref !== undefined) throw Error('Invalid sparse ordinal chunk');
            table.chunks.push({ ids: null, count, present: 0, owner: table.mutationToken });
            continue;
          }
          const page = partsOf(chunk.ref);
          if (!allowed.has(page.file) || page.page > allowed.get(page.file).pages)
            throw Error('Unlisted ordinal file or chunk size');
          const ids = this.readIndex(chunk.ref);
          if (ids.length !== count) throw Error('Invalid ordinal count');
          let present = 0,
            entry,
            lastPage = -1,
            lastFile = -1;
          for (let i = 0; i < count; i++) {
            const id = ids[i];
            if (!id) continue;
            if (!Number.isSafeInteger(id) || id < 0) throw Error('Dangling record locator');
            const file = Math.floor(id / FILE),
              within = id - file * FILE,
              pageNumber = Math.floor(within / SLOTS);
            if (file !== lastFile || pageNumber !== lastPage) {
              entry =
                allowed.has(file) && pageNumber <= allowed.get(file).pages && pageNumber > 0
                  ? this.files[file]?.store.entries.at(pageNumber)
                  : undefined;
              lastFile = file;
              lastPage = pageNumber;
            }
            if (!entry || entry.kind !== 1 || within - pageNumber * SLOTS >= entry.count)
              throw Error('Dangling record locator');
            if (id <= previous) ascending = false;
            previous = id;
            present++;
          }
          table.present += present;
          table.chunks.push({ ids, count, present, owner: table.mutationToken, ref: chunk.ref });
        }
        if (length !== descriptor.length) throw Error('Invalid ordinal chunk size');
        if (table.present !== descriptor.records) throw Error('Stored record count disagrees with its locators');
        table.length = descriptor.length;
        // Earlier descriptors recorded no alias flag: any out-of-order locator may be one.
        table.aliases = descriptor.aliases ?? !ascending;
        // Descriptors predating owner keys, alias flags or header digests are
        // written afresh on their next publication.
        table.description =
          descriptor.owner === undefined ||
          descriptor.aliases === undefined ||
          descriptor.files.some((file) => file.prefix?.format !== 2)
            ? undefined
            : descriptor;
        if (
          descriptor.versionHighWatermark !== undefined &&
          (!Number.isSafeInteger(descriptor.versionHighWatermark) || descriptor.versionHighWatermark < 0)
        )
          throw Error('Invalid stored row-version watermark');
        table.versionHighWatermark = descriptor.versionHighWatermark;
        if (descriptor.looseBraceKeys !== undefined && typeof descriptor.looseBraceKeys !== 'boolean')
          throw Error('Invalid key normalization flag');
        table.looseBraceKeys = descriptor.looseBraceKeys ?? true;
        if (descriptor.keyIndex) {
          const index = descriptor.keyIndex;
          if (
            typeof index.column !== 'string' ||
            !Array.isArray(index.files) ||
            index.files.some((file) => !allowed.has(file))
          )
            throw Error('Invalid key index descriptor');
          table.keyColumn = index.column;
          table.keyTree = new PersistentKeyTree(
            this.keyStoreWithin(index.files.map((file) => [file, allowed.get(file).pages])),
            { root: index.root, files: index.files },
          );
          // Verify root ownership before any query follows its descendants.
          if (index.root) {
            const root = partsOf(index.root.id);
            if (!index.files.includes(root.file) || root.page > allowed.get(root.file).pages)
              throw Error('Unlisted key index root');
            table.keyTree.node(index.root);
          }
        }
        restored.push(table.proxy);
      }
      return restored;
    } catch (error) {
      for (const store of opened) store.close();
      this.files = [];
      throw error;
    }
  }
  info() {
    return {
      files: this.files.filter(Boolean).length,
      rawBytes: this.rawSize,
      decodedBytes: this.decodedSize,
      materializedRows: this.materialized.size,
      materializedBytes: this.rowBytes,
      keyBytes: this.keyBytes,
      openFiles: new Set(this.files.filter((file) => file && file.store.fd !== null).map((file) => file.store)).size,
      ownership: this.ownership,
    };
  }
  close() {
    if (this.closeComplete) return;
    const failures = [];
    if (!this.closed)
      try {
        this.flushRecords();
      } catch (error) {
        failures.push(error);
      }
    this.closed = true;
    for (const entry of this.files)
      try {
        entry?.store.close();
      } catch (error) {
        failures.push(error);
      }
    this.decoded.clear();
    this.materialized.clear();
    this.rawPages.clear();
    this.keyLeaves.clear();
    this.keyBranches.clear();
    this.stagedNodes.clear();
    this.openReaders.clear();
    this.decodedSize = 0;
    this.rowBytes = 0;
    this.rawSize = 0;
    this.keyBytes = 0;
    if (this.files.every((entry) => !entry || entry.store.fd === null)) {
      try {
        this.lease.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.lease.closed) {
      this.closeComplete = true;
      this.files.length = 0;
      this.backends.clear();
    }
    if (failures.length) throw new AggregateError(failures, 'Record storage cleanup failed');
  }
}

function typed(values) {
  return values.some((id) => id > 0xffffffff) ? Float64Array.from(values) : Uint32Array.from(values);
}
function chunkOf(values, owner) {
  let present = 0;
  for (const id of values) if (id) present++;
  return { ids: present ? typed(values) : null, count: values.length, present, owner };
}
// A chunk's own ids changed: drop everything derived from them.
function rewritten(chunk) {
  delete chunk.ref;
  delete chunk.fingerprint;
  delete chunk.files;
  delete chunk.sorted;
}
// Record files a chunk's locators name, in ascending order.
function filesOf(chunk) {
  if (!chunk.files) {
    const files = [];
    let last = -1;
    for (let i = 0; i < chunk.count; i++) {
      const id = chunk.ids[i];
      if (!id) continue;
      const file = Math.floor(id / FILE);
      if (file !== last && !files.includes(file)) files.push(file);
      last = file;
    }
    chunk.files = files.sort((a, b) => a - b);
  }
  return chunk.files;
}
// The chunk's present ids in ascending order: its own buffer when already
// ascending (bulk-built chunks), otherwise a sorted copy.
// ponytail: an edited chunk's sorted copy costs as much memory as its ids; a
// shared per-table id index is the upgrade if lookups after mass edits outgrow it.
function sortedIds(chunk) {
  const ids = chunk.ids;
  let previous = 0,
    ascending = true;
  for (let i = 0; i < chunk.count; i++) {
    const id = ids[i];
    if (!id || id < previous) {
      ascending = false;
      break;
    }
    previous = id;
  }
  if (ascending) return ids.subarray(0, chunk.count);
  const values = new ids.constructor(chunk.present);
  let n = 0;
  for (let i = 0; i < chunk.count; i++) if (ids[i]) values[n++] = ids[i];
  return values.subarray(0, n).sort();
}
function includesSorted(values, id) {
  let low = 0,
    high = values.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < id) low = mid + 1;
    else if (values[mid] > id) high = mid - 1;
    else return true;
  }
  return false;
}

class PagedRecords {
  constructor(session) {
    liveTables++;
    recordTablesCreated = true;
    liveTableRegistry.register(this, undefined);
    this.session = session;
    this.trackSession(session);
    this.length = 0;
    this.present = 0;
    this.mutationToken = Symbol();
    // Ordered chunks of at most CHUNK positions each; `starts` caches their offsets.
    this.chunks = [];
    this.starts = null;
    this.cursor = 0;
    this.revision = 0;
    // Chunks whose positions a version lookup searched (a diagnostic count).
    this.scannedChunks = 0;
    this.rows = new Map();
    this.aliases = false;
    this.versionHighWatermark = 0;
    this.looseBraceKeys = false;
    this.target = [];
    const self = this,
      methods = new Map();
    for (const name of ['splice', 'reverse', 'sort', 'push', 'pop', 'shift', 'unshift', 'fill', 'copyWithin']) {
      const native = Array.prototype[name],
        method = { [name]: (args) => self[name](args) }[name];
      methods.set(name, {
        native,
        wrapper: function (...args) {
          return this === self.proxy ? method(args) : Reflect.apply(native, this, args);
        },
      });
    }
    this.proxy = new Proxy(this.target, {
      get(target, key, receiver) {
        if (key === 'length') return self.length;
        const index = indexOf(key);
        if (index >= 0) return self.at(index) ?? Reflect.get(target, key, receiver);
        const value = Reflect.get(target, key, receiver),
          method = methods.get(key);
        return method && value === method.native ? method.wrapper : value;
      },
      set(target, key, value, receiver) {
        if (key === 'length') {
          self.resize(value);
          return true;
        }
        const index = indexOf(key);
        if (index >= 0) {
          self.set(index, value);
          return true;
        }
        return Reflect.set(target, key, value, receiver);
      },
      has(target, key) {
        const index = indexOf(key);
        return index >= 0 ? Boolean(self.id(index)) || Reflect.has(target, key) : Reflect.has(target, key);
      },
      deleteProperty(target, key) {
        const index = indexOf(key);
        if (index >= 0) {
          self.setId(index, 0);
          return true;
        }
        return Reflect.deleteProperty(target, key);
      },
      ownKeys(target) {
        const keys = [];
        for (let i = 0; i < self.length; i++) if (self.id(i)) keys.push(String(i));
        return [...keys, ...Reflect.ownKeys(target)];
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length') return { value: self.length, writable: true, enumerable: false, configurable: false };
        const index = indexOf(key);
        return index >= 0 && self.id(index)
          ? { value: self.at(index), writable: true, enumerable: true, configurable: true }
          : Reflect.getOwnPropertyDescriptor(target, key);
      },
      defineProperty(target, key, descriptor) {
        const index = indexOf(key);
        if (key === 'length' && Object.keys(descriptor).every((key) => key === 'value')) {
          self.resize(descriptor.value);
          return true;
        }
        if (
          index >= 0 &&
          'value' in descriptor &&
          descriptor.writable === true &&
          descriptor.enumerable === true &&
          descriptor.configurable === true
        ) {
          self.set(index, descriptor.value);
          return true;
        }
        if (index >= 0 || key === 'length')
          throw TypeError(
            'Stored JSON record elements require writable, enumerable, configurable data properties; snapshot() provides detached JavaScript arrays',
          );
        return Reflect.defineProperty(target, key, descriptor);
      },
    });
    tables.set(this.proxy, this);
  }
  indexStarts() {
    const starts = new Float64Array(this.chunks.length + 1);
    let at = 0;
    for (let c = 0; c < this.chunks.length; c++) {
      starts[c] = at;
      at += this.chunks[c].count;
    }
    starts[this.chunks.length] = at;
    return (this.starts = starts);
  }
  chunkAt(index) {
    const starts = this.starts ?? this.indexStarts();
    const c = this.cursor;
    if (c < this.chunks.length && starts[c] <= index && index < starts[c + 1]) return c;
    let low = 0,
      high = this.chunks.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return (this.cursor = low);
  }
  id(index) {
    if (!(index >= 0 && index < this.length)) return 0;
    const c = this.chunkAt(index),
      chunk = this.chunks[c];
    return chunk.ids ? chunk.ids[index - this.starts[c]] : 0;
  }
  // Chunk boundaries or contents changed.
  restructure() {
    this.starts = null;
    this.description = undefined;
    this.fingerprintCache = undefined;
    this.revision++;
  }
  trackSession(session) {
    if (this.tracking) {
      cleanupTables.unregister(this.tracking);
      this.tracking.session.deref()?.backends.delete(this.tracking.ref);
    }
    const token = { session: new WeakRef(session), ref: new WeakRef(this) };
    session.backends.add(token.ref);
    cleanupTables.register(this, token, token);
    this.tracking = token;
  }
  retainVersion(value) {
    const version = Number(value);
    if (this.versionHighWatermark === undefined) this.maximumVersion();
    if (Number.isSafeInteger(version) && version > this.versionHighWatermark) this.versionHighWatermark = version;
  }
  maximumVersion() {
    if (this.versionHighWatermark === undefined) {
      this.versionHighWatermark = 0;
      for (let index = 0; index < this.length; index++) this.retainVersion(this.raw(index)?.versionnumber);
    }
    return this.versionHighWatermark;
  }
  fingerprint() {
    if (this.fingerprintCache) return this.fingerprintCache;
    const hash = createHash('sha256').update(String(this.length) + ':');
    for (const chunk of this.chunks) {
      if (!chunk.fingerprint) {
        const names = chunk.ids ? filesOf(chunk).map((index) => this.session.files[index].name) : [];
        chunk.fingerprint = chunk.ids
          ? createHash('sha256')
              .update(JSON.stringify(names))
              .update(bufferOf(chunk.ids.subarray(0, chunk.count)))
              .digest('hex')
          : 'holes:' + chunk.count;
      }
      hash.update(chunk.fingerprint + ':');
    }
    return (this.fingerprintCache = hash.digest('hex'));
  }
  /** Every position of one record version. Each chunk is skipped by its sorted
   * ids unless it holds the version, so lookups stay bounded after edits. */
  positions(id) {
    const positions = [],
      starts = this.starts ?? this.indexStarts();
    for (let c = 0; c < this.chunks.length; c++) {
      const chunk = this.chunks[c];
      if (!chunk.ids) continue;
      const sorted = (chunk.sorted ??= sortedIds(chunk));
      if (!sorted.length || id < sorted[0] || id > sorted[sorted.length - 1] || !includesSorted(sorted, id)) continue;
      this.scannedChunks++;
      for (let at = chunk.ids.indexOf(id); at >= 0 && at < chunk.count; at = chunk.ids.indexOf(id, at + 1))
        positions.push(starts[c] + at);
    }
    return positions;
  }
  primaryPositions(column, key) {
    if (!this.keyTree || column !== this.keyColumn || typeof key !== 'string') return null;
    const out = [];
    for (const id of this.keyTree.lookup(normalizeKey(key))) out.push(...this.positions(id));
    return out.sort((a, b) => a - b);
  }
  noteKeyShape(key) {
    if (key.replace(/[{}]/g, '').toLowerCase() !== normalizeKey(key)) this.looseBraceKeys = true;
  }
  /** Ids among `removed` that still occur outside [start, end) stay indexed. */
  retainOutside(removed, start, end) {
    if (!removed.size || !this.aliases) return;
    if (removed.size <= 64) {
      for (const id of removed) if (this.positions(id).some((at) => at < start || at >= end)) removed.delete(id);
      return;
    }
    for (let i = 0; i < this.length && removed.size; i++) {
      if (i === start) i = end;
      if (i < this.length) removed.delete(this.id(i));
    }
  }
  prepareIndex(removed, added) {
    if (!this.keyTree) return null;
    const removedSet = new Set(removed),
      addedSet = new Set(added);
    // Large truncations/splices are one sequential key pass, rather than one
    // path-copy transaction per removed row. Smaller edits path-copy O(log n)
    // key nodes and persist only the final version of each.
    if (removedSet.size + addedSet.size > 1024) {
      const sorter = new KeySorter(this.session.directory);
      try {
        for (const pair of this.keyTree.entries()) if (!removedSet.has(pair[1])) sorter.add(pair);
        for (const id of addedSet) {
          const key = this.session.readRow(id)[this.keyColumn];
          if (typeof key !== 'string') return null;
          this.noteKeyShape(key);
          sorter.add([normalizeKey(key), id]);
        }
        return PersistentKeyTree.fromSorted(this.session.keyStore, sorter.sorted());
      } finally {
        sorter.close();
      }
    }
    const draft = transientKeyStore(this.keyTree.store),
      next = new PersistentKeyTree(draft, {
        root: this.keyTree.root,
        files: this.keyTree.files,
        capacity: this.keyTree.capacity,
      });
    for (const id of removedSet) {
      const key = this.session.readRow(id)[this.keyColumn];
      if (typeof key !== 'string') return null;
      next.delete(normalizeKey(key), id);
    }
    for (const id of addedSet) {
      const key = this.session.readRow(id)[this.keyColumn];
      if (typeof key !== 'string') return null;
      this.noteKeyShape(key);
      next.insert(normalizeKey(key), id);
    }
    return draft.publish(next);
  }
  setId(index, id, { updateIndex = true, preparedVersion } = {}) {
    const previous = this.id(index);
    if (previous === id) return;
    if (index >= this.length && !id) return;
    const nextIndex =
      updateIndex && this.keyTree
        ? this.prepareIndex(
            previous && (!this.aliases || this.positions(previous).length === 1) ? [previous] : [],
            id ? [id] : [],
          )
        : null;
    const version = preparedVersion ?? (id ? Number(this.session.readRow(id).versionnumber) : undefined);
    if (index >= this.length) this.resize(index + 1);
    const c = this.chunkAt(index),
      old = this.chunks[c],
      offset = index - this.starts[c];
    const present = old.present + Number(Boolean(id)) - Number(Boolean(previous));
    let next;
    if (!present) next = { ids: null, count: old.count, present: 0, owner: this.mutationToken };
    else if (old.owner === this.mutationToken && old.ids && (id <= 0xffffffff || old.ids instanceof Float64Array)) {
      next = old;
      next.ids[offset] = id;
      next.present = present;
      rewritten(next);
    } else {
      const wide = id > 0xffffffff || old.ids instanceof Float64Array,
        ids = new (wide ? Float64Array : Uint32Array)(c === this.chunks.length - 1 ? CHUNK : old.count);
      if (old.ids) ids.set(old.ids.subarray(0, old.count));
      ids[offset] = id;
      next = { ids, count: old.count, present, owner: this.mutationToken };
    }
    this.chunks[c] = next;
    this.present += Number(Boolean(id)) - Number(Boolean(previous));
    this.description = undefined;
    this.fingerprintCache = undefined;
    this.revision++;
    if (id) this.retainVersion(version);
    if (updateIndex) this.keyTree = nextIndex;
  }
  /** Append positions, filling the last chunk in place (after one copy when shared). */
  appendIds(ids) {
    let at = 0,
      present = 0;
    const tail = this.chunks.at(-1);
    if (tail && tail.count < CHUNK && ids.length) {
      const n = Math.min(CHUNK - tail.count, ids.length);
      let wide = tail.ids instanceof Float64Array;
      for (let i = 0; i < n && !wide; i++) wide = ids[i] > 0xffffffff;
      let chunk = tail;
      if (
        tail.owner === this.mutationToken &&
        tail.ids &&
        tail.ids.length >= tail.count + n &&
        (!wide || tail.ids instanceof Float64Array)
      )
        rewritten(chunk);
      else {
        const next = new (wide ? Float64Array : Uint32Array)(CHUNK);
        if (tail.ids) next.set(tail.ids.subarray(0, tail.count));
        chunk = { ids: next, count: tail.count, present: tail.present, owner: this.mutationToken };
        this.chunks[this.chunks.length - 1] = chunk;
      }
      for (; at < n; at++) {
        chunk.ids[chunk.count++] = ids[at];
        if (ids[at]) {
          chunk.present++;
          present++;
        }
      }
    }
    const grew = at < ids.length;
    while (at < ids.length) {
      const chunk = chunkOf(Array.from(ids.slice(at, at + CHUNK)), this.mutationToken);
      this.chunks.push(chunk);
      present += chunk.present;
      at += chunk.count;
    }
    this.present += present;
    this.length += ids.length;
    if (grew || !this.starts) this.restructure();
    else {
      this.starts[this.chunks.length] = this.length;
      this.description = undefined;
      this.fingerprintCache = undefined;
      this.revision++;
    }
  }
  /** Replace positions [start, start + remove) by `ids`. Only the chunks holding
   * the change are copied; earlier and later chunks keep their identity, so
   * their ordinal pages are not written again. */
  layout(start, remove, ids) {
    if (!remove && start === this.length) return this.appendIds(ids);
    const end = start + remove,
      starts = this.starts ?? this.indexStarts();
    let first = this.chunkAt(start),
      last = remove ? this.chunkAt(end - 1) : first;
    const take = (target, chunk, from, to) => {
      for (let i = from; i < to; i++) target.push(chunk.ids ? chunk.ids[i] : 0);
    };
    let region = [];
    take(region, this.chunks[first], 0, start - starts[first]);
    for (const id of ids) region.push(id);
    take(region, this.chunks[last], end - starts[last], this.chunks[last].count);
    // A small remainder joins a neighbour, so repeated deletes keep chunks large.
    if (region.length < CHUNK / 4) {
      if (last + 1 < this.chunks.length && region.length + this.chunks[last + 1].count <= CHUNK) {
        last++;
        take(region, this.chunks[last], 0, this.chunks[last].count);
      } else if (first > 0 && region.length + this.chunks[first - 1].count <= CHUNK) {
        first--;
        const before = [];
        take(before, this.chunks[first], 0, this.chunks[first].count);
        region = before.concat(region);
      }
    }
    let removedPresent = 0;
    for (let c = first; c <= last; c++) removedPresent += this.chunks[c].present;
    const replacement = [],
      pieces = Math.ceil(region.length / CHUNK);
    for (let piece = 0, at = 0; piece < pieces; piece++) {
      const size = Math.floor(region.length / pieces) + Number(piece < region.length % pieces);
      replacement.push(chunkOf(region.slice(at, at + size), this.mutationToken));
      at += size;
    }
    this.chunks.splice(first, last - first + 1, ...replacement);
    this.length += ids.length - remove;
    this.present += replacement.reduce((sum, chunk) => sum + chunk.present, 0) - removedPresent;
    this.restructure();
  }
  /** Lay out a complete reordering of the current positions. */
  reorder(ids) {
    const chunks = [];
    for (let at = 0; at < ids.length; at += CHUNK)
      chunks.push(chunkOf(Array.from(ids.subarray(at, at + CHUNK)), this.mutationToken));
    this.chunks = chunks;
    this.restructure();
  }
  resize(value) {
    const length = +value;
    if (!Number.isInteger(length) || length < 0 || length > 4294967295) throw RangeError('Invalid array length');
    if (length === this.length) return;
    if (length < this.length) {
      if (this.keyTree) {
        const removed = new Set();
        for (let i = length; i < this.length; i++) {
          const id = this.id(i);
          if (id) removed.add(id);
        }
        this.retainOutside(removed, length, this.length);
        this.keyTree = this.prepareIndex(removed, []);
      }
      if (!length) this.chunks = [];
      else {
        const c = this.chunkAt(length - 1),
          old = this.chunks[c],
          keep = length - this.starts[c];
        this.chunks = this.chunks.slice(0, c + 1);
        if (keep < old.count)
          this.chunks[c] = old.ids
            ? chunkOf(Array.from(old.ids.subarray(0, keep)), this.mutationToken)
            : { ids: null, count: keep, present: 0, owner: this.mutationToken };
      }
      this.present = this.chunks.reduce((sum, chunk) => sum + chunk.present, 0);
    } else {
      let missing = length - this.length;
      const tail = this.chunks.at(-1);
      if (tail && tail.count < CHUNK) {
        const count = Math.min(CHUNK, tail.count + missing);
        let chunk;
        if (tail.owner === this.mutationToken && (!tail.ids || tail.ids.length >= count)) {
          chunk = tail;
          rewritten(chunk);
        } else {
          let ids = null;
          if (tail.ids) {
            ids = new tail.ids.constructor(CHUNK);
            ids.set(tail.ids.subarray(0, tail.count));
          }
          chunk = { ids, count: tail.count, present: tail.present, owner: this.mutationToken };
          this.chunks[this.chunks.length - 1] = chunk;
        }
        missing -= count - chunk.count;
        chunk.count = count;
      }
      for (; missing > 0; missing -= CHUNK)
        this.chunks.push({ ids: null, count: Math.min(CHUNK, missing), present: 0, owner: this.mutationToken });
    }
    this.length = length;
    this.restructure();
  }
  set(index, value) {
    const state = rowStates.get(value);
    let id,
      version,
      reused = false;
    if (state?.owner?.deref() === this) {
      id = this.reuse(state);
      reused = true;
    } else {
      const stored = this.session.put(value, { metadata: true });
      id = stored.id;
      version = storedFields(rawOf(value), stored.text).version;
    }
    this.setId(index, id, { preparedVersion: reused ? undefined : version });
    if (reused) {
      state.index = index;
      if (!this.aliases && this.positions(id).length > 1) this.aliases = true;
    }
  }
  reuse(state) {
    if (state.detachedDirty) {
      const next = this.session.put(state.raw, { metadata: true });
      this.rows.delete(state.id);
      state.id = next.id;
      state.cacheBytes = next.bytes;
      state.detachedDirty = false;
      state.cleanup.id = next.id;
      this.rows.set(state.id, state.cleanup.ref);
    }
    this.session.retain(state);
    return state.id;
  }
  raw(index, { borrow = false } = {}) {
    const id = this.id(index);
    if (!id) return undefined;
    const state = this.rows.get(id)?.deref();
    return state ? (borrow ? state.raw : structuredClone(state.raw)) : this.session.readRow(id);
  }
  at(index) {
    const id = this.id(index);
    if (!id) return undefined;
    const existing = this.rows.get(id)?.deref();
    if (existing) {
      this.session.retain(existing);
      return existing.proxy;
    }
    const loaded = this.session.readRow(id, { metadata: true });
    const state = {
      id,
      index,
      raw: loaded.row,
      cacheBytes: loaded.bytes,
      owner: new WeakRef(this),
      cacheOwner: new WeakRef(this.session),
      wrapped: new WeakMap(),
      depth: 0,
      dirty: false,
    };
    const changed = () => {
      if (state.depth) {
        state.dirty = true;
        return;
      }
      const owner = state.owner.deref();
      if (!owner) {
        state.cacheOwner.deref()?.release(state);
        return;
      }
      // `index` is a hint: positions are found by record version when it moved.
      const positions =
        !owner.aliases && owner.id(state.index) === state.id ? [state.index] : owner.positions(state.id);
      if (!positions.length) {
        state.detachedDirty = true;
        owner.session.release(state);
        return;
      }
      const next = owner.session.put(state.raw, { metadata: true });
      const nextIndex = owner.prepareIndex([state.id], [next.id]);
      for (const at of positions) owner.setId(at, next.id, { updateIndex: false });
      owner.keyTree = nextIndex;
      owner.rows.delete(state.id);
      state.id = next.id;
      state.cacheBytes = next.bytes;
      state.index = positions[0];
      state.cleanup.id = next.id;
      owner.rows.set(next.id, state.cleanup.ref);
      owner.session.retain(state);
    };
    state.changed = changed;
    const wrap = (raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const previous = state.wrapped.get(raw);
      if (previous) return previous;
      const proxy = new Proxy(raw, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (Array.isArray(target) && MUTATORS.has(key) && value === Array.prototype[key])
            return function (...args) {
              if (this !== proxy) return Reflect.apply(value, this, args);
              const before = Object.getOwnPropertyDescriptors(target);
              state.depth++;
              let result, failure;
              try {
                result = Reflect.apply(value, target, args.map(rawOf));
              } catch (error) {
                failure = error;
              }
              state.depth--;
              if (!state.depth) {
                state.dirty = false;
                try {
                  changed();
                } catch (error) {
                  restoreProperties(target, before);
                  throw error;
                }
              }
              if (failure) throw failure;
              return result === target ? proxy : result;
            };
          return wrap(value);
        },
        set(target, key, value) {
          const before = Object.getOwnPropertyDescriptor(target, key);
          const ok = Reflect.set(target, key, rawOf(value), target);
          if (ok)
            try {
              changed();
            } catch (error) {
              before ? Reflect.defineProperty(target, key, before) : Reflect.deleteProperty(target, key);
              throw error;
            }
          return ok;
        },
        deleteProperty(target, key) {
          const before = Object.getOwnPropertyDescriptor(target, key),
            ok = Reflect.deleteProperty(target, key);
          if (ok)
            try {
              changed();
            } catch (error) {
              if (before) Reflect.defineProperty(target, key, before);
              throw error;
            }
          return ok;
        },
        defineProperty(target, key, descriptor) {
          const before = Object.getOwnPropertyDescriptor(target, key),
            ok = Reflect.defineProperty(target, key, descriptor);
          if (ok)
            try {
              changed();
            } catch (error) {
              before ? Reflect.defineProperty(target, key, before) : Reflect.deleteProperty(target, key);
              throw error;
            }
          return ok;
        },
      });
      state.wrapped.set(raw, proxy);
      rowStates.set(proxy, {
        get raw() {
          return raw;
        },
        state,
      });
      return proxy;
    };
    state.proxy = wrap(state.raw);
    rowStates.set(state.proxy, state);
    state.cleanup = { owner: state.owner, id, ref: new WeakRef(state) };
    cleanupRows.register(state, state.cleanup, state.cleanup);
    this.rows.set(id, state.cleanup.ref);
    this.session.retain(state);
    return state.proxy;
  }
  /** Array.prototype.splice over record versions. */
  splice(args) {
    const start = relative(args.length ? args[0] : 0, this.length, 0);
    const remove =
      args.length < 2
        ? args.length
          ? this.length - start
          : 0
        : Math.min(Math.max(integer(args[1]), 0), this.length - start);
    return this.replace(start, remove, args.slice(2));
  }
  replace(start, remove, added) {
    const deleted = new Array(remove);
    if (!remove && !added.length) return deleted;
    if (this.length - remove + added.length > 4294967295) throw RangeError('Invalid array length');
    for (let i = 0; i < remove; i++) if (this.id(start + i)) deleted[i] = this.at(start + i);
    const removedIds = new Set();
    if (this.keyTree)
      for (let i = 0; i < remove; i++) {
        const id = this.id(start + i);
        if (id) removedIds.add(id);
      }
    const addedIds = [],
      reused = [],
      versions = [];
    for (const value of added) {
      const state = rowStates.get(value);
      if (state?.owner?.deref() === this) {
        state.index = start + addedIds.length;
        addedIds.push(this.reuse(state));
        reused.push(state.id);
      } else {
        const stored = this.session.put(value, { metadata: true });
        addedIds.push(stored.id);
        versions.push(storedFields(rawOf(value), stored.text).version);
      }
    }
    const addedSet = new Set(addedIds);
    for (const id of removedIds) if (addedSet.has(id)) removedIds.delete(id);
    this.retainOutside(removedIds, start, start + remove);
    const nextIndex = this.prepareIndex(removedIds, addedSet);
    for (const version of versions) this.retainVersion(version);
    this.layout(start, remove, addedIds);
    this.keyTree = nextIndex;
    if (!this.aliases)
      for (const id of new Set(reused))
        if (this.positions(id).length > 1) {
          this.aliases = true;
          break;
        }
    return deleted;
  }
  push(items) {
    this.replace(this.length, 0, items);
    return this.length;
  }
  pop() {
    if (!this.length) return undefined;
    const last = this.length - 1,
      value = this.id(last) ? this.at(last) : undefined;
    this.replace(last, 1, []);
    return value;
  }
  shift() {
    if (!this.length) return undefined;
    const value = this.id(0) ? this.at(0) : undefined;
    this.replace(0, 1, []);
    return value;
  }
  unshift(items) {
    if (items.length) this.replace(0, 0, items);
    return this.length;
  }
  reverse() {
    const chunks = [],
      pending = [];
    for (let i = this.length - 1; i >= 0; i--) {
      pending.push(this.id(i));
      if (pending.length === CHUNK) {
        chunks.push(chunkOf(pending, this.mutationToken));
        pending.length = 0;
      }
    }
    if (pending.length) chunks.push(chunkOf(pending, this.mutationToken));
    this.chunks = chunks;
    this.restructure();
    return this.proxy;
  }
  /** Array.prototype.sort: the comparator orders this table's facades and the
   * ordered record versions are laid out once; holes move to the end. */
  sort([comparator]) {
    if (comparator !== undefined && typeof comparator !== 'function')
      throw TypeError('The comparison function must be either a function or undefined');
    const items = [];
    for (let i = 0; i < this.length; i++) if (this.id(i)) items.push(this.at(i));
    const revision = this.revision;
    items.sort(comparator);
    if (this.revision !== revision) {
      // The comparator changed the table: write the items back as the generic algorithm does.
      for (const [index, row] of items.entries()) this.set(index, row);
      for (let index = items.length; index < this.length; index++) this.setId(index, 0);
      return this.proxy;
    }
    const ids = new Float64Array(this.length);
    items.forEach((row, index) => (ids[index] = rowStates.get(row).id));
    this.reorder(ids);
    return this.proxy;
  }
  /** Array.prototype.fill: one stored record occupies every filled position. */
  fill([value, start, end]) {
    const from = relative(start, this.length, 0),
      to = relative(end, this.length, this.length);
    if (from >= to) return this.proxy;
    const state = rowStates.get(value);
    let id, version;
    if (state?.owner?.deref() === this) id = this.reuse(state);
    else {
      const stored = this.session.put(value, { metadata: true });
      id = stored.id;
      version = storedFields(rawOf(value), stored.text).version;
    }
    const removed = new Set();
    if (this.keyTree)
      for (let i = from; i < to; i++) {
        const previous = this.id(i);
        if (previous && previous !== id) removed.add(previous);
      }
    this.retainOutside(removed, from, to);
    const nextIndex = this.prepareIndex(removed, [id]);
    this.retainVersion(version);
    this.layout(from, to - from, new Array(to - from).fill(id));
    this.keyTree = nextIndex;
    if (!this.aliases && (to - from > 1 || this.positions(id).length > 1)) this.aliases = true;
    return this.proxy;
  }
  /** Array.prototype.copyWithin: positions receive the record versions (or holes) copied. */
  copyWithin([target, start, end]) {
    const to = relative(target, this.length, 0),
      from = relative(start, this.length, 0),
      final = relative(end, this.length, this.length),
      count = Math.min(final - from, this.length - to);
    if (count <= 0) return this.proxy;
    const ids = new Array(count);
    for (let i = 0; i < count; i++) ids[i] = this.id(from + i);
    const copied = new Set(ids),
      removed = new Set();
    if (this.keyTree)
      for (let i = to; i < to + count; i++) {
        const id = this.id(i);
        if (id && !copied.has(id)) removed.add(id);
      }
    this.retainOutside(removed, to, to + count);
    // Every copied version stays in place at its source or in the copy itself.
    const nextIndex = this.prepareIndex(removed, []);
    this.layout(to, count, ids);
    this.keyTree = nextIndex;
    copied.delete(0);
    if (!this.aliases)
      if (copied.size > 64) this.aliases = true;
      else for (const id of copied) if (this.positions(id).length > 1) this.aliases = true;
    return this.proxy;
  }
  fork() {
    const next = new PagedRecords(this.session);
    this.mutationToken = Symbol();
    next.chunks = [...this.chunks];
    next.length = this.length;
    next.present = this.present;
    next.aliases = this.aliases;
    next.description = this.description;
    next.fingerprintCache = this.fingerprintCache;
    next.versionHighWatermark = this.versionHighWatermark;
    next.looseBraceKeys = this.looseBraceKeys;
    next.keyColumn = this.keyColumn;
    next.keyTree = this.keyTree?.fork();
    return next.proxy;
  }
  /** Return to a private snapshot of this table (row facades restore separately). */
  restore(value) {
    const snapshot = tables.get(value);
    if (!snapshot || snapshot.session !== this.session) throw Error('Invalid record rollback snapshot');
    this.mutationToken = Symbol();
    for (const key of [
      'length',
      'present',
      'aliases',
      'keyColumn',
      'keyTree',
      'versionHighWatermark',
      'looseBraceKeys',
      'description',
      'fingerprintCache',
    ])
      this[key] = snapshot[key];
    this.chunks = [...snapshot.chunks];
    this.starts = null;
    this.revision++;
  }
  /** Return a mutated facade to its earlier value and record version. */
  restoreRow(row, previous, id) {
    const state = rowStates.get(row);
    if (!state?.changed || state.owner.deref() !== this) return;
    if (!id) throw Error('Record rollback omitted its prior row');
    this.rows.delete(state.id);
    restoreProperties(state.raw, Object.getOwnPropertyDescriptors(previous));
    state.id = id;
    state.cleanup.id = id;
    state.detachedDirty = false;
    this.rows.set(id, state.cleanup.ref);
  }
  adopt(value) {
    const next = tables.get(value);
    if (!next || !next.movedRows || next.length !== this.length || next.present !== this.present)
      throw Error('Invalid compacted record table');
    const old = this.session,
      rows = new Map();
    for (const [id, ref] of this.rows) {
      const state = ref.deref();
      if (!state) continue;
      const position = next.movedRows.has(id) ? -1 : this.positions(id)[0];
      const moved = next.movedRows.get(id) ?? (position === undefined ? -id : next.id(position));
      if (moved < 0) state.detachedDirty = true;
      old.release(state);
      state.id = moved;
      state.cleanup.id = moved;
      state.cacheOwner = new WeakRef(next.session);
      next.session.retain(state);
      rows.set(moved, ref);
    }
    for (const key of [
      'session',
      'length',
      'present',
      'chunks',
      'aliases',
      'keyColumn',
      'keyTree',
      'versionHighWatermark',
      'looseBraceKeys',
      'description',
      'fingerprintCache',
    ])
      this[key] = next[key];
    // Neither table owns the shared chunks: the first write to either copies.
    this.chunks = [...next.chunks];
    this.mutationToken = Symbol();
    next.mutationToken = Symbol();
    this.starts = null;
    this.revision++;
    this.rows = rows;
    this.trackSession(this.session);
  }
}

/** Key-tree edits of one change keep their intermediate nodes in memory;
 * `publish` writes only the nodes the final root reaches. */
function transientKeyStore(base) {
  const drafts = new Map();
  let next = Number.MAX_SAFE_INTEGER;
  return {
    read: (id) => drafts.get(id) ?? base.read(id),
    write(node) {
      drafts.set(next, node);
      return next--;
    },
    fileOf: () => undefined,
    publish(tree) {
      const files = new Set(tree.files);
      const persist = (ref) => {
        const node = ref && drafts.get(ref.id);
        if (!node) return ref;
        const stored = node.leaf ? node : { leaf: false, children: node.children.map(persist) };
        const id = base.write(stored),
          file = base.fileOf?.(id);
        if (file !== undefined) files.add(file);
        return { ...ref, id };
      };
      const root = persist(tree.root);
      return new PersistentKeyTree(base, { root, files: root ? files : [], capacity: tree.capacity });
    },
  };
}

export const pagedRecordsOf = (value) => tables.get(value);
export const rawRecordOf = (value) => rowStates.get(value)?.raw;
/** The record version a table facade currently names. */
export const recordIdOf = (row) => rowStates.get(row)?.id;
/** Return a mutated facade of `rows` to its earlier value and record version. */
export const restoreRecordRow = (rows, row, previous, id) => tables.get(rows)?.restoreRow(row, previous, id);

/** Plain page values for internal read-only scans, with ordinary array
 * iteration's hole behavior. Never retain a mutable facade for each record. */
export function* readRecordValues(rows) {
  const paged = pagedRecordsOf(rows);
  if (!paged) yield* rows;
  else for (let index = 0; index < paged.length; index++) yield paged.id(index) ? paged.raw(index) : undefined;
}
/** Core multi-column updates publish one immutable payload and index change. */
export function assignRecordValues(row, values) {
  const state = rowStates.get(row);
  if (!state?.changed) return false;
  const before = Object.getOwnPropertyDescriptors(state.raw);
  state.depth++;
  try {
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(row, key, { value, enumerable: true, configurable: true, writable: true });
    state.depth--;
    if (!state.depth) {
      state.dirty = false;
      state.changed();
    }
    return true;
  } catch (error) {
    if (state.depth) state.depth--;
    state.dirty = false;
    restoreProperties(state.raw, before);
    throw error;
  }
}
export const materializeRecord = (value) => structuredClone(rawOf(value));
