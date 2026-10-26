import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { runWorkspaceTask, stopOwnedChild } from './helpers/workspace-task.mjs';
import YAML from 'yaml';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { createFixture } from '../test/fixture.mjs';
import { freeDebugPort } from './helpers/debug-port.mjs';

test('owned task shutdown drains pending stdio after the direct child exit', { timeout: 15000 }, async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-init-drain-'));
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("owned-output");'], {
    cwd: work,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close'),
    exited = once(child, 'exit');
  const release = Promise.withResolvers(),
    destroying = Promise.withResolvers();
  const destroy = child.stdout._destroy.bind(child.stdout);
  // Hold the actual pipe's destruction callback: process exit must not let
  // cleanup skip an outstanding stdio close, even when that close is delayed.
  child.stdout._destroy = (error, callback) => {
    destroying.resolve();
    release.promise.then(() => destroy(error, callback));
  };
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    release.resolve();
    await stopOwnedChild(child, closed);
    await fs.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  assert.deepEqual(await exited, [0, null]);
  await destroying.promise;
  let drained = false;
  const stopping = stopOwnedChild(child, closed).then((result) => {
    drained = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, 'exit alone cannot establish that stdio has closed');
  release.resolve();
  assert.deepEqual(await stopping, [0, null]);
  assert.equal(output, 'owned-output');
  await fs.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await assert.rejects(fs.stat(work), { code: 'ENOENT' });
});

test(
  'empty-project debugger task matches the actual local development ready line and reuses its browser',
  { timeout: 120000 },
  async (t) => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-init-browser-'));
    const fixture = createFixture();
    await prepareProject(work, { name: 'sample', noPack: true });
    const config = YAML.parse(await fs.readFile(path.join(work, 'paqvilo.config.yml'), 'utf8'));
    config.sourceRoot = fixture.dir;
    config.sites.portal.source = '.';
    config.sites.portal.environments.dev = 'http://127.0.0.1:8787';
    config.sites.portal.mirage.port = 0;
    await fs.writeFile(path.join(work, 'paqvilo.config.yml'), YAML.stringify(config));
    const manifest = JSON.parse(await fs.readFile(path.join(work, 'package.json'), 'utf8'));
    const tasks = JSON.parse(await fs.readFile(path.join(work, '.vscode/tasks.json'), 'utf8'));
    const launches = JSON.parse(await fs.readFile(path.join(work, '.vscode/launch.json'), 'utf8'));
    const launch = launches.configurations.find((item) => item.port === 9223 && item.preLaunchTask.includes('portal'));
    const task = tasks.tasks.find((item) => item.label === launch.preLaunchTask);
    assert.equal(task.type, 'process');
    assert.equal(manifest.scripts['mirage:dev:portal:debug'], 'npm run mirage:dev:portal -- --debug-port 9223');
    const port = await freeDebugPort();
    const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
    const args = task.args
      .slice(1)
      .filter((arg) => arg !== '--headed')
      .map((arg) => (arg === '9223' ? String(port) : arg.replace('${workspaceFolder}', work)));
    const run = runWorkspaceTask(t, {
      cli,
      args,
      cwd: work,
      env,
      task,
      port,
      stop: ['--config', path.join(work, 'paqvilo.config.yml'), '--site', 'portal'],
      work,
      cleanup: () => fixture.cleanup(),
      label: 'Generated task readiness',
    });
    const browser = await run.attach();
    const page = browser.contexts()[0].pages()[0];
    assert.ok(page, 'debugger reuses the browser opened by development');
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+/, { timeout: 30000 });
    const response = await page.request.get(page.url());
    assert.equal(response.status(), 200);
    const status = await page.request.get(new URL('/_sim/', page.url()).href);
    assert.equal(status.status(), 200);
  },
);
