import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export function stateRecordOwner(file) {
  const absolute = path.resolve(file),
    identity = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  return createHash('sha256')
    .update(process.platform === 'win32' ? identity.toLowerCase() : identity)
    .digest('hex');
}

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const recordFileName = new RegExp('^' + uuid + '\\.pages$');
const leaseName = new RegExp('^' + uuid + '\\.lease$');
const integrity = (message) => Object.assign(Error(message), { code: 'StateIntegrity' });

/** A live session protects every file it has ever admitted. Publish protection
 * before creating a writer or opening a restored file; updates are monotonic. */
export class RecordFileLease {
  constructor(directory, { io = fs } = {}) {
    this.directory = fs.realpathSync(directory);
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
    const temp = path.join(this.directory, this.id + '-' + randomUUID() + '.lease.tmp');
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
 * A reused live PID is conservatively retained; unknown ownership fails closed. */
export async function collectRecordGarbage(directory, publishedNames, { isAlive } = {}) {
  const root = await fs.promises.realpath(directory),
    names = await fs.promises.readdir(root);
  const candidates = names.filter((name) => recordFileName.test(name));
  const protectedNames = new Set(publishedNames);
  if ([...protectedNames].some((name) => !recordFileName.test(name)))
    throw integrity('Invalid published record filename');
  const alive =
    isAlive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        return true;
      }
    });
  const leases = (await fs.promises.readdir(root)).filter((name) => leaseName.test(name));
  for (const name of leases) {
    const file = path.join(root, name);
    let body;
    try {
      if ((await fs.promises.lstat(file)).isSymbolicLink()) throw integrity('Record leases cannot be symlinks');
      body = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (
      body?.format !== 1 ||
      name !== body.id + '.lease' ||
      !Number.isSafeInteger(body.pid) ||
      body.pid <= 0 ||
      !Array.isArray(body.files) ||
      body.files.some((name) => !recordFileName.test(name))
    )
      throw integrity('Invalid record lease');
    if (await alive(body.pid)) for (const name of body.files) protectedNames.add(name);
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
  return { removed, retained };
}
