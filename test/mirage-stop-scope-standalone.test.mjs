// @test-kind unproven: the checks in this file exercise mirage stop scope standalone with local fixtures; no native capture establishes the behaviour they assert.
// Standalone runtimes: stop and init hints keep their ownership directory and runtime from another
// cwd, a failed hint stops what it started, and shared hint payloads outlive unverified targets.
//
// The commands run in this process against runtime doubles (test/helpers/mirage-in-process.mjs): which runtime a
// hint or a cleanup selects is decided from the ownership records, whatever kind of process a runtime is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { miragePaths, stopOwnedSessions } from '../lense/commands/mirage.mjs';
import { persistCommandPayload } from '../lense/command-payload.mjs';
import { workspace, runMirage, hintCommands, cli, alive, stopped } from './helpers/mirage-in-process.mjs';

// @test-kind contract: hint preparation failure stops newly started single/group sessions and preserves a reused sibling
test('hint preparation failure stops newly started single/group sessions and preserves a reused sibling', async (t) => {
  const work = await workspace(t);
  const config = path.join(work.directory, 'catalogue', 'custom.json');
  await work.writeCatalogue(config, { all: true });
  const existing = await work.start(['--config', config, '--site', 'first', '--portals', 'selected']);
  const paths = miragePaths({ stateDir: path.join(path.dirname(config), '.paqvilo') });
  // The command's hint formatter fails once the runtimes are recorded, and notes what was recorded then.
  let sessions;
  const failing = {
    ...work.host,
    commandHint() {
      sessions = JSON.parse(fsSync.readFileSync(paths.ownershipFile, 'utf8')).sessions.map(({ pid, url }) => ({
        pid,
        url,
      }));
      throw new Error('Invented hint preparation failure');
    },
  };
  for (const selection of [
    [],
    ['--site', 'first', '--portals', 'selected', '--state', path.join(work.directory, 'new-single-state.json')],
  ]) {
    sessions = null;
    const result = await runMirage(['mirage', 'start', '--config', config, ...selection, '--json'], {
      cwd: work.cwd,
      host: failing,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stdout).error.message, /Invented hint preparation failure/);
    const started = sessions.filter(({ pid }) => pid !== existing.pid);
    assert.equal(started.length, 1, 'the failure follows a runtime launch');
    for (const session of started) await stopped(session);
    await alive(existing);
    assert.deepEqual(
      JSON.parse(await fs.readFile(paths.ownershipFile, 'utf8')).sessions.map(({ pid }) => pid),
      [existing.pid],
    );
  }
});

// @test-kind contract: projectless standalone stop and init next preserve ownership cwd and runtime from another empty directory
test('projectless standalone stop and init next preserve ownership cwd and runtime from another empty directory', async (t) => {
  const work = await workspace(t);
  const elsewhere = path.join(work.directory, 'different empty cwd');
  await fs.mkdir(elsewhere);
  const state = path.join(work.directory, 'first standalone.json');
  const standalone = (file) =>
    work.start(['--runtime', 'model-driven', '--state', file, '--port', '0', '--simulation', 'dry-run']);
  // Separate states: independent launches.
  const [first, sibling] = await Promise.all([
    standalone(state),
    standalone(path.join(work.directory, 'other standalone.json')),
  ]);
  await work.replay(first.stop, elsewhere);
  await stopped(first);
  await alive(sibling);
  const init = await work.run([
    'mirage',
    'init',
    '--runtime',
    'model-driven',
    '--state',
    state,
    '--port',
    '0',
    '--simulation',
    'dry-run',
    '--solution-root',
    work.alternate,
    '--json',
  ]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const report = JSON.parse(init.stdout);
  assert.deepEqual(report.writesFiles, []);
  assert.doesNotMatch(report.skipped, /catalogue settings configure/);
  const next = hintCommands(report.next);
  assert.equal(next.cwd, work.cwd, 'the hint returns to the directory that holds the ownership records');
  const [args] = next.commands;
  assert.ok(args.includes('model-driven') && args.includes(state) && args.includes(work.alternate));
  assert.ok(args.includes('--simulation') && args.includes('dry-run'));
});

// @test-kind contract: standalone project with external configuration replays both inferred and explicit runtimes from another cwd
test('standalone project with external configuration replays both inferred and explicit runtimes from another cwd', async (t) => {
  const work = await workspace(t);
  const elsewhere = path.join(work.directory, 'another empty cwd');
  await fs.mkdir(elsewhere);
  const project = path.join(work.directory, 'standalone project', 'workspace.json');
  await fs.mkdir(path.dirname(project), { recursive: true });
  await fs.writeFile(project, JSON.stringify({ version: 2, runtime: { kind: 'model-driven' }, solutions: [] }));
  const config = path.join(work.directory, 'external browser config', 'custom.json');
  await work.writeCatalogue(config);
  for (const runtime of [[], ['--runtime', 'model-driven']]) {
    const args = [
      '--config',
      config,
      '--project',
      project,
      '--repo',
      work.alternate,
      ...runtime,
      '--port',
      '0',
      '--simulation',
      'dry-run',
    ];
    const started = await work.start(args);
    await work.replay(started.stop, elsewhere);
    await stopped(started);
  }
  const init = await work.run([
    'mirage',
    'init',
    '--config',
    config,
    '--project',
    project,
    '--runtime',
    'model-driven',
    '--repo',
    work.alternate,
    '--json',
  ]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const [args] = hintCommands(JSON.parse(init.stdout).next).commands;
  assert.ok(
    args.includes(config) && args.includes(work.alternate) && args.includes(project) && args.includes('model-driven'),
  );
});

// @test-kind contract: shared hint payload stays while a target is unverified and is removed after the final owned target stops
test('shared hint payload stays while a target is unverified and is removed after the final owned target stops', async (t) => {
  const work = await workspace(t);
  const paths = miragePaths({ stateDir: path.join(work.directory, '.paqvilo') });
  // Two running processes of the test's own process table: a signal ends the one it names.
  const pids = [2_100_000_001, 2_100_000_002];
  const identities = new Map(pids.map((pid, index) => [pid, `invented identity ${index}`]));
  const running = new Set(pids);
  const table = {
    identityOf: (pid) => (running.has(pid) ? identities.get(pid) : null),
    alive: (pid) => running.has(pid),
    kill: (pid) => running.delete(pid),
  };
  const payload = persistCommandPayload(
    path.join(path.dirname(paths.ownershipFile), 'commands'),
    Buffer.from(JSON.stringify([[cli, 'mirage', 'stop']])),
  );
  const records = pids.map((pid, index) => ({
    pid,
    processIdentity: index === 0 ? identities.get(pid) : null,
    sourceDir: null,
    url: null,
    hintFiles: [payload],
  }));
  await fs.mkdir(path.dirname(paths.ownershipFile), { recursive: true });
  await fs.writeFile(paths.ownershipFile, JSON.stringify({ sessions: records }));
  const first = await stopOwnedSessions({ paths, pids: [pids[0]], ...table });
  assert.equal(first.stopped.length, 1);
  assert.deepEqual([...running], [pids[1]], 'the record without an identity was never signalled');
  await fs.access(payload);
  records[1].processIdentity = identities.get(pids[1]);
  await fs.writeFile(paths.ownershipFile, JSON.stringify({ sessions: [records[1]] }));
  const last = await stopOwnedSessions({ paths, pids: [pids[1]], ...table });
  assert.equal(last.stopped.length, 1);
  await assert.rejects(fs.access(payload), { code: 'ENOENT' });
});
