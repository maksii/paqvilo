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
  const state = await (await fetch(started.url + '/_sim/api/status')).json();
  assert.equal(state.runtime.kind, 'model-driven');
  assert.equal(state.simulation.level, 'dry-run');
  const reused = await run('start', '--port', '0');
  assert.equal(reused.started, false);
  assert.equal(reused.pid, started.pid);
  const stopped = await run('stop');
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
