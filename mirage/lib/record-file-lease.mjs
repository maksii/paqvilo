import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

const hashOf = (identity) =>
  createHash('sha256')
    .update(process.platform === 'win32' ? identity.toLowerCase() : identity)
    .digest('hex');
// An existing file resolves symlinks, 8.3 short names and letter case in full.
const canonicalState = (file) => {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
  }
};
/** The location identity of a state file. Ownership itself is a random key;
 * this identity lets a state without stored records adopt its own directory. */
export function stateRecordOwner(file) {
  return hashOf(canonicalState(file));
}
/** The location identity earlier markers stored: the canonical directory and the given file name. */
export const earlierStateOwner = (file) => {
  const absolute = path.resolve(file);
  return hashOf(path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute)));
};

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const recordFileName = new RegExp('^' + uuid + '\\.pages$');
const leaseName = new RegExp('^' + uuid + '\\.lease$');
// Temporaries name their creating process; earlier temporaries did not.
const temporaryName = new RegExp(
  '^(?:([1-9]\\d*)-' +
    uuid +
    '\\.(?:owner\\.tmp|lease\\.tmp|sort)|' +
    uuid +
    '(?:\\.owner\\.tmp|\\.sort|-' +
    uuid +
    '\\.lease\\.tmp))$',
);
const integrity = (message) => Object.assign(Error(message), { code: 'StateIntegrity' });
const OWNER = '.record-owner.json';
/** A temporary file name in a record directory, attributed to this process. */
export const temporaryRecordName = (kind) => process.pid + '-' + randomUUID() + '.' + kind;
const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A reused live PID is conservatively retained.
    return error.code !== 'ESRCH';
  }
};

// Open first, then compare the path with the opened handle. Reads remain bound
// to that handle even if the name changes after validation.
export function openRecordReader(file, io = fs) {
  const fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = io.fstatSync(fd, { bigint: true }),
      named = io.lstatSync(file, { bigint: true });
    if (!opened.isFile() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino)
      throw integrity('Record file identity changed or is a symlink');
    return fd;
  } catch (error) {
    io.closeSync(fd);
    throw error;
  }
}

function readLease(file) {
  const fd = openRecordReader(file);
  let body;
  try {
    body = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
  if (
    body?.format !== 1 ||
    path.basename(file) !== body.id + '.lease' ||
    !Number.isSafeInteger(body.pid) ||
    body.pid <= 0 ||
    !Array.isArray(body.files) ||
    body.files.some((name) => !recordFileName.test(name))
  )
    throw integrity('Invalid record lease');
  return body;
}

/** Remove temporaries that no live process can still use: those of an exited
 * process, and unattributed (earlier) ones while no other live process holds a
 * lease here. A lease that cannot be read counts as live. */
function removeStaleTemporaries(directory, { isAlive = processAlive } = {}) {
  const names = fs.readdirSync(directory);
  let otherLive = false;
  for (const name of names.filter((name) => leaseName.test(name))) {
    try {
      const body = readLease(path.join(directory, name));
      if (body.pid !== process.pid && isAlive(body.pid)) otherLive = true;
    } catch (error) {
      if (error.code !== 'ENOENT') otherLive = true;
    }
  }
  let removed = 0,
    retained = 0;
  for (const name of names) {
    const match = temporaryName.exec(name);
    if (!match) continue;
    const pid = match[1] ? Number(match[1]) : null;
    if (pid === null ? otherLive : pid === process.pid || isAlive(pid)) {
      retained++;
      continue;
    }
    try {
      fs.unlinkSync(path.join(directory, name));
      removed++;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
      retained++;
    }
  }
  return { removed, retained };
}

// Link failures meaning the filesystem has no hard links (FAT32, exFAT, some shares).
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR', 'EINVAL', 'EXDEV', 'EMLINK']);
/** Publish an owner marker unless one exists. A complete temporary is linked to
 * the final name; without hard links the final name is created exclusively and
 * written by one call, and readers wait for that write to land. */
function publishRecordOwner(directory, body, { io = fs } = {}) {
  const file = path.join(directory, OWNER),
    temporary = path.join(directory, temporaryRecordName('owner.tmp')),
    bytes = Buffer.from(JSON.stringify(body));
  try {
    io.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      io.linkSync(temporary, file);
      return;
    } catch (error) {
      if (error.code === 'EEXIST') return;
      if (!NO_LINKS.has(error.code)) throw error;
    }
    let fd;
    try {
      fd = io.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return;
      throw error;
    }
    try {
      if (io.writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw Error('Incomplete record owner write');
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
  } finally {
    io.rmSync(temporary, { force: true });
  }
}

const wait = new Int32Array(new SharedArrayBuffer(4));
function readOwner(directory) {
  for (let attempt = 0; ; attempt++) {
    let fd;
    try {
      fd = openRecordReader(path.join(directory, OWNER));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    let text;
    try {
      if (fs.fstatSync(fd).size > 1024) throw integrity('Invalid record directory owner');
      text = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    // An exclusively created marker is empty only until its single write lands.
    if (!text && attempt < 100) {
      Atomics.wait(wait, 0, 0, 2);
      continue;
    }
    let owner;
    try {
      owner = JSON.parse(text);
    } catch {
      throw integrity('Invalid record directory owner');
    }
    if (
      (owner?.format !== 1 && owner?.format !== 2) ||
      !/^[a-f0-9]{64}$/.test(owner.key ?? '') ||
      (owner.state !== undefined && !/^[a-f0-9]{64}$/.test(owner.state))
    )
      throw integrity('Invalid record directory owner');
    return owner;
  }
}

/** Claim a record directory. Its marker holds a random owner key, so a state and
 * its directory stay paired when both move together. `ownerKey` is the key the
 * caller's stored descriptors name; `adopt` accepts the marker for descriptors
 * written before keys existed (their files verify against this directory);
 * otherwise the state's `location` (stateRecordOwner) or `earlierLocation`
 * (earlierStateOwner) must match the marker. A directory with files but no
 * marker is used unowned: nothing in it is collected. */
export function claimRecordDirectory(directory, { ownerKey, location, earlierLocation, adopt = false, io = fs } = {}) {
  if (ownerKey !== undefined && !/^[a-f0-9]{64}$/.test(ownerKey)) throw TypeError('Invalid record directory owner');
  let owner = readOwner(directory);
  if (!owner) {
    removeStaleTemporaries(directory);
    // Only temporaries (a concurrent creator's included) may precede a marker.
    if (fs.readdirSync(directory).every((name) => temporaryName.test(name)))
      publishRecordOwner(
        directory,
        { format: 2, key: ownerKey ?? randomBytes(32).toString('hex'), ...(location ? { state: location } : {}) },
        { io },
      );
    owner = readOwner(directory);
    if (!owner)
      return { key: ownerKey ?? randomBytes(32).toString('hex'), owned: false, reason: 'missing-owner-marker' };
  }
  const matches =
    ownerKey !== undefined
      ? owner.key === ownerKey
      : adopt || !location || [location, earlierLocation].includes(owner.format === 1 ? owner.key : owner.state);
  if (!matches) throw Error('Record directory belongs to a different state');
  // Record where the owning state now lives, migrating an earlier marker.
  if (location && (owner.format !== 2 || owner.state !== location)) {
    const temporary = path.join(directory, temporaryRecordName('owner.tmp'));
    try {
      fs.writeFileSync(temporary, JSON.stringify({ format: 2, key: owner.key, state: location }), {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporary, path.join(directory, OWNER));
    } catch {
      // The marker stays valid with its earlier location, e.g. while another reader holds it.
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return { key: owner.key, owned: true };
}

/** A live session protects every file it has ever admitted. Publish protection
 * before creating a writer or opening a restored file; updates are monotonic. */
export class RecordFileLease {
  constructor(directory, { io = fs } = {}) {
    this.directory = fs.realpathSync.native(directory);
    this.io = io;
    this.id = randomUUID();
    this.file = path.join(this.directory, this.id + '.lease');
    this.files = new Set();
    this.closed = false;
  }
  protect(names) {
    if (this.closed) throw Error('Record file lease is closed');
    const next = new Set([...this.files, ...names]);
    if ([...next].some((name) => !recordFileName.test(name))) throw integrity('Invalid leased record filename');
    if (next.size === this.files.size) return;
    const temp = path.join(this.directory, temporaryRecordName('lease.tmp'));
    const body = JSON.stringify({ format: 1, id: this.id, pid: process.pid, files: [...next].sort() });
    const fd = this.io.openSync(temp, 'wx', 0o600);
    try {
      try {
        this.io.writeFileSync(fd, body);
        this.io.fsyncSync(fd);
      } finally {
        this.io.closeSync(fd);
      }
      this.io.renameSync(temp, this.file);
      this.files = next;
    } finally {
      this.io.rmSync(temp, { force: true });
    }
  }
  close() {
    if (this.closed) return;
    if (this.files.size) {
      let body;
      try {
        body = JSON.parse(this.io.readFileSync(this.file, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (body && (body.id !== this.id || body.pid !== process.pid)) throw integrity('Record lease ownership changed');
      if (body) this.io.unlinkSync(this.file);
    }
    this.closed = true;
    this.files.clear();
  }
}

/** Caller holds the state publication lock. Enumerate candidate files BEFORE
 * reading leases: a newly visible writer already has a published lease, and a
 * writer appearing afterwards is outside this collection's candidate set.
 * A reused live PID is conservatively retained; unknown ownership fails closed.
 * Stale temporaries (sort runs, lease and owner temporaries) are removed too. */
export async function collectRecordGarbage(directory, publishedNames, { isAlive } = {}) {
  const root = await fs.promises.realpath(directory),
    names = await fs.promises.readdir(root);
  const candidates = names.filter((name) => recordFileName.test(name));
  const protectedNames = new Set(publishedNames);
  if ([...protectedNames].some((name) => !recordFileName.test(name)))
    throw integrity('Invalid published record filename');
  const alive = isAlive ?? processAlive;
  const leases = (await fs.promises.readdir(root)).filter((name) => leaseName.test(name));
  const live = new Map();
  for (const name of leases) {
    const file = path.join(root, name);
    let body;
    try {
      body = readLease(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!live.has(body.pid)) live.set(body.pid, await alive(body.pid));
    if (live.get(body.pid)) for (const name of body.files) protectedNames.add(name);
    else
      await fs.promises.unlink(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
  let removed = 0,
    retained = 0;
  for (const name of candidates) {
    if (protectedNames.has(name)) {
      retained++;
      continue;
    }
    const file = path.join(root, name);
    if (path.dirname(file) !== root) throw integrity('Record collection escaped its owned directory');
    try {
      await fs.promises.unlink(file);
      removed++;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
      retained++;
    }
  }
  for (const name of await fs.promises.readdir(root)) {
    const pid = Number(temporaryName.exec(name)?.[1]);
    if (pid && !live.has(pid)) live.set(pid, await alive(pid));
  }
  const temporaries = removeStaleTemporaries(root, { isAlive: (pid) => live.get(pid) ?? true });
  return { removed: removed + temporaries.removed, retained: retained + temporaries.retained };
}
