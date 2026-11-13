// @test-kind tooling: test-harness workspace reaper never leaves Mirage runtimes behind
// The stop-scope workspace never leaves a runtime behind: not when a test fails or times out while
// a CLI is still starting one, and not when the test process itself ends abruptly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isAlive,
  miragePaths,
  start,
  stopDevelopmentSession,
  stopOwnedSessions,
  stopStarted,
  updateOwnedSessions,
} from '../lense/commands/mirage.mjs';
import { guardShutdownSignals } from '../lense/signal-forwarding.mjs';
import { workspace, cli, stopped } from './mirage-stop-workspace.mjs';
import { processesNaming, trackedCliEnded } from './mirage-reaper.mjs';
import { captureConsoleOutput } from './helpers/mirage-session-doubles.mjs';

const standalone = (directory) => [
  'mirage',
  'start',
  '--runtime',
  'model-driven',
  '--state',
  path.join(directory, 'standalone.json'),
  '--port',
  '0',
  '--simulation',
  'dry-run',
  '--json',
];

// @test-kind tooling: a closed CLI stays ended when its PID is reused
test('a closed CLI stays ended when its PID is reused', () => {
  const occupied = () => true;
  assert.equal(trackedCliEnded(1234, true, occupied), true);
  assert.equal(trackedCliEnded(1234, false, occupied), false);
  assert.equal(
    trackedCliEnded(1234, false, () => false),
    true,
  );
});

// @test-kind tooling: workspace cleanup on a failed or timed-out test ends a CLI still starting and the runtime it launched
test('workspace cleanup on a failed or timed-out test ends a CLI still starting and the runtime it launched', async (t) => {
  const work = await workspace(t);
  // The CLI launches and records its runtime, reports it on stdout, then blocks before answering,
  // as a CLI does when the test times out during its start.
  const formatter = pathToFileURL(fileURLToPath(new URL('../lense/stop-command.mjs', import.meta.url))).href;
  // A standalone start records its runtime under <cwd>/.paqvilo/mirage/sessions.json.
  const replacement = `import fs from 'node:fs';import path from 'node:path';export {listenerPort} from ${JSON.stringify(formatter + '?original')};function hang(){const sessions=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.paqvilo','mirage','sessions.json'),'utf8')).sessions;fs.writeSync(1,JSON.stringify(sessions.map(({pid,url})=>({pid,url})))+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}export {hang as mirageCommandHint,hang as mirageStopCommand};`;
  const hooks = path.join(work.directory, 'hang-after-launch.mjs');
  fs.writeFileSync(
    hooks,
    `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){const result=next(specifier,context);return result.url===${JSON.stringify(formatter)}?{url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(replacement))},shortCircuit:true}:result}});`,
  );
  const { child, result } = work.launchCli(standalone(work.directory), {
    NODE_OPTIONS: '--import=' + pathToFileURL(hooks).href,
  });
  const [line] = await once(child.stdout, 'data');
  const [session] = JSON.parse(String(line));
  assert.ok(isAlive(session.pid), 'the hung CLI has a running runtime');
  // What the owned fixture runs after a failure or timeout.
  await work.dispose();
  assert.notEqual((await result).status, 0, 'the hung CLI was ended');
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(isAlive(session.pid), false, 'its runtime was stopped');
  await stopped(session);
});

// `after start`: the test process dies once its CLI has started and recorded a runtime.
// `during start`: it dies while the CLI is still starting. On Windows the CLI then dies with it (a
// libuv child joins its parent's kill-on-close job), so a runtime it launched has no record.
// @test-kind tooling: cancellation and cleanup for each authored lifecycle case
for (const moment of ['after start', 'during start'])
  test(`an abruptly ended test process leaves its workspace to the reaper (${moment})`, async (t) => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-reaped-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const reaper = new URL('./mirage-reaper.mjs', import.meta.url).href;
    // A stand-in test process: it starts the reaper and a tracked CLI that launches a runtime, and is
    // then killed. The reaper inherits its stdout, so the stream ends only once the reaper finished.
    const script = `import {startReaper} from ${JSON.stringify(reaper)};import {execFile} from 'node:child_process';import {once} from 'node:events';import fs from 'node:fs';const [directory,cli,args,moment]=process.argv.slice(1);const reaper=startReaper(directory);let output='';const child=execFile(process.execPath,[cli,...JSON.parse(args)],{cwd:directory,windowsHide:true},(error,stdout)=>{output=stdout});await reaper.track(child);let cliClosed=false;if(moment==='after start'){await once(child,'close');cliClosed=true;output=JSON.parse(output).pid}fs.writeSync(1,JSON.stringify({cli:child.pid,cliClosed,runtime:output||null})+'\\n');process.kill(process.pid,'SIGKILL');`;
    const stand = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, directory, cli, JSON.stringify(standalone(directory)), moment],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    let written = '';
    stand.stdout.setEncoding('utf8').on('data', (chunk) => (written += chunk));
    await once(stand.stdout, 'end');
    const [started, report] = written.trim().split('\n').map(JSON.parse);
    t.diagnostic(JSON.stringify(report));
    if (moment === 'after start') assert.equal(started.cliClosed, true, 'the CLI was observed to close');
    // Once a child closes, Windows can reuse its PID for an unrelated process. Match the unique workspace instead.
    const named = await processesNaming(directory);
    assert.equal(
      trackedCliEnded(started.cli, started.cliClosed, (pid) => named.includes(pid)),
      true,
      'the tracked CLI ended',
    );
    assert.equal(named.includes(started.cli), false, 'the reaper waited for the CLI belonging to this workspace');
    if (moment === 'after start') {
      assert.equal(typeof started.runtime, 'number', 'the CLI started a runtime');
      assert.deepEqual(report.reaped, [started.runtime], 'the reaper stopped the recorded runtime');
    }
    assert.deepEqual(report.left, []);
    for (const pid of [...report.reaped, ...report.strays])
      assert.equal(named.includes(pid), false, 'the stopped workspace process is no longer present');
    assert.deepEqual(named, [], 'no process names the workspace any longer');
    assert.equal(fs.existsSync(directory), false, 'the reaper removed the workspace');
  });

// @test-kind tooling: a live unrelated process does not count as a workspace CLI when a PID is reused
test('a live unrelated process does not count as a workspace CLI when a PID is reused', async (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-reaper-identity-')));
  const script = "process.stdout.write('ready\\n');process.stdin.resume()";
  const start = (args) =>
    spawn(process.execPath, ['-e', script, ...args], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
  const child = start([]),
    matching = start([directory]);
  const closed = [once(child, 'close'), once(matching, 'close')];
  t.after(async () => {
    child.stdin.end();
    matching.stdin.end();
    await Promise.all(closed);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([once(child.stdout, 'data'), once(matching.stdout, 'data')]);
  assert.equal(isAlive(child.pid), true);
  assert.equal(isAlive(matching.pid), true);
  const named = await processesNaming(directory);
  assert.equal(named.includes(matching.pid), true, 'a live process naming the workspace is found');
  assert.equal(named.includes(child.pid), false, 'a live unrelated process is excluded');
  assert.equal(
    trackedCliEnded(child.pid, false),
    false,
    'raw numeric liveness alone cannot prove that a reused PID belongs to the tracked CLI',
  );
  assert.equal(
    trackedCliEnded(child.pid, false, (pid) => named.includes(pid)),
    true,
    'a live unrelated process cannot revive the ended workspace CLI',
  );
  assert.equal(
    trackedCliEnded(matching.pid, false, (pid) => named.includes(pid)),
    false,
    'an actual live workspace CLI must still be reported as running',
  );
});

// @test-kind contract: a start prunes start-up logs beyond the newest 20 that no owned record names, and keeps the one a live record names
test('a start prunes start-up logs beyond the newest 20 that no owned record names, and keeps the one a live record names', async (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-log-prune-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cfg = { stateDir: directory, runtime: { kind: 'model-driven' }, siteName: 'invented' };
  const paths = miragePaths(cfg);
  await fsp.mkdir(paths.logRoot, { recursive: true });
  // Ascending start times: the last twenty are the newest.
  const seeded = Array.from(
    { length: 30 },
    (_, index) => `startup-${1000 + index}-a${String(index).padStart(3, '0')}.log`,
  );
  const referenced = 'startup-500-ffff.log';
  for (const name of [...seeded, referenced]) await fsp.writeFile(path.join(paths.logRoot, name), '');
  // The live record belongs to another state file, so the start under test is not refused for sharing one.
  const stateFile = path.join(directory, 'other.json');
  await updateOwnedSessions(paths, () => [
    {
      pid: process.pid,
      stateFile,
      log: path.join(paths.logRoot, referenced),
      identity: { stateFile, runtime: { kind: 'model-driven' } },
    },
  ]);
  let created;
  await assert.rejects(
    start(
      cfg,
      { port: '0', state: path.join(directory, 'state.json') },
      {
        paths,
        spawnRuntime() {
          throw new Error('invented spawn failure');
        },
      },
    ),
    (error) => {
      created = path.basename(/Startup log: (.+)$/.exec(error.message)[1]);
      return /invented spawn failure/.test(error.message);
    },
  );
  const remaining = (await fsp.readdir(paths.logRoot))
    .filter((name) => name !== created)
    .toSorted((a, b) => a.localeCompare(b));
  assert.deepEqual(
    remaining,
    [referenced, ...seeded.slice(10)].toSorted((a, b) => a.localeCompare(b)),
  );
});

// @test-kind contract: a stop removes the start-up log of a ready runtime that acknowledged its shutdown
test('a stop removes the start-up log of a ready runtime that acknowledged its shutdown', async (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-log-stop-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cfg = { stateDir: directory, runtime: { kind: 'model-driven' }, siteName: 'invented' };
  const paths = miragePaths(cfg);
  await fsp.mkdir(paths.logRoot, { recursive: true });
  const log = path.join(paths.logRoot, 'startup-1000-abc.log');
  await fsp.writeFile(log, '');
  // A stand-in runtime: a pid double that is alive until it acknowledges the shutdown request.
  const pid = 424242;
  let running = true;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST') {
      running = false;
      response.writeHead(202).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ csrf: 'invented-csrf' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const stateFile = path.join(directory, 'state.json');
  await updateOwnedSessions(paths, () => [
    {
      pid,
      processIdentity: 'invented identity',
      url,
      stateFile,
      log,
      ready: true,
      identity: { stateFile, runtime: { kind: 'model-driven' } },
    },
  ]);
  const identityOf = (candidate) => (candidate === pid ? 'invented identity' : null);
  const alive = (candidate) => candidate === pid && running;
  const report = await stopOwnedSessions({ paths, pids: [pid], identityOf, alive });
  assert.deepEqual(report.remaining, []);
  assert.equal(report.stopped[0].graceful, true);
  await assert.rejects(fsp.access(log), { code: 'ENOENT' });
});

// @test-kind contract: a repeated Ctrl+C while the owned sessions are stopped must not end the process before the stop settles
test('a repeated stop signal during shutdown is absorbed until the owned sessions are stopped', async () => {
  const source = new EventEmitter();
  const notices = [];
  let finishStop,
    stops = 0;
  const stopping = new Promise((resolve) => {
    finishStop = resolve;
  });
  const shutdown = guardShutdownSignals(
    () => {
      stops++;
      return stopping;
    },
    (line) => notices.push(line),
    { source },
  );
  source.emit('SIGINT');
  source.emit('SIGTERM');
  assert.ok(source.listenerCount('SIGINT') > 0, 'the stop must keep a SIGINT listener while it is pending');
  assert.equal(stops, 1);
  finishStop();
  await shutdown;
  assert.deepEqual(notices, ['stopping…']);
  assert.equal(source.listenerCount('SIGINT'), 0);
});

// Guards a cleanup that stays pending until finishCleanup is called, and records the notices and exit codes it produces.
function guardedCleanup() {
  const source = new EventEmitter();
  const notices = [];
  const exits = [];
  let finishCleanup;
  const cleanup = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  const shutdown = guardShutdownSignals(
    () => cleanup,
    (line) => notices.push(line),
    {
      exit: (code) => exits.push(code),
      source,
    },
  );
  return { source, notices, exits, finishCleanup, shutdown };
}

// @test-kind contract: one and two stop signals during cleanup neither exit the process nor cut the cleanup short
test('one and two stop signals during cleanup neither exit nor end the cleanup early', async () => {
  const { source, notices, exits, finishCleanup, shutdown } = guardedCleanup();
  source.emit('SIGINT');
  source.emit('SIGTERM');
  assert.deepEqual(exits, []);
  finishCleanup('cleaned');
  assert.equal(await shutdown, 'cleaned');
  assert.deepEqual(notices, ['stopping…']);
  assert.deepEqual(exits, []);
  assert.equal(source.listenerCount('SIGINT'), 0);
  assert.equal(source.listenerCount('SIGTERM'), 0);
});

// @test-kind contract: a third Ctrl+C during cleanup forces exit 130 exactly once and removes the listeners
test('a third Ctrl+C during cleanup forces exit 130 once and removes the listeners', async () => {
  const { source, notices, exits, finishCleanup, shutdown } = guardedCleanup();
  source.emit('SIGINT');
  source.emit('SIGINT');
  source.emit('SIGINT');
  assert.deepEqual(exits, [130]);
  source.emit('SIGINT');
  assert.deepEqual(exits, [130]);
  assert.deepEqual(notices, ['stopping…', 'Forced exit: cleanup did not finish.']);
  finishCleanup();
  await shutdown;
  assert.equal(source.listenerCount('SIGINT'), 0);
  assert.equal(source.listenerCount('SIGTERM'), 0);
});

// @test-kind contract: a third stop signal that is SIGTERM forces exit 143, the code of the signal that arrived third
test('a third SIGTERM during cleanup forces exit 143', async () => {
  const source = new EventEmitter();
  const exits = [];
  let finishCleanup;
  const cleanup = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  const shutdown = guardShutdownSignals(
    () => cleanup,
    () => {},
    { exit: (code) => exits.push(code), source },
  );
  source.emit('SIGINT');
  source.emit('SIGTERM');
  assert.deepEqual(exits, []);
  source.emit('SIGTERM');
  assert.deepEqual(exits, [143]);
  finishCleanup();
  await shutdown;
});

// @test-kind contract: a repeated Ctrl+C while a started Mirage is being stopped must not end the process before the stop settles
test('a repeated stop signal while a started Mirage stops is absorbed until the stop settles', async () => {
  const source = new EventEmitter();
  const { output, restore } = captureConsoleOutput();
  let finishStop;
  try {
    const stopping = new Promise((resolve) => {
      finishStop = resolve;
    });
    let stops = 0;
    const stop = () => {
      stops++;
      return stopping.then(() => ({ stopped: [{ pid: 4321 }], remaining: [] }));
    };
    const portals = [{ site: 'alpha', session: { started: true, pid: 4321, url: 'http://127.0.0.1:4100/' } }];
    const run = stopStarted(portals, {}, stop, { source });
    source.emit('SIGINT');
    source.emit('SIGTERM');
    assert.ok(source.listenerCount('SIGINT') > 0, 'the stop must keep a SIGINT listener while it is pending');
    assert.equal(stops, 1);
    finishStop();
    await run;
    assert.equal(stops, 1);
    assert.deepEqual(output.errors, ['stopping…']);
    assert.equal(source.listenerCount('SIGINT'), 0);
    assert.equal(source.listenerCount('SIGTERM'), 0);
  } finally {
    finishStop?.();
    restore();
  }
});

// @test-kind contract: a development session whose Mirage cannot be stopped must fail the command, not only print a line
test('a development session whose Mirage could not be stopped reports once on stderr and fails the command', async (t) => {
  const saved = process.exitCode;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-dev-stop-'));
  t.after(() => {
    process.exitCode = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.exitCode = undefined;
  const reported = [];
  await stopDevelopmentSession(
    null,
    { started: true, pid: 4321, url: 'http://127.0.0.1:4100/' },
    miragePaths({ stateDir: dir }),
    'hint',
    {
      stopSessions: async () => ({ stopped: [], remaining: [{ pid: 4321 }] }),
      report: (line) => reported.push(line),
    },
  );
  assert.equal(reported.length, 1);
  assert.match(reported[0], /could not stop pid 4321/);
  assert.equal(process.exitCode, 1);
});

// @test-kind contract: a Code App dev interrupt is its own abort reason, not a message text
test('only the Ctrl+C reason of a Code App dev session counts as its interrupt', async () => {
  const { codeAppInterrupt } = await import('../lense/commands/mirage.mjs');
  const first = codeAppInterrupt();
  assert.equal(first.interrupted(), false, 'nothing was requested yet');
  first.interrupt();
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(first.interrupted(), true);
  assert.equal(first.interrupted(first.controller.signal.reason), true);
  const failed = codeAppInterrupt();
  failed.controller.abort(new Error('Code App development stopped.'));
  assert.equal(failed.interrupted(), false, 'another error with the same text is a failure');
  assert.equal(failed.interrupted(new Error('Code App development stopped.')), false);
});
