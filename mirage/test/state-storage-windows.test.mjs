import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DataStore } from '../lib/data.mjs';
import { stateFileSignature } from '../lib/state-storage.mjs';

// .NET retains NTFS's 100 ns timestamp precision; fs.utimes(Date) would round
// the timestamp and test an ordinary detectable edit instead of this boundary.
const preserveTimestampEdit = `
$ErrorActionPreference = 'Stop'
$taskPath = $env:PAQ_STORAGE_FIXTURE
$taskTimestamp = [IO.File]::GetLastWriteTimeUtc($taskPath)
$taskBytes = [IO.File]::ReadAllBytes($taskPath)
$taskOffset = [Text.Encoding]::UTF8.GetString($taskBytes).LastIndexOf('"step"', [StringComparison]::Ordinal)
if ($taskOffset -lt 0) { throw 'Fixture marker not found' }
$taskReplacement = [Text.Encoding]::UTF8.GetBytes('"evil"')
$taskHandle = [IO.File]::Open($taskPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
try { $taskHandle.Position = $taskOffset; $taskHandle.Write($taskReplacement, 0, $taskReplacement.Length); $taskHandle.Flush($true) }
finally { $taskHandle.Dispose() }
[IO.File]::SetLastWriteTimeUtc($taskPath, $taskTimestamp)
`;

// POSIX keeps the change timestamp in the signature, so the same in-place edit with an exactly restored
// modification time (touch -r copies nanoseconds) is a StateConflict before any write.
for (const journal of [false, true])
  test(
    `POSIX change time detects a metadata-preserving in-place edit (${journal ? 'journal' : 'JSON'})`,
    {
      skip: process.platform === 'win32' ? 'Windows excludes ChangeTime; covered by the Windows boundary test' : false,
    },
    async (t) => {
      const root = await fs.mkdtemp(join(tmpdir(), 'paqvilo-posix-state-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const file = join(root, 'state.json'),
        reference = join(root, 'timestamps'),
        persistence = { journalThresholdBytes: journal ? 0 : Number.MAX_SAFE_INTEGER };
      const store = await new DataStore({
        file,
        persistence,
        state: {
          settings: { permissionMode: 'permissive' },
          mappings: { item: { idColumn: 'itemid', entitySet: 'items' } },
          tables: { item: [{ itemid: 'one', name: 'seed' }] },
        },
      }).init();
      await store.update('items', 'one', { name: 'step' });
      const touch = (...args) => {
        const result = spawnSync('touch', args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
      };
      await fs.writeFile(reference, '');
      touch('-r', file, reference);
      const before = await fs.stat(file, { bigint: true });
      // Linux stamps ctime from a coarse clock (one tick can be 10 ms): an edit in the tick of the last save would
      // keep ctime and test nothing. Rewrite the reference until its ctime passes the state file's.
      while ((await fs.stat(reference, { bigint: true })).ctimeNs <= before.ctimeNs) touch('-r', file, reference);
      const text = await fs.readFile(file, 'utf8'),
        offset = Buffer.byteLength(text.slice(0, text.lastIndexOf('"step"')));
      const handle = await fs.open(file, 'r+');
      try {
        await handle.write(Buffer.from('"evil"'), 0, 6, offset);
      } finally {
        await handle.close();
      }
      touch('-r', reference, file);
      const after = await fs.stat(file, { bigint: true });
      assert.deepEqual(
        [after.ino, after.size, after.mtimeNs],
        [before.ino, before.size, before.mtimeNs],
        'the edit must preserve identity, size and the exact modification time',
      );
      assert.notEqual(stateFileSignature(after), stateFileSignature(before));
      await assert.rejects(store.update('items', 'one', { note: 'refused' }), { code: 'StateConflict' });
      assert.ok((await fs.readFile(file, 'utf8')).includes('"evil"'));
    },
  );

for (const journal of [false, true])
  test(
    `Windows metadata-preserving edits match the documented ${journal ? 'journal checksum' : 'JSON replacement'} boundary`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const root = await fs.mkdtemp(join(tmpdir(), 'paqvilo-windows-state-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const file = join(root, 'state.json'),
        persistence = { journalThresholdBytes: journal ? 0 : Number.MAX_SAFE_INTEGER };
      const store = await new DataStore({
        file,
        persistence,
        state: {
          settings: { permissionMode: 'permissive' },
          mappings: { item: { idColumn: 'itemid', entitySet: 'items' } },
          tables: { item: [{ itemid: 'one', name: 'seed' }] },
        },
      }).init();
      await fs.readFile(file);
      await fs.copyFile(file, join(root, 'backup.json'));
      await store.update('items', 'one', { name: 'step' });
      const before = stateFileSignature(await fs.stat(file, { bigint: true }));
      const edited = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(preserveTimestampEdit, 'utf16le').toString('base64'),
        ],
        {
          env: { ...process.env, PAQ_STORAGE_FIXTURE: file },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
        },
      );
      assert.equal(edited.status, 0, edited.stderr || edited.error?.message);
      assert.equal(
        stateFileSignature(await fs.stat(file, { bigint: true })),
        before,
        'the edit must preserve every checked metadata field',
      );
      assert.ok((await fs.readFile(file, 'utf8')).includes('"evil"'));
      await store.update('items', 'one', { note: 'acknowledged' });
      if (journal) await assert.rejects(new DataStore({ file, persistence }).init(), { code: 'StateIntegrity' });
      else {
        const reloaded = await new DataStore({ file, persistence }).init();
        assert.equal(reloaded.state.tables.item[0].name, 'step');
        assert.equal(reloaded.state.tables.item[0].note, 'acknowledged');
      }
    },
  );
