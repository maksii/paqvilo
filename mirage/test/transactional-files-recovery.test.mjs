import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { publishTransactionalFiles, recoverTransactionalFiles } from '../lib/transactional-files.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-interrupted-files-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const files = ['one.json', 'two.json'].map((name) => path.join(directory, name));
  const before = files.map((_, index) => JSON.stringify({ value: `Original ${index}` }));
  await Promise.all(files.map((file, index) => fs.writeFile(file, before[index])));
  const entries = files.map((file, index) => ({
    file,
    value: { value: `Changed ${index}` },
    expectedDigest: hash(before[index]),
    existingOnly: true,
  }));
  return { directory, files, before, entries, journalFile: path.join(directory, 'transaction.json') };
}

async function interruptedWriter(t, fixture, alive = false) {
  const script = `
    import fs from 'node:fs/promises';
    import { publishTransactionalFiles } from ${JSON.stringify(new URL('../lib/transactional-files.mjs', import.meta.url).href)};
    const options = ${JSON.stringify({ entries: fixture.entries, journalFile: fixture.journalFile, allowedFiles: fixture.files })};
    const io = { ...fs, rename: async (from, to) => {
      await fs.rename(from, to);
      if (to === options.entries[0].file) {
        if (${alive}) { process.on('message', () => {}); process.send({ published: true }); await new Promise(() => {}); }
        else process.exit(77);
      }
    }};
    await publishTransactionalFiles({ ...options, io });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let diagnostic = '';
  child.stderr.on('data', (chunk) => {
    diagnostic += chunk;
  });
  const exited = once(child, 'exit');
  ownedFixture(t).add(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      assert.ok(child.kill(), 'Owned writer termination must be accepted');
      await exited;
    }
  });
  if (alive)
    await Promise.race([
      once(child, 'message'),
      exited.then(() => {
        throw Error(`Writer stopped before publication: ${diagnostic}`);
      }),
    ]);
  else assert.equal((await exited)[0], 77, diagnostic);
  return { child, exited };
}

test('a journal-owned crashed writer is recovered before restart, with a no-op subsequent recovery', async (t) => {
  const f = await fixture(t);
  await interruptedWriter(t, f);
  assert.equal(JSON.parse(await fs.readFile(f.files[0], 'utf8')).value, 'Changed 0');
  assert.equal(await fs.readFile(f.files[1], 'utf8'), f.before[1]);
  let restorations = 0;
  const io = {
    ...fs,
    copyFile: (...args) => {
      assert.ok(
        !f.files.includes(args[1]),
        'Rollback copies into an owned replacement, never a destination that could be swapped to a symlink.',
      );
      restorations++;
      return fs.copyFile(...args);
    },
  };
  await recoverTransactionalFiles({ journalFile: f.journalFile, files: f.files, io });
  assert.ok(restorations > 0);
  assert.deepEqual(await Promise.all(f.files.map((file) => fs.readFile(file, 'utf8'))), f.before);
  const stats = await Promise.all(f.files.map((file) => fs.stat(file)));
  await recoverTransactionalFiles({ journalFile: f.journalFile, files: f.files });
  assert.deepEqual(
    (await Promise.all(f.files.map((file) => fs.stat(file)))).map((stat) => stat.mtimeMs),
    stats.map((stat) => stat.mtimeMs),
  );
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['one.json', 'two.json']);
});

test('a live journal owner is never reclaimed, then recovery succeeds after that owned child stops', async (t) => {
  const f = await fixture(t),
    { child, exited } = await interruptedWriter(t, f, true);
  await assert.rejects(recoverTransactionalFiles({ journalFile: f.journalFile, files: f.files }), {
    code: 'PackDataConflict',
  });
  child.kill();
  await exited;
  await recoverTransactionalFiles({ journalFile: f.journalFile, files: f.files });
  assert.deepEqual(await Promise.all(f.files.map((file) => fs.readFile(file, 'utf8'))), f.before);
});

test('foreign lock tokens and legacy journals remain refused without deleting either lock', async (t) => {
  const f = await fixture(t);
  await interruptedWriter(t, f);
  const original = await fs.readFile(`${f.files[0]}.lock`, 'utf8'),
    foreign = `${process.pid}:${randomUUID()}`;
  await fs.writeFile(`${f.files[0]}.lock`, foreign);
  await assert.rejects(recoverTransactionalFiles({ journalFile: f.journalFile, files: f.files }), {
    code: 'PersistenceRecoveryRequired',
  });
  assert.equal(await fs.readFile(`${f.files[0]}.lock`, 'utf8'), foreign);
  assert.equal(await fs.readFile(`${f.files[1]}.lock`, 'utf8'), original);
  await fs.writeFile(`${f.files[0]}.lock`, original);
  const journal = JSON.parse(await fs.readFile(f.journalFile, 'utf8'));
  journal.version = 1;
  delete journal.lockFiles;
  delete journal.lockOwner;
  await fs.writeFile(f.journalFile, JSON.stringify(journal));
  await assert.rejects(recoverTransactionalFiles({ journalFile: f.journalFile, files: f.files }), {
    code: 'PackDataConflict',
  });
  assert.equal(await fs.readFile(`${f.files[0]}.lock`, 'utf8'), original);
});

test('locks with no ownership journal are never reclaimed', async (t) => {
  const f = await fixture(t),
    token = `2147483646:${randomUUID()}`;
  await fs.writeFile(`${f.files[0]}.lock`, token);
  await assert.rejects(publishTransactionalFiles({ ...f, allowedFiles: f.files }), { code: 'PackDataConflict' });
  assert.equal(await fs.readFile(`${f.files[0]}.lock`, 'utf8'), token);
  assert.deepEqual(await Promise.all(f.files.map((file) => fs.readFile(file, 'utf8'))), f.before);
});

test('recovery refuses a destination symlink before following it or reclaiming locks', async (t) => {
  const f = await fixture(t);
  await interruptedWriter(t, f);
  const outside = path.join(f.directory, 'outside.json'),
    bytes = await fs.readFile(f.files[0]);
  await fs.writeFile(outside, bytes);
  await fs.unlink(f.files[0]);
  try {
    await fs.symlink(outside, f.files[0], 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`File symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(recoverTransactionalFiles({ journalFile: f.journalFile, files: f.files }), {
    code: 'PersistenceRecoveryRequired',
  });
  assert.deepEqual(await fs.readFile(outside), bytes);
  assert.equal((await fs.lstat(f.files[0])).isSymbolicLink(), true);
  assert.ok(await fs.stat(`${f.files[0]}.lock`));
});

test('recovery validates companion symlinks before reading backup content', async (t) => {
  const f = await fixture(t);
  await interruptedWriter(t, f);
  const journal = JSON.parse(await fs.readFile(f.journalFile, 'utf8')),
    backup = journal.entries[0].backup;
  let followed = false;
  const io = {
    ...fs,
    lstat: (file) =>
      file === backup ? Promise.resolve({ isSymbolicLink: () => true, isFile: () => false }) : fs.lstat(file),
    readFile: (...args) => {
      if (args[0] === backup) followed = true;
      return fs.readFile(...args);
    },
  };
  await assert.rejects(recoverTransactionalFiles({ journalFile: f.journalFile, files: f.files, io }), {
    code: 'PersistenceRecoveryRequired',
  });
  assert.equal(followed, false);
});

test('recovery refuses a changed physical parent path before restoring or reclaiming locks', async (t) => {
  const f = await fixture(t);
  await interruptedWriter(t, f);
  const io = {
    ...fs,
    realpath: (file) =>
      file === f.files[0] ? Promise.resolve(path.join(f.directory, 'outside', 'one.json')) : fs.realpath(file),
  };
  await assert.rejects(recoverTransactionalFiles({ journalFile: f.journalFile, files: f.files, io }), {
    code: 'PersistenceRecoveryRequired',
  });
  assert.equal(JSON.parse(await fs.readFile(f.files[0], 'utf8')).value, 'Changed 0');
  assert.ok(await fs.stat(`${f.files[0]}.lock`));
});

test('publication refuses a replaced path and closes its validated read descriptor', async (t) => {
  const f = await fixture(t);
  let swapped = false,
    closed = false,
    read = false;
  const io = {
    ...fs,
    open: async (file, ...options) => {
      const handle = await fs.open(file, ...options);
      if (file !== f.files[0] || swapped) return handle;
      swapped = true;
      await fs.rename(file, `${file}.original`);
      await fs.writeFile(file, 'foreign replacement');
      return {
        stat: () => handle.stat(),
        readFile: (...args) => {
          read = true;
          return handle.readFile(...args);
        },
        close: async () => {
          closed = true;
          await handle.close();
        },
      };
    },
  };
  await assert.rejects(publishTransactionalFiles({ ...f, io }), { code: 'PersistenceRecoveryRequired' });
  assert.equal(read, false, 'A descriptor that no longer names the declared file is not consumed.');
  assert.equal(closed, true);
  assert.equal(await fs.readFile(f.files[0], 'utf8'), 'foreign replacement');
  assert.equal(await fs.readFile(`${f.files[0]}.original`, 'utf8'), f.before[0]);
});

test(
  'transaction publication accepts a Windows 8.3 parent alias without changing declared file identities',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t);
    // Static interop source; the owned fixture path is passed as data in the child
    // environment, never interpolated into shell commands or executable source.
    const script = `
    Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public class PaqviloShortPath { [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetShortPathName(string path, StringBuilder output, uint size); }';
    $short = New-Object System.Text.StringBuilder 32768;
    if ([PaqviloShortPath]::GetShortPathName($env:PAQVILO_TEST_SHORT_PATH, $short, $short.Capacity) -eq 0) { exit 2; }
    [Console]::Write($short.ToString());
  `;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, PAQVILO_TEST_SHORT_PATH: f.directory },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const shortRoot = result.stdout.trim();
    if (shortRoot.toLowerCase() === (await fs.realpath(f.directory)).toLowerCase()) {
      t.skip('8.3 aliases are disabled on the fixture volume.');
      return;
    }
    assert.equal(await fs.realpath(shortRoot), await fs.realpath(f.directory));
    const files = f.files.map((file) => path.join(shortRoot, path.basename(file)));
    await publishTransactionalFiles({
      entries: f.entries.map((entry, index) => ({ ...entry, file: files[index] })),
      files,
      allowedFiles: files,
      journalFile: path.join(shortRoot, 'transaction.json'),
    });
    assert.deepEqual(
      await Promise.all(f.files.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8')))),
      f.entries.map((entry) => entry.value),
    );
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['one.json', 'two.json']);
  },
);

// Windows junctions need no symlink privilege; POSIX exercises the same ancestor-link refusal with a directory symlink.
test('transaction publication refuses an ancestor junction or directory link instead of treating it as a path alias', async (t) => {
  const f = await fixture(t),
    alias = path.join(f.directory, 'junction');
  await fs.symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const files = f.files.map((file) => path.join(alias, path.basename(file)));
  await assert.rejects(
    publishTransactionalFiles({
      entries: f.entries.map((entry, index) => ({ ...entry, file: files[index] })),
      allowedFiles: files,
      journalFile: path.join(alias, 'transaction.json'),
    }),
    { code: 'PersistenceRecoveryRequired' },
  );
  assert.deepEqual(await Promise.all(f.files.map((file) => fs.readFile(file, 'utf8'))), f.before);
});
