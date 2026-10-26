import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { tempDir } from './fixture.mjs';

const execute = promisify(execFile),
  cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
// A start may use the whole default Mirage startup budget (120 s, lense/commands/mirage.mjs); the guard only ends a
// hung command. The tests have no overall deadline: every command they wait for is bounded by this guard.
const COMMAND_TIMEOUT = 150_000;
// A developer's or runner's PAQVILO_REPO, PAQVILO_URL and similar settings would change the commands' selections.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
);
/** Runs one toolkit command and parses its JSON output; a failing exit rejects. */
const toolkit = async (args, options = {}) =>
  JSON.parse(
    (
      await withProcessSlot(() =>
        execute(process.execPath, [cli, ...args], {
          windowsHide: true,
          env,
          timeout: COMMAND_TIMEOUT,
          maxBuffer: 8 * 1024 * 1024,
          ...options,
        }),
      )
    ).stdout,
  );
/** Awaits every independent command before reporting the first failure, so cleanup never races a pending start. */
const settled = async (...promises) => {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
};
const stopArguments = (hint) => {
  if (hint.startsWith('node -e ')) {
    const payload = /Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(hint)?.[1];
    assert.ok(payload, 'fallback commands carry a literal argv payload');
    const commands = JSON.parse(inflateRawSync(Buffer.from(payload, 'base64')).toString('utf8'));
    assert.equal(commands.length, 1);
    const args = commands[0];
    assert.equal(args[0], cli, 'fallback invokes the toolkit that emitted the hint');
    return args.slice(1);
  }
  const tokens =
    process.platform === 'win32'
      ? hint.match(/"[^"]*"|[^\s"]+/g).map((token) => (token.startsWith('"') ? token.slice(1, -1) : token))
      : hint.match(/(?:'[^']*'|"[^"]*"|[^\s'"]+)+/g).map((token) =>
          token
            .match(/'[^']*'|"[^"]*"|[^'"]+/g)
            .map((part) => (/^["']/.test(part) ? part.slice(1, -1) : part))
            .join(''),
        );
  assert.deepEqual(tokens.slice(0, 2), ['npx', 'paqvilo']);
  return tokens.slice(2);
};
test('public project inspect/start/reuse/stop works without any portal or catalogue', async (t) => {
  const directory = await tempDir('paqvilo-standalone-cli-');
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
  const run = (...args) => toolkit(['mirage', ...args, '--project', project, '--json'], { cwd: directory });
  let running = true;
  t.after(async () => {
    if (running) await run('stop').catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
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
  const state = await (await fetch(started.url + '/_sim/api/status')).json();
  assert.equal(state.runtime.kind, 'model-driven');
  assert.equal(state.simulation.level, 'dry-run');
  const reused = await run('start', '--port', '0');
  assert.equal(reused.started, false);
  assert.equal(reused.pid, started.pid);
  // Execute the exact advertised selection, including from the toolkit checkout
  // where the bundled catalogue's sites differ from this project's file name.
  const stopped = await toolkit([...stopArguments(started.stop), '--json']);
  assert.equal(
    stopped.stopped.some((item) => item.pid === started.pid),
    true,
  );
  await assert.rejects(fetch(started.url + '/_sim/api/status'), /fetch failed/);
  running = false;
  assert.equal(await fs.readFile(project, 'utf8'), text);
});

test('catalogue standalone lifecycle needs no source or environment and stops only its selected profile', async (t) => {
  const directory = await tempDir('paqvilo-standalone-profiles-');
  const config = path.join(directory, 'catalogue.yml');
  const text =
    'sites:\n  first:\n    mirage:\n      runtime: {kind: model-driven}\n      simulation: {level: dry-run}\n  second:\n    mirage:\n      runtime: {kind: model-driven}\n      simulation: {level: dry-run}\n';
  await fs.writeFile(config, text);
  const run = (site, command, ...args) =>
    toolkit(['mirage', command, '--config', config, '--site', site, '--json', ...args], { cwd: directory });
  const running = new Set(['first', 'second']);
  t.after(async () => {
    for (const site of running) await run(site, 'stop').catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
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
  const status = await (await fetch(first.url + '/_setup/api/status')).json();
  assert.equal(status.layers.shared.file, config);
  const stopped = await run('first', 'stop');
  assert.ok(stopped.stopped.some((item) => item.pid === first.pid));
  assert.equal(
    stopped.stopped.some((item) => item.pid === second.pid),
    false,
  );
  await assert.rejects(fetch(first.url + '/_sim/api/status'), /fetch failed/);
  running.delete('first');
  assert.equal((await fetch(second.url + '/_sim/api/status')).status, 200);
  assert.equal(await fs.readFile(config, 'utf8'), text);
});

test('projectless stop hints retain runtime, Solution and state selectors without stopping a sibling', async (t) => {
  const directory = await tempDir('paqvilo-unscoped-stop-');
  const running = new Map();
  const run = (...args) => toolkit(['mirage', ...args, '--json'], { cwd: directory });
  const replay = (hint) => toolkit([...stopArguments(hint), '--json'], { cwd: directory });
  const start = async (...args) => {
    const session = await run('start', ...args);
    running.set(session.pid, session.stop);
    return session;
  };
  t.after(async () => {
    for (const hint of running.values()) await replay(hint).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  // The two runtimes have their own Solution root and state file, so they start concurrently.
  const [first, sibling] = await settled(
    ...['first', 'sibling'].map(async (name) => {
      const root = path.join(
        directory,
        name === 'first' ? "first $([char]65) 'quoted' `ticks solution" : 'sibling solution',
      );
      await fs.mkdir(root);
      return start(
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
  if (process.platform === 'win32') {
    // Execute the exact published fallback through both shells. It directly
    // invokes the current toolkit, with no npx download or shell argument rewrite.
    for (const shell of ['cmd.exe', 'powershell.exe']) {
      const active =
        shell === 'cmd.exe' ? first : await start('--simulation', 'dry-run', ...stopArguments(first.stop).slice(2));
      const args =
        shell === 'cmd.exe'
          ? ['/d', '/s', '/v:on', '/c', active.stop]
          : ['-NoProfile', '-NonInteractive', '-Command', active.stop];
      await execute(shell, args, {
        cwd: directory,
        windowsHide: true,
        windowsVerbatimArguments: shell === 'cmd.exe',
        timeout: COMMAND_TIMEOUT,
      });
      await assert.rejects(fetch(active.url + '/_sim/api/status'), /fetch failed/);
      running.delete(active.pid);
      assert.equal((await fetch(sibling.url + '/_sim/api/status')).status, 200);
    }
  } else {
    const result = await replay(first.stop);
    assert.deepEqual(
      result.stopped.map((entry) => entry.pid),
      [first.pid],
    );
    running.delete(first.pid);
  }
  assert.equal((await fetch(sibling.url + '/_sim/api/status')).status, 200);
  await assert.rejects(fetch(first.url + '/_sim/api/status'), /fetch failed/);
});

test('project and catalogue stop hints replay explicit runtime overrides instead of the declared kind', async (t) => {
  const directory = await tempDir('paqvilo-overridden-stop-');
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
  const running = new Map();
  const run = (args) => toolkit([...args, '--json'], { cwd: directory });
  t.after(async () => {
    for (const hint of running.values()) await run(stopArguments(hint)).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Both selections run at once and share this directory's Mirage records: each replayed stop must stop only its own.
  await settled(
    ...[
      ['--project', project],
      ['--config', catalogue, '--site', 'invented'],
    ].map(async (selection) => {
      const active = await run(['mirage', 'start', ...selection, '--runtime', 'dataverse-api', '--port', '0']);
      running.set(active.pid, active.stop);
      assert.ok(stopArguments(active.stop).includes('dataverse-api'));
      const stopped = await run(stopArguments(active.stop));
      assert.deepEqual(
        stopped.stopped.map((entry) => entry.pid),
        [active.pid],
      );
      await assert.rejects(fetch(active.url + '/_sim/api/status'), /fetch failed/);
      running.delete(active.pid);
    }),
  );
});
