// JSON record pages, bounded read caches and copy-on-write table positions.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { RecordPageFile } from './record-page-file.mjs';
import { PersistentKeyTree } from './record-key-index.mjs';
import { KeySorter } from './record-key-sort.mjs';
import { RecordFileLease, stateRecordOwner } from './record-file-lease.mjs';
import { setImmediate } from 'node:timers/promises';

const FILE = 4294967296,
  SLOTS = 512,
  CHUNK = 4096;
const rowStates = new WeakMap(),
  tables = new WeakMap();
export let recordTablesCreated = false;
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
  if (!Number.isSafeInteger(value) || page >= FILE / SLOTS)
    throw RangeError('Record locator exceeds its supported range');
  return value;
};
const partsOf = (value) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid record locator');
  const file = Math.floor(value / FILE),
    within = value % FILE;
  return { file, page: Math.floor(within / SLOTS), slot: within % SLOTS };
};
const bufferOf = (ids) => {
  if (endianness() === 'LE') return Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength);
  const wide = ids instanceof Float64Array,
    bytes = Buffer.allocUnsafe(ids.length * (wide ? 8 : 4));
  for (let i = 0; i < ids.length; i++) wide ? bytes.writeDoubleLE(ids[i], i * 8) : bytes.writeUInt32LE(ids[i], i * 4);
  return bytes;
};

export class RecordPageSession {
  constructor(
    directory,
    {
      decodedBytes = 16 * 1024 * 1024,
      materializedRows = 4096,
      materializedBytes = 32 * 1024 * 1024,
      rawBytes = 4 * 1024 * 1024,
      maxOpenFiles = 32,
      stateOwner,
      ownerKey,
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
    if (!Number.isInteger(maxOpenFiles) || maxOpenFiles < 1 || maxOpenFiles > 256)
      throw TypeError('Invalid record file handle budget');
    fs.mkdirSync(directory, { recursive: true });
    this.directory = fs.realpathSync(directory);
    this.ownerKey =
      ownerKey ??
      (stateOwner
        ? stateRecordOwner(stateOwner)
        : createHash('sha256')
            .update(process.platform === 'win32' ? this.directory.toLowerCase() : this.directory)
            .digest('hex'));
    if (!/^[a-f0-9]{64}$/.test(this.ownerKey)) throw TypeError('Invalid record directory owner');
    const ownerFile = path.join(this.directory, '.record-owner.json');
    const readOwner = () => {
      const info = fs.lstatSync(ownerFile);
      if (info.isSymbolicLink() || info.size > 1024) throw Error('Invalid record directory owner');
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      } catch {
        throw Error('Invalid record directory owner');
      }
      if (owner?.format !== 1 || owner.key !== this.ownerKey)
        throw Error('Record directory belongs to a different state');
      this.ownedDirectory = true;
    };
    if (fs.existsSync(ownerFile)) readOwner();
    else if (!fs.readdirSync(this.directory).length) {
      try {
        fs.writeFileSync(ownerFile, JSON.stringify({ format: 1, key: this.ownerKey }), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      readOwner();
    } else this.ownedDirectory = false;
    this.lease = new RecordFileLease(this.directory);
    this.closed = false;
    this.backends = new Set();
    this.files = [];
    this.writerIndex = null;
    this.pending = [];
    this.pendingBytes = 2;
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
    this.keyNodes = new Map();
    this.keyBytes = 0;
    this.keyLimit = 2 * 1024 * 1024;
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
  put(row, { metadata = false } = {}) {
    row = rawOf(row);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw TypeError('A streamed record must be an object');
    // Persist typed numeric markers, matching ordinary simulator state. The
    // public wire encoder, not storage, converts them to exact JSON numbers.
    const text = JSON.stringify(row);
    if (text?.[0] !== '{' || text.at(-1) !== '}') throw TypeError('A streamed record must encode as a JSON object');
    const bytes = Buffer.byteLength(text) + 1;
    const writer = this.writer();
    if (this.pending.length && this.pendingBytes + bytes > 256 * 1024) this.flushRecords();
    const id = locator(this.writerIndex, writer.entries.length, this.pending.length);
    this.pending.push(text);
    this.pendingBytes += bytes;
    if (this.pending.length === SLOTS) this.flushRecords();
    return metadata ? { id, text, bytes: bytes * 3 + 2048 } : id;
  }
  flushRecords() {
    if (!this.pending.length) return;
    const values = this.pending.map((text) => Buffer.from(text));
    const header = Buffer.allocUnsafe(values.length * 4);
    values.forEach((value, i) => header.writeUInt32LE(value.length, i * 4));
    this.writer().append(1, Buffer.concat([header, ...values]), this.pending.length);
    this.pending = [];
    this.pendingBytes = 2;
  }
  putIndex(ids) {
    this.flushRecords();
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
    this.flushRecords();
    const writer = this.writer();
    const entries = node.leaf ? node.pairs : node.children;
    const id = locator(
      this.writerIndex,
      writer.append(node.leaf ? 4 : 5, Buffer.from(JSON.stringify(node)), entries.length),
    );
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
  readKeyNode(id) {
    const cached = this.keyNodes.get(id);
    if (cached) {
      this.keyNodes.delete(id);
      this.keyNodes.set(id, cached);
      return cached.node;
    }
    const p = partsOf(id),
      entry = this.files[p.file]?.store.page(p.page);
    if (p.slot || !entry || ![4, 5].includes(entry.kind)) throw Error('Invalid key index page');
    const bytes = this.readBytes(p),
      node = JSON.parse(bytes.toString('utf8'));
    if (Boolean(node.leaf) !== (entry.kind === 4) || (node.leaf ? node.pairs : node.children)?.length !== entry.count)
      throw Error('Invalid key index node');
    const size = bytes.length * 3 + 1024;
    if (size <= this.keyLimit) {
      while (this.keyBytes + size > this.keyLimit) {
        const oldest = this.keyNodes.keys().next().value;
        this.keyBytes -= this.keyNodes.get(oldest).size;
        this.keyNodes.delete(oldest);
      }
      this.keyNodes.set(id, { node, size });
      this.keyBytes += size;
    }
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
  readRow(id, { metadata = false } = {}) {
    const p = partsOf(id),
      store = this.files[p.file]?.store;
    if (p.file === this.writerIndex && p.page === store?.entries.length && p.slot < this.pending.length) {
      const text = this.pending[p.slot],
        row = JSON.parse(text);
      return metadata ? { row, bytes: Buffer.byteLength(text) * 3 + 2048 } : row;
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
    const row = JSON.parse(raw.toString('utf8', start, end));
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Invalid stored record');
    return metadata ? { row, bytes: (end - start) * 3 + 2048 } : row;
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
        const stored = this.put(row, { metadata: true }),
          id = stored.id;
        const record = JSON.parse(stored.text);
        table.retainVersion(record.versionnumber);
        if (sorter) {
          const key = record[primaryKey];
          if (typeof key !== 'string') {
            sorter.close();
            sorter = null;
          } else {
            table.noteKeyShape(key);
            sorter.add([normalizeKey(key), id]);
          }
        }
        ids.push(id);
        if (ids.length === CHUNK) {
          table.chunks.push(chunkOf(ids, table.mutationToken));
          table.length += ids.length;
          table.present += ids.length;
          ids = [];
        }
      }
      if (ids.length) {
        table.chunks.push(chunkOf(ids, table.mutationToken));
        table.length += ids.length;
        table.present += ids.length;
      }
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
    const save = (oldId, row) => {
      const stored = this.put(row, { metadata: true }),
        id = stored.id;
      if (held.has(oldId)) moved.set(oldId, id);
      if (sorter) {
        const key = JSON.parse(stored.text)[source.keyColumn];
        if (typeof key !== 'string') throw Error('Record key index disagrees with its records');
        table.noteKeyShape(key);
        sorter.add([normalizeKey(key), id]);
      }
      return id;
    };
    try {
      if (!source.aliases) {
        let ids = [];
        for (let index = 0; index < source.length; index++) {
          const oldId = source.id(index);
          ids.push(oldId ? save(oldId, source.raw(index)) : 0);
          if (ids.length === CHUNK || index + 1 === source.length) {
            const chunk = chunkOf(ids, table.mutationToken);
            table.chunks.push(chunk);
            table.length += ids.length;
            table.present += chunk.present;
            ids = [];
            await yieldWork();
          }
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
              id = save(oldId, source.session.readRow(oldId));
              previous = oldId;
            }
            table.setId(position - 1, id, { updateIndex: false, preparedVersion: 0 });
            if (++operations % 512 === 0) await yieldWork();
          }
          table.aliases = true;
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
    const chunks = table.chunks.map((chunk) => {
      if (!chunk.ids) return { holes: chunk.count };
      for (const id of chunk.ids) if (id) used.add(partsOf(id).file);
      chunk.ref ??= this.putIndex(chunk.ids);
      used.add(partsOf(chunk.ref).file);
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
      length: table.length,
      records: table.present,
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
        descriptor.chunks.length !== Math.ceil(descriptor.length / CHUNK)
      )
        throw Error('Invalid paged table descriptor');
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
          real = fs.realpathSync(file);
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
        let previous = 0;
        for (const [index, chunk] of descriptor.chunks.entries()) {
          const count = Math.min(CHUNK, descriptor.length - index * CHUNK);
          if (chunk?.holes !== undefined) {
            if (chunk.holes !== count || chunk.ref !== undefined) throw Error('Invalid sparse ordinal chunk');
            table.chunks.push({ ids: null, count, present: 0, owner: table.mutationToken });
            continue;
          }
          const page = partsOf(chunk?.ref);
          if (!allowed.has(page.file) || page.page > allowed.get(page.file).pages || chunk.count !== count)
            throw Error('Unlisted ordinal file or chunk size');
          const ids = this.readIndex(chunk.ref);
          if (ids.length !== count) throw Error('Invalid ordinal count');
          let present = 0;
          for (const id of ids) {
            if (!id) continue;
            const p = partsOf(id),
              entry =
                allowed.has(p.file) && p.page <= allowed.get(p.file).pages
                  ? this.files[p.file]?.store.page(p.page)
                  : undefined;
            if (!entry || entry.kind !== 1 || p.slot >= entry.count) throw Error('Dangling record locator');
            if (id <= previous) table.aliases = true;
            previous = id;
            present++;
          }
          table.present += present;
          table.chunks.push({ ids, count, present, owner: table.mutationToken, ref: chunk.ref });
        }
        if (table.present !== descriptor.records) throw Error('Stored record count disagrees with its locators');
        table.length = descriptor.length;
        table.description = descriptor;
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
    this.keyNodes.clear();
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

class PagedRecords {
  constructor(session) {
    recordTablesCreated = true;
    this.session = session;
    this.trackSession(session);
    this.length = 0;
    this.present = 0;
    this.mutationToken = Symbol();
    this.chunks = [];
    this.rows = new Map();
    this.aliases = false;
    this.versionHighWatermark = 0;
    this.looseBraceKeys = false;
    this.target = [];
    const self = this;
    const splice = function (...args) {
      return this === self.proxy ? self.splice(args) : Reflect.apply(Array.prototype.splice, this, args);
    };
    const reverse = function () {
      return this === self.proxy ? self.reverse() : Reflect.apply(Array.prototype.reverse, this, []);
    };
    this.proxy = new Proxy(this.target, {
      get(target, key, receiver) {
        if (key === 'length') return self.length;
        const index = indexOf(key);
        if (index >= 0) return self.at(index) ?? Reflect.get(target, key, receiver);
        const value = Reflect.get(target, key, receiver);
        if (key === 'splice' && value === Array.prototype.splice) return splice;
        if (key === 'reverse' && value === Array.prototype.reverse) return reverse;
        return value;
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
  id(index) {
    return index < this.length ? (this.chunks[Math.floor(index / CHUNK)]?.ids?.[index % CHUNK] ?? 0) : 0;
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
        const files = new Set();
        for (const id of chunk.ids ?? []) if (id) files.add(Math.floor(id / FILE));
        const names = [...files].sort((a, b) => a - b).map((index) => this.session.files[index].name);
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
  positions(id) {
    const positions = [];
    for (let chunkIndex = 0; chunkIndex < this.chunks.length; chunkIndex++) {
      const chunk = this.chunks[chunkIndex];
      if (!chunk.ids) continue;
      if (chunk.minimum === undefined) {
        let minimum = Infinity,
          maximum = 0;
        for (const value of chunk.ids)
          if (value) {
            minimum = Math.min(minimum, value);
            maximum = Math.max(maximum, value);
          }
        chunk.minimum = minimum;
        chunk.maximum = maximum;
      }
      if (id < chunk.minimum || id > chunk.maximum) continue;
      let at = 0;
      while ((at = chunk.ids.indexOf(id, at)) >= 0) {
        positions.push(chunkIndex * CHUNK + at);
        at++;
      }
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
  prepareIndex(removed, added) {
    if (!this.keyTree) return null;
    const removedSet = new Set(removed),
      addedSet = new Set(added);
    // Large truncations/splices are one sequential key pass, rather than one
    // path-copy transaction per removed row. Ordinary edits retain O(log n).
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
    const next = this.keyTree.fork();
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
    return next;
  }
  setId(index, id, { updateIndex = true, preparedVersion } = {}) {
    const previous = this.id(index);
    if (previous === id) return;
    if (index >= this.length && !id) return;
    const nextIndex =
      updateIndex && this.keyTree
        ? this.prepareIndex(previous && this.positions(previous).length === 1 ? [previous] : [], id ? [id] : [])
        : null;
    const version = preparedVersion ?? (id ? Number(this.session.readRow(id).versionnumber) : undefined);
    if (index >= this.length) this.resize(index + 1);
    const chunkIndex = Math.floor(index / CHUNK),
      old = this.chunks[chunkIndex];
    const size = Math.min(CHUNK, this.length - chunkIndex * CHUNK);
    const present = old.present + Number(Boolean(id)) - Number(Boolean(previous));
    let next;
    if (!present) next = { ids: null, count: size, present: 0, owner: this.mutationToken };
    else if (old.owner === this.mutationToken && old.ids && (id <= 0xffffffff || old.ids instanceof Float64Array)) {
      next = old;
      next.ids[index % CHUNK] = id;
      next.present = present;
      delete next.ref;
      delete next.minimum;
      delete next.maximum;
      delete next.fingerprint;
    } else {
      const ids = id > 0xffffffff || old.ids instanceof Float64Array ? new Float64Array(size) : new Uint32Array(size);
      if (old.ids) ids.set(old.ids.subarray(0, size));
      ids[index % CHUNK] = id;
      next = { ids, count: size, present, owner: this.mutationToken };
    }
    this.chunks[chunkIndex] = next;
    this.present += Number(Boolean(id)) - Number(Boolean(previous));
    this.description = undefined;
    this.fingerprintCache = undefined;
    if (id) this.retainVersion(version);
    if (updateIndex) this.keyTree = nextIndex;
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
        for (let i = 0; i < length && removed.size; i++) removed.delete(this.id(i));
        this.keyTree = this.prepareIndex(removed, []);
      }
      for (let i = length; i < this.length; i++) if (this.id(i)) this.present--;
      this.chunks = this.chunks.slice(0, Math.ceil(length / CHUNK));
      if (length % CHUNK && this.chunks.length) {
        const last = this.chunks.at(-1),
          count = length % CHUNK;
        this.chunks[this.chunks.length - 1] = last.ids
          ? chunkOf(Array.from(last.ids.subarray(0, count)), this.mutationToken)
          : { ids: null, count, present: 0, owner: this.mutationToken };
      }
    } else {
      if (this.chunks.length) {
        const oldIndex = this.chunks.length - 1,
          old = this.chunks[oldIndex],
          needed = Math.min(CHUNK, length - oldIndex * CHUNK);
        if (old.count < needed) {
          let ids = null;
          if (old.ids) {
            ids = new old.ids.constructor(needed);
            ids.set(old.ids);
          }
          this.chunks[oldIndex] = { ids, count: needed, present: old.present, owner: this.mutationToken };
        }
      }
      for (let i = this.chunks.length; i < Math.ceil(length / CHUNK); i++)
        this.chunks.push({
          ids: null,
          count: Math.min(CHUNK, length - i * CHUNK),
          present: 0,
          owner: this.mutationToken,
        });
    }
    this.length = length;
    this.description = undefined;
    this.fingerprintCache = undefined;
  }
  set(index, value) {
    const state = rowStates.get(value);
    let id;
    if (state?.owner?.deref() === this) {
      id = this.reuse(state, index);
    } else id = this.session.put(value);
    this.setId(index, id);
  }
  reuse(state, index) {
    if (state.detachedDirty) {
      const next = this.session.put(state.raw, { metadata: true });
      this.rows.delete(state.id);
      state.id = next.id;
      state.cacheBytes = next.bytes;
      state.detachedDirty = false;
      state.cleanup.id = next.id;
      this.rows.set(state.id, state.cleanup.ref);
    }
    state.index = index;
    this.aliases = true;
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
      const positions = [];
      if (owner.aliases) {
        for (let i = 0; i < owner.length; i++) if (owner.id(i) === state.id) positions.push(i);
      } else if (owner.id(state.index) === state.id) positions.push(state.index);
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
  splice(args) {
    const integer = (value) => {
      const n = +value;
      return Number.isNaN(n) ? 0 : Math.trunc(n);
    };
    const startValue = args.length ? integer(args[0]) : 0;
    const start = startValue < 0 ? Math.max(this.length + startValue, 0) : Math.min(startValue, this.length);
    const remove =
      args.length < 2
        ? args.length
          ? this.length - start
          : 0
        : Math.min(Math.max(integer(args[1]), 0), this.length - start);
    const added = args.slice(2),
      deleted = new Array(remove),
      addedIds = [];
    if (!remove && !added.length) return deleted;
    if (this.length - remove + added.length > 4294967295) throw RangeError('Invalid array length');
    const removedIds = new Set();
    for (let i = 0; i < remove; i++) if (this.id(start + i)) deleted[i] = this.at(start + i);
    if (this.keyTree)
      for (let i = 0; i < remove; i++) {
        const id = this.id(start + i);
        if (id) removedIds.add(id);
      }
    for (const value of added) {
      const state = rowStates.get(value);
      if (state?.owner?.deref() === this) {
        addedIds.push(this.reuse(state, start + addedIds.length));
      } else addedIds.push(this.session.put(value));
    }
    for (const id of removedIds)
      if (addedIds.includes(id) || this.positions(id).some((index) => index < start || index >= start + remove))
        removedIds.delete(id);
    const nextIndex = this.prepareIndex(removedIds, new Set(addedIds));
    for (const id of addedIds) this.retainVersion(this.session.readRow(id).versionnumber);
    const chunks = [],
      pending = [],
      positions = new Map();
    const append = (id) => {
      if (this.rows.has(id) && !positions.has(id)) positions.set(id, chunks.length * CHUNK + pending.length);
      pending.push(id);
      if (pending.length === CHUNK) {
        chunks.push(chunkOf(pending, this.mutationToken));
        pending.length = 0;
      }
    };
    for (let i = 0; i < start; i++) append(this.id(i));
    for (const id of addedIds) append(id);
    for (let i = start + remove; i < this.length; i++) append(this.id(i));
    if (pending.length) chunks.push(chunkOf(pending, this.mutationToken));
    this.chunks = chunks;
    this.length += added.length - remove;
    this.present = this.chunks.reduce((sum, chunk) => sum + chunk.present, 0);
    this.description = undefined;
    this.fingerprintCache = undefined;
    this.keyTree = nextIndex;
    for (const [id, ref] of this.rows) {
      const state = ref.deref();
      if (state && positions.has(id)) state.index = positions.get(id);
    }
    return deleted;
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
    for (const ref of this.rows.values()) {
      const state = ref.deref();
      if (state) state.index = this.length - 1 - state.index;
    }
    this.chunks = chunks;
    this.description = undefined;
    this.fingerprintCache = undefined;
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
  restore(value, row, previous, index) {
    const snapshot = tables.get(value);
    if (!snapshot || snapshot.session !== this.session) throw Error('Invalid record rollback snapshot');
    const state = row && rowStates.get(row);
    if (state?.changed) {
      const oldId = snapshot.id(index);
      if (!oldId) throw Error('Record rollback omitted its prior row');
      this.rows.delete(state.id);
      const before = Object.getOwnPropertyDescriptors(previous);
      restoreProperties(state.raw, before);
      state.id = oldId;
      state.cleanup.id = oldId;
      state.detachedDirty = false;
      this.rows.set(oldId, state.cleanup.ref);
    }
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
    for (const [id, ref] of this.rows) {
      const current = ref.deref();
      if (!current) continue;
      const first = this.positions(id)[0];
      if (first !== undefined) current.index = first;
      else this.session.release(current);
    }
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
      'mutationToken',
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
    this.rows = rows;
    this.trackSession(this.session);
  }
}

export const pagedRecordsOf = (value) => tables.get(value);
export const rawRecordOf = (value) => rowStates.get(value)?.raw;
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
