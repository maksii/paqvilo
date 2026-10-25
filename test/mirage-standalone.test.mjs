import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';

const execute = promisify(execFile),
  cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const stopArguments = (hint) => {
  if (hint.startsWith('node -e ')) {
    const payload = /Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(hint)?.[1];
    assert.ok(payload, 'fallback commands carry a literal argv payload');
    const args = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
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
test('public project inspect/start/reuse/stop works without any portal or catalogue', { timeout: 60000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-standalone-cli-'));
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
  const run = async (...args) => {
    const result = await withProcessSlot(() =>
      execute(process.execPath, [cli, 'mirage', ...args, '--project', project, '--json'], {
        cwd: directory,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      }),
    );
    return JSON.parse(result.stdout);
  };
  t.after(async () => {
    await run('stop').catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  const inspected = await run('inspect');
  assert.equal(inspected.runtime.kind, 'model-driven');
  assert.deepEqual(inspected.portals, []);
  const started = await run('start', '--port', '0');
  assert.equal(started.started, true);
  assert.equal(started.sourceDir, null);
  assert.ok(started.pid);
  assert.deepEqual(stopArguments(started.stop), ['mirage', 'stop', '--project', project, '--port', '0']);
  const state = await (await fetch(started.url + '/_sim/api/status')).json();
  assert.equal(state.runtime.kind, 'model-driven');
  assert.equal(state.simulation.level, 'dry-run');
  const reused = await run('start', '--port', '0');
  assert.equal(reused.started, false);
  assert.equal(reused.pid, started.pid);
  // Execute the exact advertised selection, including from the toolkit checkout
  // where the bundled catalogue's sites differ from this project's file name.
  const stopResult = await withProcessSlot(() =>
    execute(process.execPath, [cli, ...stopArguments(started.stop), '--json'], {
      windowsHide: true,
      timeout: 30000,
    }),
  );
  const stopped = JSON.parse(stopResult.stdout);
  assert.equal(
    stopped.stopped.some((item) => item.pid === started.pid),
    true,
  );
  await assert.rejects(fetch(started.url + '/_sim/api/status'), /fetch failed/);
  assert.equal(await fs.readFile(project, 'utf8'), text);
});

test(
  'catalogue standalone lifecycle needs no source or environment and stops only its selected profile',
  { timeout: 60000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-standalone-profiles-'));
    const config = path.join(directory, 'catalogue.yml');
    const text =
      'sites:\n  first:\n    mirage:\n      runtime: {kind: model-driven}\n      simulation: {level: dry-run}\n  second:\n    mirage:\n      runtime: {kind: model-driven}\n      simulation: {level: dry-run}\n';
    await fs.writeFile(config, text);
    const run = async (site, command, ...args) => {
      const result = await withProcessSlot(() =>
        execute(process.execPath, [cli, 'mirage', command, '--config', config, '--site', site, '--json', ...args], {
          cwd: directory,
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 8 * 1024 * 1024,
        }),
      );
      return JSON.parse(result.stdout);
    };
    t.after(async () => {
      await run('first', 'stop').catch(() => {});
      await run('second', 'stop').catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    });
    assert.equal((await run('first', 'inspect')).runtime.kind, 'model-driven');
    const [first, second] = await Promise.all([
      run('first', 'start', '--port', '0'),
      run('second', 'start', '--port', '0'),
    ]);
    assert.equal(first.started, true);
    assert.deepEqual(stopArguments(first.stop), [
      'mirage',
      'stop',
      '--config',
      config,
      '--site',
      'first',
      '--runtime',
      'model-driven',
      '--port',
      '0',
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
    assert.equal((await fetch(second.url + '/_sim/api/status')).status, 200);
    assert.equal(await fs.readFile(config, 'utf8'), text);
  },
);

test(
  'projectless stop hints retain runtime, Solution and state selectors without stopping a sibling',
  { timeout: 60000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-unscoped-stop-'));
    const sessions = [];
    const run = async (...args) =>
      JSON.parse(
        (
          await withProcessSlot(() =>
            execute(process.execPath, [cli, 'mirage', ...args, '--json'], {
              cwd: directory,
              windowsHide: true,
              timeout: 30000,
            }),
          )
        ).stdout,
      );
    const replay = async (hint) =>
      JSON.parse(
        (
          await withProcessSlot(() =>
            execute(process.execPath, [cli, ...stopArguments(hint), '--json'], {
              cwd: directory,
              windowsHide: true,
              timeout: 30000,
            }),
          )
        ).stdout,
      );
    t.after(async () => {
      for (const session of sessions) await replay(session.stop).catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    });
    for (const name of ['first', 'sibling']) {
      const root = path.join(
        directory,
        name === 'first' ? "first $([char]65) 'quoted' `ticks solution" : 'sibling solution',
      );
      await fs.mkdir(root);
      sessions.push(
        await run(
          'start',
          '--runtime',
          'model-driven',
          '--simulation',
          'dry-run',
          '--solution-root',
          root,
          '--state',
          path.join(directory, `${name} state.json`),
          '--port',
          '0',
        ),
      );
    }
    const [first, sibling] = sessions;
    if (process.platform === 'win32') assert.match(first.stop, /^node -e /);
    assert.ok(stopArguments(first.stop).includes(path.join(directory, "first $([char]65) 'quoted' `ticks solution")));
    if (process.platform === 'win32') {
      // Execute the exact published fallback through both shells. It directly
      // invokes the current toolkit, with no npx download or shell argument rewrite.
      for (const shell of ['cmd.exe', 'powershell.exe']) {
        const active =
          shell === 'cmd.exe'
            ? first
            : await run('start', '--simulation', 'dry-run', ...stopArguments(first.stop).slice(2));
        if (active !== first) sessions.push(active);
        const args =
          shell === 'cmd.exe'
            ? ['/d', '/s', '/v:on', '/c', active.stop]
            : ['-NoProfile', '-NonInteractive', '-Command', active.stop];
        await execute(shell, args, {
          cwd: directory,
          windowsHide: true,
          windowsVerbatimArguments: shell === 'cmd.exe',
          timeout: 30000,
        });
        await assert.rejects(fetch(active.url + '/_sim/api/status'), /fetch failed/);
        assert.equal((await fetch(sibling.url + '/_sim/api/status')).status, 200);
      }
    } else {
      const result = await replay(first.stop);
      assert.deepEqual(
        result.stopped.map((entry) => entry.pid),
        [first.pid],
      );
    }
    assert.equal((await fetch(sibling.url + '/_sim/api/status')).status, 200);
    await assert.rejects(fetch(first.url + '/_sim/api/status'), /fetch failed/);
  },
);

test(
  'project and catalogue stop hints replay explicit runtime overrides instead of the declared kind',
  { timeout: 60000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-overridden-stop-'));
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
    let active;
    const run = async (args) =>
      JSON.parse(
        (
          await withProcessSlot(() =>
            execute(process.execPath, [cli, ...args, '--json'], {
              cwd: directory,
              windowsHide: true,
              timeout: 30000,
            }),
          )
        ).stdout,
      );
    t.after(async () => {
      if (active) await run(stopArguments(active.stop)).catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    });
    for (const selection of [
      ['--project', project],
      ['--config', catalogue, '--site', 'invented'],
    ]) {
      active = await run(['mirage', 'start', ...selection, '--runtime', 'dataverse-api', '--port', '0']);
      assert.match(active.stop, /--runtime dataverse-api/);
      const stopped = await run(stopArguments(active.stop));
      assert.deepEqual(
        stopped.stopped.map((entry) => entry.pid),
        [active.pid],
      );
      await assert.rejects(fetch(active.url + '/_sim/api/status'), /fetch failed/);
      active = null;
    }
  },
);
