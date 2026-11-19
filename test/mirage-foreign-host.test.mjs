// @test-kind contract: Mirage runtime records stamped with another host are never judged, pruned, removed or signalled here, a start on their state file is refused, and the record folders a status reads exist and are read once
// Runners that share a checkout or a home folder across hosts (Windows and WSL, several containers) see each other's
// records; a PID in one names nothing in another, and every host's PIDs start at the same numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  discoveries,
  mirageStatus,
  miragePaths,
  ownedSessions,
  print,
  recordFolders,
  start,
  stopExitStatus,
  stopOwnedSessions,
  updateOwnedSessions,
} from '../lense/commands/mirage.mjs';
import { runMirage, runtimeHost } from './helpers/mirage-in-process.mjs';
import { START_CHANNEL_ENV, startChannelReporter } from '../lense/start-channel.mjs';
import { createFixture, tempDir } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { captureConsoleOutput, readyRuntime } from './helpers/mirage-session-doubles.mjs';

// Invented host names: the injected one is this process's, the other one wrote the foreign records.
const HERE = 'win32/this-runner';
const ELSEWHERE = 'linux/other-runner';
// Invented PIDs. Tests inject `alive`, `identityOf` and `kill` for them, so no real process table is read or signalled.
const FOREIGN_GONE = 777101;
const FOREIGN_SHARED = 777102;
const LOCAL_GONE = 777103;
const UNOWNED_GONE = 777104;
const STAMPED_GONE = 777105;
const COLLIDING = 777201;
const STARTING = 777202;
const CHILD = 4343;
const reason = (paths) =>
  `it was started on ${ELSEWHERE}; stop it there. If it no longer runs on ${ELSEWHERE} (the host was renamed or removed), delete its entry from ${paths.ownershipFile}`;

/** A state folder of the test, run from an empty folder of its own: a start notes its record folder in a project folder. */
async function fixture(t) {
  const root = await tempDir('paq-foreign-host-');
  const cwd = path.join(root, 'empty');
  await fs.mkdir(cwd);
  const previous = process.cwd();
  process.chdir(cwd);
  // A closer, so a failing removal cannot leave the working directory changed for the next test.
  ownedFixture(t).add(() => process.chdir(previous));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const paths = miragePaths({ stateDir });
  await fs.mkdir(paths.discoveryRoot, { recursive: true });
  const cfg = { stateDir, runtime: { kind: 'model-driven' }, siteName: 'invented' };
  return { root, cwd, cfg, paths, stateFile: path.join(root, 'state.json') };
}

const discoveryOf = (paths, pid) => path.join(paths.discoveryRoot, `session-${pid}.json`);
async function publish(paths, pid, extra = {}) {
  await fs.writeFile(discoveryOf(paths, pid), JSON.stringify({ pid, url: 'http://127.0.0.1:9/', ...extra }));
}
const record = (paths, pid, { host, stateFile, sourceDir = null } = {}) => ({
  pid,
  processIdentity: `identity of ${pid}`,
  ...(host ? { host } : {}),
  discovery: discoveryOf(paths, pid),
  url: 'http://127.0.0.1:9/',
  sourceDir,
  stateFile,
  identity: {
    stateFile,
    runtime: { kind: 'model-driven' },
    solutionOrder: 'derived',
    solutionRoots: [],
    requestedPort: '0',
  },
  ready: true,
});
// Every recorded process still has its recorded identity: only the host can keep a record from being acted on.
const recordedIdentity = async (_pid, { recorded } = {}) => recorded;

test('stop never prunes, signals or removes the discovery of a record stamped with another host; a record without a host is local', async (t) => {
  const { paths, stateFile } = await fixture(t);
  for (const pid of [FOREIGN_GONE, FOREIGN_SHARED, LOCAL_GONE]) await publish(paths, pid);
  await updateOwnedSessions(paths, () => [
    record(paths, FOREIGN_GONE, { host: ELSEWHERE, stateFile }),
    // A local process holds the same number as this foreign record.
    record(paths, FOREIGN_SHARED, { host: ELSEWHERE, stateFile }),
    record(paths, LOCAL_GONE, { stateFile }),
  ]);
  const signals = [];
  const report = await stopOwnedSessions({
    paths,
    pids: [FOREIGN_GONE, FOREIGN_SHARED, LOCAL_GONE],
    hostName: HERE,
    // A signalled process ends, so a stop that wrongly signals the shared number fails here instead of waiting.
    alive: (pid) => pid === FOREIGN_SHARED && !signals.length,
    identityOf: recordedIdentity,
    kill: (pid, signal) => signals.push([pid, signal]),
  });
  assert.deepEqual(signals, [], 'no foreign record is signalled');
  assert.deepEqual(report.stopped, []);
  assert.deepEqual(
    report.unverified.map((item) => [item.pid, item.reason]),
    [
      [FOREIGN_GONE, reason(paths)],
      [FOREIGN_SHARED, reason(paths)],
    ],
  );
  assert.deepEqual(
    report.pruned.map((item) => item.pid),
    [LOCAL_GONE],
    'a record without a host is judged here, as before',
  );
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [FOREIGN_GONE, FOREIGN_SHARED],
  );
  assert.deepEqual(
    [FOREIGN_GONE, FOREIGN_SHARED, LOCAL_GONE].map((pid) => fsSync.existsSync(discoveryOf(paths, pid))),
    [true, true, false],
    'only the local exited runtime loses its discovery file',
  );
});

// A stale local record and another host's live runtime share one PID number, so one discovery file name.
test('stop prunes a stale local record but neither removes nor asks to shut down the other host runtime that has its file', async (t) => {
  const { paths, stateFile } = await fixture(t);
  const requests = [];
  const url = await readyRuntime(t, () => requests.push('request'));
  for (const pid of [COLLIDING, STARTING]) await publish(paths, pid, { host: ELSEWHERE, url });
  // The starting runtime has no URL of its own yet: stop would ask the one its discovery file names.
  await updateOwnedSessions(paths, () => [
    record(paths, COLLIDING, { stateFile }),
    { ...record(paths, STARTING, { stateFile }), url: null, ready: false },
  ]);
  const signals = [];
  const report = await stopOwnedSessions({
    paths,
    pids: [COLLIDING, STARTING],
    hostName: HERE,
    deadline: 0,
    alive: (pid) => pid === STARTING && !signals.length,
    identityOf: recordedIdentity,
    kill: (pid, signal) => signals.push([pid, signal]),
  });
  assert.deepEqual(requests, [], "no request reaches the other host's runtime");
  assert.deepEqual(
    report.pruned.map((item) => item.pid),
    [COLLIDING],
  );
  assert.deepEqual(
    report.stopped.map((item) => [item.pid, item.graceful]),
    [[STARTING, false]],
  );
  assert.deepEqual(report.removedDiscoveries, []);
  for (const pid of [COLLIDING, STARTING])
    assert.equal(JSON.parse(fsSync.readFileSync(discoveryOf(paths, pid), 'utf8')).host, ELSEWHERE);
});

// The child's PID number is that of another host's runtime, whose discovery file is in place before the child's own.
test("a start neither takes another host's discovery file for its child's nor removes it when the child is abandoned", async (t) => {
  const { cfg, paths, stateFile } = await fixture(t);
  const requests = [];
  const url = await readyRuntime(t, () => requests.push('request'));
  const child = Object.assign(new EventEmitter(), {
    pid: CHILD,
    exitCode: null,
    signalCode: null,
    unref() {},
    kill() {},
  });
  // A virtual clock: the start-up silence bound passes at the first wait, without real time.
  let clock = 0;
  await assert.rejects(
    start(
      cfg,
      { port: '0', state: stateFile, 'startup-timeout': '1000' },
      {
        paths,
        hostName: HERE,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        identityOf: async () => 'injected identity',
        spawnRuntime() {
          fsSync.writeFileSync(discoveryOf(paths, CHILD), JSON.stringify({ pid: CHILD, host: ELSEWHERE, url }));
          return child;
        },
      },
    ),
    /Mirage reported no start-up progress/,
  );
  assert.deepEqual(requests, [], "the other host's runtime is not asked for its status");
  assert.equal(JSON.parse(fsSync.readFileSync(discoveryOf(paths, CHILD), 'utf8')).host, ELSEWHERE);
  assert.deepEqual(await ownedSessions(paths), [], 'the abandoned child leaves no record');
});

test('discoveries neither list nor remove another host runtime: one its record names, or one stamped with its host', async (t) => {
  const { paths, stateFile } = await fixture(t);
  await publish(paths, FOREIGN_GONE);
  await publish(paths, UNOWNED_GONE);
  await publish(paths, STAMPED_GONE, { host: ELSEWHERE });
  await publish(paths, process.pid, { host: HERE });
  await updateOwnedSessions(paths, () => [record(paths, FOREIGN_GONE, { host: ELSEWHERE, stateFile })]);
  const found = await discoveries(paths, { probe: false, alive: (pid) => pid === process.pid, hostName: HERE });
  assert.deepEqual(
    found.map((session) => [session.pid, Object.hasOwn(session, 'host')]),
    [[process.pid, false]],
    'only the local runtime is listed, and a status report does not publish its machine name',
  );
  assert.deepEqual(
    [FOREIGN_GONE, UNOWNED_GONE, STAMPED_GONE].map((pid) => fsSync.existsSync(discoveryOf(paths, pid))),
    [true, false, true],
    'only the local discovery of an exited process is removed',
  );
});

test('status does not list a runtime recorded on another host, although a local process holds its number', async (t) => {
  const { paths, stateFile } = await fixture(t);
  await updateOwnedSessions(paths, () => [record(paths, FOREIGN_SHARED, { host: ELSEWHERE, stateFile })]);
  const sessions = await mirageStatus(paths, {
    hostName: HERE,
    alive: (pid) => pid === FOREIGN_SHARED,
    identityOf: recordedIdentity,
  });
  assert.deepEqual(sessions, []);
});

test('a start refuses a state file recorded for a runtime of another host, before spawning', async (t) => {
  const { cfg, paths, stateFile } = await fixture(t);
  await updateOwnedSessions(paths, () => [record(paths, FOREIGN_GONE, { host: ELSEWHERE, stateFile })]);
  let spawned = 0;
  await assert.rejects(
    start(
      cfg,
      { port: '0', state: stateFile },
      {
        paths,
        hostName: HERE,
        alive: () => false,
        identityOf: recordedIdentity,
        spawnRuntime() {
          spawned++;
          throw new Error('the refused start must not spawn');
        },
      },
    ),
    (error) => {
      assert.equal(
        error.message,
        `Mirage pid ${FOREIGN_GONE} on ${ELSEWHERE} is recorded for state file ${stateFile}; this host cannot see or stop that process. Stop it on ${ELSEWHERE} (which also clears its record) or pass --state <other file>. If it no longer runs on ${ELSEWHERE} (the host was renamed or removed), delete its entry from ${paths.ownershipFile}.`,
      );
      return true;
    },
  );
  assert.equal(spawned, 0);
});

test('a start stamps its record with its host and keeps another host record that carries the same PID', async (t) => {
  const { cfg, paths, root, stateFile } = await fixture(t);
  const url = await readyRuntime(t, () => {});
  const elsewhere = record(paths, CHILD, { host: ELSEWHERE, stateFile: path.join(root, 'other state.json') });
  await updateOwnedSessions(paths, () => [elsewhere]);
  const child = Object.assign(new EventEmitter(), {
    pid: CHILD,
    exitCode: null,
    signalCode: null,
    unref() {},
    kill() {},
  });
  const session = await start(
    cfg,
    { port: '0', state: stateFile },
    {
      paths,
      hostName: HERE,
      identityOf: async () => 'injected identity',
      spawnRuntime(_command, _args, options) {
        fsSync.writeFileSync(discoveryOf(paths, CHILD), JSON.stringify({ pid: CHILD, host: HERE, url }));
        startChannelReporter(options.env[START_CHANNEL_ENV])({ phase: 'ready', elapsedMs: 0 });
        return child;
      },
    },
  );
  assert.equal(session.started, true);
  assert.equal(Object.hasOwn(session, 'host'), false, 'a start report does not publish the machine name');
  const owned = await ownedSessions(paths);
  assert.deepEqual(
    owned.map((item) => [item.pid, item.host, item.processIdentity]),
    [
      [CHILD, ELSEWHERE, elsewhere.processIdentity],
      [CHILD, HERE, 'injected identity'],
    ],
  );
});

test('the record folders a status reads are the noted folders that still exist, each read once', async (t) => {
  const { root, cwd, paths } = await fixture(t);
  const kept = path.join(root, 'kept', '.paqvilo');
  await fs.mkdir(kept, { recursive: true });
  const spellings = [kept, `${kept}${path.sep}`, path.join(kept, '..', '.paqvilo')];
  if (process.platform === 'win32') spellings.push(kept.toUpperCase());
  await fs.mkdir(path.join(cwd, '.paqvilo', 'mirage'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, '.paqvilo', 'mirage', 'record-folders.json'),
    JSON.stringify([path.join(root, 'removed', '.paqvilo'), ...spellings, path.join(root, 'gone', '.paqvilo')]),
  );
  const folders = (await recordFolders(paths)).map((item) => path.dirname(path.dirname(item.ownershipFile)));
  assert.deepEqual(folders, [path.dirname(path.dirname(paths.ownershipFile)), path.join(cwd, '.paqvilo'), kept]);
});

test('status says that a runtime ready on its record did not answer in time, so what only its answer reports is not shown', () => {
  const { output, restore } = captureConsoleOutput();
  try {
    print(
      {
        sessions: [
          {
            pid: 4321,
            url: 'http://127.0.0.1:4100/',
            processAlive: true,
            owned: true,
            ready: true,
            probe: 'no-answer',
            runtime: null,
          },
          {
            pid: 4322,
            url: 'http://127.0.0.1:4200/',
            processAlive: true,
            owned: true,
            ready: true,
            probe: 'answered',
            runtime: { site: 'Invented', pageCount: 3 },
          },
        ],
      },
      false,
    );
  } finally {
    restore();
  }
  const note =
    '    the runtime did not answer this status in time, so its site, pages and preset are not shown; run the status again';
  assert.deepEqual(
    output.logs.filter((line) => line === note),
    [note],
    'the note names the runtime that did not answer, and only that one',
  );
  assert.equal(output.logs.indexOf(note), 2, 'it follows the details of that runtime');
});

// A machine whose name changed while its runtimes kept running (macOS renames itself with the network).
const RENAMED_FROM = 'win32/old-name';
const RENAMED = 777301;
const TOKEN = `token:${'a'.repeat(32)}`;
async function renamedRuntime(t) {
  const fixed = await fixture(t);
  const url = await readyRuntime(t, () => {});
  await publish(fixed.paths, RENAMED, { host: RENAMED_FROM, url });
  const entry = { ...record(fixed.paths, RENAMED, { host: RENAMED_FROM, stateFile: fixed.stateFile }), url };
  entry.processIdentity = TOKEN;
  entry.identity.presetMode = 'always';
  await updateOwnedSessions(fixed.paths, () => [entry]);
  return { ...fixed, url };
}

test('a runtime of this machine recorded under its earlier name is listed, reused and stopped when its full identity verifies', async (t) => {
  const { cfg, paths, stateFile } = await renamedRuntime(t);
  const signals = [];
  const alive = (pid) => pid === RENAMED && !signals.length;
  const identityOf = async (pid, { recorded } = {}) => (alive(pid) ? recorded : null);
  const [listed] = await mirageStatus(paths, { hostName: HERE, alive, identityOf, probeTimeout: null });
  assert.deepEqual([listed?.pid, listed?.owned], [RENAMED, true]);
  const reused = await start(
    cfg,
    { port: '0', state: stateFile },
    {
      paths,
      hostName: HERE,
      alive,
      identityOf,
      spawnRuntime() {
        throw new Error('the running runtime is reused, not refused or started again');
      },
    },
  );
  assert.deepEqual([reused.pid, reused.started], [RENAMED, false]);
  const report = await stopOwnedSessions({
    paths,
    pids: [RENAMED],
    hostName: HERE,
    alive,
    identityOf,
    kill: (pid, signal) => signals.push([pid, signal]),
  });
  assert.deepEqual(
    report.stopped.map((item) => item.pid),
    [RENAMED],
  );
  assert.deepEqual(signals, [[RENAMED, 'SIGTERM']]);
  assert.equal(stopExitStatus(report, [RENAMED]), 0);
});

test('a record of this platform under another name stays foreign when the process at its PID has another identity', async (t) => {
  const { cfg, paths, stateFile } = await renamedRuntime(t);
  const alive = (pid) => pid === RENAMED;
  // Another process holds the number: its identity is not the recorded one.
  const identityOf = async () => `token:${'b'.repeat(32)}`;
  assert.deepEqual(await mirageStatus(paths, { hostName: HERE, alive, identityOf, probeTimeout: null }), []);
  await assert.rejects(
    start(
      cfg,
      { port: '0', state: stateFile },
      {
        paths,
        hostName: HERE,
        alive,
        identityOf,
        spawnRuntime() {
          throw new Error('the refused start must not spawn');
        },
      },
    ),
    new RegExp(`Mirage pid ${RENAMED} on ${RENAMED_FROM} is recorded for state file`),
  );
  const signals = [];
  const report = await stopOwnedSessions({
    paths,
    pids: [RENAMED],
    hostName: HERE,
    alive,
    identityOf,
    kill: (pid, signal) => signals.push([pid, signal]),
  });
  assert.deepEqual(signals, [], 'never signalled');
  assert.deepEqual(
    report.unverified.map((item) => [item.pid, item.foreignHost]),
    [[RENAMED, true]],
  );
});

test('a stop that ended the local runtime does not exit 2 for another host record with the same PID number', async (t) => {
  const { paths, stateFile } = await fixture(t);
  await updateOwnedSessions(paths, () => [
    { ...record(paths, COLLIDING, { host: ELSEWHERE, stateFile }), processIdentity: 'their identity' },
    { ...record(paths, COLLIDING, { host: HERE, stateFile }), processIdentity: 'our identity' },
  ]);
  const signals = [];
  const alive = (pid) => pid === COLLIDING && !signals.length;
  const report = await stopOwnedSessions({
    paths,
    pids: [COLLIDING],
    hostName: HERE,
    alive,
    identityOf: async (pid) => (alive(pid) ? 'our identity' : null),
    kill: (pid, signal) => signals.push([pid, signal]),
  });
  assert.deepEqual(
    report.stopped.map((item) => item.pid),
    [COLLIDING],
  );
  assert.deepEqual(
    report.unverified.map((item) => [item.pid, item.foreignHost]),
    [[COLLIDING, true]],
  );
  assert.equal(stopExitStatus(report, [COLLIDING]), 0, 'only a selected session of this host keeps the exit at 2');
});

test('mirage stop never selects a runtime recorded on another host, so it stops the local one and exits 0', async (t) => {
  const host = runtimeHost(t);
  const run = (...args) => runMirage(args, { host });
  const portal = createFixture();
  const work = await tempDir('paq-foreign-selection-');
  ownedFixture(t).remove(() => {
    portal.cleanup();
    return fs.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const config = path.join(work, 'paqvilo.config.yml');
  await fs.writeFile(
    config,
    JSON.stringify({
      defaultSite: 'site',
      sites: { site: { source: portal.dir, environments: { dev: 'https://portal.example.com' }, mirage: { port: 0 } } },
    }),
  );
  const started = await run('mirage', 'start', '--config', config, '--json');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const { pid } = JSON.parse(started.stdout);
  const paths = miragePaths({ stateDir: path.join(work, '.paqvilo') });
  // Another host recorded a runtime for the same site, under a number this process table does not run.
  const other = 999_001;
  await updateOwnedSessions(paths, (sessions) => [
    ...sessions,
    { ...sessions.find((item) => item.pid === pid), pid: other, processIdentity: 'their identity', host: 'aix/other' },
  ]);
  const listed = await run('mirage', 'status', '--config', config, '--json');
  assert.deepEqual(
    JSON.parse(listed.stdout).sessions.map((item) => item.pid),
    [pid],
  );
  const stopped = await run('mirage', 'stop', '--config', config, '--json');
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  const report = JSON.parse(stopped.stdout);
  assert.deepEqual(
    report.stopped.map((item) => item.pid),
    [pid],
  );
  assert.deepEqual(
    report.unverified.map((item) => [item.pid, item.foreignHost]),
    [[other, true]],
  );
});

test('a noted record folder missing at one read stays in the note and is read once it is there again', async (t) => {
  const { cfg, cwd, paths, root, stateFile } = await fixture(t);
  const url = await readyRuntime(t, () => {});
  // The working directory is a project folder, so the start notes its record folder there.
  const note = path.join(cwd, '.paqvilo', 'mirage', 'record-folders.json');
  const unmounted = path.join(root, 'unmounted', '.paqvilo');
  await fs.mkdir(path.dirname(note), { recursive: true });
  await fs.writeFile(note, JSON.stringify([unmounted]));
  const child = Object.assign(new EventEmitter(), {
    pid: CHILD,
    exitCode: null,
    signalCode: null,
    unref() {},
    kill() {},
  });
  await start(
    cfg,
    { port: '0', state: stateFile },
    {
      paths,
      hostName: HERE,
      identityOf: async () => 'injected identity',
      spawnRuntime(_command, _args, options) {
        fsSync.writeFileSync(discoveryOf(paths, CHILD), JSON.stringify({ pid: CHILD, host: HERE, url }));
        startChannelReporter(options.env[START_CHANNEL_ENV])({ phase: 'ready', elapsedMs: 0 });
        return child;
      },
    },
  );
  const stateFolder = path.dirname(path.dirname(paths.ownershipFile));
  assert.deepEqual(JSON.parse(await fs.readFile(note, 'utf8')), [unmounted, stateFolder]);
  const read = async () => (await recordFolders(paths)).map((item) => path.dirname(path.dirname(item.ownershipFile)));
  assert.deepEqual(await read(), [stateFolder, path.join(cwd, '.paqvilo')]);
  await fs.mkdir(unmounted, { recursive: true });
  assert.deepEqual(await read(), [stateFolder, path.join(cwd, '.paqvilo'), unmounted]);
});
