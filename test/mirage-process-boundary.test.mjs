// @test-kind contract: the Mirage lifecycle across real processes — a detached runtime, a shell, a stop
// The process boundary of `mirage start` and `mirage stop`: the command line starts a runtime that is a process of
// its own and outlives the command, a native shell hands a printed hint over as the argv it holds, and a stop ends
// the runtime's process. One real runtime per behaviour and shell kind.
//
// Everything else about the lifecycle (which record a stop selects, what a hint contains, when a start reuses a
// runtime) is decided inside the command and is tested in this process against runtime doubles
// (test/helpers/mirage-in-process.mjs). The last two tests hold those doubles to the real runtime: the discovery
// record they publish and the requests they answer are the ones a real runtime of the same command line does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recordedIdentityNow } from '../lense/process-identity.mjs';
import { ownedSessions } from '../lense/commands/mirage.mjs';
import { workspace, fixtureStatusURL, alive, stopped } from './mirage-stop-workspace.mjs';
import { runtimeHost, runMirage, hintCommands } from './helpers/mirage-in-process.mjs';
import { SCENARIO_HANG_GUARD_MS } from './helpers/bounded-command.mjs';

const execute = promisify(execFile);

// pwsh is optional on Windows.
const nativeShells = process.platform === 'win32' ? ['cmd.exe', 'powershell.exe', 'pwsh.exe'] : ['/bin/sh'];
async function shellInstalled(shell) {
  if (shell !== 'pwsh.exe') return true;
  try {
    await execute(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      windowsHide: true,
    });
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

const standaloneProject = {
  version: 2,
  runtime: { kind: 'model-driven' },
  solutions: [],
  simulation: { level: 'dry-run' },
};

/** The ownership record of `session`, read from the records its start wrote. */
async function recordOf(session) {
  const ownershipFile = session.writesFiles.find((file) => file.endsWith(path.join('mirage', 'sessions.json')));
  const record = (await ownedSessions({ ownershipFile })).find((entry) => entry.pid === session.pid);
  assert.ok(record?.processIdentity, 'the start recorded the runtime with its start identity');
  return record;
}

/** The recorded runtime has gone: no process has the identity its record named. */
async function assertEnded(record) {
  assert.notEqual(
    await recordedIdentityNow(record.pid, record.processIdentity),
    record.processIdentity,
    'no process has the start identity the runtime was recorded with',
  );
}

/**
 * Hints whose arguments a shell could rewrite, printed by real commands that started runtime doubles: a readable
 * project hint, one whose project path is full of shell syntax, one with shell syntax in its Solution root and state
 * file, and the `next` of an init, which carries a working directory.
 */
async function hostileHints(t, work) {
  const host = runtimeHost(t);
  const run = async (argv) => {
    const result = await runMirage([...argv, '--json'], { cwd: work.cwd, host });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const project = path.join(work.directory, 'plain project', 'organization.json');
  const literal = path.join(work.directory, 'literal $([char]65) ` %PAQ_HINT% !PAQ_HINT! & ^', 'organization.json');
  const root = path.join(work.directory, "first $([char]65) 'quoted' `ticks solution");
  for (const file of [project, literal]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(standaloneProject));
  }
  await fs.mkdir(root);
  const start = (...args) => run(['mirage', 'start', ...args, '--port', '0']);
  const [plain, shellSyntax, quoted, init] = await Promise.all([
    start('--project', project, '--state', path.join(work.directory, 'plain.json')),
    start('--project', literal, '--state', path.join(work.directory, 'literal.json')),
    start(
      ...['--runtime', 'model-driven', '--simulation', 'dry-run', '--solution-root', root],
      ...['--state', path.join(work.directory, "first $([char]65) 'quoted' `ticks state.json")],
    ),
    run(['mirage', 'init', '--runtime', 'model-driven', '--solution-root', work.alternate, '--port', '0']),
  ]);
  assert.match(plain.stop, /^npx paqvilo mirage stop --project /, 'a plain project path prints a readable hint');
  if (process.platform === 'win32') {
    assert.match(shellSyntax.stop, /^node -e /, 'Windows shell-active project paths retain fixed encoded argv');
    assert.match(quoted.stop, /^node -e /);
  } else
    assert.match(shellSyntax.stop, /^npx paqvilo mirage stop --project '/, 'POSIX literal quoting remains readable');
  return { project, literal, hints: [plain.stop, shellSyntax.stop, quoted.stop, init.next] };
}

// One test per native shell: each replays for real once.
// Hang guard only: four shell replays, a real start, its detached runtime and the shell replay that stops it.
for (const shell of nativeShells)
  test(
    `${shell} hands every hint over as the argv it holds, and its replay stops a detached runtime that outlived its start`,
    { timeout: SCENARIO_HANG_GUARD_MS },
    async (t) => {
      if (!(await shellInstalled(shell))) return t.skip(`${shell} is not installed`);
      const work = await workspace(t);
      const elsewhere = path.join(work.directory, 'empty replay directory');
      await fs.mkdir(elsewhere);
      const { project, literal, hints } = await hostileHints(t, work);
      // The shell runs each hint with the toolkit replaced by a program that prints the argv it was given.
      await Promise.all(
        hints.map(async (hint) => {
          const printed = (await work.replay(hint, true, elsewhere, shell)).stdout.trim().split(/\r?\n/);
          assert.deepEqual(printed.map(JSON.parse), hintCommands(hint).commands, hint);
        }),
      );
      assert.ok(
        hintCommands(hints[1]).commands[0].includes(literal),
        'the complete project path is one argument of the hint',
      );
      // The real command line starts a real runtime and ends; the runtime keeps answering.
      const session = await work.start([
        '--project',
        project,
        '--state',
        path.join(work.directory, 'real.json'),
        '--port',
        '0',
      ]);
      assert.equal(session.started, true);
      const record = await recordOf(session);
      const status = await (await fetch(fixtureStatusURL(session))).json();
      assert.equal(status.runtime.kind, 'model-driven');
      assert.equal(status.simulation.level, 'dry-run');
      await work.replay(session.stop, false, elsewhere, shell);
      await stopped(session);
      await assertEnded(record);
    },
  );

/** What the lifecycle reads of a discovery record: the keys and the kind of each value. */
const shapeOf = (record) =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, Array.isArray(value) ? 'array' : typeof value]),
  );

/**
 * Starts the same command line once for real and once against a runtime double, each in a folder of its own, and
 * holds the double to the real runtime: every field the double publishes is one the real runtime publishes, of the
 * same kind, and both answer the status and state requests the toolkit sends. Returns the real session.
 */
async function sameContract(t, work, selectors) {
  const host = runtimeHost(t);
  const doubled = await runMirage(['mirage', 'start', ...selectors('double'), '--json'], { cwd: work.cwd, host });
  assert.equal(doubled.status, 0, doubled.stdout + doubled.stderr);
  const double = JSON.parse(doubled.stdout);
  const real = await work.start(selectors('real'));
  const [realRecord, doubleRecord] = await Promise.all(
    [real, double].map(async (session) => JSON.parse(await fs.readFile(session.discovery, 'utf8'))),
  );
  const published = shapeOf(realRecord);
  for (const [key, kind] of Object.entries(shapeOf(doubleRecord)))
    assert.equal(published[key], kind, `a real runtime publishes ${key} as the double does`);
  assert.equal(
    double.writesFiles.includes(double.stateFile),
    real.writesFiles.includes(real.stateFile),
    'the double writes a state file exactly when a real runtime of this command line does',
  );
  for (const session of [real, double]) {
    const answered = await fetch(new URL('/_sim/api/status', session.url));
    assert.equal(answered.status, 200);
    assert.equal(typeof (await answered.json()).runtime.kind, 'string');
    const state = await (await fetch(new URL('/_sim/api/state?summary=1', session.url))).json();
    assert.equal(typeof state.csrf, 'string', 'the state names the token a shutdown request carries');
  }
  return real;
}

/** `mirage stop --json` for `selectors`: the runtime acknowledged its shutdown, removed its record and has gone. */
async function stopsGracefully(work, session, selectors) {
  const record = await recordOf(session);
  const stop = await work.run(['mirage', 'stop', ...selectors, '--json']);
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  assert.deepEqual(
    JSON.parse(stop.stdout).stopped.map(({ pid, graceful, wasReady }) => ({ pid, graceful, wasReady })),
    [{ pid: session.pid, graceful: true, wasReady: true }],
  );
  await stopped(session);
  await assertEnded(record);
  await assert.rejects(fs.access(session.discovery), { code: 'ENOENT' }, 'a runtime that shut down removed its record');
}

// Hang guard only: it runs real CLI commands and the runtimes they start; on a loaded slow host that is slow, not hung.
test(
  'a real portal runtime publishes and answers what its double does, reports its own administration address and shuts down when asked',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const work = await workspace(t);
    const selectors = (name) => {
      const config = path.join(work.directory, name, 'catalogue.json');
      return ['--config', config, '--repo', work.alternate, '--port', '0'];
    };
    for (const name of ['real', 'double']) await work.writeCatalogue(selectors(name)[1]);
    const session = await sameContract(t, work, selectors);
    await alive(session);
    // The printed administration address is the one the runtime reports on its own admin port.
    const reported = await (await fetch(new URL('/_sim/api/status', session.url))).json();
    assert.equal(session.adminUrl, reported.adminUrl);
    assert.notEqual(new URL(session.adminUrl).port, new URL(session.url).port);
    await stopsGracefully(work, session, selectors('real').slice(0, 4));
  },
);

// Hang guard only: it runs real CLI commands and the runtimes they start; on a loaded slow host that is slow, not hung.
test(
  'a real standalone catalogue runtime publishes and answers what its double does, reads the catalogue it was started from and shuts down when asked',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const work = await workspace(t);
    const selectors = (name) => [
      '--config',
      path.join(work.directory, name, 'catalogue.yml'),
      '--site',
      'first',
      '--port',
      '0',
    ];
    for (const name of ['real', 'double']) {
      await fs.mkdir(path.join(work.directory, name));
      await fs.writeFile(
        selectors(name)[1],
        'sites:\n  first:\n    mirage:\n      runtime: {kind: model-driven}\n      simulation: {level: dry-run}\n',
      );
    }
    const session = await sameContract(t, work, selectors);
    const setup = await (await fetch(new URL('/_setup/api/status', session.url))).json();
    assert.equal(setup.layers.shared.file, selectors('real')[1]);
    await stopsGracefully(work, session, selectors('real').slice(0, 4));
  },
);

// @test-kind security+contract: owned status probes admit only a numeric port on the fixed HTTP loopback endpoint
test('owned status probes admit only a numeric port on the fixed HTTP loopback endpoint', () => {
  assert.equal(fixtureStatusURL({ url: 'http://127.0.0.1:12345' }), 'http://127.0.0.1:12345/_sim/api/status');
  assert.equal(fixtureStatusURL({ url: 'http://127.0.0.1:80/' }), 'http://127.0.0.1:80/_sim/api/status');
  for (const url of [
    'https://127.0.0.1:12345',
    'http://invented.example.invalid:12345',
    'http://127.0.0.1.invented.invalid:12345',
    'http://localhost:12345',
    'http://[::1]:12345',
    'http://2130706433:12345',
    'http://user:secret@127.0.0.1:12345',
    'http://127.0.0.1:12345/other',
    'http://127.0.0.1:12345/?value=invented',
    'http://127.0.0.1:12345/#fragment',
    'http://127.0.0.1:12345/?',
    'http://127.0.0.1:12345/#',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:00123',
    'http://127.0.0.1:12345\\',
    'http://127.0.0.1:12345\n',
    'file:///invented',
  ])
    assert.throws(() => fixtureStatusURL({ url }), /owned HTTP loopback runtime address/);
});
