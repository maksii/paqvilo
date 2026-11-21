import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { writeJsonStream } from './state-stream.mjs';
import { DataError } from './data-error.mjs';
import { renameThroughSharingHoldsAsync } from './record-file-lease.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) =>
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
async function atDeclaredLocation(file, io) {
  const physical = await io.realpath(file);
  if (samePath(physical, file)) return true;
  if (process.platform !== 'win32') return false;
  // Windows TEMP may contain an 8.3 parent alias (for example RUNNER~1).
  // Expand that parent without accepting a symlink/junction as a path alias.
  const parent = path.dirname(path.resolve(file));
  if (!samePath(physical, path.join(await io.realpath(parent), path.basename(file)))) return false;
  for (let ancestor = parent; ;) {
    if ((await io.lstat(ancestor)).isSymbolicLink()) return false;
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  return true;
}
// Read through the validated descriptor. A path check followed by readFile(path)
// could follow a replacement symlink between those two operations.
async function readDeclaredFile(file, io, encoding) {
  let handle;
  try {
    handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat(),
      declared = await io.lstat(file);
    if (
      !opened.isFile() ||
      declared.isSymbolicLink() ||
      !declared.isFile() ||
      opened.dev !== declared.dev ||
      opened.ino !== declared.ino ||
      !(await atDeclaredLocation(file, io))
    )
      throw failure(
        `Transaction path is not a regular file at its declared location: ${file}.`,
        'PersistenceRecoveryRequired',
      );
    return await handle.readFile(encoding);
  } catch (error) {
    if (error.code === 'ELOOP')
      throw failure(`Transaction path is a symbolic link: ${file}.`, 'PersistenceRecoveryRequired');
    throw error;
  } finally {
    await handle?.close();
  }
}
async function currentDigest(file, io) {
  try {
    return digest(await readDeclaredFile(file, io));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
const failure = (message, code = 'PackDataConflict', status = 409) =>
  Object.assign(new DataError(message, status, code), { persistenceFailure: true });
const companion = (file, token, suffix) => `${file}.paqvilo-${token}.${suffix}`;

// ---- writer locks: `<file>.lock`, taken by pack publication here and by state file saves (data.mjs)
/*
 * A lock is created whole (written to a staged companion, then hard-linked into place) and records its owner as JSON:
 * { owner: "<pid>:<nonce>", pid, thread, host, ticks?, processStartedAt, createdAt, toolkit }. `host` is the operating
 * system and machine name (`lockHost`); `ticks` (Linux) is the owner's start in clock ticks since boot. An older
 * toolkit's lock holds only `<pid>:<nonce>`: it names no host, so it is never judged stale here.
 *
 * A lock taken on this host is stale once its owner has ended: no process has its number (`process.kill(pid, 0)`
 * answers ESRCH; EPERM means one runs), the number is this thread's own and the thread holds no lock with that nonce,
 * or (Linux) the live process with that number started at another clock tick. No clock or age is compared: a live
 * owner is never reclaimed however long it writes. Residual case: off Linux, an unrelated process that reuses a dead
 * owner's number keeps that lock held (a conflict naming the process) until the process ends.
 *
 * A stale lock is reclaimed under a guard, itself a writer lock on `<lock>.paqvilo-<owner nonce>.reclaim`: only one
 * reclaimer per stale owner proceeds, and since no later lock records that nonce, the lock it removes is the one it
 * judged. It first discards the dead owner's unpublished `<file>.paqvilo-<nonce>.tmp`/`.bak` companions.
 */
const lockHost = () => `${process.platform}/${os.hostname()}`;
// Lock nonces this thread holds, counted; shared by every copy of this module loaded in the thread.
const heldNonces = (globalThis[Symbol.for('paqvilo.writerLockNonces')] ??= new Map());
const nonceOf = (owner) => owner.slice(owner.indexOf(':') + 1);
const hold = (owner) => heldNonces.set(nonceOf(owner), (heldNonces.get(nonceOf(owner)) ?? 0) + 1);
// One owner's record text, the same in every lock of its set, while that owner holds any.
const ownerTexts = new Map();
const drop = (owner) => {
  const count = (heldNonces.get(nonceOf(owner)) ?? 1) - 1;
  if (count > 0) heldNonces.set(nonceOf(owner), count);
  else {
    heldNonces.delete(nonceOf(owner));
    ownerTexts.delete(owner);
  }
};
const LOCK_OWNER = /^([1-9]\d*):([a-f\d-]{36})$/i;
// Hard links unavailable on this file system (FAT/exFAT, some network shares): the lock is then written in place.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR', 'EXDEV', 'EMLINK']);
let toolkitVersion, ownTicks;
const toolkit = () =>
  (toolkitVersion ??= JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
async function startTicks(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
  } catch {
    return null;
  }
}
/** A new owner token for writer locks, `<pid>:<nonce>`. */
const newLockOwner = () => `${process.pid}:${randomUUID()}`;
/** The companion a lock owner writes beside `file` (`<file>.paqvilo-<nonce>.<suffix>`), which a reclaim discards. */
export const lockCompanion = (file, owner, suffix) => companion(file, nonceOf(owner), suffix);

function lockRecord(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const match = LOCK_OWNER.exec(value?.owner ?? '');
  return match && Number(match[1]) === value.pid && typeof value.host === 'string' ? value : null;
}
async function ownerEnded(record) {
  if (record.pid === process.pid && record.thread === threadId) return !heldNonces.has(nonceOf(record.owner));
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    return error.code === 'ESRCH';
  }
  if (!record.ticks) return false;
  const ticks = await startTicks(record.pid);
  return ticks !== null && ticks !== record.ticks;
}
const readLockText = (io, read) => read ?? ((name) => io.readFile(name, 'utf8'));
async function removedFile(file, io) {
  try {
    await io.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function createLock(name, owner, io) {
  ownTicks ??= startTicks('self');
  const ticks = await ownTicks;
  if (!ownerTexts.has(owner))
    ownerTexts.set(
      owner,
      JSON.stringify({
        owner,
        pid: process.pid,
        thread: threadId,
        host: lockHost(),
        ...(ticks ? { ticks } : {}),
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        createdAt: new Date().toISOString(),
        toolkit: toolkit(),
      }),
    );
  const text = ownerTexts.get(owner);
  // A writer stopped while writing leaves at most this staged file, never a lock that names no owner.
  const staged = lockCompanion(name, owner, 'owner');
  await io.writeFile(staged, text, { flag: 'wx', mode: 0o600 });
  try {
    await io.link(staged, name);
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    if (!LINK_UNSUPPORTED.has(error.code)) throw error;
    try {
      await io.writeFile(name, text, { flag: 'wx', mode: 0o600 });
    } catch (error_) {
      if (error_.code === 'EEXIST') return null;
      throw error_;
    }
  } finally {
    await io.rm(staged, { force: true });
  }
  return text;
}

async function readOptional(readText, file) {
  try {
    return await readText(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
/** `{ record }` of a lock whose owner has ended, else `{ busy }`. */
async function judgeLock(name, text, journalOwner) {
  const record =
    lockRecord(text) ??
    (journalOwner && text === journalOwner
      ? { owner: text, pid: Number(text.split(':')[0]), thread: null, host: lockHost() }
      : null);
  if (journalOwner && record?.owner !== journalOwner)
    throw failure('A pack lock is not owned by the interrupted journal.', 'PersistenceRecoveryRequired');
  if (!record) return { busy: { kind: 'unidentified', lock: name } };
  if (record.host !== lockHost()) return { busy: { kind: 'foreign', lock: name, record } };
  if (!(await ownerEnded(record))) return { busy: { kind: 'live', lock: name, record } };
  return { record };
}
/** Removes an ended owner's files beside `file`; without a journal it published nothing, a journal's recovery needs them. */
async function discardLeftovers(file, nonce, journalOwner, io) {
  const name = `${file}.lock`;
  const leftovers = journalOwner
    ? [companion(name, nonce, 'owner')]
    : [companion(file, nonce, 'tmp'), companion(file, nonce, 'bak'), companion(name, nonce, 'owner')];
  const discarded = [];
  for (const leftover of leftovers) if (await removedFile(leftover, io)) discarded.push(leftover);
  return discarded;
}

/**
 * Judges `<file>.lock` and reclaims it when its owner has ended (and `reclaim` allows it). Returns `{ free }` (no
 * lock), `{ changed }` (another lock replaced it meanwhile), `{ reclaimed }` (the diagnostic, also passed to
 * `onReclaim`) or `{ busy: { kind, lock, record } }` with kind `live`, `reclaiming`, `foreign`, `unidentified` or
 * `ended` (stale, but not reclaimable here). `journalOwner` accepts an older toolkit's lock naming that owner.
 */
async function reclaimWriterLock(file, { io = fs, read, onReclaim, reclaim = true, journalOwner } = {}) {
  const name = `${file}.lock`,
    readText = readLockText(io, read);
  const text = await readOptional(readText, name);
  if (text === null) return { free: true };
  const { record, busy } = await judgeLock(name, text, journalOwner);
  if (busy) return { busy };
  if (!reclaim) return { busy: { kind: 'ended', lock: name, record } };
  const nonce = nonceOf(record.owner),
    guardFile = companion(name, nonce, 'reclaim');
  const guard = await takeWriterLock(guardFile, { io, read, onReclaim });
  if (guard.busy) return { busy: { kind: 'reclaiming', lock: name, record: guard.busy.record } };
  try {
    if ((await readOptional(readText, name)) !== text) return { changed: true };
    const discarded = await discardLeftovers(file, nonce, journalOwner, io);
    await io.unlink(name);
    const reclaimed = {
      code: 'WRITER_LOCK_RECLAIMED',
      severity: 'warning',
      message:
        `Reclaimed ${name} from process ${record.pid}, which ended without releasing it` +
        (discarded.length ? `; discarded its unpublished ${discarded.join(', ')}.` : '.'),
      lock: name,
      ownerPid: record.pid,
      ...(record.createdAt ? { ownerCreatedAt: record.createdAt } : {}),
      ...(record.toolkit ? { ownerToolkit: record.toolkit } : {}),
      discarded,
    };
    onReclaim?.(reclaimed);
    return { reclaimed };
  } finally {
    await releaseWriterLock(guardFile, guard, { io, read });
  }
}

/**
 * Startup recovery of `<file>.lock`: reclaims it when its writer has ended, then removes what ended writers left beside
 * it without a lock: a staged lock record (stopped before the link) and a reclaim guard (stopped after its reclaim).
 * Live, foreign and unidentified locks are left for the first write to report.
 */
export async function recoverWriterLock(file, { io = fs, read, onReclaim, reclaim = true } = {}) {
  await reclaimWriterLock(file, { io, read, onReclaim, reclaim });
  const directory = path.dirname(file),
    prefix = `${path.basename(file)}.lock.paqvilo-`,
    readText = readLockText(io, read);
  let names;
  try {
    names = await io.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names.filter((entry) => entry.startsWith(prefix))) {
    const leftover = path.join(directory, name);
    if (name.endsWith('.reclaim.lock'))
      await reclaimWriterLock(leftover.slice(0, -'.lock'.length), { io, read, onReclaim });
    else if (name.endsWith('.owner')) await removeStagedRecord(file, leftover, readText, io, onReclaim);
  }
}
/** Removes a staged lock record whose writer ended before linking it as the lock. */
async function removeStagedRecord(file, staged, readText, io, onReclaim) {
  const text = await readOptional(readText, staged);
  const record = text === null ? null : lockRecord(text);
  if (record?.host !== lockHost() || !(await ownerEnded(record))) return;
  if (await removedFile(staged, io))
    onReclaim?.({
      code: 'WRITER_LOCK_RECLAIMED',
      severity: 'warning',
      message: `Removed ${staged}, a lock record staged by process ${record.pid}, which ended before taking the lock.`,
      lock: `${file}.lock`,
      ownerPid: record.pid,
      discarded: [staged],
    });
}

/**
 * Takes `<file>.lock` for `owner`, reclaiming a stale lock first (unless `reclaim` is false). Returns `{ owner, text }`
 * for releaseWriterLock, or `{ busy }` (writerLockBusyMessage says what it means).
 */
export async function takeWriterLock(file, { owner = newLockOwner(), io = fs, read, onReclaim, reclaim = true } = {}) {
  const name = `${file}.lock`;
  hold(owner);
  try {
    for (;;) {
      const text = await createLock(name, owner, io);
      if (text) return { owner, text };
      const found = await reclaimWriterLock(file, { io, read, onReclaim, reclaim });
      if (found.busy) {
        drop(owner);
        return found;
      }
    }
  } catch (error) {
    drop(owner);
    throw error;
  }
}

/** Removes `<file>.lock` when it still holds what takeWriterLock wrote. */
export async function releaseWriterLock(file, taken, { io = fs, read } = {}) {
  const name = `${file}.lock`;
  try {
    if ((await readLockText(io, read)(name)) === taken.text) await io.unlink(name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    drop(taken.owner);
  }
}

/** One line for a lock takeWriterLock found busy: who holds it and what to do. `journal`: a publication is pending. */
export function writerLockBusyMessage({ kind, lock, record, journal = false }) {
  const file = lock.slice(0, -'.lock'.length);
  const remove = journal
    ? `delete ${lock} and restart: the pending transaction journal then completes or rolls back the publication`
    : `delete ${lock} and its leftover ${file}.*.tmp and ${file}.paqvilo-*.bak files, then retry`;
  switch (kind) {
    case 'live':
      return `A writer owns ${lock}: process ${record.pid} on this host is still running; retry after it finishes.`;
    case 'reclaiming': {
      const recoverer = record ? 'process ' + record.pid : 'another process';
      return `${lock} is being recovered by ${recoverer}; retry after it finishes.`;
    }
    case 'foreign':
      return `A writer on ${record.host} owns ${lock} (process ${record.pid}); this host cannot tell whether it still runs. If no Mirage runtime on ${record.host} uses these files, delete ${lock} and retry.`;
    case 'ended':
      return `${lock} belongs to process ${record.pid}, which has ended, but the pending transaction journal does not name it, so it is not reclaimed automatically. If no Mirage runtime uses these files, ${remove}.`;
    default:
      return `${lock} does not name an owner this toolkit can check (an older toolkit's lock, or one interrupted while it was created). If no Mirage runtime uses these files, ${remove}.`;
  }
}

async function durableWrite(file, value, io) {
  const handle = await io.open(file, 'wx', 0o600);
  let failed;
  try {
    await handle.writeFile(value);
    await handle.sync();
  } catch (error) {
    failed = error;
  } finally {
    await handle.close();
  }
  if (failed) {
    await io.rm(file, { force: true }).catch(() => {});
    throw failed;
  }
}

/** Recovery only follows journal entries matching this runtime's declared file
 * set. Unknown file contents are never overwritten, including during rollback. */
/* NOSONAR: preserve transaction and recovery await boundaries */ async function readJournal(journalFile, allowed, io) {
  let journal;
  try {
    journal = JSON.parse(await readDeclaredFile(journalFile, io, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw failure('Cannot read the pack transaction journal.', 'PersistenceRecoveryRequired');
  }
  if (
    !journal ||
    typeof journal !== 'object' ||
    ![1, 2].includes(journal.version) ||
    !/^[a-f\d-]{36}$/i.test(journal.token) ||
    !['prepared', 'committed'].includes(journal.phase) ||
    !Array.isArray(journal.entries) ||
    !journal.entries.length
  )
    throw failure('Invalid pack transaction journal; restore it before restarting.', 'PersistenceRecoveryRequired');
  if (
    journal.version === 2 &&
    (!/^[1-9]\d*:[a-f\d-]{36}$/i.test(journal.lockOwner ?? '') ||
      !Number.isSafeInteger(Number(journal.lockOwner.split(':')[0])) ||
      !Array.isArray(journal.lockFiles) ||
      journal.lockFiles.length !== allowed.size ||
      new Set(journal.lockFiles).size !== allowed.size ||
      journal.lockFiles.some((file) => !allowed.has(file)))
  )
    throw failure('Pack journal lock ownership does not match the declared files.', 'PersistenceRecoveryRequired');
  const entries = journal.entries;
  const seen = new Set();
  for (const entry of entries) {
    if (
      !entry ||
      !allowed.has(entry.file) ||
      seen.has(entry.file) ||
      entry.temp !== companion(entry.file, journal.token, 'tmp') ||
      entry.backup !== companion(entry.file, journal.token, 'bak') ||
      !/^[a-f\d]{64}$/.test(entry.after) ||
      (entry.before !== null && !/^[a-f\d]{64}$/.test(entry.before))
    )
      throw failure('Pack journal does not match the declared data files.', 'PersistenceRecoveryRequired');
    seen.add(entry.file);
    const actual = await currentDigest(entry.file, io);
    if (journal.phase === 'prepared' && actual !== entry.before && actual !== entry.after)
      throw failure(`Pack recovery found an external change in ${entry.file}.`, 'PersistenceRecoveryRequired');
    if (
      journal.phase === 'prepared' &&
      entry.before !== null &&
      (await currentDigest(entry.backup, io)) !== entry.before
    )
      throw failure(`Pack recovery backup is missing or changed for ${entry.file}.`, 'PersistenceRecoveryRequired');
  }
  return journal;
}

/* NOSONAR: preserve transaction and recovery await boundaries */ async function recover(journalFile, allowed, io) {
  const journal = await readJournal(journalFile, allowed, io);
  if (!journal) return;
  const entries = journal.entries;
  if (journal.phase === 'prepared')
    for (const entry of [...entries].reverse()) {
      if ((await currentDigest(entry.file, io)) !== entry.after) continue;
      if (entry.before === null) await io.unlink(entry.file);
      else {
        // Restore through an owned replacement. copyFile onto the destination
        // would follow a concurrently replaced symlink outside the declared set.
        await io.rm(entry.temp, { force: true });
        if ((await currentDigest(entry.backup, io)) !== entry.before)
          throw failure('Pack recovery backup changed.', 'PersistenceRecoveryRequired');
        await io.copyFile(entry.backup, entry.temp, constants.COPYFILE_EXCL);
        if (
          (await currentDigest(entry.temp, io)) !== entry.before ||
          (await currentDigest(entry.file, io)) !== entry.after
        )
          throw failure('Pack recovery path changed before restoration.', 'PersistenceRecoveryRequired');
        await renameThroughSharingHoldsAsync(io, entry.temp, entry.file);
      }
    }
  for (const entry of entries) {
    await io.rm(entry.temp, { force: true });
    await io.rm(entry.backup, { force: true });
  }
  await io.rm(companion(journalFile, journal.token, 'tmp'), { force: true });
  await io.unlink(journalFile);
}

/** With a pending journal, only the locks of the exact owner it names are reclaimed, once every one of them is checked. */
/* NOSONAR: preserve transaction and recovery await boundaries */ async function reclaimJournalLocks(
  journalFile,
  files,
  io,
  onReclaim,
) {
  const journal = await readJournal(journalFile, new Set(files), io);
  if (journal?.version !== 2) return;
  const read = (name) => readDeclaredFile(name, io, 'utf8');
  const judged = [];
  for (const file of journal.lockFiles) {
    const found = await reclaimWriterLock(file, { io, read, reclaim: false, journalOwner: journal.lockOwner });
    if (found.busy?.kind !== 'ended' && !found.free) return;
    if (found.busy) judged.push(file);
  }
  for (const file of judged) {
    const found = await reclaimWriterLock(file, { io, read, onReclaim, journalOwner: journal.lockOwner });
    if (found.busy || found.changed)
      throw failure('A pack lock changed before recovery.', 'PersistenceRecoveryRequired');
  }
}

async function journalPending(journalFile, io) {
  try {
    await io.access(journalFile);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/* NOSONAR: preserve transaction and recovery await boundaries */ async function locks(
  files,
  io,
  journalFile,
  onReclaim,
) {
  // A dead writer's lock is reclaimed through its journal when one is pending, else from the lock's own record.
  const journal = Boolean(journalFile) && (await journalPending(journalFile, io));
  if (journal) await reclaimJournalLocks(journalFile, files, io, onReclaim);
  const owner = newLockOwner(),
    read = (name) => readDeclaredFile(name, io, 'utf8'),
    owned = [];
  const release = async () => {
    for (const taken of /* NOSONAR */ owned.reverse()) {
      // NOSONAR: retain in-place receiver mutation and ordering
      await releaseWriterLock(taken.file, taken, { io, read });
    }
  };
  try {
    for (const file of [...files]./* NOSONAR */ sort()) {
      // NOSONAR: preserve default coercion and UTF-16 sort order
      const taken = await takeWriterLock(file, { owner, io, read, onReclaim, reclaim: !journal });
      if (taken.busy) throw failure(writerLockBusyMessage({ ...taken.busy, journal }));
      owned.push({ ...taken, file });
    }
    release.owner = owner;
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

/** Startup recovery: completes or rolls back a pending journal, and reclaims the locks of writers that have ended. */
export async function recoverTransactionalFiles({ journalFile, files, io = fs, onReclaim }) {
  if (await journalPending(journalFile, io)) {
    const release = await locks(files, io, journalFile, onReclaim);
    try {
      await recover(journalFile, new Set(files), io);
    } finally {
      await release();
    }
  }
  // A live, foreign or unidentified lock is left as it is: the first write reports it.
  const read = (name) => readDeclaredFile(name, io, 'utf8');
  for (const file of files) await recoverWriterLock(file, { io, read, onReclaim });
}

/** Locked compare-and-swap publication with rollback and an on-disk recovery
 * journal. Every output is prepared before the first replacement. Cooperating
 * runtimes serialize; external content changes fail rather than being rebased. */
/* NOSONAR: preserve transaction and recovery await boundaries */ export async function publishTransactionalFiles({
  entries,
  journalFile,
  io = fs,
  verify = async () => {},
  allowedFiles = entries.map((entry) => entry.file),
  onReclaim,
}) {
  if (!entries.length) return [];
  const files = entries.map((entry) => entry.file);
  if (new Set(files).size !== files.length)
    throw failure('A transaction names the same data file twice.', 'InvalidPackData', 400);
  await io.mkdir(path.dirname(journalFile), { recursive: true });
  const lockFiles = [...new Set(allowedFiles)].sort(); // NOSONAR: preserve default coercion and UTF-16 sort order
  const release = await locks(lockFiles, io, journalFile, onReclaim);
  // Companions carry the lock owner's nonce, so a reclaim of this writer's locks finds exactly its leftovers.
  const token = nonceOf(release.owner),
    prepared = [];
  let journalWritten = false,
    committed = false;
  try {
    await recover(journalFile, new Set(allowedFiles), io);
    await verify();
    for (const entry of entries) {
      const before = await currentDigest(entry.file, io);
      if (before !== entry.expectedDigest || (entry.existingOnly && before === null))
        throw failure(
          `Data changed outside this runtime: ${entry.file}. Restart from the updated pack before writing.`,
        );
      const item = {
        file: entry.file,
        before,
        temp: companion(entry.file, token, 'tmp'),
        backup: companion(entry.file, token, 'bak'),
      };
      prepared.push(item);
      await writeJsonStream(item.temp, entry.value);
      item.after = await currentDigest(item.temp, io);
      if (before !== null) {
        await io.copyFile(entry.file, item.backup, constants.COPYFILE_EXCL);
        const backup = await io.open(item.backup, 'r+');
        try {
          await backup.sync();
        } finally {
          await backup.close();
        }
      }
    }
    // Recheck the whole set before publication, not just each file at preparation.
    await verify();
    for (const item of prepared)
      if ((await currentDigest(item.file, io)) !== item.before)
        throw failure(`Data changed while preparing ${item.file}.`);
    await durableWrite(
      journalFile,
      JSON.stringify({ version: 2, token, phase: 'prepared', entries: prepared, lockOwner: release.owner, lockFiles }),
      io,
    );
    journalWritten = true;
    for (const item of prepared) {
      if ((await currentDigest(item.file, io)) !== item.before)
        throw failure(`Data changed before publishing ${item.file}.`);
      await renameThroughSharingHoldsAsync(io, item.temp, item.file);
    }
    const marker = companion(journalFile, token, 'tmp');
    await durableWrite(
      marker,
      JSON.stringify({ version: 2, token, phase: 'committed', entries: prepared, lockOwner: release.owner, lockFiles }),
      io,
    );
    await renameThroughSharingHoldsAsync(io, marker, journalFile);
    committed = true;
    return prepared.map((item) => ({ file: item.file, digest: item.after }));
  } catch (error) {
    if (journalWritten) {
      try {
        await recover(journalFile, new Set(allowedFiles), io);
        journalWritten = false;
      } catch (recoveryError) {
        throw failure(
          `Publication failed and requires recovery: ${recoveryError.message}`,
          'PersistenceRecoveryRequired',
          500,
        );
      }
    }
    error.persistenceFailure = true;
    throw error;
  } finally {
    // Once committed, cleanup failure cannot turn durable success into rollback.
    if (committed) await recover(journalFile, new Set(allowedFiles), io).catch(() => {});
    else if (!journalWritten)
      for (const item of prepared) {
        await io.rm(item.temp, { force: true }).catch(() => {});
        await io.rm(item.backup, { force: true }).catch(() => {});
      }
    if (committed) await release().catch(() => {});
    else await release();
  }
}
