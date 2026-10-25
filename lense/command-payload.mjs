import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_COMMAND_PAYLOAD_BYTES = 1024 * 1024;
const PAYLOAD_NAME = /^stop-([a-f0-9]{64})\.json$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const failure = (message, code) => Object.assign(new Error(message), { code });
const sameFileVersion = (a, b) =>
  b.isFile() &&
  !b.isSymbolicLink() &&
  b.nlink === 1 &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;

// The caller selects an ignored ownership parent, which may use a trusted alias.
// Canonicalize that parent; our own commands directory must not be a link.
function commandDirectory(directory, create) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0'))
    throw failure('Command payload storage requires an absolute directory.', 'COMMAND_PAYLOAD_DIRECTORY');
  const selected = path.resolve(directory);
  try {
    const parent = path.dirname(selected);
    if (create) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const absolute = path.join(fs.realpathSync(parent), path.basename(selected));
    let info = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!info && create) {
      try {
        fs.mkdirSync(absolute, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      info = fs.lstatSync(absolute);
    }
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink())
      throw failure(
        'Command payload storage cannot use a linked or non-directory commands folder.',
        'COMMAND_PAYLOAD_DIRECTORY',
      );
    return { selected, absolute, real: fs.realpathSync(absolute), info };
  } catch (error) {
    if (!create && error.code === 'ENOENT') return null;
    if (error.code?.startsWith('COMMAND_PAYLOAD_')) throw error;
    throw failure('Cannot prepare command payload storage.', 'COMMAND_PAYLOAD_DIRECTORY');
  }
}

function checkDirectory(directory) {
  const current = commandDirectory(directory.selected, false);
  if (
    !current ||
    !samePath(current.real, directory.real) ||
    current.info.dev !== directory.info.dev ||
    current.info.ino !== directory.info.ino
  )
    throw failure('Command payload storage changed during the operation.', 'COMMAND_PAYLOAD_DIRECTORY');
}

function readOwned(file) {
  let handle;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_COMMAND_PAYLOAD_BYTES)
      return null;
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(handle);
    if (!sameFileVersion(before, opened)) return null;
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(handle, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fs.lstatSync(file);
    if (bytes.length > MAX_COMMAND_PAYLOAD_BYTES || !sameFileVersion(opened, after) || after.size !== bytes.length)
      return null;
    return { bytes, info: after };
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/** Persist raw JSON bytes without overwriting any existing path or exposing its contents. */
export function persistCommandPayload(directory, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_COMMAND_PAYLOAD_BYTES)
    throw failure('Command payload must be a nonempty Buffer of at most 1 MiB.', 'COMMAND_PAYLOAD_INVALID');
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw failure('Command payload must contain valid UTF-8 JSON.', 'COMMAND_PAYLOAD_INVALID');
  }
  const storage = commandDirectory(directory, true);
  const file = path.join(storage.absolute, `stop-${digest(bytes)}.json`);
  const existing = () => {
    const until = Date.now() + 200;
    for (;;) {
      checkDirectory(storage);
      const saved = readOwned(file);
      if (saved?.bytes.equals(bytes)) return file;
      const info = fs.lstatSync(file, { throwIfNoEntry: false });
      // Another publisher can have atomically linked the complete file and be
      // about to remove its temporary link. Never accept a hard-linked file.
      if (info?.isFile() && info.nlink === 2 && Date.now() < until) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4);
        continue;
      }
      throw failure(
        'An existing command payload is unsafe or does not match its identity.',
        'COMMAND_PAYLOAD_CONFLICT',
      );
    }
  };
  if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) return existing();
  const temporary = path.join(storage.absolute, `.stop-${randomUUID()}.tmp`);
  let handle, temporaryIdentity;
  try {
    checkDirectory(storage);
    handle = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryIdentity = fs.fstatSync(handle);
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    checkDirectory(storage);
    try {
      // Hard-link publication is atomic and refuses an existing target. Unlike
      // rename, it cannot replace a file that appeared after our initial check.
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw failure('Cannot publish command payload.', 'COMMAND_PAYLOAD_WRITE');
      return existing();
    }
    return file;
  } catch (error) {
    if (error.code?.startsWith('COMMAND_PAYLOAD_')) throw error;
    throw failure('Cannot persist command payload.', 'COMMAND_PAYLOAD_WRITE');
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    // Delete only our random temporary regular file while the original directory
    // still has the same identity. A replaced directory is never followed.
    try {
      checkDirectory(storage);
      const info = fs.lstatSync(temporary, { throwIfNoEntry: false });
      if (
        temporaryIdentity &&
        info?.isFile() &&
        !info.isSymbolicLink() &&
        info.dev === temporaryIdentity.dev &&
        info.ino === temporaryIdentity.ino
      )
        fs.unlinkSync(temporary);
    } catch {
      /* Preserve unfamiliar paths rather than trying broader cleanup. */
    }
  }
}

/** Remove only explicitly released, intact payloads with no remaining ownership reference. */
export function pruneCommandPayloads(directory, releasedFiles = [], retainedFiles = []) {
  const storage = commandDirectory(directory, false);
  if (!storage) return [];
  const canonical = (file) => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) return null;
    try {
      if (!samePath(fs.realpathSync(path.dirname(file)), storage.real)) return null;
      return path.join(storage.absolute, path.basename(file));
    } catch {
      return null;
    }
  };
  const keyOf = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
  const retained = new Set(retainedFiles.map(canonical).filter(Boolean).map(keyOf));
  const removed = [];
  for (const candidate of new Set(releasedFiles)) {
    const file = canonical(candidate);
    if (!file) continue;
    const name = PAYLOAD_NAME.exec(path.basename(file));
    const key = keyOf(file);
    if (!name || !samePath(path.dirname(file), storage.absolute) || retained.has(key)) continue;
    checkDirectory(storage);
    const saved = readOwned(file);
    if (!saved || digest(saved.bytes) !== name[1]) continue;
    checkDirectory(storage);
    const current = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!current || !sameFileVersion(saved.info, current)) continue;
    fs.unlinkSync(file);
    removed.push(file);
  }
  return removed;
}
