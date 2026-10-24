import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { writeJsonStream } from './state-stream.mjs';
import { DataError } from './data-error.mjs';

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
async function readJournal(journalFile, allowed, io) {
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

async function recover(journalFile, allowed, io) {
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
        await io.rename(entry.temp, entry.file);
      }
    }
  for (const entry of entries) {
    await io.rm(entry.temp, { force: true });
    await io.rm(entry.backup, { force: true });
  }
  await io.rm(companion(journalFile, journal.token, 'tmp'), { force: true });
  await io.unlink(journalFile);
}

async function reclaimJournalLocks(journalFile, files, io) {
  const journal = await readJournal(journalFile, new Set(files), io);
  if (journal?.version !== 2) return;
  const pid = Number(journal.lockOwner.split(':')[0]);
  try {
    process.kill(pid, 0);
    return;
  } catch (error) {
    if (error.code !== 'ESRCH') return;
  }
  const names = journal.lockFiles.map((file) => `${file}.lock`),
    stale = [];
  for (const name of names) {
    try {
      if ((await readDeclaredFile(name, io, 'utf8')) !== journal.lockOwner)
        throw failure('A pack lock is not owned by the interrupted journal.', 'PersistenceRecoveryRequired');
      stale.push(name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const name of stale) {
    if ((await readDeclaredFile(name, io, 'utf8')) !== journal.lockOwner)
      throw failure('A pack lock changed before recovery.', 'PersistenceRecoveryRequired');
    await io.unlink(name);
  }
}

async function locks(files, io, journalFile) {
  if (journalFile) await reclaimJournalLocks(journalFile, files, io);
  const token = `${process.pid}:${randomUUID()}`,
    owned = [];
  const release = async () => {
    for (const file of owned.reverse()) {
      try {
        if ((await readDeclaredFile(file, io, 'utf8')) === token) await io.unlink(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  };
  try {
    for (const file of [...files].sort()) {
      const name = `${file}.lock`;
      let handle;
      try {
        handle = await io.open(name, 'wx', 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') throw failure(`A writer owns ${name}; finish it before retrying.`);
        throw error;
      }
      owned.push(name);
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
    }
    release.owner = token;
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

export async function recoverTransactionalFiles({ journalFile, files, io = fs }) {
  try {
    await io.access(journalFile);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const release = await locks(files, io, journalFile);
  try {
    await recover(journalFile, new Set(files), io);
  } finally {
    await release();
  }
}

/** Locked compare-and-swap publication with rollback and an on-disk recovery
 * journal. Every output is prepared before the first replacement. Cooperating
 * runtimes serialize; external content changes fail rather than being rebased. */
export async function publishTransactionalFiles({
  entries,
  journalFile,
  io = fs,
  verify = async () => {},
  allowedFiles = entries.map((entry) => entry.file),
}) {
  if (!entries.length) return [];
  const files = entries.map((entry) => entry.file);
  if (new Set(files).size !== files.length)
    throw failure('A transaction names the same data file twice.', 'InvalidPackData', 400);
  await io.mkdir(path.dirname(journalFile), { recursive: true });
  const lockFiles = [...new Set(allowedFiles)].sort();
  const release = await locks(lockFiles, io, journalFile);
  const token = randomUUID(),
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
      await io.rename(item.temp, item.file);
    }
    const marker = companion(journalFile, token, 'tmp');
    await durableWrite(
      marker,
      JSON.stringify({ version: 2, token, phase: 'committed', entries: prepared, lockOwner: release.owner, lockFiles }),
      io,
    );
    await io.rename(marker, journalFile);
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
