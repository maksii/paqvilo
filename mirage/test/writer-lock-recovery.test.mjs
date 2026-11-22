// @test-kind contract: Paqvilo design: a writer lock names its owner and a lock whose writer has ended is reclaimed, reported and its unpublished files discarded at the next start (mirage/docs/simulation-levels.md "Publication, conflicts and recovery"; mirage/docs/state-storage.md "Write integrity")
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { createSimulator } from '../api.mjs';
import { DataStore } from '../lib/data.mjs';
import {
  publishTransactionalFiles,
  recoverWriterLock,
  releaseWriterLock,
  takeWriterLock,
  writerLockBusyMessage,
} from '../lib/transactional-files.mjs';
import { stateFileEndpoint } from '../lib/state-file-claim.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { SCENARIO_HANG_GUARD_MS } from '../../test/helpers/bounded-command.mjs';

const CHILD = fileURLToPath(new URL('./fixtures/writer-lock-child.mjs', import.meta.url));
const HOST = `${process.platform}/${os.hostname()}`;
const ENTITY =
  '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>';

async function directory(t) {
  // Persistence refuses declared files below a symbolic link (lib/transactional-files.mjs), and a runner's temporary
  // directory may be one (a symlinked TMPDIR, macOS /var): start from its real path.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'writer-lock-')));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** A standalone project: `pack` declares a DATA file at level simulation, otherwise the state file alone persists. */
async function project(t, mode) {
  const root = await directory(t);
  const files = {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedLocks</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': ENTITY,
    'data.json': JSON.stringify({ items: [] }),
    'pack.mjs':
      "export default { id: 'invented-locks', name: 'Invented', description: 'Invented', matches: () => true, presets: () => ({})," +
      " dataFiles: [{ file: 'data.json', tables: { x_item: { path: ['items'], idColumn: 'x_itemid' } } }] };",
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  const options = {
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    stateFile: path.join(root, 'state', 'state.json'),
    dataverse: { enabled: true, port: 0, tls: false, tds: { enabled: false } },
    ...(mode === 'pack' ? { simulation: { level: 'simulation' }, packs: [path.join(root, 'pack.mjs')] } : {}),
  };
  return { root, options, dataFile: path.join(root, 'data.json'), stateFile: options.stateFile };
}

/** Starts a runtime writer in a child, asks it to write one record and waits until that write reaches `gate`. */
async function gatedWriter(t, options, gate) {
  const child = spawn(process.execPath, [CHILD], {
    env: { ...process.env, WRITER_LOCK_CHILD: JSON.stringify({ options, gate }) },
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
      assert.ok(child.kill('SIGKILL'), 'Owned writer termination must be accepted');
      await exited;
    }
    // A killed writer leaves the socket of its claim on the state file; no later start of this test may take it over.
    if (process.platform !== 'win32' && options.stateFile)
      await fs.rm(await stateFileEndpoint(options.stateFile), { force: true });
  });
  const next = () =>
    Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(([code]) => {
        throw new Error(`Writer stopped (${code}): ${diagnostic}`);
      }),
    ]);
  assert.deepEqual(await next(), { ready: true });
  child.send('write');
  assert.deepEqual(await next(), { gate: gate.name }, diagnostic);
  return {
    child,
    kill: async () => {
      assert.ok(child.kill('SIGKILL'));
      await exited;
    },
  };
}

const leftovers = async (...directories) =>
  (await Promise.all(directories.map((entry) => fs.readdir(entry))))
    .flat()
    .filter((name) => name.endsWith('.lock') || name.includes('.paqvilo-'));

const PACK_GATES = [
  // Staged lock record written, the first lock not yet linked.
  { name: 'before-lock', op: 'link', suffix: 'data.json.lock', when: 'before', committed: false },
  // Every lock held, nothing prepared.
  { name: 'holding-lock', op: 'link', suffix: 'state.json.lock', when: 'after', committed: false },
  // Temporary and backup files prepared, no journal: the state left by `kill -9` in the reproduction.
  { name: 'after-tmp', op: 'open', suffix: 'pack-transaction.json', flag: 'wx', when: 'before', committed: false },
  // Journal written and the DATA file replaced: the journal rolls the publication back.
  { name: 'mid-publication', op: 'rename', suffix: 'data.json', when: 'after', committed: false },
  // Publication committed and its journal removed, the locks not yet released.
  { name: 'after-commit', op: 'unlink', suffix: 'pack-transaction.json', when: 'after', committed: true },
];
const STATE_GATES = [
  { name: 'before-lock', op: 'link', suffix: 'state.json.lock', when: 'before', committed: false },
  { name: 'holding-lock', op: 'link', suffix: 'state.json.lock', when: 'after', committed: false },
  // The checkpoint is written to its temporary file, not yet renamed over the state file.
  { name: 'after-tmp', op: 'rename', suffix: 'state.json', when: 'before', committed: false },
  // The checkpoint replaced the state file; the lock is not yet released.
  { name: 'after-rename', op: 'rename', suffix: 'state.json', when: 'after', committed: true },
];

for (const [mode, gates] of [
  ['pack', PACK_GATES],
  ['state', STATE_GATES],
])
  for (const gate of gates)
    // Hang guard only: a gated writer process that is killed, and a simulator start that recovers its lock.
    test(
      `a ${mode} writer killed at ${gate.name} is recovered and reported by the next start, which then writes`,
      { timeout: SCENARIO_HANG_GUARD_MS },
      async (t) => {
        const { root, options, dataFile, stateFile } = await project(t, mode);
        const writer = await gatedWriter(t, options, gate);
        await writer.kill();
        const sim = await createSimulator(options);
        ownedFixture(t).add(() => sim.close());
        // The reclaim is a runtime finding, served by the diagnostics API.
        const { diagnostics } = await (await fetch(`${sim.url}/_sim/api/diagnostics`)).json();
        const reclaimed = diagnostics.filter((entry) => entry.code === 'WRITER_LOCK_RECLAIMED');
        assert.ok(reclaimed.length > 0, JSON.stringify(diagnostics));
        for (const entry of reclaimed) {
          assert.equal(entry.ownerPid, writer.child.pid);
          assert.match(entry.message, new RegExp(`process ${writer.child.pid}`));
        }
        const names = () => sim.store.state.tables.x_item.map((row) => row.x_name);
        assert.deepEqual(names(), gate.committed ? ['Interrupted'] : []);
        await sim.store.create('x_item', { x_name: 'After restart' }, { admin: true });
        assert.deepEqual(names(), gate.committed ? ['Interrupted', 'After restart'] : ['After restart']);
        if (mode === 'pack')
          assert.deepEqual(
            JSON.parse(await fs.readFile(dataFile, 'utf8')).items.map((row) => row.x_name),
            names(),
          );
        assert.deepEqual(await leftovers(root, path.dirname(stateFile)), []);
      },
    );

test('a live writer keeps its lock: the conflict names its process, and the lock is reclaimed once it has ended', async (t) => {
  const { options, dataFile } = await project(t, 'pack');
  const writer = await gatedWriter(t, options, PACK_GATES[1]);
  const lock = `${dataFile}.lock`,
    before = await fs.readFile(lock, 'utf8');
  const taken = await takeWriterLock(dataFile);
  assert.equal(taken.busy?.kind, 'live');
  assert.equal(taken.busy.record.pid, writer.child.pid);
  assert.equal(
    writerLockBusyMessage(taken.busy),
    `A writer owns ${lock}: process ${writer.child.pid} on this host is still running; retry after it finishes.`,
  );
  const reported = [];
  await recoverWriterLock(dataFile, { onReclaim: (entry) => reported.push(entry) });
  assert.deepEqual(reported, []);
  assert.equal(await fs.readFile(lock, 'utf8'), before);
  await writer.kill();
  const retaken = await takeWriterLock(dataFile, { onReclaim: (entry) => reported.push(entry) });
  assert.equal(retaken.busy, undefined);
  assert.deepEqual(
    reported.map((entry) => entry.ownerPid),
    [writer.child.pid],
  );
  await releaseWriterLock(dataFile, retaken);
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

/** The pid of a process that has ended. */
async function endedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await once(child, 'exit');
  return child.pid;
}
const record = (pid, extra = {}) => {
  const owner = `${pid}:${randomUUID()}`;
  return { owner, text: JSON.stringify({ owner, pid, thread: 0, host: HOST, createdAt: 'invented', ...extra }) };
};

test('a lock taken on another host is never reclaimed and names that host', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'state.json');
  const store = await new DataStore({
    file,
    state: {
      mappings: { item: { idColumn: 'itemid' } },
      tables: { item: [] },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const foreign = record(await endedPid(), { host: 'linux/invented-other-host' });
  await fs.writeFile(`${file}.lock`, foreign.text);
  await assert.rejects(store.create('item', { itemid: 'blocked' }), (error) => {
    assert.equal(error.code, 'StateConflict');
    assert.match(error.message, /^A writer on linux\/invented-other-host owns .*state\.json\.lock/);
    assert.match(error.message, /If no Mirage runtime on linux\/invented-other-host uses these files, delete /);
    return true;
  });
  const entries = [{ file: path.join(root, 'data.json'), value: {}, expectedDigest: null }];
  await fs.writeFile(`${entries[0].file}.lock`, foreign.text);
  await assert.rejects(publishTransactionalFiles({ entries, journalFile: path.join(root, 'journal.json') }), {
    code: 'PackDataConflict',
    message: /^A writer on linux\/invented-other-host owns /,
  });
  assert.equal(await fs.readFile(`${file}.lock`, 'utf8'), foreign.text);
  assert.equal(await fs.readFile(`${entries[0].file}.lock`, 'utf8'), foreign.text);
});

test('an older toolkit lock is kept, and the conflict says which files to delete', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'state.json'),
    legacy = `${await endedPid()}:${randomUUID()}\n`;
  const store = await new DataStore({
    file,
    state: {
      mappings: { item: { idColumn: 'itemid' } },
      tables: { item: [] },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  await fs.writeFile(`${file}.lock`, legacy);
  await assert.rejects(store.create('item', { itemid: 'blocked' }), (error) => {
    assert.equal(error.code, 'StateConflict');
    assert.equal(
      error.message,
      `${file}.lock does not name an owner this toolkit can check (an older toolkit's lock, or one interrupted while it was created). If no Mirage runtime uses these files, delete ${file}.lock and its leftover ${file}.*.tmp and ${file}.paqvilo-*.bak files, then retry.`,
    );
    return true;
  });
  assert.equal(await fs.readFile(`${file}.lock`, 'utf8'), legacy);
});

test('a lock naming this process with a nonce it does not hold is reclaimed: its number was reused', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'state.json');
  const reused = record(process.pid, { thread: threadId });
  await fs.writeFile(`${file}.lock`, reused.text);
  await fs.writeFile(`${file}.paqvilo-${reused.owner.split(':')[1]}.tmp`, 'unpublished');
  const reported = [];
  const store = await new DataStore({
    file,
    state: {
      mappings: { item: { idColumn: 'itemid' } },
      tables: { item: [] },
      settings: { permissionMode: 'permissive' },
    },
    onLockRecovery: (entry) => reported.push(entry),
  }).init();
  assert.deepEqual(
    reported.map((entry) => [entry.ownerPid, entry.discarded.map((name) => path.basename(name))]),
    [[process.pid, [`state.json.paqvilo-${reused.owner.split(':')[1]}.tmp`]]],
  );
  assert.deepEqual(store.lockRecoveries, reported);
  await store.create('item', { itemid: 'written' });
  assert.deepEqual(await fs.readdir(root), ['state.json']);
});

test('starters racing to reclaim one stale lock: exactly one reclaims it and takes the lock', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'data.json');
  const stale = record(await endedPid());
  await fs.writeFile(`${file}.lock`, stale.text);
  await fs.writeFile(`${file}.paqvilo-${stale.owner.split(':')[1]}.bak`, 'unpublished');
  const script = `
    import { takeWriterLock } from ${JSON.stringify(new URL('../lib/transactional-files.mjs', import.meta.url).href)};
    process.on('message', async (message) => {
      if (message !== 'go') return process.exit(0);
      const reclaimed = [];
      const taken = await takeWriterLock(${JSON.stringify(file)}, { onReclaim: (entry) => reclaimed.push(entry.ownerPid) });
      process.send({ won: !taken.busy, kind: taken.busy?.kind ?? null, reclaimed });
    });
    process.send('ready');
  `;
  const starters = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: true,
    });
    const exited = once(child, 'exit');
    ownedFixture(t).add(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    });
    return { child, exited, ready: once(child, 'message') };
  });
  await Promise.all(starters.map((starter) => starter.ready));
  const results = starters.map((starter) => once(starter.child, 'message').then(([message]) => message));
  for (const starter of starters) starter.child.send('go');
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter((outcome) => outcome.won).length, 1, JSON.stringify(outcomes));
  assert.deepEqual(
    outcomes.flatMap((outcome) => outcome.reclaimed),
    [stale.owner.split(':').map(Number)[0]],
  );
  for (const outcome of outcomes.filter((item) => !item.won)) assert.ok(['live', 'reclaiming'].includes(outcome.kind));
  const winner = starters[outcomes.findIndex((outcome) => outcome.won)];
  assert.equal(JSON.parse(await fs.readFile(`${file}.lock`, 'utf8')).pid, winner.child.pid);
  assert.deepEqual((await fs.readdir(root)).sort(), ['data.json.lock']);
  for (const starter of starters) starter.child.send('exit');
  await Promise.all(starters.map((starter) => starter.exited));
});
