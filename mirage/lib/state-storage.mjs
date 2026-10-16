import { createReadStream } from 'node:fs';
import { open, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DataError } from './data-error.mjs';
import { jsonChunks, parseJsonStream, hashStateFile, writeJsonStream } from './state-stream.mjs';

const MAGIC = '{"$paqvilo":"mirage-state-journal-v1"}\n';
export const DEFAULT_JOURNAL_THRESHOLD = 16 * 1024 * 1024;
const conflict = () => new DataError('Local state changed outside this runtime; restart the simulator from the updated state file before writing', 409, 'StateConflict');
// NTFS updates ChangeTime on the first read/open when last-access updates are
// enabled. That is not a content change. Retain inode, size and nanosecond mtime
// checks on Windows; committed bytes remain protected by the persisted digest.
export const stateFileSignature = (info, platform = process.platform) =>
  [info.dev, info.ino, info.size, info.mtimeNs, ...(platform === 'win32' ? [] : [info.ctimeNs])].join(':');
const signature = stateFileSignature;
const identity = info => [info.dev, info.ino].join(':');
const fileSignature = async file => signature(await stat(file, { bigint: true }));
const put = (object, key, value) => Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });

function apply(state, entry) {
  if (entry.op === 'section') put(state, entry.key, entry.value);
  else if (entry.op === 'remove-section') delete state[entry.key];
  else if (entry.op === 'table') put(state.tables, entry.table, []);
  else if (entry.op === 'remove-table') delete state.tables[entry.table];
  else if (entry.op === 'insert') state.tables[entry.table].splice(entry.index, 0, entry.row);
  else if (entry.op === 'set') state.tables[entry.table][entry.index] = entry.row;
  else if (entry.op === 'delete') state.tables[entry.table].splice(entry.index, 1);
  else throw new DataError('Unknown local state journal operation', 500, 'StateIntegrity');
}

async function* checkpoint(state) {
  for (const [key, value] of Object.entries(state)) {
    if (key !== 'tables') yield { op: 'section', key, value };
  }
  for (const [table, rows] of Object.entries(state.tables ?? {})) {
    yield { op: 'table', table };
    for (let index = 0; index < rows.length; index++) yield { op: 'insert', table, index, row: rows[index] };
  }
}

// A single append contains a begin marker, bounded JSON records and a commit
// checksum. Only checksum-verified commits are visible after a restart. A torn
// tail is retained until the next locked write truncates it to committedBytes.
async function append(handle, entries, hash, start, { header = false } = {}) {
  let bytes = start, buffer = '';
  const flush = async () => { if (buffer) { await handle.writeFile(buffer); buffer = ''; } };
  const write = async value => {
    hash.update(value); bytes += Buffer.byteLength(value); buffer += value;
    if (buffer.length >= 65536) await flush();
  };
  if (header) await write(MAGIC);
  await write('{"op":"begin"}\n');
  for await (const entry of entries) {
    const chunks = jsonChunks(entry), first = chunks.next(), second = chunks.next();
    if (second.done) await write(first.value + '\n');
    else {
      // Large metadata sections, custom presets and large individual records
      // need not fit in one line/string either.
      await write('{"op":"fragments"}\n');
      await write(JSON.stringify({ chunk: first.value }) + '\n');
      await write(JSON.stringify({ chunk: second.value }) + '\n');
      for (const chunk of chunks) await write(JSON.stringify({ chunk }) + '\n');
      await write('{"op":"end-fragments"}\n');
    }
  }
  await write(JSON.stringify({ op: 'commit', digest: hash.copy().digest('hex') }) + '\n');
  await flush(); await handle.sync();
  return { hash, committedBytes: bytes };
}

export class StateStorage {
  constructor(file, { journalThresholdBytes = DEFAULT_JOURNAL_THRESHOLD } = {}) {
    if (!Number.isSafeInteger(journalThresholdBytes) || journalThresholdBytes < 0) throw new TypeError('journalThresholdBytes must be a nonnegative safe integer');
    this.file = file; this.threshold = journalThresholdBytes; this.digest = null;
    this.signature = null; this.journal = false;
  }
  async load({ sections } = {}) {
    const selected = sections ? new Set(sections) : null;
    const wanted = entry => !selected || selected.has(entry.key ?? 'tables');
    const before = await fileSignature(this.file);
    const handle = await open(this.file, 'r');
    let prefix;
    try { const buffer = Buffer.alloc(Buffer.byteLength(MAGIC)); const { bytesRead } = await handle.read(buffer); prefix = buffer.subarray(0, bytesRead).toString(); }
    finally { await handle.close(); }
    let state;
    if (prefix === MAGIC) {
      this.journal = true;
      state = { tables: {} };
      let hash = createHash('sha256'), bytes = 0, pending = null, committed = false, tail = false;
      const size = Number((await stat(this.file)).size);
      const stream = createReadStream(this.file, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      const iterator = lines[Symbol.asyncIterator]();
      const verifyTornTail = async () => {
        // A malformed *committed* record is corruption, not crash recovery.
        // Only a suffix with no later commit marker may be discarded.
        while (true) {
          const next = await iterator.next(); if (next.done) return;
          let item; try { item = JSON.parse(next.value); } catch { continue; }
          if (item.op === 'commit') throw new DataError('Local state journal contains a damaged committed transaction', 500, 'StateIntegrity');
        }
      };
      // Checkpoint rows are applied eagerly to avoid retaining another copy of
      // millions of rows. An incomplete checkpoint is never accepted.
      try {
        while (true) {
          const next = await iterator.next(); if (next.done) break;
          const line = next.value;
          const raw = line + '\n';
          if (bytes + Buffer.byteLength(raw) > size) { tail = true; break; }
          if (bytes === 0) { hash.update(raw); bytes += Buffer.byteLength(raw); continue; }
          let entry;
          try { entry = JSON.parse(line); } catch (cause) { if (!committed) throw cause; await verifyTornTail(); tail = true; break; }
          let alreadyHashed = false;
          if (entry.op === 'fragments') {
            hash.update(raw); bytes += Buffer.byteLength(raw); alreadyHashed = true;
            let incomplete = false;
            async function* fragments() {
              while (true) {
                const part = await iterator.next();
                if (part.done || bytes + Buffer.byteLength(part.value + '\n') > size) { incomplete = true; return; }
                const item = JSON.parse(part.value);
                hash.update(part.value + '\n'); bytes += Buffer.byteLength(part.value + '\n');
                if (item.op === 'end-fragments') return;
                if (typeof item.chunk !== 'string') throw new DataError('Invalid state JSON fragment', 500, 'StateIntegrity');
                yield item.chunk;
              }
            }
            try { entry = await parseJsonStream(fragments()); }
            catch (cause) { if (!incomplete || !committed) throw cause; tail = true; break; }
            if (incomplete) { tail = true; break; }
          }
          if (entry.op === 'commit') {
            if (!pending || entry.digest !== hash.copy().digest('hex')) throw new DataError('Local state journal checksum mismatch', 500, 'StateIntegrity');
            if (committed) for (const change of pending) apply(state, change);
            pending = null; committed = true;
          } else if (entry.op === 'begin') {
            if (pending) throw new DataError('Invalid local state journal boundary', 500, 'StateIntegrity');
            pending = [];
          } else {
            if (!pending) throw new DataError('Uncommitted local state journal operation', 500, 'StateIntegrity');
            if (wanted(entry)) { if (committed) pending.push(entry); else apply(state, entry); }
          }
          if (!alreadyHashed) { hash.update(raw); bytes += Buffer.byteLength(raw); }
          if (entry.op === 'commit') { this.hash = hash.copy(); this.committedBytes = bytes; }
        }
      } finally { lines.close(); stream.destroy(); }
      if (!committed) throw new DataError('Local state checkpoint is incomplete', 500, 'StateIntegrity');
      this.recoveredTail = Boolean(pending || tail);
      this.digest = this.hash.copy().digest('hex');
    } else {
      const hash = createHash('sha256');
      async function* chunks(file) {
        // Hash bytes before decoding, preserving exact-byte conflict checks.
        const stream = createReadStream(file);
        const { StringDecoder } = await import('node:string_decoder'); const decoder = new StringDecoder('utf8');
        for await (const chunk of stream) { hash.update(chunk); yield decoder.write(chunk); }
        yield decoder.end();
      }
      state = await parseJsonStream(chunks(this.file)); this.digest = hash.digest('hex');
      // An explicit reload can switch a previously journaled file back to JSON.
      // Never append using offsets and a hash inherited from that previous file.
      this.journal = false; this.hash = undefined; this.committedBytes = undefined; this.recoveredTail = false;
    }
    this.signature = await fileSignature(this.file);
    if (before !== this.signature) throw conflict();
    return selected ? Object.fromEntries(Object.entries(state).filter(([key]) => selected.has(key))) : state;
  }
  async assertUnchanged() {
    let current;
    try { current = await fileSignature(this.file); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; current = null; }
    if (current !== this.signature) throw conflict();
  }
  async persistedDigest() {
    try {
      // Exact-byte hashes are established at load/checkpoint and advanced for
      // appended commits. Stable file identity avoids re-reading gigabytes for
      // every PATCH. Changed identity is always a conflict, even equal bytes.
      await this.assertUnchanged(); return this.digest;
    } catch (cause) {
      if (cause.code !== 'StateConflict') throw cause;
      try { return await hashStateFile(this.file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
  }
  async prepareCheckpoint(temp, state) {
    // Stop the JSON probe once the threshold is crossed; a 1 GiB checkpoint
    // must not be serialized/written twice merely to choose its format.
    let result = await writeJsonStream(temp, state, { stopAtBytes: this.threshold });
    if (result.bytes >= this.threshold) {
      await rm(temp);
      const handle = await open(temp, 'wx', 0o600);
      try { result = { ...await append(handle, checkpoint(state), createHash('sha256'), 0, { header: true }), journal: true }; }
      finally { await handle.close(); }
      result.digest = result.hash.copy().digest('hex');
    }
    return result;
  }
  async checkpointCommitted(result) {
    this.journal = result.journal === true; this.hash = result.hash;
    this.committedBytes = result.committedBytes; this.digest = result.digest;
    this.signature = await fileSignature(this.file);
  }
  async appendChanges(entries) {
    await this.assertUnchanged();
    const handle = await open(this.file, 'r+');
    const previousBytes = this.committedBytes, hash = this.hash.copy();
    let result, owned, failure, rolledBack = false;
    try {
      owned = await handle.stat({ bigint: true });
      if (signature(owned) !== this.signature) throw conflict();
      await this.assertUnchanged();
      await handle.truncate(previousBytes);
      // r+ writes start at offset zero; use a handle positioned at the committed
      // end through explicit write offsets, including after tail recovery.
      let position = previousBytes;
      const positioned = { writeFile: async value => {
        const buffer = Buffer.from(value); let offset = 0;
        while (offset < buffer.length) { const result = await handle.write(buffer, offset, buffer.length - offset, position); offset += result.bytesWritten; position += result.bytesWritten; }
      }, sync: () => handle.sync() };
      result = await append(positioned, entries, hash, previousBytes);
      const written = await handle.stat({ bigint: true });
      if (await fileSignature(this.file) !== signature(written) || written.size !== BigInt(result.committedBytes)) throw conflict();
    } catch (cause) {
      failure = cause;
      // Never truncate or adopt the identity of an external replacement. In
      // particular, an editor's atomic rename can leave our open descriptor
      // pointing at an unlinked file while the path belongs to the editor.
      if (cause.code !== 'StateConflict') {
        const written = await handle.stat({ bigint: true });
        const current = await fileSignature(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (current === signature(written) && identity(written) === identity(owned)) {
          await handle.truncate(previousBytes); await handle.sync(); rolledBack = true;
        }
      }
    } finally { await handle.close(); }
    const closed = await stat(this.file, { bigint: true }).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null; });
    if (failure) {
      if (rolledBack && closed && identity(closed) === identity(owned) && closed.size === BigInt(previousBytes)) this.signature = signature(closed);
      throw failure;
    }
    if (!closed || identity(closed) !== identity(owned) || closed.size !== BigInt(result.committedBytes)) throw conflict();
    // Windows may finalize modification timestamps when the write handle closes.
    this.signature = signature(closed);
    this.hash = result.hash; this.committedBytes = result.committedBytes;
    this.digest = this.hash.copy().digest('hex'); this.recoveredTail = false;
  }
}

/** Reads both legacy JSON and checkpoint/journal states. Never loads a whole
 * file into one Buffer/string. Copies/backups remain self-contained files. */
export async function readStateFile(file, options) { return new StateStorage(file).load(options); }
