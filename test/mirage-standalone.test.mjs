// @test-kind contract: standalone Mirage projects and catalogues start, reuse and stop only the profile they select.
// The commands run in this process against runtime doubles (test/helpers/mirage-in-process.mjs): which profile a
// start reuses and a stop selects is decided from the configuration and the ownership records. What a real standalone
// runtime reports once started, and that native shells replay these hints, is test/mirage-process-boundary.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { tempDir } from './fixture.mjs';
import { runtimeHost, runMirage, hintCommands } from './helpers/mirage-in-process.mjs';

/** A folder of its own and the commands of a command line run from it; a failing exit rejects, as a shell reports it. */
async function standalone(t, prefix) {
  const directory = await tempDir(prefix);
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const host = runtimeHost(t);
  const toolkit = async (args, cwd = directory) => {
    const result = await runMirage(args, { cwd, host });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  return { directory, host, toolkit };
}
/** Awaits every independent command before reporting the first failure. */
const settled = async (...promises) => {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
};
/** The argv of the one command a stop hint holds. */
const stopArguments = (hint) => {
  const { commands } = hintCommands(hint);
  assert.equal(commands.length, 1);
  return commands[0];
};
const answers = (session) => fetch(session.url + '/_sim/api/status');

test('public project inspect/start/reuse/stop works without any portal or catalogue', async (t) => {
  const { directory, host, toolkit } = await standalone(t, 'paqvilo-standalone-cli-');
  const project = path.join(directory, 'organization.project.json');
  const text = JSON.stringify({
    version: 2,
    runtime: { kind: 'model-driven' },
    simulation: { level: 'dry-run' },
    solutions: [],
    defaultPortal: 'future',
    portals: [
      { id: 'future', path: './unavailable-portal' },
      { id: 'other', path: './another-unavailable-portal' },
    ],
  });
  await fs.writeFile(project, text);
  const run = (...args) => toolkit(['mirage', ...args, '--project', project, '--json']);
  // Offline inspection does not depend on the runtime, so it runs while the runtime starts.
  const [inspected, started] = await settled(run('inspect'), run('start', '--port', '0'));
  assert.equal(inspected.runtime.kind, 'model-driven');
  assert.deepEqual(inspected.portals, []);
  assert.equal(started.started, true);
  assert.equal(started.sourceDir, null);
  assert.ok(started.pid);
  assert.deepEqual(stopArguments(started.stop), [
    'mirage',
    'stop',
    '--project',
    project,
    '--runtime',
    'model-driven',
    '--state',
    started.stateFile,
    '--port',
    new URL(started.url).port,
  ]);
  // The runtime was started as the project's kind, with the project and no portal selected.
  const [launched] = host.launches;
  assert.equal((await (await answers(started)).json()).runtime.kind, 'model-driven');
  assert.equal(launched.values.project, project);
  assert.equal(launched.values.portal, undefined);
  const reused = await run('start', '--port', '0');
  assert.equal(reused.started, false);
  assert.equal(reused.pid, started.pid);
  assert.equal(host.launches.length, 1, 'a reused runtime is not started again');
  // Execute the exact advertised selection, including from the toolkit checkout
  // where the bundled catalogue's sites differ from this project's file name.
  const stopped = await toolkit([...stopArguments(started.stop), '--json'], process.cwd());
  assert.equal(
    stopped.stopped.some((item) => item.pid === started.pid),
    true,
  );
  await assert.rejects(answers(started), /fetch failed/);
  assert.equal(await fs.readFile(project, 'utf8'), text);
});

test('catalogue standalone lifecycle needs no source or environment and stops only its selected profile', async (t) => {
  const { directory, host, toolkit } = await standalone(t, 'paqvilo-standalone-profiles-');
  const config = path.join(directory, 'catalogue.yml');
  const text =
    'sites:\n  first:\n    mirage:\n      runtime: {kind: model-driven}\n      simulation: {level: dry-run}\n  second:\n    mirage:\n      runtime: {kind: model-driven}\n      simulation: {level: dry-run}\n';
  await fs.writeFile(config, text);
  const run = (site, command, ...args) =>
    toolkit(['mirage', command, '--config', config, '--site', site, '--json', ...args]);
  const [inspected, first, second] = await settled(
    run('first', 'inspect'),
    run('first', 'start', '--port', '0'),
    run('second', 'start', '--port', '0'),
  );
  assert.equal(inspected.runtime.kind, 'model-driven');
  assert.equal(first.started, true);
  assert.deepEqual(stopArguments(first.stop), [
    'mirage',
    'stop',
    '--config',
    config,
    '--repo',
    directory,
    '--site',
    'first',
    '--portals',
    'selected',
    '--runtime',
    'model-driven',
    '--state',
    first.stateFile,
    '--port',
    new URL(first.url).port,
  ]);
  assert.equal(second.started, true);
  assert.notEqual(first.pid, second.pid);
  assert.equal((await run('first', 'start', '--port', '0')).pid, first.pid);
  // The runtime is started with the catalogue and site it reads its settings from, and is told who started it.
  const launched = host.runtime(first.pid);
  assert.deepEqual(launched.argv.slice(launched.argv.indexOf('--config'), launched.argv.indexOf('--config') + 4), [
    '--config',
    config,
    '--site',
    'first',
  ]);
  assert.deepEqual(JSON.parse(launched.environment.MIRAGE_SETUP_RUNTIME), { command: 'mirage start', site: 'first' });
  const stopped = await run('first', 'stop');
  assert.ok(stopped.stopped.some((item) => item.pid === first.pid));
  assert.equal(
    stopped.stopped.some((item) => item.pid === second.pid),
    false,
  );
  await assert.rejects(answers(first), /fetch failed/);
  assert.equal((await answers(second)).status, 200);
  assert.equal(await fs.readFile(config, 'utf8'), text);
});

test('projectless stop hints retain runtime, Solution and state selectors without stopping a sibling', async (t) => {
  const { directory, toolkit } = await standalone(t, 'paqvilo-unscoped-stop-');
  const run = (...args) => toolkit(['mirage', ...args, '--json']);
  const replay = (hint) => toolkit([...stopArguments(hint), '--json'], hintCommands(hint).cwd ?? directory);
  // The two runtimes have their own Solution root and state file, so they start concurrently.
  const [first, sibling] = await settled(
    ...['first', 'sibling'].map(async (name) => {
      const root = path.join(
        directory,
        name === 'first' ? "first $([char]65) 'quoted' `ticks solution" : 'sibling solution',
      );
      await fs.mkdir(root);
      return run(
        'start',
        '--runtime',
        'model-driven',
        '--simulation',
        'dry-run',
        '--solution-root',
        root,
        '--state',
        path.join(directory, name === 'first' ? "first $([char]65) 'quoted' `ticks state.json" : 'sibling state.json'),
        '--port',
        '0',
      );
    }),
  );
  if (process.platform === 'win32') assert.match(first.stop, /^node -e /);
  assert.ok(stopArguments(first.stop).includes(first.stateFile));
  // The exact published command stops its runtime; started again from the hint's own selectors, it does so again.
  for (const round of [1, 2]) {
    const active =
      round === 1 ? first : await run('start', '--simulation', 'dry-run', ...stopArguments(first.stop).slice(2));
    const result = await replay(active.stop);
    assert.deepEqual(
      result.stopped.map((entry) => entry.pid),
      [active.pid],
    );
    await assert.rejects(answers(active), /fetch failed/);
    assert.equal((await answers(sibling)).status, 200);
  }
});

test('project and catalogue stop hints replay explicit runtime overrides instead of the declared kind', async (t) => {
  const { directory, toolkit } = await standalone(t, 'paqvilo-overridden-stop-');
  const project = path.join(directory, 'organization.json'),
    catalogue = path.join(directory, 'catalogue.yml');
  await fs.writeFile(
    project,
    JSON.stringify({
      version: 2,
      runtime: { kind: 'model-driven' },
      simulation: { level: 'dry-run' },
      solutions: [],
    }),
  );
  await fs.writeFile(
    catalogue,
    'sites:\n  invented:\n    mirage:\n      runtime: {kind: model-driven}\n      simulation: {level: dry-run}\n',
  );
  const run = (args) => toolkit([...args, '--json']);
  // Both selections run at once and share this directory's Mirage records: each replayed stop must stop only its own.
  await settled(
    ...[
      ['--project', project],
      ['--config', catalogue, '--site', 'invented'],
    ].map(async (selection) => {
      const active = await run(['mirage', 'start', ...selection, '--runtime', 'dataverse-api', '--port', '0']);
      assert.ok(stopArguments(active.stop).includes('dataverse-api'));
      const stopped = await run(stopArguments(active.stop));
      assert.deepEqual(
        stopped.stopped.map((entry) => entry.pid),
        [active.pid],
      );
      await assert.rejects(answers(active), /fetch failed/);
    }),
  );
});

test('a stop that names only the listening port stops the runtime on that port and no other', async (t) => {
  const { directory, toolkit } = await standalone(t, 'paqvilo-port-stop-');
  const run = (...args) => toolkit(['mirage', ...args, '--runtime', 'model-driven', '--json']);
  const [first, sibling] = await settled(
    ...['first', 'sibling'].map((name) =>
      run('start', '--simulation', 'dry-run', '--state', path.join(directory, `${name}.json`), '--port', '0'),
    ),
  );
  const none = await run('stop', '--port', '1');
  assert.deepEqual(none.stopped, [], 'a port nothing was started on selects nothing');
  const stopped = await run('stop', '--port', new URL(first.url).port);
  assert.deepEqual(
    stopped.stopped.map((entry) => entry.pid),
    [first.pid],
  );
  await assert.rejects(answers(first), /fetch failed/);
  assert.equal((await answers(sibling)).status, 200);
});
